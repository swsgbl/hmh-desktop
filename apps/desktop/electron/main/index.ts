/**
 * HMH Desktop — Electron 主进程(ADR-001/003/004)。
 *
 * 安全不变量(开发计划 M0 出口门 + Electron 官方安全清单):
 *  - renderer:contextIsolation + sandbox + 禁 nodeIntegration,严格 CSP;
 *  - 导航/新窗口一律拒绝(只加载我们自己的 renderer);
 *  - 每条 IPC 校验 sender 的顶层 frame URL 属于本应用,通道白名单;
 *  - host token 只存在于本进程与子进程 env,日志输出前先脱敏;
 *  - 单实例锁;退出时只停止自己 spawn 的 host(优雅→兜底 kill)。
 *
 * 阶段E(2026-10-10):main 持有 DesktopHostClient,SSE 信封流(event: hmh)
 * 经 50ms 批量推给 renderer;sendTask/approve/interrupt/sessions 全部转发
 * 给 host —— fake 与真实 hmharness desktop-host 走同一条代码路径。
 */
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DesktopRuntimeSupervisor, DesktopHostClient, envelopeFromFrame, type HostState } from '@hmh-desktop/host-adapter';
import { isEventEnvelope, type EventEnvelope } from '@hmh-desktop/contracts';

const here = import.meta.dirname ?? '.';
const isDev = process.env.HMH_DESKTOP_DEV === '1';
const rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? '';
const preloadPath = join(here, '../preload/index.cjs');

