/** renderer 侧的 preload bridge 类型(与 electron/preload 的 HmhBridge 同形)。 */
import type { EventEnvelope } from '@hmh-desktop/contracts';

export interface BridgeState {
  hostState: string;
  hostPort: number | null;
  hostVersion: string | null;
  lastError: string | null;
  sessions: Array<{ id: string; title: string; createdAt: string }>;
  error?: string;
}

export interface HmhBridge {
  getState(): Promise<BridgeState>;
  newSession(): Promise<{ id: string; error?: string }>;
  sendTask(text: string, sessionId: string): Promise<{ ok: boolean; runId?: string; code?: string }>;
  stopHost(): Promise<{ ok: boolean }>;
  onEventBatches(cb: (batch: EventEnvelope[]) => void): () => void;
  onHostState(cb: (state: string, info: { restartCount: number; lastError?: string }) => void): () => void;
}

declare global {
  interface Window {
    hmh: HmhBridge;
  }
}

export const bridge: HmhBridge | undefined = typeof window !== 'undefined' ? window.hmh : undefined;
