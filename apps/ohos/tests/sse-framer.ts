/**
 * 纯逻辑:SSE 分帧器(与 entry/ets/net/SseClient.ets 中分帧核心同构)
 * 契约:帧 = 行序列 id/event/data,帧间空行(\n\n);CRLF 归一为 \n
 * node:test 单测,与 ArkUI 零依赖。
 */

export interface SseFrame {
  id: string
  event: string
  data: string
}

/** 分帧器:喂任意切割的字节块,吐完整帧。残包缓存在内部 buffer。 */
export class SseFramer {
  private buf: string = ''
  frames: SseFrame[] = []

  /** 喂一块文本(可能含半帧),返回本次新吐出的帧 */
  push(chunk: string): SseFrame[] {
    this.buf += chunk.replace(/\r\n/g, '\n')
    const out: SseFrame[] = []
    // 帧分隔:空行。兼容 \n\n 与行间多空行
    for (;;) {
      const idx = this.buf.indexOf('\n\n')
      if (idx < 0) break
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      const f = this.parseBlock(block)
      if (f) out.push(f)
    }
    this.frames = this.frames.concat(out)
    return out
  }

  /** 流结束:buffer 里若有残余非空块,也解析吐出 */
  flush(): SseFrame[] {
    const rest = this.buf
    this.buf = ''
    const f = this.parseBlock(rest)
    return f ? [f] : []
  }

  private parseBlock(block: string): SseFrame | null {
    let id = ''
    let event = ''
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      if (rawLine === '') continue
      if (rawLine.startsWith(':')) continue // SSE 注释行
      const colon = rawLine.indexOf(':')
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon)
      let value = colon < 0 ? '' : rawLine.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'id') id = value
      else if (field === 'event') event = value
      else if (field === 'data') dataLines.push(value)
    }
    if (dataLines.length === 0 && event === '') return null
    return { id, event, data: dataLines.join('\n') }
  }
}