/* ---- 日志脱敏:token/authorization 永不进控制台 ---- */
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

  /* ---- host 监管 + 桥客户端 ---- */
  interface BridgeSnapshot {
    hostState: HostState;
    hostPort: number | null;
    hostVersion: string | null;
    lastError: string | null;
    mode: 'fake' | 'real';
  }
  let supervisor: DesktopRuntimeSupervisor | null = null;
  let client: DesktopHostClient | null = null;
  let bridge: BridgeSnapshot = { hostState: 'stopped', hostPort: null, hostVersion: null, lastError: null, mode: 'fake' };
  /** 事件批量缓冲:高频 SSE 不逐条过 IPC,50ms 批量 flush(渲染不卡)。 */
  let eventBuffer: EventEnvelope[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let sseAbort: AbortController | null = null;
  let lastEventId = '';
  /** 未知/畸形信封计数(SCHEMA_MISMATCH 面向诊断,不崩)。 */
  let droppedFrames = 0;

  function pushEvent(env: EventEnvelope): void {
    eventBuffer.push(env);
    if (eventBuffer.length > 2_000) eventBuffer.splice(0, eventBuffer.length - 2_000);
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

  function broadcastHostState(s: HostState, info: { restartCount: number; lastError?: string }): void {
    bridge = { ...bridge, hostState: s, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null };
    logInfo('host', `state=${s}${info.lastError !== undefined ? ` err=${info.lastError}` : ''}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('bridge:host-state', s, info);
    }
  }

  /** SSE 流订阅:信封(event: hmh)批量推 renderer;高频 delta/line 原帧
   *  作为流块转发(renderer 拼接当前 assistant 占位)。断线自动重连。 */
  async function pumpEvents(): Promise<void> {
    if (client === null) return;
    for (;;) {
      const c = client;
      if (c === null) return;
      try {
        for await (const frame of c.rawEvents(lastEventId === '' ? undefined : lastEventId, sseAbort?.signal)) {
          if (frame.event === 'hmh') {
            const env = envelopeFromFrame(frame);
            if (env === null) {
              droppedFrames += 1;
              continue;
            }
            lastEventId = env.eventId;
            pushEvent(env);
          } else if (frame.event === 'delta' || frame.event === 'line') {
            try {
              const d = JSON.parse(frame.data) as { sessionId?: string; k?: string; chunk?: string; text?: string };
              const payload = frame.event === 'delta'
                ? { sessionId: d.sessionId ?? '', kind: d.k ?? 'text', chunk: String(d.chunk ?? '') }
                : { sessionId: d.sessionId ?? '', kind: 'line', chunk: String(d.text ?? '') };
              for (const w of BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed()) w.webContents.send('bridge:stream-chunk', payload);
              }
            } catch { /* malformed stream frame: skip */ }
          }
        }
        return; // 流正常结束(host 关闭)
      } catch {
        // 断线:短退避后重连(supervisor 可能正在重启 host)
        await new Promise((r) => setTimeout(r, 1_000));
        if (sseAbort?.signal.aborted) return;
      }
    }
  }

  /** dev 默认 fake host;HMH_DESKTOP_REAL=1 时连真实 hmharness desktop-host。
   *  注意:Electron 主进程的 process.execPath 是 electron.exe——host 子进程
   *  必须带 ELECTRON_RUN_AS_NODE=1 才会以纯 node 语义跑 --import tsx。 */
  async function startHost(): Promise<void> {
    const useReal = process.env.HMH_DESKTOP_REAL === '1';
    bridge = { ...bridge, mode: useReal ? 'real' : 'fake' };
    const repoRoot = join(here, '..', '..', '..', '..'); // apps/desktop/dist-electron/main → repo root
    const spec = useReal
      ? {
          command: process.execPath,
          args: ['--import', 'tsx', join(repoRoot, '..', 'hmharness', 'packages', 'web', 'src', 'desktop-host.ts')],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        }
      : {
          command: process.execPath,
          // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
          // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
          args: ['--import', 'tsx', join(repoRoot, 'packages', 'host-adapter', 'src', 'fake-host.ts')],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        };
    supervisor = new DesktopRuntimeSupervisor(spec, {
      onStateChange: broadcastHostState,
      // 首次启动与 crash 自愈后的重启都会走这里:端口/token 都是新的,
      // 重建桥客户端并重新订阅 SSE(renderer 的 EventStore 靠 eventId 去重)
      onReady: (ep) => {
        client = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, ep.token);
        sseAbort?.abort();
        sseAbort = new AbortController();
        lastEventId = '';
        void pumpEvents();
        logInfo('host', `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode})`);
      },
    });
    try {
      await supervisor.start();
    } catch (err) {
      const detail = (() => { try { return JSON.stringify(err); } catch { return String(err); } })().slice(0, 400);
      bridge = { ...bridge, hostState: 'failed', lastError: detail };
      logInfo('host', `start failed: ${detail}`);
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
    let top: Electron.WebFrameMain | null = senderFrame;
    while (top?.parent !== null && top?.parent !== undefined) top = top.parent;
    const url = top?.url ?? '';
    for (const origin of allowedOrigins) {
      if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) return true;
    }
    return false;
  }

  /** 需要 host 就绪的 IPC handler 公共壳:未就绪返回结构化错误。 */
  function hostCall<T>(event: Electron.IpcMainInvokeEvent, fn: (c: DesktopHostClient) => Promise<T>): Promise<T | { error: string; code: string }> {
    if (!senderTrusted(event.senderFrame)) return Promise.resolve({ error: 'untrusted sender', code: 'FORBIDDEN' });
    if (client === null || bridge.hostState !== 'ready') {
      return Promise.resolve({ error: `host not ready (${bridge.hostState})`, code: 'HOST_NOT_READY' });
    }
    return fn(client).catch((err: unknown) => {
      const detail = (() => { try { return JSON.stringify(err); } catch { return String(err); } })().slice(0, 300);
      return { error: detail, code: 'BRIDGE_ERROR' };
    });
  }

  function registerIpc(): void {
    ipcMain.handle('bridge:get-state', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      return { ...bridge, droppedFrames };
    });

    ipcMain.handle('bridge:sessions', (event) =>
      hostCall(event, (c) => c.getJson<{ sessions: Array<{ id: string; title: string; task: string; outcome: string; turns: number; toolUses: number; time: string; cwd: string; createdAt: string; updatedAt: string }> }>('/api/sessions?limit=100')));

    ipcMain.handle('bridge:send-task', (event, text: unknown, sessionId: unknown, mode: unknown) => {
      const task = typeof text === 'string' ? text.slice(0, 20_000) : '';
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      const m = mode === 'auto' || mode === 'yolo' ? mode : 'ask';
      if (task === '' || sid === '') return Promise.resolve({ ok: false, code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean; runId?: string }>('/api/task', { text: task, sessionId: sid, mode: m }));
    });

    ipcMain.handle('bridge:approve', (event, granted: unknown, sessionId: unknown) =>
      hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/approve', {
        granted: granted === true,
        sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 80) : '',
      })));

    ipcMain.handle('bridge:interrupt', (event, sessionId: unknown) =>
      hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/interrupt', {
        sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 80) : '',
      })));

    // ---- M4:工作区文件面(路径授权在 runtime:insideWs 校验) ----
    ipcMain.handle('bridge:fs-list', (event, path: unknown) => {
      const p = typeof path === 'string' ? path.slice(0, 1000) : '';
      return hostCall(event, (c) => c.getJson<Record<string, unknown>>(`/api/fs?files=1${p !== '' ? `&path=${encodeURIComponent(p)}` : ''}`));
    });

    ipcMain.handle('bridge:fs-read', (event, path: unknown) => {
      const p = typeof path === 'string' ? path.slice(0, 1000) : '';
      if (p === '') return Promise.resolve({ error: 'path required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.getJson<Record<string, unknown>>(`/api/fs/read?path=${encodeURIComponent(p)}`));
    });

    // ---- M4:Diff 面板(只读 git 变更;授权在 runtime) ----
    ipcMain.handle('bridge:diff', (event, sessionId: unknown) => {
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      return hostCall(event, (c) => c.getJson<Record<string, unknown>>(`/api/diff${sid !== '' ? `?sessionId=${encodeURIComponent(sid)}` : ''}`));
    });

    // ---- M5:认知状态(结构化事实;缺数据字段由 UI 显示"无数据") ----
    ipcMain.handle('bridge:cognitive', (event) =>
      hostCall(event, (c) => c.getJson<Record<string, unknown>>('/api/cognitive')));

    // ---- 历史会话预览(最后 80 条,每条 500 字;runtime 权威数据) ----
    ipcMain.handle('bridge:session-preview', (event, id: unknown) => {
      const sid = typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_:.@-]/g, '').slice(0, 80) : '';
      if (sid === '') return Promise.resolve({ error: 'id required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.getJson<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sid)}`));
    });

    ipcMain.handle('bridge:stop-host', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender' };
      void (async () => {
        sseAbort?.abort();
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
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      const ok = [...allowedOrigins].some((o) => url === o || url.startsWith(`${o}/`) || url.startsWith(`${o}?`));
      if (!ok) {
        logInfo('nav', `blocked navigation to ${url.slice(0, 120)}`);
        e.preventDefault();
      }
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
      sseAbort?.abort();
      void supervisor.stop().finally(() => app.quit());
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
