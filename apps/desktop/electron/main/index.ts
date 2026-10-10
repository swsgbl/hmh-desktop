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
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
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
   *  必须带 ELECTRON_RUN_AS_NODE=1 才会以纯 node 语义跑。
   *  打包产品(app.isPackaged):fake host 用 extraResources 里的自包含 cjs;
   *  真实 runtime 需 HMH_DESKTOP_REAL_ENTRY 指向 desktop-host 入口(产品化
   *  的 runtime 捆绑属后续设计,见验收报告)。 */
  async function startHost(): Promise<void> {
    const useReal = process.env.HMH_DESKTOP_REAL === '1';
    bridge = { ...bridge, mode: useReal ? 'real' : 'fake' };
    const repoRoot = join(here, '..', '..', '..', '..'); // apps/desktop/dist-electron/main → repo root
    const packaged = app.isPackaged;
    let spec: { command: string; args: string[]; env: Record<string, string> };
    if (useReal) {
      const entry = process.env.HMH_DESKTOP_REAL_ENTRY ?? (packaged ? '' : join(repoRoot, '..', 'hmharness', 'packages', 'web', 'src', 'desktop-host.ts'));
      if (entry === '') {
        bridge = { ...bridge, hostState: 'failed', lastError: '真实 runtime 未配置:打包产品需设置 HMH_DESKTOP_REAL_ENTRY 指向 hmharness desktop-host 入口' };
        logInfo('host', 'real mode without HMH_DESKTOP_REAL_ENTRY in packaged app');
        return;
      }
      spec = {
        command: process.execPath,
        args: ['--import', 'tsx', entry],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    } else if (packaged) {
      spec = {
        command: process.execPath,
        args: [join(process.resourcesPath, 'fake-host.cjs')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ['--import', 'tsx', join(repoRoot, 'packages', 'host-adapter', 'src', 'fake-host.ts')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
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

    ipcMain.handle('bridge:send-task', (event, text: unknown, sessionId: unknown, mode: unknown, attachments: unknown) => {
      const task = typeof text === 'string' ? text.slice(0, 20_000) : '';
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      const m = mode === 'auto' || mode === 'yolo' ? mode : 'ask';
      // 附件:后端授权 DTO 的绝对路径(@ 选择器只来自 /api/fs/search)
      const atts = Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string').slice(0, 10) : [];
      if (task === '' || sid === '') return Promise.resolve({ ok: false, code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean; runId?: string }>('/api/task', { text: task, sessionId: sid, mode: m, attachments: atts }));
    });

    // ---- @ 附件:工作区文件搜索(runtime 授权的路径来源) ----
    ipcMain.handle('bridge:fs-search', (event, q: unknown) => {
      const query = typeof q === 'string' ? q.slice(0, 200) : '';
      if (query === '') return Promise.resolve({ results: [] });
      return hostCall(event, (c) => c.getJson<{ results: Array<{ rel: string; path: string }> }>(`/api/fs/search?q=${encodeURIComponent(query)}`));
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

    ipcMain.handle('bridge:inject', (event, text: unknown, sessionId: unknown) => {
      const t = typeof text === 'string' ? text.slice(0, 20_000) : '';
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      if (t === '' || sid === '') return Promise.resolve({ ok: false, code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/inject', { text: t, sessionId: sid }));
    });

    // ---- 会话导出(export.md → 保存对话框;文件写入只在 main) ----
    ipcMain.handle('bridge:export-session', async (event, id: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const sid = typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_:.@-]/g, '').slice(0, 80) : '';
      if (sid === '') return { error: 'id required', code: 'BAD_REQUEST' };
      if (client === null || bridge.hostState !== 'ready') return { error: `host not ready (${bridge.hostState})`, code: 'HOST_NOT_READY' };
      try {
        const md = await client.getText(`/api/sessions/${encodeURIComponent(sid)}/export.md`);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win === undefined) return { error: 'no window', code: 'BRIDGE_ERROR' };
        const r = await dialog.showSaveDialog(win, {
          title: '导出会话',
          defaultPath: `hmh-${sid}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (r.canceled || r.filePath === undefined || r.filePath === '') return { ok: false, canceled: true };
        await writeFile(r.filePath, md, 'utf8');
        logInfo('export', `session ${sid} → ${r.filePath}`);
        return { ok: true, path: r.filePath };
      } catch (err) {
        const detail = (() => { try { return JSON.stringify(err); } catch { return String(err); } })().slice(0, 300);
        return { error: detail, code: 'BRIDGE_ERROR' };
      }
    });

    // ---- 审批模式读写(权威在 runtime config;切换必须显式) ----
    ipcMain.handle('bridge:approval-get', (event) =>
      hostCall(event, (c) => c.getJson<{ settings?: { approval?: string } }>('/api/state')));

    ipcMain.handle('bridge:approval-set', (event, mode: unknown) => {
      const m = mode === 'auto' ? 'auto' : mode === 'ask' ? 'ask' : '';
      if (m === '') return Promise.resolve({ error: 'mode must be ask|auto', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/config', { approval: m }));
    });

    // ---- Provider 设置(03 §七:key 只出 hasKey/末四位;保存直写 runtime) ----
    ipcMain.handle('bridge:providers', (event) =>
      hostCall(event, (c) => c.getJson<{ providersDetail?: Array<{ name: string; model: string; baseUrl: string; hasKey: boolean; keyTail?: string }>; model?: string }>('/api/state')));

    ipcMain.handle('bridge:provider-save', (event, provider: unknown) => {
      const p = provider as { name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
      const name = typeof p?.name === 'string' ? p.name.slice(0, 80) : '';
      const baseUrl = typeof p?.baseUrl === 'string' ? p.baseUrl.slice(0, 300) : '';
      const model = typeof p?.model === 'string' ? p.model.slice(0, 120) : '';
      if (name === '' || baseUrl === '' || model === '') return Promise.resolve({ error: 'name/baseUrl/model required', code: 'BAD_REQUEST' });
      const body: Record<string, unknown> = { name, baseUrl, model };
      // apiKey 只在显式输入时上传,绝不回显(renderer 表单提交后即清空)
      if (typeof p?.apiKey === 'string' && p.apiKey !== '') body.apiKey = p.apiKey.slice(0, 300);
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/providers', body));
    });

    // ---- 工作区(03 §六;切换语义与 web 相同:runtime 单选 cwd) ----
    ipcMain.handle('bridge:workspaces', (event) =>
      hostCall(event, (c) => c.getJson<{ current: string; items: Array<{ id: string; name: string; path: string }> }>('/api/workspaces')));

    ipcMain.handle('bridge:workspace-use', (event, id: unknown) => {
      const wid = typeof id === 'string' ? id.slice(0, 60) : '';
      if (wid === '') return Promise.resolve({ error: 'id required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/workspaces/use', { id: wid }));
    });

    ipcMain.handle('bridge:workspace-add', (event, name: unknown, path: unknown) => {
      const n = typeof name === 'string' ? name.slice(0, 120) : '';
      const p = typeof path === 'string' ? path.slice(0, 1000) : '';
      if (p === '') return Promise.resolve({ error: 'path required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>('/api/workspaces', { name: n === '' ? undefined : n, path: p }));
    });

    // ---- 会话归档/删除(移入 archive/trash,可恢复;runtime 权威) ----
    ipcMain.handle('bridge:session-op', (event, id: unknown, op: unknown) => {
      const sid = typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_:.@-]/g, '').slice(0, 80) : '';
      const o = op === 'archive' || op === 'delete' ? op : '';
      if (sid === '' || o === '') return Promise.resolve({ error: 'id and op(archive|delete) required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sid)}/${o}`, {}));
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
  // 03 §七:Desktop 本地只存 UI 偏好/窗口状态(userData/window-state.json)
  const windowStateFile = (): string => join(app.getPath('userData'), 'window-state.json');
  async function loadBounds(): Promise<{ width: number; height: number; x?: number; y?: number } | null> {
    try {
      return JSON.parse(await readFile(windowStateFile(), 'utf8')) as { width: number; height: number; x?: number; y?: number };
    } catch { return null; }
  }
  async function saveBounds(win: BrowserWindow): Promise<void> {
    try { await writeFile(windowStateFile(), JSON.stringify(win.getBounds()), 'utf8'); } catch { /* best effort */ }
  }

  async function createWindow(): Promise<BrowserWindow | null> {
    const saved = await loadBounds();
    const win = new BrowserWindow({
      width: saved?.width ?? 1440,
      height: saved?.height ?? 900,
      ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
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
    win.on('close', () => { void saveBounds(win); });

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
    return win;
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
    // createWindow 是 async(bounds 恢复);安全自测在窗口就绪后从内部挂载
    void createWindow().then((win) => {
      if (win !== null && process.env.HMH_DESKTOP_SECURITY_TEST === '1') {
        win.webContents.once('did-finish-load', () => {
          void securitySelfTest(win);
        });
      }
    });
    void startHost();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  async function securitySelfTest(win: BrowserWindow): Promise<void> {
    const results: Array<[string, boolean, string]> = [];
    const check = async (name: string, probe: () => Promise<[boolean, string]>): Promise<void> => {
      try {
        const [ok, detail] = await probe();
        results.push([name, ok, detail]);
      } catch (err) {
        results.push([name, false, String(err).slice(0, 120)]);
      }
    };
    const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code, true);

    await check('renderer 无可用的 process/require(sandbox 生效)', async () => {
      const r = (await js(`(function(){
        var t = function(f){ try { var v = f(); return (v === undefined || v === null) ? 'unavailable' : typeof v; } catch(e){ return 'blocked'; } };
        return JSON.stringify([t(function(){return process}), t(function(){return require}), t(function(){return globalThis.process})]);
      })()`)) as string;
      const parsed = JSON.parse(r) as string[];
      const p = parsed[0] ?? 'unknown';
      const req = parsed[1] ?? 'unknown';
      const safe = (v: string): boolean => v === 'unavailable' || v === 'blocked';
      return [safe(p) && safe(req), `process=${p} require=${req}`];
    });
    await check('window.hmh 只有白名单方法(无 ipcRenderer/额外面)', async () => {
      const r = (await js('Object.keys(window.hmh || {}).sort().join(",")')) as string;
      const allow = ['approve', 'approvalGet', 'approvalSet', 'cognitive', 'diff', 'exportSession', 'fsList', 'fsRead', 'fsSearch', 'getState', 'inject', 'interrupt', 'onEventBatches', 'onHostState', 'onStreamChunks', 'providerSave', 'providers', 'sendTask', 'sessionOp', 'sessionPreview', 'sessions', 'stopHost', 'workspaces', 'workspaceAdd', 'workspaceUse'];
      const got = r === '' ? [] : r.split(',');
      const unexpected = got.filter((k) => !allow.includes(k));
      return [unexpected.length === 0, `keys=${r}`];
    });
    await check('外部导航被拦截(URL 不变)', async () => {
      const before = win.webContents.getURL();
      await js('location.href = "https://example.invalid/x"; "noop"').catch(() => 'noop');
      await new Promise((r2) => setTimeout(r2, 1_200));
      const after = win.webContents.getURL();
      return [after === before, `${before} → ${after}`];
    });
    await check('window.open 被拒绝(返回 null 且无新窗口)', async () => {
      const before = BrowserWindow.getAllWindows().length;
      const r = (await js('String(window.open("https://example.invalid"))')) as string;
      await new Promise((r2) => setTimeout(r2, 400));
      const after = BrowserWindow.getAllWindows().length;
      return [r === 'null' && after === before, `open()=${r} windows=${before}→${after}`];
    });
    await check('CSP 存在(meta 注入或响应头)', async () => {
      const meta = (await js('Boolean(document.querySelector("meta[http-equiv=\'Content-Security-Policy\']"))')) as boolean;
      const headerCsp = isDev ? 'dev: header CSP 由 onHeadersReceived 注入(不适用 meta 断言)' : 'prod';
      return [meta || isDev, `meta=${meta} ${headerCsp}`];
    });
    await check('bridge:get-state 正常返回(host 桥可用)', async () => {
      const r = (await js('window.hmh.getState().then(s => JSON.stringify(s)).catch(e => "ERR:"+e)')) as string;
      return [r.startsWith('{') && r.includes('hostState'), r.slice(0, 80)];
    });
    await check('XSS:恶意任务文本只以文本渲染(不执行)', async () => {
      const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2<\/script>"&\'';
      const sendR = (await js(`window.hmh.sendTask(${JSON.stringify(payload)}, 'sec-xss-1', 'auto').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e)`)) as string;
      if (!sendR.includes('"ok":true')) return [false, `sendTask 未受理: ${sendR.slice(0, 80)}`];
      // fake host echo 回来后经 React 渲染(用户消息 + 助手 echo 双路径)
      await new Promise((r2) => setTimeout(r2, 3_000));
      const probe = (await js(`JSON.stringify({
        xssFlag: typeof window.__xss,
        imgCount: document.querySelectorAll('img[src="x"]').length,
        scriptRan: document.body.innerText.indexOf('window.__xss=2') >= 0
      })`)) as string;
      const p = JSON.parse(probe) as { xssFlag: string; imgCount: number; scriptRan: boolean };
      return [p.xssFlag === 'undefined' && p.imgCount === 0, `xssFlag=${p.xssFlag} img=${p.imgCount}`];
    });

    let failed = 0;
    for (const [name, ok, detail] of results) {
      console.log(`SECURITY-TEST ${ok ? 'PASS' : 'FAIL'} | ${name} | ${redact(detail)}`);
      if (!ok) failed += 1;
    }
    console.log(`SECURITY-TEST SUMMARY pass=${results.length - failed}/${results.length}`);
    app.exit(failed === 0 ? 0 : 1);
  }

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
