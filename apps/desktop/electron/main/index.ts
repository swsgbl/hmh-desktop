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
import { app, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from 'electron';
import { join, dirname, basename, isAbsolute, resolve } from 'node:path';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { writeFile, readFile, stat, rename } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DesktopRuntimeSupervisor, DesktopHostClient, envelopeFromFrame, type HostState } from '@hmh-desktop/host-adapter';
import { isEventEnvelope, type EventEnvelope } from '@hmh-desktop/contracts';
import { attachUiVerify } from './uiverify.ts';
import { attachVisualRegression } from './visualregression.ts';
import { installTarget, resolveInstalledEntry, startCliInstall, type InstallProgress } from './installer.ts';
import { orderedCheckChannels, downloadCandidates, normalizeChannel, normalizeRelease, pickInstallerAsset, sizeMatches, summarizeCheckFailures, cmpVersion, type LatestRelease, type ReleaseAsset, type UpdateChannelId, type UpdateRepos } from './updater-channels.ts';

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
    notifyEvent(env);
  }

  /* ---- 系统托盘 + 通知(03 号 §一:桌面产品需要系统托盘、通知) ----
     审批等待必须打扰(用户必须决策);完成/失败仅在窗口失焦时提醒。 */
  const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAR0lEQVR4nGNgQAPSsor/8WF09URrxGsQqZoxDIEJ6Dd+B2N0hbjEMWwn1QCwIYPTAFyYfgYMfBiQZADFCYkqSZnizERJdgYAlL5rsDc2aTcAAAAASUVORK5CYII=';
  let tray: Tray | null = null;
  const sendMenuAction = (a: string): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('menu:action', a);
    }
  };
  function focusMainWindow(): void {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win === undefined) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function setupTray(): void {
    if (tray !== null) return;
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
    tray = new Tray(icon);
    tray.setToolTip('HMH Desktop');
    tray.on('click', focusMainWindow);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '新建会话', click: (): void => sendMenuAction('new-session') },
      { label: '显示主窗口', click: focusMainWindow },
      { label: '手机远程控制', click: (): void => sendMenuAction('open-remote') },
      { label: '设置', click: (): void => sendMenuAction('open-settings') },
      { type: 'separator' },
      { label: '退出', click: (): void => { app.quit(); } },
    ]));
  }
  function notifyEvent(env: EventEnvelope): void {
    // 验收/截图/渲染探针/视觉回归模式静默(不往用户桌面弹测试通知)
    if (process.env.HMH_DESKTOP_UIVERIFY === '1' || process.env.HMH_DESKTOP_SNAPSHOT !== undefined || process.env.HMH_DESKTOP_RENDER_TEST === '1' || process.env.HMH_DESKTOP_VISREG === '1') return;
    if (!Notification.isSupported()) return;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const focused = win?.isFocused() ?? false;
    const mk = (title: string, body: string): void => {
      const n = new Notification({ title, body, icon: nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`) });
      n.on('click', focusMainWindow);
      n.show();
    };
    if (env.kind === 'approval.required') {
      const p = env.payload as { tool?: string };
      mk('HMH 需要审批', `${String(p.tool ?? '操作')} 等待你的批准`);
    } else if (env.kind === 'run.completed' && !focused) {
      mk('HMH 任务完成', `会话 ${env.sessionId} 的任务已完成`);
    } else if (env.kind === 'run.failed' && !focused) {
      mk('HMH 任务失败', `会话 ${env.sessionId} 的任务失败,点击查看`);
    }
  }

  /* ---- 自定义标题栏(2026-10-11 用户反馈:亮色模式顶部黑条=原生菜单栏
     不跟主题;菜单与设置重复) ---- 方案:隐藏式标题栏 + titleBarOverlay
     (颜色随主题),菜单栏 autoHide(Alt 呼出)且精简为系统级能力;
     常用动作走 renderer 标题栏 ☰ 主菜单(唯一入口)。 */
  // v4 DSH 设计语言:overlay 色跟随 titlebar 的 bg-layer-1(浅 #fff/深 #16181d)
  const chromeFor = (dark: boolean): { color: string; symbolColor: string } =>
    dark ? { color: '#16181d', symbolColor: '#f5f6f8' } : { color: '#ffffff', symbolColor: '#0f1115' };
  function applyChrome(dark: boolean): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        try { w.setTitleBarOverlay(chromeFor(dark)); } catch { /* 仅 Windows 支持 */ }
      }
    }
  }

  /* ---- 应用内更新(2026-10-26:自研轻量更新器,零依赖;GitHub Releases 通道)
     流程:启动 30s 后静默检查 → fetch latest release tag → 比版本 → 后台流式
     下载 Setup exe 到临时目录(进度推送 renderer 横幅)→"重启更新"→ 退出应用
     后 NSIS /S /D=原目录 静默覆盖安装(下次启动即新版)——全程不跳浏览器。
     2026-10-29 双通道根修(用户国内收不到推送):检查通道镜像回退链
     (直连 8s → gh-proxy → ghfast)+ 命中通道粘性记忆 + 下载同源优先。
     同日任务 13-C:atomgit 国内首选通道(链第二位,国内直连匿名可读)+ 流式
     下载进度 + 下载 size 校验 + "重启更新"非模态横幅(renderer)。
     旋钮:UPDATE_REPO / UPDATE_REPO_ATOMGIT 覆盖双仓;HMH_DESKTOP_UPDATE_FORCE_TAG
     非空 → 无视版本比较强制走更新流程(验收用,不重打包)。 */
  const UPDATE_REPOS: UpdateRepos = {
    github: process.env.UPDATE_REPO ?? 'swsgbl/hmh-desktop',
    atomgit: process.env.UPDATE_REPO_ATOMGIT ?? 'hongfu/hmh-desktop',
  };
  const UPDATE_FORCE_TAG = process.env.HMH_DESKTOP_UPDATE_FORCE_TAG ?? '';
  interface UpdateProgress { received: number; total: number; speedBps: number }
  interface UpdateState { checking: boolean; currentVersion: string; latest: string | null; notes: string; downloaded: boolean; error: string; channel: string; progress: UpdateProgress | null }
  let updateState: UpdateState = { checking: false, currentVersion: app.getVersion(), latest: null, notes: '', downloaded: false, error: '', channel: '', progress: null };
  let installerPath: string | null = null;
  const bumpUpdate = (patch: Partial<UpdateState>): void => {
    updateState = { ...updateState, ...patch };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:state', updateState);
    }
  };
  /** 通道粘性:上次成功命中的检查通道(userData/update-channel.json,与 runtime.json 同模式)。 */
  const updateChannelFile = (): string => join(app.getPath('userData'), 'update-channel.json');
  async function loadStickyChannel(): Promise<UpdateChannelId | null> {
    try {
      const v = JSON.parse(await readFile(updateChannelFile(), 'utf8')) as { channel?: unknown };
      return normalizeChannel(v.channel);
    } catch { return null; }
  }
  async function saveStickyChannel(id: UpdateChannelId): Promise<void> {
    await writeFile(updateChannelFile(), JSON.stringify({ channel: id }, null, 2), 'utf8').catch(() => undefined);
  }
  async function checkForUpdates(): Promise<UpdateState> {
    if (updateState.checking || updateState.downloaded) return updateState;
    bumpUpdate({ checking: true, error: '' });
    logInfo('update', `checking… (current v${app.getVersion()})${UPDATE_FORCE_TAG !== '' ? ` force-tag=${UPDATE_FORCE_TAG}` : ''}`);
    const failures: Array<{ label: string; reason: string }> = [];
    try {
      const sticky = await loadStickyChannel();
      const channels = orderedCheckChannels(sticky ?? undefined);
      for (const ch of channels) {
        let rel: LatestRelease | null = null;
        try {
          const r = await fetch(ch.apiUrl(UPDATE_REPOS), {
            headers: { 'user-agent': 'hmh-desktop-updater' },
            signal: AbortSignal.timeout(ch.timeoutMs),
          });
          if (!r.ok) { failures.push({ label: ch.label, reason: `HTTP ${r.status}` }); logInfo('update', `${ch.label} → HTTP ${r.status}`); continue; }
          // 镜像可能回 200 但内容非 JSON(HTML 错误页);GitHub 回对象、atomgit
          // 回数组——normalizeRelease 统一归一,形状不对按本通道失败回退
          rel = normalizeRelease(await r.json());
          if (rel === null) { failures.push({ label: ch.label, reason: '响应无 tag_name' }); logInfo('update', `${ch.label} → 无 tag_name`); continue; }
        } catch (err) {
          const e = err as { cause?: { code?: unknown } };
          const reason = err instanceof Error && err.name === 'TimeoutError'
            ? `超时(${Math.round(ch.timeoutMs / 1000)}s)`
            : String(e.cause?.code ?? err).slice(0, 60);
          failures.push({ label: ch.label, reason });
          logInfo('update', `${ch.label} → fail ${reason}`);
          continue;
        }
        const tag = rel.tag_name;
        logInfo('update', `latest=${tag} assets=${(rel.assets ?? []).length} via ${ch.label}${sticky === ch.id ? '(sticky)' : ''}`);
        await saveStickyChannel(ch.id); // 粘性:下次先试本通道
        bumpUpdate({ checking: false, latest: tag, notes: String(rel.body ?? '').slice(0, 600), channel: ch.id });
        // 有新版(或 FORCE_TAG 验收旋钮)且未下载过 → 后台下载安装包
        if ((UPDATE_FORCE_TAG !== '' || cmpVersion(app.getVersion(), tag) < 0) && !updateState.downloaded) {
          void downloadInstaller(rel.assets ?? [], tag);
        }
        return updateState;
      }
      const summary = summarizeCheckFailures(failures);
      logInfo('update', `check failed: all channels (${summary})`);
      bumpUpdate({ checking: false, error: `全部检查通道失败(${summary})`.slice(0, 200) });
    } catch (err) {
      logInfo('update', `check failed: ${String(err).slice(0, 140)}`);
      bumpUpdate({ checking: false, error: String(err).slice(0, 120) });
    }
    return updateState;
  }
  /** 后台流式下载安装包:分块写盘(112MB 不再整驻内存),进度(已下载/总字节/
   *  速度)经 update:state 推 renderer 横幅;落盘后按资产元数据 size 校验。 */
  async function downloadInstaller(assets: readonly ReleaseAsset[], tag: string): Promise<void> {
    try {
      const asset = pickInstallerAsset(assets);
      if (asset === null) { bumpUpdate({ error: 'release 无安装包资产' }); return; }
      const dest = join(app.getPath('temp'), asset.name);
      // 上次会话已把同版本安装包完整下到临时目录(size 对得上)→ 直接复用,
      // 不再拉 112MB;这就是"用户忽略横幅继续用,下次启动仍一键可装"的落地。
      try {
        const st = await stat(dest);
        if (sizeMatches(asset.size, st.size)) {
          installerPath = dest;
          bumpUpdate({ downloaded: true, progress: null });
          logInfo('update', `复用已下载 ${asset.name}(${Math.round(st.size / 1e6)}MB) → ${dest}`);
          return;
        }
      } catch { /* 不存在则正常下载 */ }
      // 下载候选链:atomgit 命中 → atomgit 直链/API 端点优先,GitHub 主仓镜像兜底
      const candidates = downloadCandidates({ channel: updateState.channel, tag, assetUrl: asset.browser_download_url, assetName: asset.name, repos: UPDATE_REPOS });
      let lastErr = '';
      for (const u of candidates) {
        try {
          logInfo('update', `trying ${new URL(u).host}…`);
          const r = await fetch(u, { signal: AbortSignal.timeout(900_000) });
          if (!r.ok) { lastErr = `HTTP ${r.status}`; logInfo('update', `→ HTTP ${r.status}`); continue; }
          if (r.body === null) { lastErr = '无响应体'; continue; }
          const total = Number(r.headers.get('content-length') ?? 0) > 0 ? Number(r.headers.get('content-length')) : asset.size;
          const destTmp = `${dest}.part`;
          const out = createWriteStream(destTmp);
          let received = 0;
          let lastBump = 0;
          const t0 = Date.now();
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done === true || value === undefined) break;
            received += value.byteLength;
            out.write(value);
            // 进度节流:≤ 每 400ms 一帧,IPC 不洪泛;首块立即上报(总字节尽快可见)
            const now = Date.now();
            if (received === value.byteLength || now - lastBump > 400) {
              lastBump = now;
              bumpUpdate({ progress: { received, total, speedBps: Math.round(received / Math.max((now - t0) / 1000, 0.1)) } });
            }
          }
          await new Promise<void>((res, rej) => { out.end((err?: Error | null) => { if (err !== null && err !== undefined) rej(err); else res(); }); });
          if (received < 1_000_000) { lastErr = `内容异常(${received}B)`; logInfo('update', `→ ${lastErr}`); continue; }
          if (!sizeMatches(asset.size, received)) { lastErr = `size 不符(元数据 ${asset.size}B / 实收 ${received}B)`; logInfo('update', `→ ${lastErr}`); continue; }
          await rename(destTmp, dest);
          installerPath = dest;
          bumpUpdate({ downloaded: true, progress: null });
          logInfo('update', `已下载 ${asset.name}(${Math.round(received / 1e6)}MB) → ${dest}`);
          return;
        } catch (err) {
          const e = err as { cause?: { code?: unknown } };
          lastErr = String(e.cause?.code ?? err).slice(0, 80);
          logInfo('update', `→ fail ${lastErr}`);
          bumpUpdate({ progress: null });
        }
      }
      bumpUpdate({ error: `下载失败:全部下载通道失败(${lastErr})`.slice(0, 160), progress: null });
    } catch (err) {
      bumpUpdate({ error: `下载失败: ${String(err).slice(0, 120)}`, progress: null });
    }
  }
  function applyUpdate(): void {
    // 验收可观测:每次 apply 请求都留日志(mock/无安装包时点击"重启更新"
    // 不退出,UIVERIFY 断言"点击后进程存活"配合这行日志构成完整证据链)。
    logInfo('update', `apply requested (installer=${installerPath === null ? 'none' : basename(installerPath)})`);
    if (installerPath === null) return;
    // 退出当前应用后由安装器静默覆盖安装(装回原目录)。NSIS assisted 规则:
    // /S 且 /D=path 必须最后一个参数、值不加引号(含空格也不加)——node spawn
    // 默认会给含空格参数加引号导致 NSIS 解析错路径(实测装坏目录),故用
    // windowsVerbatimArguments 原样传递。
    const installDir = dirname(process.execPath);
    const child = spawn(`"${installerPath}" /S /D=${installDir}`, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    logInfo('update', `apply: ${installerPath} → ${installDir}`);
    app.exit(0);
  }

  function buildAppMenu(): void {
    // 精简:只保留 UI 没有的系统级能力(剪贴板/窗口);其余唯一入口在 UI。
    const template: Array<Electron.MenuItemConstructorOptions> = [
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { type: 'separator' },
          { role: 'close', label: '关闭' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
  /** 标题栏 ☰ 主菜单(常用动作的唯一入口;视图态经 menu:action 转发)。 */
  function popupMainMenu(): void {
    const send = (a: string): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('menu:action', a);
      }
    };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win === undefined) return;
    Menu.buildFromTemplate([
      { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: (): void => send('new-session') },
      { label: '设置', accelerator: 'CmdOrCtrl+Shift+P', click: (): void => send('open-settings') },
      { label: '快捷键', accelerator: 'CmdOrCtrl+/', click: (): void => send('shortcuts') },
      { type: 'separator' },
      { label: '手机远程控制', click: (): void => send('open-remote') },
      { type: 'separator' },
      {
        label: updateState.downloaded ? `重启并安装更新(v${updateState.latest ?? '?'})` : '检查更新…',
        click: (): void => {
          if (updateState.downloaded) { applyUpdate(); return; }
          void checkForUpdates().then((st) => {
            const newer = st.latest !== null && (cmpVersion(st.currentVersion, st.latest) < 0 || UPDATE_FORCE_TAG !== '');
            const detail = newer ? `${st.notes}\n\n安装包正在后台下载,完成后顶部横幅会出现"重启更新"一键安装(无需打开下载页)。` : '';
            void dialog.showMessageBox(win, {
              type: 'info',
              title: '检查更新',
              message: newer
                ? `发现新版本 v${st.latest}!`
                : (st.error !== '' ? `检查失败:${st.error}` : `已是最新版本(v${st.currentVersion})`),
              detail,
            });
          });
        },
      },
      {
        label: '关于 HMH Desktop',
        click: (): void => {
          void dialog.showMessageBox(win, {
            type: 'info',
            title: '关于 HMH Desktop',
            message: 'HMH Desktop',
            detail: `app v${app.getVersion()} · 更新通道:${updateState.channel || '-'}\nruntime: hmharness ${bridge.hostVersion ?? '(未连接)'}${useBundledRuntime ? '(内置)' : ''}\n模式: ${bridge.mode === 'real' ? (useBundledRuntime ? '真实 hmharness(内置 runtime)' : '真实 hmharness(外部安装)') : '演示(假数据)'}\n\n与 CLI / TUI / 网页版共享同一 HMH_HOME。`,
          });
        },
      },
      { label: '退出', role: 'quit' },
    ]).popup({ window: win });
  }

  /* ---- 手机远程控制(03 号:Web 7788 是浏览器/远程/手机入口,ADR-005:
     Desktop 不默认打开 LAN —— 这里是用户显式启动的入口) ---- */
  const WEB_PORT = 7788;
  async function probeWebRemote(): Promise<{ up: boolean; version: string }> {
    try {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return { up: false, version: '' };
      const d = (await r.json()) as { daemonVersion?: string };
      return { up: true, version: String(d.daemonVersion ?? '') };
    } catch { return { up: false, version: '' }; }
  }
  /** 开机自启是否已装(runtime web-daemon 的启动项文件存在性;0.23.37 新能力)。 */
  function webAutostartInstalled(): boolean {
    const home = process.env.HOME ?? '';
    const candidates = process.platform === 'win32'
      ? [join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'hmharness-web-daemon.cmd')]
      : process.platform === 'darwin'
        ? [join(home, 'Library', 'LaunchAgents', 'hmharness-web-daemon.plist')]
        : [join(home, '.config', 'systemd', 'user', 'hmharness-web-daemon.service')];
    return candidates.some((p) => { try { return existsSync(p); } catch { return false; } });
  }
  /** 手机可路由的 LAN IP(RFC1918,排除虚拟网卡)。 */
  function lanIpOf(): string {
    const VIRTUAL = /vmware|virtual|hyper-?v|vethernet|wsl|tailscale|loopback|bluetooth|vbox|docker|tap-|pseudo/i;
    const isRfc1918 = (a: string): boolean => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
    let lanIp = '';
    let fallback = '';
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const n of list ?? []) {
        if (n.family !== 'IPv4' || n.internal || !isRfc1918(n.address)) continue;
        if (!VIRTUAL.test(name)) lanIp = lanIp || n.address;
        else fallback = fallback || n.address;
      }
    }
    return lanIp || fallback;
  }
  /** CLI 入口:源码 repo 布局(main.ts,经 tsx)或 npm 安装布局(dist/main.js
   *  直跑——从 runtime 入口上溯找 @hmharness/cli 包;嵌套/提升/源码三种布局通吃)。 */
  function cliEntryOf(): string {
    if (runtimeEntry === '' || runtimeEntry === null) return '';
    try {
      const p = join(repoRootOf(runtimeEntry), 'packages', 'cli', 'src', 'main.ts');
      if (existsSync(p)) return p;
    } catch { /* 非 repo 布局 */ }
    let dir = dirname(runtimeEntry);
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'dist', 'main.js')) && pkgNameAt(dir) === '@hmharness/cli') return join(dir, 'dist', 'main.js');
      if (basename(dir) === '@hmharness' && existsSync(join(dir, 'cli', 'dist', 'main.js'))) return join(dir, 'cli', 'dist', 'main.js');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return '';
  }
  function runCli(args: string[]): void {
    const entry = cliEntryOf();
    if (entry === '') return;
    const isTs = entry.endsWith('.ts');
    const repo = repoRootOf(runtimeEntry ?? entry);
    const child = spawn(process.execPath, isTs ? ['--import', 'tsx', entry, ...args] : [entry, ...args], {
      cwd: isTs ? repo : dirname(entry),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
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
     会话历史天然共享)。v5.1 发现顺序:显式配置 > where hmh(源码 link 与
     @hmharness/cli npm 安装两种布局)> npm 全局根(同)> 向导安装目录
     ~/.hmharness-global > 常见源码位置。 */
  const runtimeConfigFile = (): string => join(app.getPath('userData'), 'runtime.json');
  /** runtime.json:{ entry(手动/向导选择的入口), demo(持久演示模式) }。 */
  async function loadRuntimeConfig(): Promise<{ entry: string; demo: boolean }> {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), 'utf8')) as { entry?: unknown; demo?: unknown };
      return {
        entry: typeof v.entry === 'string' && v.entry !== '' && isAbsolute(v.entry) ? v.entry : '',
        demo: v.demo === true,
      };
    } catch { return { entry: '', demo: false }; }
  }
  async function saveRuntimeConfig(cfg: { entry: string; demo: boolean }): Promise<void> {
    await writeFile(runtimeConfigFile(), JSON.stringify(cfg, null, 2), 'utf8').catch(() => undefined);
  }
  async function loadRuntimeEntryOverride(): Promise<string> {
    return (await loadRuntimeConfig()).entry;
  }
  async function saveRuntimeEntryOverride(entry: string): Promise<void> {
    await saveRuntimeConfig({ entry, demo: (await loadRuntimeConfig()).demo });
  }

  interface ExternalRuntime { entry: string; version: string; source: string }

  /** 读包版本(package.json 的 version 字段;失败空串)。 */
  function pkgVersionAt(dir: string): string {
    try {
      const v = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown };
      return typeof v.version === 'string' ? v.version : '';
    } catch { return ''; }
  }
  /** 读包名(同上;@hmharness/cli 布局识别用)。 */
  function pkgNameAt(dir: string): string {
    try {
      const v = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      return typeof v.name === 'string' ? v.name : '';
    } catch { return ''; }
  }

  /** npm 安装的 @hmharness/cli → desktop-host 编译入口(嵌套与提升两种布局)。 */
  function entryFromCliDir(cliDir: string): string {
    const nested = join(cliDir, 'node_modules', '@hmharness', 'web', 'dist', 'desktop-host.js');
    if (existsSync(nested)) return nested;
    const hoisted = join(dirname(cliDir), 'web', 'dist', 'desktop-host.js');
    if (existsSync(hoisted)) return hoisted;
    return '';
  }

  /** 外部发现(供自动连接与向导检测页共用)。优先级:env > where hmh > npm
   *  全局根 > 向导安装目录 ~/.hmharness-global > 源码仓扫描;同一层内
   *  "已装 CLI(npm 布局)" 先于 "源码 repo 布局"。 */
  function detectExternalRuntime(): ExternalRuntime {
    // 1) 环境变量显式覆盖(高级用户)
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== undefined && envEntry !== '' && isAbsolute(envEntry)) {
      return { entry: envEntry, version: '', source: 'env' };
    }

    const whereRepos = new Set<string>();
    const whereClis: string[] = [];
    const npmRepos = new Set<string>();
    let npmCli = '';
    // 2) where hmh:npm link(源码根布局)与 @hmharness/cli npm 安装布局
    try {
      const out = execFileSync('where', ['hmh'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === '') continue;
        try {
          const binDir = dirname(bin);
          const linked = join(binDir, 'node_modules', 'hmharness');
          if (existsSync(linked)) whereRepos.add(realpathSync(linked));
          const cli = join(binDir, 'node_modules', '@hmharness', 'cli');
          if (existsSync(cli)) whereClis.push(cli);
        } catch { /* bin 布局不符,跳过 */ }
      }
    } catch { /* hmh 不在 PATH */ }
    // 3) npm 全局根(两种布局同 where)
    try {
      const out = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 6_000, windowsHide: true });
      const root = out.trim();
      const linked = join(root, 'hmharness');
      if (existsSync(linked)) npmRepos.add(realpathSync(linked));
      const cli = join(root, '@hmharness', 'cli');
      if (existsSync(cli)) npmCli = cli;
    } catch { /* npm 不可用 */ }

    // 已装 CLI(@hmharness/cli npm 布局;desktop-host 为编译产物可直跑):
    // where(PATH 真相)> npm 全局根 > 向导安装目录
    for (const [cli, source] of [[whereClis[0] ?? '', 'where-hmh'], [npmCli, 'npm-global']] as Array<[string, string]>) {
      if (cli === '') continue;
      const entry = entryFromCliDir(cli);
      if (entry !== '') return { entry, version: pkgVersionAt(cli), source };
    }
    const wizardEntry = resolveInstalledEntry(installTarget());
    if (wizardEntry !== '') {
      return { entry: wizardEntry, version: pkgVersionAt(join(installTarget(), 'node_modules', '@hmharness', 'cli')), source: 'wizard-install' };
    }

    // 源码 repo 布局(where > npm 全局 > 常见源码位置;命中须有入口与依赖)
    const repos = new Set<string>([...whereRepos, ...npmRepos]);
    const bases = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\', homedir(), join(homedir(), 'Developer')];
    for (const base of bases) {
      try {
        const p = resolve(base, 'hmharness');
        if (existsSync(p)) repos.add(p);
      } catch { /* 盘不存在 */ }
    }
    for (const repo of repos) {
      const entry = join(repo, 'packages', 'web', 'src', 'desktop-host.ts');
      if (existsSync(entry) && existsSync(join(repo, 'node_modules'))) {
        return { entry, version: pkgVersionAt(repo), source: 'source-repo' };
      }
    }
    return { entry: '', version: '', source: '' };
  }

  function detectRealEntry(): string {
    return detectExternalRuntime().entry;
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
  let useBundledRuntime = false; // v5:是否在用内置 runtime(关于/面板标注)

  /** 内置 runtime(v5 开箱即用):打包后随 extraResources 平铺在 resources/;
     dev 用仓库内构建产物(scripts/bundle-runtime.mjs)。自包含单文件,无 tsx、
     无 repo node_modules 依赖。 */
  function bundledRuntimePath(repoRoot: string): string {
    return join(app.isPackaged ? process.resourcesPath : join(repoRoot, 'apps', 'desktop', 'resources'), 'runtime', 'runtime.cjs');
  }

  /** 内置 runtime 元信息(向导"内置精简内核"选项的版本标注)。 */
  function bundledRuntimeInfo(): { ready: boolean; version: string } {
    const repoRoot = join(here, '..', '..', '..', '..');
    const p = bundledRuntimePath(repoRoot);
    let version = '';
    try {
      const v = JSON.parse(readFileSync(join(dirname(p), 'package.json'), 'utf8')) as { version?: unknown };
      version = typeof v.version === 'string' ? v.version : '';
    } catch { /* 元数据缺失则只报 ready */ }
    return { ready: existsSync(p), version };
  }

  /** npm 是否在 PATH(向导选择页 ① 的安装方式标注;where 快探,不做完整探测)。 */
  function npmOnPath(): boolean {
    try {
      execFileSync('where', ['npm'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
      return true;
    } catch { return false; }
  }

  /* ---- 首启安装向导状态(v5.1) ---- */
  const wizardFile = (): string => join(app.getPath('userData'), 'wizard.json');
  async function loadWizardState(): Promise<{ done: boolean; choice: string }> {
    try {
      const v = JSON.parse(await readFile(wizardFile(), 'utf8')) as { done?: unknown; choice?: unknown };
      return { done: v.done === true, choice: typeof v.choice === 'string' ? v.choice : '' };
    } catch { return { done: false, choice: '' }; }
  }
  async function saveWizardState(choice: string): Promise<void> {
    await writeFile(wizardFile(), JSON.stringify({ done: true, choice }, null, 2), 'utf8').catch(() => undefined);
  }
  /** 向导自动弹出抑制:测试/开发环境不弹(UIVERIFY/SNAPSHOT/RENDER_TEST/
   *  DOMPROBE/SECURITY_TEST/FAKE/dev);HMH_DESKTOP_WIZARD_FORCE=1 强制弹(验收)。 */
  function wizardSuppressed(): boolean {
    if (process.env.HMH_DESKTOP_WIZARD_FORCE === '1') return false;
    return isDev
      || process.env.HMH_DESKTOP_UIVERIFY === '1'
      || process.env.HMH_DESKTOP_SNAPSHOT !== undefined
      || process.env.HMH_DESKTOP_VISREG === '1'
      || process.env.HMH_DESKTOP_RENDER_TEST === '1'
      || process.env.HMH_DESKTOP_DOMPROBE === '1'
      || process.env.HMH_DESKTOP_SECURITY_TEST === '1'
      || process.env.HMH_DESKTOP_FAKE === '1';
  }

  /** 发现顺序:显式覆盖(含向导选择:外部入口/内置路径/演示)> 内置开关
     (HMH_DESKTOP_BUNDLED=1)> 外部发现(dev 相邻仓库 / where hmh / npm 全局 /
     向导安装目录 / 源码位置)> 内置兜底。外部优先=老用户继续用自己装的版本;
     内置=新机器装完直连真实内核。HMH_DESKTOP_FAKE=1 或 runtime.json demo=true
     (向导"演示模式"选择,持久)进演示。 */
  async function startHost(): Promise<void> {
    const repoRoot = join(here, '..', '..', '..', '..'); // apps/desktop/dist-electron/main → repo root
    const packaged = app.isPackaged;
    const cfg = await loadRuntimeConfig();
    const forceFake = process.env.HMH_DESKTOP_FAKE === '1' || cfg.demo;
    const forceBundled = process.env.HMH_DESKTOP_BUNDLED === '1';
    const override = cfg.entry;
    const adjacent = join(repoRoot, '..', 'hmharness', 'packages', 'web', 'src', 'desktop-host.ts');
    const bundled = bundledRuntimePath(repoRoot);
    const bundledReady = existsSync(bundled);
    // 解析(结果归一:override=bundled 路径→内置;源码 .ts 需 tsx;
    // npm 安装 .js 编译产物直跑;bundled=自包含 cjs 直跑)
    let entry = '';
    useBundledRuntime = false;
    if (forceFake) {
      // 演示模式
    } else if (override !== '') {
      entry = override;
      if (override === bundled) useBundledRuntime = true; // 向导选"内置精简内核"的持久形态
    } else if (forceBundled) {
      if (bundledReady) { entry = bundled; useBundledRuntime = true; }
      else logInfo('host', 'HMH_DESKTOP_BUNDLED=1 但内置 runtime 缺失(先跑 scripts/bundle-runtime.mjs)');
    } else {
      entry = packaged ? detectRealEntry() : (existsSync(adjacent) ? adjacent : detectRealEntry());
      if (entry === '' && bundledReady) { entry = bundled; useBundledRuntime = true; }
    }
    runtimeEntry = entry;
    const useReal = entry !== '' && (useBundledRuntime || existsSync(entry));
    bridge = {
      ...bridge,
      mode: useReal ? 'real' : 'fake',
      runtimeEntry: useReal ? (useBundledRuntime ? `${entry} (bundled)` : entry) : null,
    };
    let spec: { command: string; args: string[]; env: Record<string, string>; cwd?: string };
    if (useBundledRuntime) {
      spec = {
        command: process.execPath,
        args: [entry], // 自包含单文件:electron-as-node 直跑,无 tsx 无 repo
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    } else if (useReal && entry.endsWith('.js')) {
      spec = {
        command: process.execPath,
        args: [entry], // npm 安装的编译产物:ESM 依赖按文件位置解析,直跑即可
        cwd: dirname(entry),
        env: { ELECTRON_RUN_AS_NODE: '1' },
      };
    } else if (useReal) {
      const repo = repoRootOf(entry);
      spec = {
        command: process.execPath,
        args: ['--import', 'tsx', entry],
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
        logInfo('host', `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode}${useReal ? `, entry=${runtimeEntry}${useBundledRuntime ? ' [bundled]' : ''}` : ''})`);
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

    // ---- 应用内更新(GitHub Releases;自研零依赖更新器) ----
    ipcMain.handle('bridge:check-update', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      return checkForUpdates();
    });
    ipcMain.handle('bridge:apply-update', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      if (installerPath === null) return { error: 'no installer downloaded', code: 'HOST_NOT_READY' };
      applyUpdate();
      return { ok: true };
    });

    // ---- 标题栏主题同步(浅色模式不再有黑条)+ ☰ 主菜单 ----
    ipcMain.handle('bridge:chrome-theme', (event, dark: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      applyChrome(dark === true);
      return { ok: true };
    });
    ipcMain.handle('bridge:popup-main-menu', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      popupMainMenu();
      return { ok: true };
    });

    // ---- 手机远程控制(7788 web 守护;用户显式启动,ADR-005 不默认开 LAN) ----
    ipcMain.handle('bridge:remote-web-status', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const p = await probeWebRemote();
      return { up: p.up, version: p.version, lanIp: lanIpOf(), port: WEB_PORT, available: cliEntryOf() !== '', autostart: webAutostartInstalled() };
    });
    // ---- 开机自启(0.23.37 web install-daemon/uninstall-daemon;登录即守护在线) ----
    ipcMain.handle('bridge:remote-web-autostart', async (event, enabled: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      if (cliEntryOf() === '') return { error: 'no hmharness runtime detected', code: 'HOST_NOT_READY' };
      runCli(['web', enabled === true ? 'install-daemon' : 'uninstall-daemon']);
      // install-daemon 立即拉起守护:轮询确认;uninstall 即时生效
      if (enabled === true) {
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if ((await probeWebRemote()).up) return { ok: true, autostart: webAutostartInstalled() };
        }
        return { error: 'daemon did not come up within 25s', code: 'RUNTIME_CRASHED' };
      }
      return { ok: true, autostart: webAutostartInstalled() };
    });
    ipcMain.handle('bridge:remote-web-start', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      if (cliEntryOf() === '') return { error: 'no hmharness runtime detected', code: 'HOST_NOT_READY' };
      if ((await probeWebRemote()).up) {
        return { ok: true, already: true, lanUrl: `http://${lanIpOf() || '127.0.0.1'}:${WEB_PORT}` };
      }
      runCli(['web', 'start', '--exposure=lan']);
      // 守护进程冷启动(tsx 编译整套 CLI):轮询 25s
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await probeWebRemote()).up) {
          return { ok: true, lanUrl: `http://${lanIpOf() || '127.0.0.1'}:${WEB_PORT}` };
        }
      }
      return { error: 'web daemon did not come up within 25s (see HMH_HOME/web.log)', code: 'RUNTIME_CRASHED' };
    });
    ipcMain.handle('bridge:remote-web-stop', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      runCli(['web', 'stop']);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!(await probeWebRemote()).up) return { ok: true };
      }
      const still = (await probeWebRemote()).up;
      return still ? { error: 'still running', code: 'BRIDGE_ERROR' } : { ok: true };
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
    ipcMain.handle('bridge:runtime-info', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const d = detectExternalRuntime();
      const cfg = await loadRuntimeConfig();
      return {
        mode: bridge.mode,
        runtimeEntry: bridge.runtimeEntry,
        override: cfg.entry,
        demo: cfg.demo,
        detected: d.entry,
        detectedVersion: d.version,
        detectedSource: d.source,
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

    // ---- v5.1 首启安装向导:本机检测 / 下载安装(进度事件) / 向导状态 ----
    ipcMain.handle('bridge:detect-runtime', (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const info = bundledRuntimeInfo();
      // UIVERIFY 向导步的"伪造未配置态":fake 模式下恒报未检测
      // (真实检测路径由 real 变体验收,见 evidence/setup-wizard/)。
      // UIVERIFY_FAKE_DETECT_FOUND=1(uiverify 窄屏场景运行中动态置位):
      // 伪造"检测到已装",让向导出现检测页三选项 → 单击前进 → 选择页。
      if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'fake' && process.env.HMH_DESKTOP_FAKE === '1') {
        if (process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND === '1') {
          return { found: true, version: '0.0.0-verify', entry: 'verify://fake-entry', source: 'verify', bundled: info, npm: npmOnPath() };
        }
        return { found: false, version: '', entry: '', source: '', bundled: info, npm: npmOnPath() };
      }
      const d = detectExternalRuntime();
      return { found: d.entry !== '', version: d.version, entry: d.entry, source: d.source, bundled: info, npm: npmOnPath() };
    });

    ipcMain.handle('bridge:install-cli', (event, opts: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const o = (opts ?? {}) as { forceTgz?: unknown; mirrorFirst?: unknown };
      // UIVERIFY fake 向导:自动安装路径走模拟进度(不碰磁盘/网络/不热切换),
      // 且不发 done——验收要在安装页点"改用内置"切换链接。
      if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'fake' && process.env.HMH_DESKTOP_FAKE === '1') {
        const sendSim = (p: InstallProgress): void => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send('install:progress', p);
          }
        };
        void (async () => {
          sendSim({ phase: 'check', text: '检查 npm…(verify 模拟)' });
          await new Promise((r) => setTimeout(r, 400));
          sendSim({ phase: 'npm', text: 'npm install @hmharness/cli → ~/.hmharness-global(verify 模拟,不落盘)' });
        })();
        return { ok: true, test: true };
      }
      return startCliInstall(
        {
          sendProgress: (p: InstallProgress): void => {
            logInfo('install', `${p.phase}${p.pct !== undefined ? ` ${p.pct}%` : ''} ${p.text}`);
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send('install:progress', p);
            }
          },
          log: (m: string): void => { logInfo('install', m); },
          // 安装成功即持久化并热切换(向导随后收尾;中途取消也已生效)
          onInstalled: (entry: string): void => {
            void (async () => {
              await saveRuntimeConfig({ entry, demo: false });
              sseAbort?.abort();
              if (supervisor !== null) await supervisor.stop();
              await startHost();
            })();
          },
        },
        {
          forceTgz: o.forceTgz === true,
          mirrorFirst: o.mirrorFirst === 'npmmirror' ? 'npmmirror' : o.mirrorFirst === 'npmjs' ? 'npmjs' : undefined,
        },
      );
    });

    ipcMain.handle('bridge:get-wizard', async (event) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const variant = process.env.HMH_DESKTOP_UIVERIFY_WIZARD;
      if (variant !== undefined && variant !== '') {
        // 验收构造:强制向导可见且视为未配置(可重复跑);persisted=真实落盘
        // 状态(向导步断言"选择持久"用,不影响 UI 判定)
        const w = await loadWizardState();
        return { done: false, choice: '', suppressed: false, persisted: { done: w.done, choice: w.choice } };
      }
      const w = await loadWizardState();
      const cfg = await loadRuntimeConfig();
      // 已配置过 runtime(手动入口/向导选择/演示)视同已完成首启
      return { done: w.done || cfg.entry !== '' || cfg.demo, choice: w.choice, suppressed: wizardSuppressed() };
    });

    /** 向导收尾:持久化选择并应用(external/bundled→入口覆盖;demo→持久演示;
     *  install→入口已由安装器持久化,只记状态)。fake/测试环境只记状态。 */
    ipcMain.handle('bridge:wizard-complete', async (event, choice: unknown, entry: unknown) => {
      if (!senderTrusted(event.senderFrame)) return { error: 'untrusted sender', code: 'FORBIDDEN' };
      const c = choice === 'external' || choice === 'install' || choice === 'bundled' || choice === 'demo' ? choice : '';
      if (c === '') return { error: 'choice must be external|install|bundled|demo', code: 'BAD_REQUEST' };
      const e = typeof entry === 'string' ? entry : '';
      await saveWizardState(c);
      if (process.env.HMH_DESKTOP_FAKE === '1') return { ok: true, mode: bridge.mode, test: true };
      const repoRoot = join(here, '..', '..', '..', '..');
      if (c === 'external' || c === 'bundled') {
        const target = c === 'bundled' ? bundledRuntimePath(repoRoot) : e;
        if (target === '' || !isAbsolute(target) || !existsSync(target)) {
          return { error: 'runtime 入口不存在', code: 'BAD_REQUEST' };
        }
        await saveRuntimeConfig({ entry: target, demo: false });
      } else if (c === 'demo') {
        await saveRuntimeConfig({ entry: '', demo: true });
      }
      if (c !== 'install') {
        // install:安装器已在 onInstalled 持久化并热切换,这里不再重启
        sseAbort?.abort();
        if (supervisor !== null) await supervisor.stop();
        await startHost();
      }
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
      // HIG 阶段2(11-A):窄窗下限 560(04 号规格;原 960 使 ≤820px 抽屉断点不可达);
      // UIVERIFY 窄屏验收(11-B,wizard 360×640 全元素可达)需临时放宽到 320×360。
      minWidth: process.env.HMH_DESKTOP_UIVERIFY === '1' ? 320 : 560,
      minHeight: process.env.HMH_DESKTOP_UIVERIFY === '1' ? 360 : 600,
      show: false,
      backgroundColor: '#f9fafb', // v4 DSH:浅色默认(bg-base),避免深色闪屏
      title: 'HMH Desktop',
      // 隐藏式标题栏:原生窗口控制(overlay 提供)+颜色随主题(renderer 经
      // chrome-theme 同步)——根治亮色模式顶部黑条;菜单栏 autoHide(Alt 呼出)。
      titleBarStyle: 'hidden',
      // HIG 阶段2:36→44,与 renderer .titlebar 高度一致(不一致会露出/遮住 8px)
      titleBarOverlay: { ...chromeFor(nativeTheme.shouldUseDarkColors), height: 44 },
      autoHideMenuBar: true,
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
    // UIVERIFY:fake 模式验收须在 startHost 读 env 之前强制 fake;VISREG(视觉回归)同规则
    if (process.env.HMH_DESKTOP_VISREG === '1' || (process.env.HMH_DESKTOP_UIVERIFY === '1' && process.env.HMH_DESKTOP_UIVERIFY_MODE !== 'real')) {
      process.env.HMH_DESKTOP_FAKE = '1';
    }
    // Windows 通知归属(否则显示为 electron.exe)
    app.setAppUserModelId('dev.hmh.desktop');
    setupTray();
    buildAppMenu();
    // 启动 30s 后静默检查更新(有新版仅后台下载,不打扰;失败静默,下次启动再试)。
    // dev 也检查:行为与打包版一致,且 FORCE_TAG 旋钮下 dev 即可全流程验收。
    setTimeout(() => { void checkForUpdates(); }, 30_000);
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
      // 视觉回归截图钩子:HMH_DESKTOP_VISREG=1,确定性视口截图后退出(scripts/visual-regression.mjs 驱动)
      if (process.env.HMH_DESKTOP_VISREG === '1') attachVisualRegression(win);
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
      const allow = ['applyUpdate', 'approve', 'approvalGet', 'approvalSet', 'browseRuntime', 'checkUpdate', 'chromeTheme', 'cognitive', 'detectRuntime', 'diff', 'exportSession', 'fsList', 'fsRead', 'fsSearch', 'getState', 'getWizard', 'inject', 'installCli', 'interrupt', 'modelSet', 'onEventBatches', 'onHostState', 'onInstallProgress', 'onMenuAction', 'onStreamChunks', 'onUpdateState', 'pickDirectory', 'pickFiles', 'popupMainMenu', 'providerSave', 'providers', 'remoteWebAutostart', 'remoteWebStart', 'remoteWebStatus', 'remoteWebStop', 'runtimeInfo', 'sendTask', 'sessionOp', 'sessionPreview', 'sessions', 'setRuntime', 'stopHost', 'wizardComplete', 'workspaces', 'workspaceAdd', 'workspaceUse'];
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
