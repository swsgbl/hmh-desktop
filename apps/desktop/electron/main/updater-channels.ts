/**
 * 更新器通道纯逻辑(2026-10-29 用户反馈根治:国内用户收不到更新推送;
 * 同日任务 13-C:atomgit 国内首选通道 + 后台静默更新)。
 *
 * 背景:检查通道原本只走 api.github.com 直连(15s 超时),国内无代理网络必
 * 超时 → check failed → 用户永远看不到新版本;下载通道反而有镜像回退链。
 * 本模块给出纯规则(main 进程与 scripts/sim-updater.mjs 共用,单测覆盖):
 *  1) 检查通道链:直连(8s,国外秒过)→ atomgit v5(国内直连,匿名小响应)
 *     → gh-proxy → ghfast,逐个试到拿到 release;
 *  2) 通道粘性:上次命中的通道优先,失败再回退全链;
 *  3) 下载同源优先:与命中的检查通道同源的镜像先试,再直连与其余镜像;
 *     atomgit 命中 → atomgit 资产直链 / API 端点优先,GitHub 主仓镜像兜底。
 * 无 electron 依赖(可被 node --import tsx 的测试/模拟脚本直接 import)。
 */

export type UpdateChannelId = 'direct' | 'atomgit' | 'gh-proxy' | 'ghfast';

/** 双仓映射:GitHub 主仓与 atomgit 镜像仓 owner 不同(swsgbl vs hongfu),
 *  通道各自取自己的仓(可被 UPDATE_REPO / UPDATE_REPO_ATOMGIT 覆盖)。 */
export interface UpdateRepos { github: string; atomgit: string }

export interface CheckChannel {
  id: UpdateChannelId;
  /** 诊断/UI 显示名(错误信息里逐通道可见)。 */
  label: string;
  /** 单通道超时:直连 8s(国外秒过、国内快速让位镜像),atomgit/镜像 10s。 */
  timeoutMs: number;
  apiUrl: (repos: UpdateRepos) => string;
  /** 下载镜像前缀('' = 直连 asset url);须在 DOWNLOAD_MIRROR_PREFIXES 清单内。 */
  downloadPrefix: string;
}

export interface ReleaseAsset { name: string; browser_download_url: string; size: number }
export interface LatestRelease { tag_name: string; body?: string; assets?: ReleaseAsset[] }

const githubLatest = (repo: string): string => `https://api.github.com/repos/${repo}/releases/latest`;

