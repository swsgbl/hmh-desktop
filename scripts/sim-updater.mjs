/** 手动模拟更新器网络链(与 main 进程共用同一通道纯逻辑 updater-channels.ts,
 *  保证模拟=真实实现,不是第二份拷贝)。
 *  用法:node --import tsx scripts/sim-updater.mjs [--channel=direct|proxy|auto]
 *        [--break-direct] [--sticky=direct|gh-proxy|ghfast] [--full]
 *    --channel=direct  只试直连(旧单通道行为;超时与实现一致 8s)
 *    --channel=proxy   只试镜像(gh-proxy → ghfast)
 *    --channel=auto    全链(默认):粘性优先 → 直连 → gh-proxy → ghfast
 *    --break-direct    直连候选域名拼错(.invalid 保留 TLD,必 NXDOMAIN)——
 *                      模拟国内无代理断连;auto 模式断言 proxy 接管(拿到 tag+asset)
 *    --sticky=<id>     模拟通道粘性:上次命中通道排最前
 *    --full            asset 下载不截断(默认 Range 探测前 64KB,证据足够且不拖慢)
 *  退出码:链路成功 0;全部通道失败 1(auto+--break-direct 下若仍命中 direct 也判 1)。
 */
import { orderedCheckChannels, orderedDownloadMirrors, summarizeCheckFailures } from '../apps/desktop/electron/main/updater-channels.ts';

const args = process.argv.slice(2);
const argValue = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a === undefined ? '' : a.slice(name.length + 3); };
const channelMode = argValue('channel') || 'auto';
const breakDirect = args.includes('--break-direct');
const sticky = argValue('sticky') || undefined;
const full = args.includes('--full');
const REPO = 'swsgbl/hmh-desktop';

if (!['direct', 'proxy', 'auto'].includes(channelMode)) {
  console.error(`未知 --channel=${channelMode}(可用 direct|proxy|auto)`);
  process.exit(2);
}

// 候选通道:模式过滤 + 粘性排序(auto)+ 断连模拟(直连域名拼错)
let channels = orderedCheckChannels(sticky);
if (channelMode === 'direct') channels = channels.filter((c) => c.id === 'direct');
if (channelMode === 'proxy') channels = channels.filter((c) => c.id !== 'direct');
if (breakDirect) {
  channels = channels.map((c) => c.id !== 'direct' ? c : {
    ...c,
    label: `${c.label}(域名拼错模拟)`,
    apiUrl: (repo) => c.apiUrl(repo).replace('https://api.github.com', 'https://api.github.com.break-direct-sim.invalid'),
  });
}

console.log(`SIM-UPDATER mode=${channelMode}${sticky !== undefined ? ` sticky=${sticky}` : ''}${breakDirect ? ' break-direct=on' : ''}${full ? ' full-download' : ''}`);
console.log(`SIM-UPDATER chain: ${channels.map((c) => c.id).join(' → ')}`);

const failures = [];
let hit = null;
let rel = null;
for (const [i, ch] of channels.entries()) {
  const t0 = Date.now();
  const url = ch.apiUrl(REPO);
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'hmh-desktop-updater' }, signal: AbortSignal.timeout(ch.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j?.tag_name !== 'string' || j.tag_name === '') throw new Error('响应无 tag_name');
    rel = j;
    hit = ch;
    console.log(`SIM-UPDATER [${i + 1}/${channels.length}] ${ch.id} → ${r.status} ok ${Date.now() - t0}ms tag=${j.tag_name} assets=${(j.assets ?? []).length}`);
    break;
  } catch (err) {
    const e = err;
    const reason = err instanceof Error && err.name === 'TimeoutError' ? `超时(${Math.round(ch.timeoutMs / 1000)}s)` : String(e?.cause?.code ?? err).slice(0, 80);
    failures.push({ label: ch.label, reason });
    console.log(`SIM-UPDATER [${i + 1}/${channels.length}] ${ch.id} → fail ${Date.now() - t0}ms ${reason}`);
  }
}

if (hit === null || rel === null) {
  console.log(`SIM-UPDATER RESULT: FAIL 全部通道失败(${summarizeCheckFailures(failures)})`);
  process.exit(1);
}
if (breakDirect && hit.id === 'direct') {
  console.log('SIM-UPDATER RESULT: FAIL break-direct 下仍命中 direct(断言失败:应回退镜像)');
  process.exit(1);
}

const asset = (rel.assets ?? []).find((a) => /^HMH-Desktop-Setup-.*\.exe$/i.test(a.name)) ?? null;
console.log(`SIM-UPDATER hit=${hit.id}${sticky === hit.id ? '(=sticky 命中)' : ''} latest=${rel.tag_name}`);
if (asset === null) {
  console.log('SIM-UPDATER RESULT: PASS(检查链通;release 无 Setup.exe 资产,跳过下载探测)');
  process.exit(0);
}

// 下载联动:命中通道同源优先(与 downloadInstaller 同一 orderedDownloadMirrors)
const mirrors = orderedDownloadMirrors(asset.browser_download_url, hit.id);
console.log(`SIM-UPDATER asset=${asset.name}`);
console.log(`SIM-UPDATER download-chain: ${mirrors.map((u) => new URL(u).host).join(' → ')}`);
async function probeMirror(u) {
  const r = await fetch(u, { headers: { 'user-agent': 'hmh-desktop-updater', range: 'bytes=0-65535' }, signal: AbortSignal.timeout(full ? 600_000 : 60_000) });
  if (!r.ok && r.status !== 206) return { ok: false, status: r.status, host: new URL(r.url).host, bytes: 0 };
  const host = new URL(r.url).host;
  const len = Number(r.headers.get('content-length') ?? '0');
  if (!full && len > 512 * 1024) { await r.body?.cancel(); return { ok: true, status: r.status, host, bytes: len, partial: true }; }
  const buf = Buffer.from(await r.arrayBuffer());
  return { ok: true, status: r.status, host, bytes: buf.length, partial: r.status === 206 };
}
for (const [i, u] of mirrors.entries()) {
  const t0 = Date.now();
  try {
    const p = await probeMirror(u);
    if (!p.ok) { console.log(`SIM-UPDATER dl[${i + 1}] ${new URL(u).host} → HTTP ${p.status} ${Date.now() - t0}ms`); continue; }
    console.log(`SIM-UPDATER dl[${i + 1}] ${new URL(u).host} → ${p.status} ${Date.now() - t0}ms bytes=${p.bytes}${p.partial ? '(Range 探测,未全量)' : ''} final-host=${p.host}`);
    console.log(`SIM-UPDATER RESULT: PASS 检查命中=${hit.id};下载命中=${p.host}`);
    process.exit(0);
  } catch (err) {
    const e = err;
    console.log(`SIM-UPDATER dl[${i + 1}] ${new URL(u).host} → fail ${Date.now() - t0}ms ${String(e?.cause?.code ?? err).slice(0, 80)}`);
  }
}
console.log('SIM-UPDATER RESULT: PARTIAL 检查链通但全部下载镜像失败');
process.exit(1);
