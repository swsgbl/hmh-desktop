/**
 * HMH Desktop — Electron 主进程(ADR-001/003/004)。
 *
 * 安全不变量(开发计划 M0 出口门 + Electron 官方安全清单):
 *  - renderer:contextIsolation + sandbox + 禁 nodeIntegration,严格 CSP;
 *  - 导航/新窗口一律拒绝(只加载我们自己的 renderer);
 *  - 每条 IPC 校验 sender 的顶层 frame URL 属于本应用,通道白名单;
 *  - host token 只存在于本进程与子进程 env,日志输出前先脱敏;
 *  - 单实例锁;退出时只停止自己 spawn 的 host(优雅→兜底 kill)。
 */
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DesktopRuntimeSupervisor, type HostState } from '@hmh-desktop/host-adapter';
import type { EventEnvelope, EventKind } from '@hmh-desktop/contracts';

// cjs bundle(esbuild)输出;__dirname 指向 dist-electron/main
const here = __dirname;
const isDev = process.env.HMH_DESKTOP_DEV === '1';
const rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? '';
const preloadPath = join(here, '../preload/index.js');

/* ---- 日志脱敏:token/authorization 永不进控制台(崩溃报告同理见 main 的日志包装) ---- */
const secrets: string[] = [];
function redact(s: string): string {
  let out = s;
  for (const sec of secrets) {
    if (sec.length >= 8) out = out.split(sec).join('[redacted]');
  }
  return out;
}
function logInfo(tag: string, msg: string): void {
  console.log(`[hmh-desktop:${tag}] ${redact(msg)}`);
}

