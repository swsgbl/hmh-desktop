/**
 * DesktopHostClient — 对 hmh host 的 HTTP+SSE 客户端。
 *
 * - 每个 HTTP 请求自动带 X-Hmh-Key(token 不进 URL);
 * - 结构化错误(res.body 里的 DesktopError 形状或 HTTP 状态)规约成异常抛出;
 * - SSE 用 fetch 流手写解析(id/event/data 帧),支持 Last-Event-ID 补拉重连。
 */
import { desktopError, isDesktopError, isEventEnvelope, type DesktopError, type EventEnvelope } from '@hmh-desktop/contracts';

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

/** 解析一段 SSE 文本为帧(不含跨 chunk 的缓冲逻辑,纯函数便于测试)。 */
export function parseSseChunk(chunk: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of chunk.split(/\n\n/)) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event = 'message';
    const dataLines: string[] = [];
    let sawField = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // 注释/心跳
      if (line.startsWith('id:')) { id = line.slice(3).trim(); sawField = true; }
      else if (line.startsWith('event:')) { event = line.slice(6).trim(); sawField = true; }
      else if (line.startsWith('data:')) { dataLines.push(line.slice(5).replace(/^ /, '')); sawField = true; }
    }
    if (!sawField) continue; // 纯注释/心跳块不产生帧
    frames.push({ ...(id !== undefined ? { id } : {}), event, data: dataLines.join('\n') });
  }
  return frames;
}

/** 从 SSE 帧数据中解出合法 EventEnvelope;不合法的返回 null(SCHEMA_MISMATCH 由调用方计数)。 */
export function envelopeFromFrame(frame: SseFrame): EventEnvelope | null {
  if (frame.event !== 'hmh') return null; // 我们的事件信封统一走 event: hmh
  try {
    const parsed: unknown = JSON.parse(frame.data);
    return isEventEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class DesktopHttpError extends Error {
  constructor(public readonly detail: DesktopError) {
    super(detail.message);
  }
}

export class DesktopHostClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-hmh-key': this.token, ...extra };
  }

  async getJson<T>(path: string, timeoutMs = 5_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DesktopHttpError(desktopError('HOST_NOT_READY', `request failed: ${String(err).slice(0, 160)}`, { retryable: true, recoveryAction: 'RECONNECT' }));
    }
    return this.parseResponse<T>(res);
  }

  async postJson<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DesktopHttpError(desktopError('HOST_NOT_READY', `request failed: ${String(err).slice(0, 160)}`, { retryable: true, recoveryAction: 'RECONNECT' }));
    }
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError('AUTH_FAILED', `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: 'RECONNECT' }));
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      if (isDesktopError(parsed)) throw new DesktopHttpError(parsed);
      throw new DesktopHttpError(desktopError('HOST_NOT_READY', `HTTP ${res.status}: ${text.slice(0, 160)}`, { retryable: res.status >= 500 }));
    }
    return parsed as T;
  }

  /**
   * 订阅 SSE 事件流(async iterator)。断线由调用方重连;重连时把最后
   * 收到的 eventId 传入 lastEventId,host 端从重放环补发。
   */
  async *events(lastEventId?: string, signal?: AbortSignal): AsyncGenerator<EventEnvelope> {
    const res = await fetch(`${this.baseUrl}/api/events`, {
      headers: this.headers({
        accept: 'text/event-stream',
        ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError('AUTH_FAILED', `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: 'RECONNECT' }));
    }
    if (!res.ok || !res.body) {
      throw new DesktopHttpError(desktopError('HOST_NOT_READY', `SSE HTTP ${res.status}`, { retryable: true, recoveryAction: 'RECONNECT' }));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // 以空行分帧;保留不完整的尾部
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const frame of parseSseChunk(block)) {
          const env = envelopeFromFrame(frame);
          if (env !== null) yield env;
        }
      }
    }
  }
}
