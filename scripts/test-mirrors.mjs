/** 测下载镜像可用性(HEAD/前 64KB)。 */
const url = 'https://github.com/swsgbl/hmh-desktop/releases/download/v0.2.1/HMH-Desktop-Setup-0.2.1.exe';
const candidates = [
  ['direct', url],
  ['ghproxy.cn', `https://ghproxy.cn/${url}`],
  ['gh-proxy.com', `https://gh-proxy.com/${url}`],
  ['ghfast.top', `https://ghfast.top/${url}`],
];
for (const [name, u] of candidates) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const reader = r.body?.getReader();
    let got = 0;
    if (reader !== undefined) {
      const { value } = await reader.read();
      got = value?.byteLength ?? 0;
      await reader.cancel();
    }
    console.log(name, '→', r.status, 'first-chunk:', got + 'B', r.headers.get('content-length') ?? '-');
  } catch (e) {
    console.log(name, '→ FAIL', String(e.cause?.code ?? e).slice(0, 60));
  }
}