/* ---- 单实例 ---- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  /* ---- host 监管 ---- */
  interface BridgeSnapshot {
    hostState: HostState;
    hostPort: number | null;
    hostVersion: string | null;
    lastError: string | null;
  }
  let supervisor: DesktopRuntimeSupervisor | null = null;
  let bridge: BridgeSnapshot = { hostState: 'stopped', hostPort: null, hostVersion: null, lastError: null };
  /** 事件批量缓冲:高频 SSE 不逐条过 IPC,50ms 批量 flush(渲染不卡)。 */
  let eventBuffer: EventEnvelope[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const sessionsStore = new Map<string, { id: string; title: string; createdAt: string }>();

  function pushEvent(env: EventEnvelope): void {
    eventBuffer.push(env);
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const batch = eventBuffer;
        eventBuffer = [];
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('bridge:event-batch', batch);
        }
      }, 50);
    }
  }

  const seqByRun = new Map<string, number>();
  function makeEnvelope(sessionId: string, runId: string, kind: EventKind, payload: Record<string, unknown>): EventEnvelope {
    const key = `${sessionId}\0${runId}`;
    const seq = (seqByRun.get(key) ?? 0) + 1;
    seqByRun.set(key, seq);
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      sessionId,
      runId,
      seq,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    };
  }

  /** dev 默认 fake host;HMH_DESKTOP_REAL=1 时尝试真实 hmharness desktop-host。 */
  async function startHost(): Promise<void> {
    const useReal = process.env.HMH_DESKTOP_REAL === '1';
    const repoRoot = join(here, '..', '..', '..', '..'); // apps/desktop/dist-electron/main → repo root
    const spec = useReal
      ? {
          command: process.execPath,
          args: ['--import', 'tsx', join(repoRoot, '..', 'hmharness', 'packages', 'web', 'src', 'desktop-host.ts')],
          env: {},
        }
      : {
          command: process.execPath,
          args: ['--import', 'tsx', join(repoRoot, 'node_modules', '@hmh-desktop', 'host-adapter', 'src', 'fake-host.ts')],
          env: {},
        };
    supervisor = new DesktopRuntimeSupervisor(spec, {
      onStateChange: (s, info) => {
        bridge = { ...bridge, hostState: s, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null, lastError: info.lastError ?? bridge.lastError };
        logInfo('host', `state=${s}${info.lastError ? ` err=${info.lastError}` : ''}`);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('bridge:host-state', s, info);
        }
      },
    });
    try {
      const ep = await supervisor.start();
      bridge = { ...bridge, hostState: 'ready', hostPort: ep.port, hostVersion: ep.version, lastError: null };
      logInfo('host', `ready on 127.0.0.1:${ep.port} (runtime ${ep.version})`);
    } catch (err) {
      bridge = { ...bridge, hostState: 'failed', lastError: String(err).slice(0, 200) };
      logInfo('host', `start failed: ${String(err).slice(0, 200)}`);
    }
  }

  /* ---- IPC 白名单 + sender 校验 ---- */
  const allowedOrigins = new Set<string>(
    isDev && rendererDevUrl
      ? [rendererDevUrl]
      : [pathToFileURL(join(here, '..', '..', 'dist-renderer', 'index.html')).href],
  );

  function senderTrusted(senderFrame: Electron.WebFrameMain | null | undefined): boolean {
    if (senderFrame === null || senderFrame === undefined) return false;
    // 校验顶层 frame 的 URL 是我们的 renderer(dev server 或打包文件)
    let top: Electron.WebFrameMain | null = senderFrame;
    while (top?.parent !== null && top?.parent !== undefined) top = top.parent;
    const url = top?.url ?? '';
    for (const origin of allowedOrigins) {
      if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) return true;
    }
    return false;
  }

  function registerIpc(): void {
    ipcMain.handle('bridge:get-state', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      return { ...bridge, sessions: [...sessionsStore.values()] };
    });

    ipcMain.handle('bridge:new-session', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      const id = `s-${randomUUID().slice(0, 8)}`;
      sessionsStore.set(id, { id, title: '新会话', createdAt: new Date().toISOString() });
      return { id };
    });

    ipcMain.handle('bridge:send-task', (event, text: unknown, sessionId: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      const task = typeof text === 'string' ? text.slice(0, 20_000) : '';
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      if (!task || !sid || supervisor === null || bridge.hostState !== 'ready') {
        return { ok: false, code: 'HOST_NOT_READY' };
      }
      const runId = `r-${randomUUID().slice(0, 8)}`;
      // 纵切片(fake):立即回执 run.started;真实接入后由 host SSE 供给全部事件
      pushEvent(makeEnvelope(sid, runId, 'run.started', { task, mode: 'ask' }));
      return { ok: true, runId };
    });

    ipcMain.handle('bridge:stop-host', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      void (async () => {
        await supervisor?.stop();
        app.quit();
      })();
      return { ok: true };
    });
  }

  /* ---- 窗口与安全策略 ---- */
  function createWindow(): void {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      backgroundColor: '#141416',
      title: 'HMH Desktop',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        spellcheck: false,
        devTools: isDev,
      },
    });
    win.once('ready-to-show', () => win.show());

    // 只允许加载我们自己的 renderer;任何导航/新窗口一律拒绝
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      const ok = [...allowedOrigins].some((o) => url === o || url.startsWith(`${o}/`) || url.startsWith(`${o}?`));
      if (!ok) {
        logInfo('nav', `blocked navigation to ${url.slice(0, 120)}`);
        e.preventDefault();
      }
    });
    // 外部链接交给系统浏览器,不在应用内打开
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    if (isDev && rendererDevUrl) {
      void win.loadURL(rendererDevUrl);
    } else {
      void win.loadFile(join(here, '..', '..', 'dist-renderer', 'index.html'));
    }
  }

  app.whenReady().then(() => {
    // CSP(dev 与 prod 不同;prod 不允许任何远程源)
    const csp = isDev
      ? [
          "default-src 'self'",
          `script-src 'self' ${rendererDevUrl}`,
          "style-src 'self' 'unsafe-inline'",
          `connect-src 'self' ${rendererDevUrl} ws://127.0.0.1:*`,
          "img-src 'self' data:",
          "font-src 'self' data:",
        ].join('; ')
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
        },
      });
    });

    registerIpc();
    createWindow();
    void startHost();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 退出:优雅停止自己 spawn 的 host(shutdown 端点 → 兜底只 kill 自己的句柄)
  app.on('before-quit', (e) => {
    if (supervisor !== null && supervisor.state !== 'stopped') {
      e.preventDefault();
      void supervisor.stop().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
