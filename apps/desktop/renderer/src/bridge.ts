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

export interface FsEntryDto {
  name: string;
  path: string;
  rel?: string;
}

export interface FsListDto {
  path: string;
  segments: FsEntryDto[];
  parent: string;
  dirs: FsEntryDto[];
  files?: FsEntryDto[];
}

export interface FsReadDto {
  path: string;
  rel: string;
  size: number;
  text?: string;
  binary?: boolean;
  truncated?: boolean;
}

export interface SessionPreviewDto {
  id: string;
  model: string;
  cwd: string;
  messages: Array<{ role: string; text: string; tools: string[] }>;
}

export interface DiffRowDto {
  state: string;
  path: string;
}

export interface DiffDto {
  git: boolean;
  cwd: string;
  changed: DiffRowDto[];
  stat: string;
}

export interface HmhBridge {
  getState(): Promise<BridgeState>;
  sessions(): Promise<{ sessions: SessionRowDto[]; nextCursor: string | null } | { error: string; code: string }>;
  sendTask(text: string, sessionId: string, mode?: 'ask' | 'auto' | 'yolo'): Promise<{ ok: boolean; runId?: string; code?: string } | { error: string; code: string }>;
  approve(granted: boolean, sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  interrupt(sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  fsList(path: string): Promise<FsListDto | { error: string; code: string }>;
  fsRead(path: string): Promise<FsReadDto | { error: string; code: string }>;
  cognitive(): Promise<Record<string, unknown> | { error: string; code: string }>;
  diff(sessionId: string): Promise<DiffDto | { error: string; code: string }>;
  sessionPreview(id: string): Promise<SessionPreviewDto | { error: string; code: string }>;
  stopHost(): Promise<{ ok: boolean }>;
  onEventBatches(cb: (batch: EventEnvelope[]) => void): () => void;
  onHostState(cb: (state: string, info: { restartCount: number; lastError?: string }) => void): () => void;
  onStreamChunks(cb: (chunk: { sessionId: string; kind: string; chunk: string }) => void): () => void;
}

declare global {
  interface Window {
    hmh: HmhBridge;
  }
}

export const bridge: HmhBridge | undefined = typeof window !== 'undefined' ? window.hmh : undefined;
