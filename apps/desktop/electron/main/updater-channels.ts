/**
 * 更新器通道纯逻辑(2026-10-29 用户反馈根治:国内用户收不到更新推送)。
 *
 * 背景:检查通道原本只走 api.github.com 直连(15s 超时),国内无代理网络必
 * 超时 → check failed → 用户永远看不到新版本;下载通道反而有镜像回退链。
 * 本模块给出三条纯规则(main 进程与 scripts/sim-updater.mjs 共用,单测覆盖):
 *  1) 检查通道链:直连(8s,国外秒过)→ gh-proxy → ghfast,逐个试到拿到 JSON;
 *  2) 通道粘性:上次命中的通道优先,失败再回退全链;
 *  3) 下载同源优先:与命中的检查通道同源的镜像先试,再直连与其余镜像。
 * 无 electron 依赖(可被 node --import tsx 的测试/模拟脚本直接 import)。
 */

export type UpdateChannelId = 'direct' | 'gh-proxy' | 'ghfast';

export interface CheckChannel {
  id: UpdateChannelId;
  /** 诊断/UI 显示名(错误信息里逐通道可见)。 */
  label: string;
  /** 单通道超时:直连 8s(国外秒过、国内快速让位镜像),镜像 10s。 */
  timeoutMs: number;
  apiUrl: (repo: string) => string;
  /** 下载镜像前缀('' = 直连 asset url);须在 DOWNLOAD_MIRROR_PREFIXES 清单内。 */
  downloadPrefix: string;
}

const githubLatest = (repo: string): string => `https://api.github.com/repos/${repo}/releases/latest`;

/** 检查通道链(默认顺序)。 */
export const CHECK_CHANNELS: readonly CheckChannel[] = [
  { id: 'direct', label: '直连', timeoutMs: 8_000, apiUrl: githubLatest, downloadPrefix: '' },
  { id: 'gh-proxy', label: 'gh-proxy', timeoutMs: 10_000, apiUrl: (repo) => `https://gh-proxy.com/${githubLatest(repo)}`, downloadPrefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', label: 'ghfast', timeoutMs: 10_000, apiUrl: (repo) => `https://ghfast.top/${githubLatest(repo)}`, downloadPrefix: 'https://ghfast.top/' },
];

/** 下载镜像全清单(默认顺序;ghproxy.cn 仅下载兜底,不做检查通道)。 */
export const DOWNLOAD_MIRROR_PREFIXES: readonly string[] = ['', 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.cn/'];

/** 存储值/IPC 值归一:合法通道 id 或 null(粘性文件损坏/旧版本残留时不致命)。 */
export function normalizeChannel(v: unknown): UpdateChannelId | null {
  return typeof v === 'string' && CHECK_CHANNELS.some((c) => c.id === v) ? (v as UpdateChannelId) : null;
}

/** 粘性排序:上次命中通道优先,其余保持默认链序(任一通道失败仍可全链回退)。 */
export function orderedCheckChannels(sticky: unknown): readonly CheckChannel[] {
  const s = normalizeChannel(sticky);
  const first = s === null ? undefined : CHECK_CHANNELS.find((c) => c.id === s);
  if (first === undefined) return CHECK_CHANNELS;
  return [first, ...CHECK_CHANNELS.filter((c) => c.id !== s)];
}

/** 下载镜像顺序:命中检查通道的同源镜像优先 → 直连 → 其余镜像(去重,4 通道清单保留)。 */
export function orderedDownloadMirrors(assetUrl: string, channel: unknown): readonly string[] {
  const hit = normalizeChannel(channel);
  const prefix = hit === null ? '' : CHECK_CHANNELS.find((c) => c.id === hit)?.downloadPrefix ?? '';
  const prefixes = [...new Set([prefix, ...DOWNLOAD_MIRROR_PREFIXES])];
  return prefixes.map((p) => (p === '' ? assetUrl : `${p}${assetUrl}`));
}

/** 全通道失败的错误串:逐通道列出原因(网络诊断用;UI 更新面板照常显示)。 */
export function summarizeCheckFailures(failures: ReadonlyArray<{ label: string; reason: string }>): string {
  return failures.map((f) => `${f.label}:${f.reason}`).join('; ');
}