/** 检查通道链(默认顺序:直连 → atomgit(国内首选)→ gh-proxy → ghfast)。 */
export const CHECK_CHANNELS: readonly CheckChannel[] = [
  { id: 'direct', label: '直连', timeoutMs: 8_000, apiUrl: (r) => githubLatest(r.github), downloadPrefix: '' },
  { id: 'atomgit', label: 'atomgit(国内)', timeoutMs: 10_000, apiUrl: (r) => `https://api.atomgit.com/api/v5/repos/${r.atomgit}/releases?per_page=5&direction=desc`, downloadPrefix: '' },
  { id: 'gh-proxy', label: 'gh-proxy', timeoutMs: 10_000, apiUrl: (r) => `https://gh-proxy.com/${githubLatest(r.github)}`, downloadPrefix: 'https://gh-proxy.com/' },
  { id: 'ghfast', label: 'ghfast', timeoutMs: 10_000, apiUrl: (r) => `https://ghfast.top/${githubLatest(r.github)}`, downloadPrefix: 'https://ghfast.top/' },
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

/** 语义版本比较('v' 前缀可选,按 . 分段数值比;不足三段补 0)。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** 响应归一:GitHub /releases/latest 返回对象,atomgit /releases 返回数组。
 *  atomgit 列表按 created_at 排序、首个元素不保证是最新 tag(实测 v0.2.8 建
 *  得比 v0.2.9 晚而排第一)→ 客户端按语义版本挑 tag 最大的 release。tag 缺失/
 *  形状不对返回 null(按本通道失败回退下一通道)。 */
export function normalizeRelease(json: unknown): LatestRelease | null {
  let best: LatestRelease | null = null;
  for (const rel of Array.isArray(json) ? json : [json]) {
    if (typeof rel !== 'object' || rel === null) continue;
    const r = rel as { tag_name?: unknown; body?: unknown; assets?: unknown };
    if (typeof r.tag_name !== 'string' || r.tag_name === '') continue;
    const assets: ReleaseAsset[] = Array.isArray(r.assets)
      ? r.assets.flatMap((a): ReleaseAsset[] => {
          const x = a as { name?: unknown; browser_download_url?: unknown; size?: unknown };
          return typeof x.name === 'string' && typeof x.browser_download_url === 'string'
            ? [{ name: x.name, browser_download_url: x.browser_download_url, size: typeof x.size === 'number' ? x.size : 0 }]
            : [];
        })
      : [];
    const cur: LatestRelease = { tag_name: r.tag_name, body: typeof r.body === 'string' ? r.body : '', assets };
    if (best === null || cmpVersion(cur.tag_name, best.tag_name) > 0) best = cur;
  }
  return best;
}

/** 从 release 资产挑安装包:HMH-Desktop-Setup-*.exe 精确匹配,兜底任意 .exe。 */
export function pickInstallerAsset(assets: readonly ReleaseAsset[]): ReleaseAsset | null {
  return assets.find((a) => /^HMH-Desktop-Setup-.*\.exe$/i.test(a.name))
    ?? assets.find((a) => a.name.toLowerCase().endsWith('.exe'))
    ?? null;
}

/** atomgit API 下载端点(ag-cli release_assets.go 同形:tag + 文件名)。 */
export function atomgitApiDownloadUrl(repos: UpdateRepos, tag: string, assetName: string): string {
  return `https://api.atomgit.com/api/v5/repos/${repos.atomgit}/releases/${tag}/attach_files/${encodeURIComponent(assetName)}/download`;
}

/** 下载候选链:atomgit 命中(或资产 URL 本就在 atomgit.com)→ atomgit 资产直链、
 *  atomgit API 端点优先,再拼 GitHub 主仓同 tag 同名资产的镜像链兜底(atomgit
 *  302 → CDN 签名直链,匿名可下、无需 Referer);GitHub 命中 → 既有镜像链。 */
export function downloadCandidates(input: { channel: unknown; tag: string; assetUrl: string; assetName: string; repos: UpdateRepos }): readonly string[] {
  const { channel, tag, assetUrl, assetName, repos } = input;
  let onAtomgit = normalizeChannel(channel) === 'atomgit';
  try { if (new URL(assetUrl).hostname === 'atomgit.com') onAtomgit = true; } catch { /* 无效 URL 按通道判定 */ }
  if (onAtomgit) {
    const githubAssetUrl = `https://github.com/${repos.github}/releases/download/${tag}/${assetName}`;
    return [...new Set([assetUrl, atomgitApiDownloadUrl(repos, tag, assetName), ...orderedDownloadMirrors(githubAssetUrl, channel)])];
  }
  return orderedDownloadMirrors(assetUrl, channel);
}

/** 下载校验:元数据 size>0 时须与落盘字节一致(atomgit 传输可靠性首验,
 *  GitHub 资产元数据同样带 size,顺带一起保真)。 */
export function sizeMatches(metaSize: number, actualBytes: number): boolean {
  return !(metaSize > 0) || metaSize === actualBytes;
}

/** 全通道失败的错误串:逐通道列出原因(网络诊断用;UI 更新面板照常显示)。 */
export function summarizeCheckFailures(failures: ReadonlyArray<{ label: string; reason: string }>): string {
  return failures.map((f) => `${f.label}:${f.reason}`).join('; ');
}
