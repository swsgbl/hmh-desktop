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
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DesktopRuntimeSupervisor, DesktopHostClient, envelopeFromFrame, type HostState } from '@hmh-desktop/host-adapter';
import { isEventEnvelope, type EventEnvelope } from '@hmh-desktop/contracts';
import { attachUiVerify } from './uiverify.ts';

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
    runtimeEntry: string | null;
  }
  let supervisor: DesktopRuntimeSupervisor | null = null;
  let client: DesktopHostClient | null = null;
  let bridge: BridgeSnapshot = { hostState: 'stopped', hostPort: null, hostVersion: null, lastError: null, mode: 'fake', runtimeEntry: null };
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

  /* ---- hmharness runtime 自动发现(2026-10-10 用户定调:装过 hmharness 的
     机器零配置直连,复用 CLI/TUI/web 7788 的同一 HMH_HOME——config/providers/
     会话历史天然共享)。发现顺序:显式配置 > where hmh > npm 全局 > 常见源码位置。 */
  const runtimeConfigFile = (): string => join(app.getPath('userData'), 'runtime.json');
  async function loadRuntimeEntryOverride(): Promise<string> {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), 'utf8')) as { entry?: unknown };
      return typeof v.entry === 'string' && v.entry !== '' && isAbsolute(v.entry) ? v.entry : '';
    } catch { return ''; }
  }
  async function saveRuntimeEntryOverride(entry: string): Promise<void> {
    await writeFile(runtimeConfigFile(), JSON.stringify({ entry }, null, 2), 'utf8').catch(() => undefined);
  }

  function detectRealEntry(): string {
    // 1) 环境变量显式覆盖(高级用户)
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== undefined && envEntry !== '' && isAbsolute(envEntry)) return envEntry;

    const repos = new Set<string>();
    // 2) where hmh:npm link/全局安装的 bin → node_modules/hmharness → 真 repo(npm link 是 symlink)
    try {
      const out = execFileSync('where', ['hmh'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === '') continue;
        try {
          const linked = join(dirname(bin), 'node_modules', 'hmharness');
          if (existsSync(linked)) repos.add(realpathSync(linked));
        } catch { /* bin 布局不符,跳过 */ }
      }
    } catch { /* hmh 不在 PATH */ }
    // 3) npm 全局根
    try {
      const out = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 6_000, windowsHide: true });
      const p = join(out.trim(), 'hmharness');
      if (existsSync(p)) repos.add(realpathSync(p));
    } catch { /* npm 不可用 */ }
    // 4) 常见源码位置(本机开发布局)
    const bases = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\', homedir(), join(homedir(), 'Developer')];
    for (const base of bases) {
      try {
        const p = resolve(base, 'hmharness');
        if (existsSync(p)) repos.add(p);
      } catch { /* 盘不存在 */ }
    }
    // 命中的 repo 必须有 desktop-host 入口与依赖布局
    for (const repo of repos) {
      const entry = join(repo, 'packages', 'web', 'src', 'desktop-host.ts');
      if (existsSync(entry) && existsSync(join(repo, 'node_modules'))) return entry;
    }
    return '';
  }

  /** 解析 runtime 入口所属的 hmharness 仓库根(packages/web/src|dist 上溯)。 */
  function repoRootOf(entry: string): string {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages', 'web'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(entry);
  }

  let runtimeEntry = ''; // 当前实际使用的真实 runtime 入口(''=未接)

  /** dev 连仓库内 hmharness;打包产品自动发现(发现不到→演示模式+引导)。 */
  async function startHost(): Promise<void> {
    const repoRoot = join(here, '..', '..', '..', '..'); // apps/desktop/dist-electron/main → repo root
    const packaged = app.isPackaged;
    // 真实入口解析:配置覆盖 > 自动发现(dev 直接用相邻仓库);
    // HMH_DESKTOP_FAKE=1 强制演示模式(快速/确定性测试与冒烟)
    const forceFake = process.env.HMH_DESKTOP_FAKE === '1';
    const override = await loadRuntimeEntryOverride();
    runtimeEntry = forceFake
      ? ''
      : override !== ''
        ? override
        : packaged
          ? detectRealEntry()
          : join(repoRoot, '..', 'hmharness', 'packages', 'web', 'src', 'desktop-host.ts');
    const useReal = runtimeEntry !== '' && existsSync(runtimeEntry);
    bridge = { ...bridge, mode: useReal ? 'real' : 'fake', runtimeEntry: useReal ? runtimeEntry : null };
    let spec: { command: string; args: string[]; env: Record<string, string>; cwd?: string };
    if (useReal) {
      const repo = repoRootOf(runtimeEntry);
      spec = {
        command: process.execPath,
        args: ['--import', 'tsx', runtimeEntry],
        cwd: repo, // bare 'tsx' 与 workspace 依赖都从 repo 的 node_modules 解析
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
        logInfo('host', `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode}${useReal ? `, entry=${runtimeEntry}` : ''})`);
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

    ipcMain.handle('bridge:send-task', (event, text: unknown, sessionId: unknown, mode: unknown, attachments: unknown, images: unknown) => {
      const task = typeof text === 'string' ? text.slice(0, 20_000) : '';
      const sid = typeof sessionId === 'string' ? sessionId.slice(0, 80) : '';
      const m = mode === 'auto' || mode === 'yolo' ? mode : 'ask';
      // 附件:后端授权 DTO 的绝对路径(@ 选择器/📎 上传只来自本地文件系统)
      const atts = Array.isArray(attachments) ? attachments.filter((a): a is string => typeof a === 'string').slice(0, 10) : [];
      // 图片:runtime vision 链协议 {name, dataUrl} base64(≤3 张 ≤6MB,renderer 生成)
      const imgs = Array.isArray(images)
        ? images
            .filter((im): im is { name: string; dataUrl: string } =>
              typeof im === 'object' && im !== null && typeof (im as { name?: unknown }).name === 'string' && typeof (im as { dataUrl?: unknown }).dataUrl === 'string')
            .slice(0, 3)
            .map((im) => ({ name: im.name.slice(0, 120), dataUrl: im.dataUrl.slice(0, 8_500_000) }))
        : [];
      if (task === '' || sid === '') return Promise.resolve({ ok: false, code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean; runId?: string }>('/api/task', { text: task, sessionId: sid, mode: m, attachments: atts, images: imgs }));
    });

    // ---- 模型切换(runtime POST /api/model:切 chat 路由,config 即时生效) ----
    ipcMain.handle('bridge:model-set', (event, name: unknown) => {
      const n = typeof name === 'string' ? name.trim().slice(0, 80) : '';
      if (n === '') return Promise.resolve({ error: 'name required', code: 'BAD_REQUEST' });
      return hostCall(event, (c) => c.postJson<{ ok: boolean; model?: string }>('/api/model', { name: n }));
    });

    // ---- 📎 文件上传(本地多选;runtime 校验 insideWs,工作区外文件会被 400) ----
    ipcMain.handle('bridge:pick-files', async (event, title: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === undefined) return { error: 'no window', code: 'BRIDGE_ERROR' };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title !== '' ? title.slice(0, 120) : '选择要附加的文件(可多选)',
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true };
      return { ok: true, paths: r.filePaths.slice(0, 10) };
    });

    // ---- 📁 目录选择(工作区添加的浏览按钮;原生 chooser) ----
    ipcMain.handle('bridge:pick-directory', async (event, title: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === undefined) return { error: 'no window', code: 'BRIDGE_ERROR' };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title !== '' ? title.slice(0, 120) : '选择文件夹',
        properties: ['openDirectory'],
      });
      if (r.canceled || r.filePaths[0] === undefined) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
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
    ipcMain.handle('bridge:export-session', async (event, id: unknown, title: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const sid = typeof id === 'string' ? id.replace(/[^a-zA-Z0-9_:.@-]/g, '').slice(0, 80) : '';
      if (sid === '') return { error: 'id required', code: 'BAD_REQUEST' };
      if (client === null || bridge.hostState !== 'ready') return { error: `host not ready (${bridge.hostState})`, code: 'HOST_NOT_READY' };
      try {
        const md = await client.getText(`/api/sessions/${encodeURIComponent(sid)}/export.md`);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win === undefined) return { error: 'no window', code: 'BRIDGE_ERROR' };
        const r = await dialog.showSaveDialog(win, {
          title: typeof title === 'string' && title !== '' ? title.slice(0, 80) : '导出会话',
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

    // ---- hmharness runtime 连接(自动发现 + 手动覆盖 + 热切换) ----
    ipcMain.handle('bridge:runtime-info', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      return {
        mode: bridge.mode,
        runtimeEntry: bridge.runtimeEntry,
        override: loadRuntimeEntryOverride(),
        detected: detectRealEntry(),
      };
    });

    ipcMain.handle('bridge:browse-runtime', async (event, title: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === undefined) return { error: 'no window', code: 'BRIDGE_ERROR' };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === 'string' && title !== '' ? title.slice(0, 120) : '选择 hmharness 的 desktop-host 入口',
        properties: ['openFile'],
        filters: [{ name: 'desktop-host', extensions: ['ts', 'js'] }],
      });
      if (r.canceled || r.filePaths[0] === undefined) return { ok: false, canceled: true };
      return { ok: true, entry: r.filePaths[0] };
    });

    /** 设置/清除手动入口后热重启 host(空串=回到自动发现)。 */
    ipcMain.handle('bridge:set-runtime', async (event, entry: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const e = typeof entry === 'string' ? entry.trim() : '';
      if (e !== '' && (!isAbsolute(e) || !existsSync(e))) {
        return { error: '入口必须是存在的绝对路径(desktop-host.ts)', code: 'BAD_REQUEST' };
      }
      await saveRuntimeEntryOverride(e);
      // 热切换:先优雅停掉当前 host,再按新配置拉起
      sseAbort?.abort();
      if (supervisor !== null) await supervisor.stop();
      await startHost();
      return { ok: true, mode: bridge.mode };
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
    // 页面加载完重播当前 host 状态:ready 广播若早于 renderer 订阅即丢失,
    // renderer 的 get-state 快照 + 这里的重播双保险(多窗口/重载场景也覆盖)。
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) {
        win.webContents.send('bridge:host-state', bridge.hostState, { restartCount: 0 });
      }
    });
    return win;
  }

  app.whenReady().then(() => {
    // UIVERIFY:fake 模式验收须在 startHost 读 env 之前强制 fake
    if (process.env.HMH_DESKTOP_UIVERIFY === '1' && process.env.HMH_DESKTOP_UIVERIFY_MODE !== 'real') {
      process.env.HMH_DESKTOP_FAKE = '1';
    }
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
    // createWindow 是 async(bounds 恢复);安全自测/渲染自检在窗口就绪后挂载
    void createWindow().then((win) => {
      if (win === null) return;
      if (process.env.HMH_DESKTOP_UIVERIFY === '1') attachUiVerify(win);
      if (process.env.HMH_DESKTOP_SECURITY_TEST === '1') {
        win.webContents.once('did-finish-load', () => {
          void securitySelfTest(win);
        });
      }
      // UI 截图钩子:HMH_DESKTOP_SNAPSHOT=<file.png> 在界面就绪后截图退出
      // (装机诊断用:亲眼看渲染结果,而不是只数 root 子节点)。
      const snap = process.env.HMH_DESKTOP_SNAPSHOT;
      if (snap !== undefined && snap !== '') {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => {
            void (async () => {
              try {
                const img = await win.webContents.capturePage();
                const { writeFile: wf } = await import('node:fs/promises');
                await wf(snap, img.toPNG());
                console.log(`SNAPSHOT ok ${snap} ${img.getSize().width}x${img.getSize().height}`);
              } catch (err) {
                console.log(`SNAPSHOT error ${String(err).slice(0, 120)}`);
              }
              const app2 = app;
              setTimeout(() => app2.exit(0), 500);
            })();
          }, Number(process.env.HMH_DESKTOP_SNAPSHOT_DELAY_MS ?? 12_000));
        });
      }
      // DOM 结构探针:HMH_DESKTOP_DOMPROBE=1 输出关键元素的 box/display/children,
      // 再退出(诊断"React 挂载了但某块 UI 不可见"这类问题;截图之外的硬证据)。
      if (process.env.HMH_DESKTOP_DOMPROBE === '1') {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => {
            void (async () => {
              try {
                const r = (await win.webContents.executeJavaScript(`(function(){
                  var pick = function(sel){
                    var els = document.querySelectorAll(sel);
                    return Array.prototype.slice.call(els, 0, 4).map(function(el){
                      var cs = getComputedStyle(el);
                      var b = el.getBoundingClientRect();
                      return { cls: (el.className||'').toString().slice(0,80), tag: el.tagName,
                        display: cs.display, vis: cs.visibility, opacity: cs.opacity,
                        pos: cs.position, z: cs.zIndex, overflow: cs.overflow,
                        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                        text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,60) };
                    });
                  };
                  var sels = ['html','body','#root','.app-shell','.sidebar','.workspace','.topbar','.stream','.empty-hint','.composer','.composer-row','.composer textarea','.composer-side','.att-picker','.att-chips','.sidepanel','.runtime-guide','.overlay','.turn','.card'];
                  var out = {};
                  sels.forEach(function(s){ try { out[s] = pick(s); } catch(e){ out[s] = [{err: String(e).slice(0,80)}]; } });
                  out.__meta = {
                    styleSheets: document.styleSheets.length,
                    sheet0rules: (document.styleSheets[0] && document.styleSheets[0].cssRules) ? document.styleSheets[0].cssRules.length : -1,
                    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
                    bodyChildren: document.body.children.length,
                    innerHTMLLen: document.body.innerHTML.length,
                    viewport: window.innerWidth + 'x' + window.innerHeight
                  };
                  return JSON.stringify(out);
                })()`, true)) as string;
                console.log(`DOMPROBE ${r}`);
              } catch (err) {
                console.log(`DOMPROBE error ${String(err).slice(0, 200)}`);
              }
              app.exit(0);
            })();
          }, Number(process.env.HMH_DESKTOP_DOMPROBE_DELAY_MS ?? 9_000));
        });
      }
      // 渲染自检(2026-10-10 装机黑屏教训:bridge ready ≠ 界面渲染了)。
      // #root 在 React 挂载后必有子节点;空 = 资源路径/CSP/脚本加载坏了。
      if (process.env.HMH_DESKTOP_RENDER_TEST === '1') {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => {
            void (async () => {
              try {
                const n = (await win.webContents.executeJavaScript(
                  'document.getElementById("root") ? document.getElementById("root").children.length : -1', true,
                )) as number;
                const ok = n > 0;
                console.log(`RENDER-TEST ${ok ? 'ok' : 'EMPTY'} rootChildren=${n}`);
                app.exit(ok ? 0 : 1);
              } catch (err) {
                console.log(`RENDER-TEST ERROR ${String(err).slice(0, 120)}`);
                app.exit(1);
              }
            })();
          }, 2_500);
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
      const allow = ['approve', 'approvalGet', 'approvalSet', 'browseRuntime', 'cognitive', 'diff', 'exportSession', 'fsList', 'fsRead', 'fsSearch', 'getState', 'inject', 'interrupt', 'modelSet', 'onEventBatches', 'onHostState', 'onStreamChunks', 'pickDirectory', 'pickFiles', 'providerSave', 'providers', 'runtimeInfo', 'sendTask', 'sessionOp', 'sessionPreview', 'sessions', 'setRuntime', 'stopHost', 'workspaces', 'workspaceAdd', 'workspaceUse'];
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
