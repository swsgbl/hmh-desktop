/** 更新器通道纯逻辑单测 —— apps/desktop/electron/main/updater-channels.ts。
 *  覆盖:检查通道链默认顺序与超时(直连 → atomgit → gh-proxy → ghfast)、
 *  双仓映射 URL、通道粘性排序、非法粘性回退、响应归一(GitHub 对象 /
 *  atomgit 数组)、安装包资产挑选、下载候选链(atomgit 同源优先 + GitHub
 *  兜底 / GitHub 命中镜像链)、size 校验、全通道失败错误串格式。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_CHANNELS,
  DOWNLOAD_MIRROR_PREFIXES,
  atomgitApiDownloadUrl,
  cmpVersion,
  downloadCandidates,
  normalizeChannel,
  normalizeRelease,
  orderedCheckChannels,
  orderedDownloadMirrors,
  pickInstallerAsset,
  sizeMatches,
  summarizeCheckFailures,
} from '../../apps/desktop/electron/main/updater-channels.ts';

const ids = (chs) => chs.map((c) => c.id);
const ASSET = 'https://github.com/swsgbl/hmh-desktop/releases/download/v0.2.8/HMH-Desktop-Setup-0.2.8.exe';
const REPOS = { github: 'swsgbl/hmh-desktop', atomgit: 'hongfu/hmh-desktop' };

test('检查通道链:默认顺序 直连 → atomgit(国内首选)→ gh-proxy → ghfast,直连超时 8s', () => {
  assert.deepEqual(ids(CHECK_CHANNELS), ['direct', 'atomgit', 'gh-proxy', 'ghfast']);
  assert.equal(CHECK_CHANNELS[0].timeoutMs, 8_000, '直连 8s(国外秒过,国内快速让位 atomgit/镜像)');
  assert.ok(CHECK_CHANNELS.slice(1).every((c) => c.timeoutMs > 0));
});

test('检查通道 URL:双仓各取各的(atomgit 仓 owner 与 GitHub 不同)', () => {
  const [direct, atomgit, proxy, fast] = CHECK_CHANNELS;
  assert.equal(direct.apiUrl(REPOS), 'https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
  assert.equal(atomgit.apiUrl(REPOS), 'https://api.atomgit.com/api/v5/repos/hongfu/hmh-desktop/releases?per_page=5&direction=desc');
  assert.equal(proxy.apiUrl(REPOS), 'https://gh-proxy.com/https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
  assert.equal(fast.apiUrl(REPOS), 'https://ghfast.top/https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
});

test('normalizeChannel:四个合法 id 放行(含 atomgit);大小写/空串/未知/非字符串拒绝', () => {
  assert.equal(normalizeChannel('direct'), 'direct');
  assert.equal(normalizeChannel('atomgit'), 'atomgit');
  assert.equal(normalizeChannel('gh-proxy'), 'gh-proxy');
  assert.equal(normalizeChannel('ghfast'), 'ghfast');
  for (const bad of ['GHFAST', 'AtomGit', '', 'ghproxy.cn', 'direct ', null, undefined, 1, {}]) {
    assert.equal(normalizeChannel(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('通道粘性:上次命中通道排最前,其余保持默认链序且无重复', () => {
  assert.deepEqual(ids(orderedCheckChannels('atomgit')), ['atomgit', 'direct', 'gh-proxy', 'ghfast']);
  assert.deepEqual(ids(orderedCheckChannels('ghfast')), ['ghfast', 'direct', 'atomgit', 'gh-proxy']);
  assert.deepEqual(ids(orderedCheckChannels('gh-proxy')), ['gh-proxy', 'direct', 'atomgit', 'ghfast']);
  assert.deepEqual(ids(orderedCheckChannels('direct')), ['direct', 'atomgit', 'gh-proxy', 'ghfast']);
  // 全链仍可回退:集合与默认一致
  assert.deepEqual(new Set(ids(orderedCheckChannels('atomgit'))), new Set(ids(CHECK_CHANNELS)));
});

test('粘性容错:非法/损坏的存储值回退默认链序', () => {
  for (const bad of ['', 'ghproxy.cn', 'DIRECT', null, undefined, {}]) {
    assert.deepEqual(ids(orderedCheckChannels(bad)), ['direct', 'atomgit', 'gh-proxy', 'ghfast'], `粘性=${JSON.stringify(bad)} 应回退默认序`);
  }
});

test('normalizeRelease:GitHub 对象直取;atomgit 数组取 tag 最大(实测列表按 created_at 排,首个≠最新);畸形形状 null', () => {
  const gh = normalizeRelease({ tag_name: 'v0.2.9', body: 'notes', assets: [{ name: 'HMH-Desktop-Setup-0.2.9.exe', browser_download_url: 'https://github.com/x/y/z.exe', size: 112147199 }] });
  assert.equal(gh.tag_name, 'v0.2.9');
  assert.equal(gh.assets.length, 1);
  assert.equal(gh.assets[0].size, 112147199);
  // 真实事故形状:v0.2.8 创建时间晚于 v0.2.9 → atomgit 排第一,但最新是 v0.2.9
  const ag = normalizeRelease([
    { tag_name: 'v0.2.8', assets: [{ name: 'HMH-OHOS-0.2.8.hap', browser_download_url: 'u1', size: 663280 }] },
    { tag_name: 'v0.2.9', assets: [
      { name: 'v0.2.9.zip', browser_download_url: 'https://raw.atomgit.com/x.zip', type: 'source' },
      { name: 'HMH-Desktop-Setup-0.2.9.exe', browser_download_url: 'https://atomgit.com/hongfu/hmh-desktop/releases/download/v0.2.9/HMH-Desktop-Setup-0.2.9.exe', size: 112147199, type: 'attach' },
    ] },
  ]);
  assert.equal(ag.tag_name, 'v0.2.9', '必须按语义版本挑最大,不取数组首个');
  assert.equal(ag.assets.length, 2);
  assert.equal(ag.assets[1].name, 'HMH-Desktop-Setup-0.2.9.exe');
  // 混入畸形条目不致命,有效条目仍可挑出
  const messy = normalizeRelease([{ no_tag: 1 }, 'junk', { tag_name: 'v0.1.0' }, { tag_name: 'v0.10.0' }, { tag_name: 'v0.9.0' }]);
  assert.equal(messy.tag_name, 'v0.10.0', '0.10 > 0.9(数值比,非字典序)');
  for (const bad of [null, undefined, 'str', 42, [], [{}], [{ no_tag: 1 }], { tag_name: '' }]) {
    assert.equal(normalizeRelease(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
  // 资产缺 name/URL 的条目被剔除,size 缺失归 0(不参与 size 校验)
  const partial = normalizeRelease({ tag_name: 'v1', assets: [{ name: 'a.exe' }, { browser_download_url: 'u' }, { name: 'ok.exe', browser_download_url: 'u2' }] });
  assert.equal(partial.assets.length, 1);
  assert.equal(partial.assets[0].size, 0);
});

test('cmpVersion:v 前缀可选、不足三段补 0、数值比较', () => {
  assert.equal(cmpVersion('0.2.9', 'v0.2.9'), 0);
  assert.equal(cmpVersion('0.2.8', 'v0.2.9'), -1);
  assert.equal(cmpVersion('0.10.0', '0.9.0'), 1);
  assert.equal(cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(cmpVersion('1.2', '1.1.9'), 1);
});

test('pickInstallerAsset:HMH-Desktop-Setup-*.exe 精确优先,兜底任意 .exe;无则 null', () => {
  const assets = [
    { name: 'HMH-OHOS-0.2.8.hap', browser_download_url: 'u1', size: 663280 },
    { name: 'other.exe', browser_download_url: 'u2', size: 10 },
    { name: 'HMH-Desktop-Setup-0.2.9.exe', browser_download_url: 'u3', size: 112147199 },
  ];
  assert.equal(pickInstallerAsset(assets).name, 'HMH-Desktop-Setup-0.2.9.exe');
  assert.equal(pickInstallerAsset(assets.slice(0, 2)).name, 'other.exe');
  assert.equal(pickInstallerAsset([assets[0]]), null);
  assert.equal(pickInstallerAsset([]), null);
});

test('下载镜像(GitHub 资产):无通道信息时保持既有默认序(直连→ghfast→gh-proxy→ghproxy.cn)', () => {
  assert.deepEqual(orderedDownloadMirrors(ASSET, '').map((u) => new URL(u).host),
    ['github.com', 'ghfast.top', 'gh-proxy.com', 'ghproxy.cn']);
});

test('下载镜像(GitHub 资产):与命中的检查通道同源者优先,再直连与其余镜像(去重、清单不缩水)', () => {
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'gh-proxy').map((u) => new URL(u).host),
    ['gh-proxy.com', 'github.com', 'ghfast.top', 'ghproxy.cn']);
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'ghfast').map((u) => new URL(u).host),
    ['ghfast.top', 'github.com', 'gh-proxy.com', 'ghproxy.cn']);
  // direct/atomgit 同源=直链/atomgit 链另行处理;GitHub URL 下 direct 与默认一致
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'direct'), orderedDownloadMirrors(ASSET, ''));
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'bogus'), orderedDownloadMirrors(ASSET, ''));
  for (const list of [orderedDownloadMirrors(ASSET, ''), orderedDownloadMirrors(ASSET, 'gh-proxy')]) {
    assert.equal(list.length, 4);
    assert.ok(list.some((u) => u.startsWith('https://ghproxy.cn/')));
    assert.ok(list.includes(ASSET));
  }
});

test('atomgitApiDownloadUrl:ag-cli release_assets.go 同形(tag + 文件名,文件名编码)', () => {
  assert.equal(
    atomgitApiDownloadUrl(REPOS, 'v0.2.9', 'HMH-Desktop-Setup-0.2.9.exe'),
    'https://api.atomgit.com/api/v5/repos/hongfu/hmh-desktop/releases/v0.2.9/attach_files/HMH-Desktop-Setup-0.2.9.exe/download',
  );
  assert.ok(atomgitApiDownloadUrl(REPOS, 'v1.0', 'a b.exe').includes('a%20b.exe'));
});

test('downloadCandidates:atomgit 命中 → atomgit 直链、API 端点优先,GitHub 主仓镜像兜底', () => {
  const AG_ASSET = 'https://atomgit.com/hongfu/hmh-desktop/releases/download/v0.2.9/HMH-Desktop-Setup-0.2.9.exe';
  const urls = downloadCandidates({ channel: 'atomgit', tag: 'v0.2.9', assetUrl: AG_ASSET, assetName: 'HMH-Desktop-Setup-0.2.9.exe', repos: REPOS });
  assert.equal(urls[0], AG_ASSET, 'atomgit 资产直链最前(302 → CDN 签名直链)');
  assert.equal(urls[1], atomgitApiDownloadUrl(REPOS, 'v0.2.9', 'HMH-Desktop-Setup-0.2.9.exe'), 'atomgit API 端点第二');
  assert.equal(urls[2], 'https://github.com/swsgbl/hmh-desktop/releases/download/v0.2.9/HMH-Desktop-Setup-0.2.9.exe', 'GitHub 主仓同名资产兜底');
  assert.ok(urls.some((u) => u.startsWith('https://ghfast.top/')), '镜像兜底仍在');
  assert.equal(new Set(urls).size, urls.length, '去重');
});

test('downloadCandidates:GitHub 命中 → 既有镜像链(atomgit 不混入);atomgit 资产 URL 自动识别', () => {
  const urls = downloadCandidates({ channel: 'direct', tag: 'v0.2.9', assetUrl: ASSET, assetName: 'HMH-Desktop-Setup-0.2.8.exe', repos: REPOS });
  assert.deepEqual(urls, orderedDownloadMirrors(ASSET, 'direct'));
  assert.ok(urls.every((u) => !u.includes('atomgit')), 'GitHub 命中不走 atomgit');
  // 资产 URL 本身在 atomgit.com → 即使通道信息丢失也按 atomgit 链走
  const AG_ASSET = 'https://atomgit.com/hongfu/hmh-desktop/releases/download/v0.2.9/HMH-Desktop-Setup-0.2.9.exe';
  const urls2 = downloadCandidates({ channel: '', tag: 'v0.2.9', assetUrl: AG_ASSET, assetName: 'HMH-Desktop-Setup-0.2.9.exe', repos: REPOS });
  assert.equal(urls2[0], AG_ASSET);
});

test('sizeMatches:元数据 size>0 时必须与落盘字节一致;0/缺失不校验', () => {
  assert.equal(sizeMatches(112147199, 112147199), true);
  assert.equal(sizeMatches(112147199, 112147198), false);
  assert.equal(sizeMatches(0, 12345), true, '元数据无 size(如 GitHub 源码包)不校验');
  assert.equal(sizeMatches(-1, 0), true);
});

test('全通道失败错误串:逐通道列出原因(网络诊断可见)', () => {
  assert.equal(
    summarizeCheckFailures([{ label: '直连', reason: '超时(8s)' }, { label: 'atomgit(国内)', reason: 'HTTP 502' }, { label: 'gh-proxy', reason: 'HTTP 502' }]),
    '直连:超时(8s); atomgit(国内):HTTP 502; gh-proxy:HTTP 502',
  );
  assert.equal(summarizeCheckFailures([]), '');
});
