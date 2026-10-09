/** renderer 侧的 preload bridge 类型(与 electron/preload 的 HmhBridge 同形)。 */
import type { EventEnvelope } from '@hmh-desktop/contracts';

export interface BridgeState {
  hostState: string;
  hostPort: number | null;
  hostVersion: string | null;
  lastError: string | null;
  mode: 'fake' | 'real';
  droppedFrames: number;
  error?: string;
}

export interface SessionRowDto {
  id: string;
  title: string;
  task: string;
  outcome: string;
  turns: number;
  toolUses: number;
  time: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface HmhBridge {
  getState(): Promise<BridgeState>;
  sessions(): Promise<{ sessions: SessionRowDto[]; nextCursor: string | null } | { error: string; code: string }>;
  sendTask(text: string, sessionId: string, mode?: 'ask' | 'auto' | 'yolo'): Promise<{ ok: boolean; runId?: string; code?: string } | { error: string; code: string }>;
  approve(granted: boolean, sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  interrupt(sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
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
