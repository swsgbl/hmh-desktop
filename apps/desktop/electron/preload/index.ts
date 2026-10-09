/**
 * preload — 最小暴露的 typed bridge(ADR-004)。
 *
 * 只暴露白名单方法;不暴露 ipcRenderer 本体、Node API、electron 模块。
 * sandbox:true 下必须是 CJS(esbuild 打包为 cjs)。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { EventEnvelope } from '@hmh-desktop/contracts';

const bridge = {
  getState(): Promise<{
    hostState: string;
    hostPort: number | null;
    hostVersion: string | null;
    lastError: string | null;
    sessions: Array<{ id: string; title: string; createdAt: string }>;
    error?: string;
  }> {
    return ipcRenderer.invoke('bridge:get-state');
  },
  newSession(): Promise<{ id: string; error?: string }> {
    return ipcRenderer.invoke('bridge:new-session');
  },
  sendTask(text: string, sessionId: string): Promise<{ ok: boolean; runId?: string; code?: string }> {
    return ipcRenderer.invoke('bridge:send-task', text, sessionId);
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
export type HmhBridge = typeof bridge;
