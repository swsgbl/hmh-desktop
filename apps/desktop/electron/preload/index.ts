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
  onUpdateState(cb: (st: { checking: boolean; currentVersion: string; latest: string | null; notes: string; downloaded: boolean; error: string }) => void): () => void {
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
};

contextBridge.exposeInMainWorld('hmh', bridge);
