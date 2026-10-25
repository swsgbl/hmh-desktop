import { http } from '@kit.NetworkKit'
import util from '@ohos.util'

/**
 * SSE 客户端:@ohos.net.http 流式(dataReceive)+ 手写分帧 + Last-Event-ID 重连
 * 分帧逻辑与 tests/sse-framer.ts 同构
 */
export interface SseFrame {
  id: string
  event: string
  data: string
}

export interface SseHandlers {
  onFrame: (f: SseFrame) => void
  onError: (msg: string) => void
  onOpen: () => void
}

export class SseClient {
  private client: http.HttpRequest | null = null
  private buf: string = ''
  private lastEventId: string = ''
  private url: string
  private token: string
  private handlers: SseHandlers
  private closed: boolean = false
  private decoder: util.TextDecoder | null = null

  constructor(url: string, token: string, handlers: SseHandlers) {
    this.url = url
    this.token = token
    this.handlers = handlers
  }

  /** 启动订阅;内部自动带 Last-Event-ID(重放环) */
  start(): void {
    this.closed = false
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.client !== null) {
      this.client.destroy()
      this.client = null
    }
  }

  private connect(): void {
    if (this.closed) {
      return
    }
    const client = http.createHttp()
    this.client = client
    client.on('headersReceive', (header: object) => {
      this.handlers.onOpen()
    })
    client.on('dataReceive', (chunk: ArrayBuffer) => {
      if (this.decoder === null) {
        this.decoder = util.TextDecoder.create('utf-8')
      }
      const text = this.decoder.decodeWithStream(new Uint8Array(chunk), { stream: true })
      this.ingest(text)
    })
    client.on('dataEnd', () => {
      this.scheduleReconnect('stream end')
    })
    client.on('dataReceiveProgress', (p: http.DataReceiveProgressInfo) => {
    })

    const header: Record<string, string> = {
      'Accept': 'text/event-stream'
    }
    if (this.token !== '') {
      header['x-hmh-key'] = this.token
    }
    if (this.lastEventId !== '') {
      header['Last-Event-ID'] = this.lastEventId
    }
    const options: http.HttpRequestOptions = {
      method: http.RequestMethod.GET,
      header: header,
      connectTimeout: 8000,
      readTimeout: 0
    }
    client.requestInStream(this.url, options).then((code: number) => {
      if (code >= 400) {
        this.handlers.onError(`SSE HTTP ${code}`)
        this.close()
      }
    }).catch((e: object) => {
      this.scheduleReconnect('connect failed')
    })
  }

  /** 喂入文本块,分帧后回调(与 SseFramer.push 同构) */
  private ingest(chunk: string): void {
    this.buf += chunk.replace(/\r\n/g, '\n')
    for (;;) {
      const idx = this.buf.indexOf('\n\n')
      if (idx < 0) {
        break
      }
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      const f = this.parseBlock(block)
      if (f !== null) {
        if (f.id !== '') {
          this.lastEventId = f.id
        }
        this.handlers.onFrame(f)
      }
    }
  }

  private parseBlock(block: string): SseFrame | null {
    let id = ''
    let event = ''
    let hasData = false
    const dataLines: string[] = []
    const lines = block.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i]
      if (rawLine === '' || rawLine.startsWith(':')) {
        continue
      }
      const colon = rawLine.indexOf(':')
      const field = colon < 0 ? rawLine : rawLine.slice(0, colon)
      let value = colon < 0 ? '' : rawLine.slice(colon + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
      if (field === 'id') {
        id = value
      } else if (field === 'event') {
        event = value
      } else if (field === 'data') {
        hasData = true
        dataLines.push(value)
      }
    }
    if (!hasData && event === '') {
      return null
    }
    return { id: id, event: event, data: dataLines.join('\n') } as SseFrame
  }

  private reconnectTimer: number = -1

  private scheduleReconnect(reason: string): void {
    if (this.closed) {
      return
    }
    if (this.client !== null) {
      this.client.destroy()
      this.client = null
    }
    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, 3000)
  }
}
