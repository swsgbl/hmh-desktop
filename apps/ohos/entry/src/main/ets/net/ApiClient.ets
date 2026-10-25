import { http } from '@kit.NetworkKit'

/**
 * hmharness runtime HTTP 客户端
 * - 全部请求带 x-hmh-key 头(token 只存在内存/preferences,绝不进日志与 URL)
 * - 结构化错误:网络失败/403 鉴权/其他状态码/JSON 解析失败
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly recoverable: boolean

  constructor(status: number, code: string, message: string, recoverable: boolean) {
    super(message)
    this.status = status
    this.code = code
    this.recoverable = recoverable
  }
}

export class ApiClient {
  private baseUrl: string
  private token: string

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl
    this.token = token
  }

  update(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl
    this.token = token
  }

  async getJson<T>(path: string): Promise<T> {
    return this.request<T>(http.RequestMethod.GET, path, null)
  }

  async postJson<T>(path: string, body: object | null): Promise<T> {
    return this.request<T>(http.RequestMethod.POST, path, body)
  }

  private async request<T>(method: http.RequestMethod, path: string, body: object | null): Promise<T> {
    let client: http.HttpRequest | null = null
    try {
      client = http.createHttp()
      const header: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
      if (this.token !== '') {
        header['x-hmh-key'] = this.token
      }
      const options: http.HttpRequestOptions = {
        method: method,
        header: header,
        connectTimeout: 8000,
        readTimeout: 15000,
        extraData: body === null ? undefined : JSON.stringify(body)
      }
      const resp = await client.request(this.baseUrl + path, options)
      if (resp.responseCode >= 400) {
        throw makeApiError(resp.responseCode, resp.result as string)
      }
      return JSON.parse(resp.result as string) as T
    } finally {
      if (client !== null) {
        client.destroy()
      }
    }
  }
}

function makeApiError(status: number, body: string): ApiError {
  let code = `http_${status}`
  let message = `HTTP ${status}`
  let recoverable = false
  try {
    const parsed = JSON.parse(body) as Record<string, Object>
    if (typeof parsed['error'] === 'string') {
      message = parsed['error'] as string
    }
    if (typeof parsed['code'] === 'string') {
      code = parsed['code'] as string
    }
    if (typeof parsed['recoverable'] === 'boolean') {
      recoverable = parsed['recoverable'] as boolean
    }
  } catch (e) {
    // 保留默认
  }
  return new ApiError(status, code, message, recoverable)
}

/** 网络层异常(BusinessError)→ ApiError 归一 */
export function toApiError(e: object): ApiError {
  const be = e as Record<string, Object>
  const msg = typeof be['message'] === 'string' ? be['message'] as string : 'network error'
  return new ApiError(0, 'network', msg, true)
}
