/**
 * baseUrl 规范化(ArkTS 侧,与 tests/url-norm.ts 同构)
 * 某些中文 IME 把半角标点转全角且吞字母;数字原样上屏。
 * 规范化:全角→半角 + 无 scheme 补 http://。
 */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim()
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xFF01 && code <= 0xFF5E) {
      out += String.fromCharCode(code - 0xFEE0)
    } else if (code === 0x3002) {
      out += '.'
    } else if (code === 0xFF1A) {
      out += ':'
    } else if (code === 0xFF0F) {
      out += '/'
    } else {
      out += s[i]
    }
  }
  s = out.trim()
  if (s === '') {
    return ''
  }
  if (!/^https?:\/\//.test(s)) {
    s = 'http://' + s
  }
  return s
}
