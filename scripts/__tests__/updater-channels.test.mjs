/** 更新器双通道纯逻辑单测 —— apps/desktop/electron/main/updater-channels.ts。
 *  覆盖:检查通道链默认顺序与超时、通道粘性排序、非法粘性回退、下载镜像
 *  同源优先与 4 镜像清单保留、全通道失败错误串格式。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_CHANNELS,
  DOWNLOAD_MIRROR_PREFIXES,
  normalizeChannel,
  orderedCheckChannels,
  orderedDownloadMirrors,
  summarizeCheckFailures,
} from '../../apps/desktop/electron/main/updater-channels.ts';

const ids = (chs) => chs.map((c) => c.id);
const ASSET = 'https://github.com/swsgbl/hmh-desktop/releases/download/v0.2.8/HMH-Desktop-Setup-0.2.8.exe';

test('检查通道链:默认顺序 直连 → gh-proxy → ghfast,直连超时 8s', () => {
  assert.deepEqual(ids(CHECK_CHANNELS), ['direct', 'gh-proxy', 'ghfast']);
  assert.equal(CHECK_CHANNELS[0].timeoutMs, 8_000, '直连 8s(国外秒过,国内快速让位镜像)');
  assert.ok(CHECK_CHANNELS.slice(1).every((c) => c.timeoutMs > 0));
});

test('检查通道 URL:直连原样;镜像前缀包裹完整 api 地址', () => {
  const [direct, proxy, fast] = CHECK_CHANNELS;
  assert.equal(direct.apiUrl('swsgbl/hmh-desktop'), 'https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
  assert.equal(proxy.apiUrl('swsgbl/hmh-desktop'), 'https://gh-proxy.com/https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
  assert.equal(fast.apiUrl('swsgbl/hmh-desktop'), 'https://ghfast.top/https://api.github.com/repos/swsgbl/hmh-desktop/releases/latest');
});

test('normalizeChannel:三个合法 id 放行;大小写/空串/未知/非字符串拒绝', () => {
  assert.equal(normalizeChannel('direct'), 'direct');
  assert.equal(normalizeChannel('gh-proxy'), 'gh-proxy');
  assert.equal(normalizeChannel('ghfast'), 'ghfast');
  for (const bad of ['GHFAST', '', 'ghproxy.cn', 'direct ', null, undefined, 1, {}]) {
    assert.equal(normalizeChannel(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('通道粘性:上次命中通道排最前,其余保持默认链序且无重复', () => {
  assert.deepEqual(ids(orderedCheckChannels('ghfast')), ['ghfast', 'direct', 'gh-proxy']);
  assert.deepEqual(ids(orderedCheckChannels('gh-proxy')), ['gh-proxy', 'direct', 'ghfast']);
  assert.deepEqual(ids(orderedCheckChannels('direct')), ['direct', 'gh-proxy', 'ghfast']);
  // 全链仍可回退:集合与默认一致
  assert.deepEqual(new Set(ids(orderedCheckChannels('ghfast'))), new Set(ids(CHECK_CHANNELS)));
});

test('粘性容错:非法/损坏的存储值回退默认链序', () => {
  for (const bad of ['', 'ghproxy.cn', 'DIRECT', null, undefined, {}]) {
    assert.deepEqual(ids(orderedCheckChannels(bad)), ['direct', 'gh-proxy', 'ghfast'], `粘性=${JSON.stringify(bad)} 应回退默认序`);
  }
});

test('下载镜像:无通道信息时保持既有默认序(直连→ghfast→gh-proxy→ghproxy.cn)', () => {
  assert.deepEqual(orderedDownloadMirrors(ASSET, '').map((u) => new URL(u).host),
    ['github.com', 'ghfast.top', 'gh-proxy.com', 'ghproxy.cn']);
});

test('下载镜像:与命中的检查通道同源者优先,再直连与其余镜像(去重、清单不缩水)', () => {
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'gh-proxy').map((u) => new URL(u).host),
    ['gh-proxy.com', 'github.com', 'ghfast.top', 'ghproxy.cn']);
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'ghfast').map((u) => new URL(u).host),
    ['ghfast.top', 'github.com', 'gh-proxy.com', 'ghproxy.cn']);
  // direct 同源=直连,顺序与默认一致;非法通道回退默认序
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'direct'), orderedDownloadMirrors(ASSET, ''));
  assert.deepEqual(orderedDownloadMirrors(ASSET, 'bogus'), orderedDownloadMirrors(ASSET, ''));
  // 4 镜像清单保留(ghproxy.cn 兜底仍在),前缀拼接正确
  for (const list of [orderedDownloadMirrors(ASSET, ''), orderedDownloadMirrors(ASSET, 'gh-proxy')]) {
    assert.equal(list.length, 4);
    assert.ok(list.some((u) => u.startsWith('https://ghproxy.cn/')));
    assert.ok(list.includes(ASSET));
  }
});

test('全通道失败错误串:逐通道列出原因(网络诊断可见)', () => {
  assert.equal(
    summarizeCheckFailures([{ label: '直连', reason: '超时(8s)' }, { label: 'gh-proxy', reason: 'HTTP 502' }]),
    '直连:超时(8s); gh-proxy:HTTP 502',
  );
  assert.equal(summarizeCheckFailures([]), '');
});
