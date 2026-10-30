/**
 * preload — 最小暴露的 typed bridge(ADR-004)。
 *
 * 只暴露白名单方法;不暴露 ipcRenderer 本体、Node API、electron 模块。
 * sandbox:true 下必须是 CJS(esbuild 打包为 .cjs)。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { EventEnvelope } from '@hmh-desktop/contracts';

const bridge = {
  getState(): Promise<{
    hostState: string;
    hostPort: number | null;
    hostVersion: string | null;
    lastError: string | null;
    mode: 'fake' | 'real';
    runtimeEntry: string | null;
    droppedFrames: number;
    error?: string;
  }> {
    return ipcRenderer.invoke('bridge:get-state');
  },
  runtimeInfo(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:runtime-info');
  },
  /** v5.1 安装向导:本机 hmh CLI 检测(发现链复用)。 */
  detectRuntime(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:detect-runtime');
  },
  /** v5.1 安装向导:启动 @hmharness/cli 安装(进度经 onInstallProgress 回流)。 */
  installCli(opts?: { forceTgz?: boolean; mirrorFirst?: 'npmjs' | 'npmmirror' }): Promise<unknown> {
    return ipcRenderer.invoke('bridge:install-cli', opts ?? {});
  },
  onInstallProgress(cb: (p: { phase: string; pct?: number; text: string; mirror?: string; entry?: string; error?: string }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, p: { phase: string; pct?: number; text: string; mirror?: string; entry?: string; error?: string }): void => cb(p);
    ipcRenderer.on('install:progress', listener);
    return () => ipcRenderer.removeListener('install:progress', listener);
  },
  /** v5.1 安装向导:首启状态(done/choice/suppressed)。 */
  getWizard(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:get-wizard');
  },
  /** v5.1 安装向导:完成收尾(选择持久 + runtime 应用)。 */
  wizardComplete(choice: 'external' | 'install' | 'bundled' | 'demo', entry?: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:wizard-complete', choice, entry ?? '');
  },
  browseRuntime(title?: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:browse-runtime', title);
  },
  setRuntime(entry: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:set-runtime', entry);
  },
  sessions(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:sessions');
  },
  sendTask(text: string, sessionId: string, mode?: 'ask' | 'auto' | 'yolo', attachments?: string[], images?: Array<{ name: string; dataUrl: string }>): Promise<unknown> {
    return ipcRenderer.invoke('bridge:send-task', text, sessionId, mode ?? 'ask', attachments ?? [], images ?? []);
  },
  pickFiles(title?: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:pick-files', title);
  },
  pickDirectory(title?: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:pick-directory', title);
  },
  modelSet(name: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:model-set', name);
  },
  remoteWebStatus(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:remote-web-status');
  },
  remoteWebStart(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:remote-web-start');
  },
  remoteWebStop(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:remote-web-stop');
  },
  remoteWebAutostart(enabled: boolean): Promise<unknown> {
    return ipcRenderer.invoke('bridge:remote-web-autostart', enabled);
  },
  /** 应用菜单 → renderer 动作(主题/语言/侧栏/面板)。 */
  onMenuAction(cb: (action: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, action: string): void => cb(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
  chromeTheme(dark: boolean): Promise<unknown> {
    return ipcRenderer.invoke('bridge:chrome-theme', dark);
  },
  popupMainMenu(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:popup-main-menu');
  },
  checkUpdate(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:check-update');
  },
  applyUpdate(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:apply-update');
  },
  onUpdateState(cb: (st: { checking: boolean; currentVersion: string; latest: string | null; notes: string; downloaded: boolean; error: string; channel: string; progress: { received: number; total: number; speedBps: number } | null }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, st: unknown): void => cb(st as Parameters<typeof cb>[0]);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  fsSearch(q: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:fs-search', q);
  },
  approve(granted: boolean, sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:approve', granted, sessionId);
  },
  interrupt(sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:interrupt', sessionId);
  },
  inject(text: string, sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:inject', text, sessionId);
  },
  exportSession(id: string, title?: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:export-session', id, title);
  },
  approvalGet(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:approval-get');
  },
  approvalSet(mode: 'ask' | 'auto'): Promise<unknown> {
    return ipcRenderer.invoke('bridge:approval-set', mode);
  },
  providers(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:providers');
  },
  providerSave(provider: { name: string; baseUrl: string; model: string; apiKey?: string }): Promise<unknown> {
    return ipcRenderer.invoke('bridge:provider-save', provider);
  },
  workspaces(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:workspaces');
  },
  workspaceUse(id: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:workspace-use', id);
  },
  workspaceAdd(name: string, path: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:workspace-add', name, path);
  },
  sessionOp(id: string, op: 'archive' | 'delete'): Promise<unknown> {
    return ipcRenderer.invoke('bridge:session-op', id, op);
  },
  fsList(path: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:fs-list', path);
  },
  fsRead(path: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:fs-read', path);
  },
  cognitive(): Promise<unknown> {
    return ipcRenderer.invoke('bridge:cognitive');
  },
  diff(sessionId: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:diff', sessionId);
  },
  sessionPreview(id: string): Promise<unknown> {
    return ipcRenderer.invoke('bridge:session-preview', id);
  },
  /** 订阅高频流块(delta/line 原帧;renderer 拼接当前 assistant 占位)。 */
  onStreamChunks(cb: (chunk: { sessionId: string; kind: string; chunk: string }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: { sessionId: string; kind: string; chunk: string }): void => cb(payload);
    ipcRenderer.on('bridge:stream-chunk', listener);
    return () => ipcRenderer.removeListener('bridge:stream-chunk', listener);
  },
  stopHost(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('bridge:stop-host');
  },
  /** 订阅事件批(50ms 批量)。返回取消函数。 */
  onEventBatches(cb: (batch: EventEnvelope[]) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, batch: EventEnvelope[]): void => cb(batch);
    ipcRenderer.on('bridge:event-batch', listener);
    return () => ipcRenderer.removeListener('bridge:event-batch', listener);
  },
  onHostState(cb: (state: string, info: { restartCount: number; lastError?: string }) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, state: string, info: { restartCount: number; lastError?: string }): void => cb(state, info);
    ipcRenderer.on('bridge:host-state', listener);
    return () => ipcRenderer.removeListener('bridge:host-state', listener);
  },
  /** v0.3 仓库面板:双平台安装/登录态(gh/ag 后端;登录态只读,令牌不入应用)。 */
  forgeStatus(): Promise<unknown> {
    return ipcRenderer.invoke('forge:status');
  },
  /** 登录 = spawn 官方 CLI 的浏览器 OAuth;行输出经 onForgeLoginOutput 回流展示。 */
  forgeLogin(host: 'github' | 'atomgit'): Promise<unknown> {
    return ipcRenderer.invoke('forge:login', host);
  },
  forgeRepos(host: 'github' | 'atomgit', page?: number): Promise<unknown> {
    return ipcRenderer.invoke('forge:repos', host, page ?? 1);
  },
  forgePrs(host: 'github' | 'atomgit', repo: string, state?: string): Promise<unknown> {
    return ipcRenderer.invoke('forge:prs', host, repo, state ?? 'open');
  },
  forgeIssues(host: 'github' | 'atomgit', repo: string, state?: string): Promise<unknown> {
    return ipcRenderer.invoke('forge:issues', host, repo, state ?? 'open');
  },
  forgeReleases(host: 'github' | 'atomgit', repo: string): Promise<unknown> {
    return ipcRenderer.invoke('forge:releases', host, repo);
  },
  /** 写操作(pr/issue/release/克隆);面板确认卡之后才可到达此处。 */
  forgeAction(kind: string, host: 'github' | 'atomgit', args: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('forge:action', kind, host, args);
  },
  /** 逃生口:域名白名单内才外开系统浏览器(renderer 禁 window.open)。 */
  forgeOpen(url: string): Promise<unknown> {
    return ipcRenderer.invoke('forge:open', url);
  },
  /** 工作区路径 → 平台仓库(/repo 面板的上下文源)。 */
  forgeResolve(path: string): Promise<unknown> {
    return ipcRenderer.invoke('forge:resolve', path);
  },
  onForgeLoginOutput(cb: (host: string, line: string) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, host: string, line: string): void => cb(host, line);
    ipcRenderer.on('forge:login-line', listener);
    return () => ipcRenderer.removeListener('forge:login-line', listener);
  },
};

contextBridge.exposeInMainWorld('hmh', bridge);
