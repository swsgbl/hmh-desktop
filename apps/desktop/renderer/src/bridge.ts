/** renderer 侧的 preload bridge 类型(与 electron/preload 的 HmhBridge 同形)。 */
import type { EventEnvelope } from '@hmh-desktop/contracts';

export interface BridgeState {
  hostState: string;
  hostPort: number | null;
  hostVersion: string | null;
  lastError: string | null;
  mode: 'fake' | 'real';
  runtimeEntry: string | null;
  droppedFrames: number;
  error?: string;
}

export interface RuntimeInfoDto {
  mode: 'fake' | 'real';
  runtimeEntry: string | null;
  override: string;
  demo?: boolean;
  detected: string;
  detectedVersion?: string;
  detectedSource?: string;
}

export interface DetectRuntimeDto {
  found: boolean;
  version: string;
  entry: string;
  source: string;
  bundled: { ready: boolean; version: string };
  npm: boolean;
}

export interface InstallProgressDto {
  phase: 'check' | 'meta' | 'download' | 'extract' | 'npm' | 'done' | 'error';
  pct?: number;
  text: string;
  mirror?: string;
  entry?: string;
  error?: string;
}

export interface WizardStateDto {
  done: boolean;
  choice: string;
  suppressed: boolean;
  /** 验收构造(UIVERIFY_WIZARD)下附带的真实落盘状态(持久化断言用)。 */
  persisted?: { done: boolean; choice: string };
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

export interface ProviderDetailDto {
  name: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyTail?: string;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  path: string;
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
  runtimeInfo(): Promise<RuntimeInfoDto | { error: string; code: string }>;
  detectRuntime(): Promise<DetectRuntimeDto | { error: string; code: string }>;
  installCli(opts?: { forceTgz?: boolean; mirrorFirst?: 'npmjs' | 'npmmirror' }): Promise<{ ok: boolean; error?: string } | { error: string; code: string }>;
  onInstallProgress(cb: (p: InstallProgressDto) => void): () => void;
  getWizard(): Promise<WizardStateDto | { error: string; code: string }>;
  wizardComplete(choice: 'external' | 'install' | 'bundled' | 'demo', entry?: string): Promise<{ ok: boolean; mode?: string; test?: boolean } | { error: string; code: string }>;
  browseRuntime(title?: string): Promise<{ ok: boolean; entry?: string; canceled?: boolean } | { error: string; code: string }>;
  setRuntime(entry: string): Promise<{ ok: boolean; mode?: string } | { error: string; code: string }>;
  sessions(): Promise<{ sessions: SessionRowDto[]; nextCursor: string | null } | { error: string; code: string }>;
  sendTask(text: string, sessionId: string, mode?: 'ask' | 'auto' | 'yolo', attachments?: string[], images?: Array<{ name: string; dataUrl: string }>): Promise<{ ok: boolean; runId?: string; code?: string } | { error: string; code: string }>;
  pickFiles(title?: string): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean } | { error: string; code: string }>;
  pickDirectory(title?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean } | { error: string; code: string }>;
  modelSet(name: string): Promise<{ ok: boolean; model?: string } | { error: string; code: string }>;
  remoteWebStatus(): Promise<{ up: boolean; version: string; lanIp: string; port: number; available: boolean; autostart: boolean } | { error: string; code: string }>;
  remoteWebStart(): Promise<{ ok: boolean; already?: boolean; lanUrl?: string } | { error: string; code: string }>;
  remoteWebStop(): Promise<{ ok: boolean } | { error: string; code: string }>;
  remoteWebAutostart(enabled: boolean): Promise<{ ok: boolean; autostart: boolean } | { error: string; code: string }>;
  onMenuAction(cb: (action: string) => void): () => void;
  chromeTheme(dark: boolean): Promise<{ ok: boolean } | { error: string; code: string }>;
  popupMainMenu(): Promise<{ ok: boolean } | { error: string; code: string }>;
  fsSearch(q: string): Promise<{ results: Array<{ rel: string; path: string }> } | { error: string; code: string }>;
  approve(granted: boolean, sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  interrupt(sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  inject(text: string, sessionId: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  exportSession(id: string, title?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean } | { error: string; code: string }>;
  approvalGet(): Promise<{ settings?: { approval?: string } } | { error: string; code: string }>;
  approvalSet(mode: 'ask' | 'auto'): Promise<{ ok: boolean } | { error: string; code: string }>;
  providers(): Promise<{ providersDetail?: ProviderDetailDto[]; model?: string; chatProvider?: string; busySessions?: string[] } | { error: string; code: string }>;
  providerSave(provider: { name: string; baseUrl: string; model: string; apiKey?: string }): Promise<{ ok: boolean } | { error: string; code: string }>;
  workspaces(): Promise<{ current: string; items: WorkspaceDto[] } | { error: string; code: string }>;
  workspaceUse(id: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  workspaceAdd(name: string, path: string): Promise<{ ok: boolean } | { error: string; code: string }>;
  sessionOp(id: string, op: 'archive' | 'delete'): Promise<{ ok: boolean } | { error: string; code: string }>;
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
