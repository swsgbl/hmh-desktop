/**
 * baseUrl 规范化(纯逻辑,与 ArkTS 同构)
 * 背景:某些中文 IME 会把半角标点转全角(http://→http：××)且吞字母;
 * 数字可原样上屏。规范化:全角→半角 + 无 scheme 时补 http:// + 去尾空。
 */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim()
  // 全角→半角(ASCII 可打印区)
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCharCode(code - 0xFEE0)
    } else if (code === 0x3002) {
      out += '.'
    } else if (code === 0xFF1A) {
      out += ':'
    } else if (code === 0xFF0F) {
      out += '/'
    } else {
      out += ch
    }
  }
  s = out.trim()
  if (s === '') return ''
  if (!/^https?:\/\//.test(s)) {
    s = 'http://' + s
  }
  return s
}
