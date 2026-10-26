/**
 * @hmharness/cli 安装核心(纯逻辑,零 IO —— fetch/解压/落盘在主进程 installer 里)。
 *
 * 职责(v5.1 安装向导):给定 registry 元数据获取函数,解析 @hmharness/cli 的
 * 完整依赖闭包(@hmharness/* 全家为精确版本互钉;外部依赖 qrcode 链为 ^ 范围),
 * 产出"装什么、从哪些镜像下、装到哪"的确定性计划。设计约束:
 *  - 闭包按包名去重(钻石依赖只装一份,npm 语义);
 *  - 范围解析只支持 npm 生态实际用到的形态:精确 / latest / * / ^ / ~ / >=,
 *    不引 semver 库(零依赖原则,与自研更新器一致);
 *  - optionalDependencies 不装:闭包内实际声明的 optional 均为平台特定
 *    (fsevents 等),tgz 路径不跑生命周期脚本,装了也只是死重。
 */
import { createHash } from 'node:crypto';

export interface PkgVersionMeta {
  version: string;
  dependencies: Record<string, string>;
  tarball: string;
  integrity?: string | undefined;
}

/** registry packument 的最小读取面(dist-tags + 全版本依赖/tarball 元数据)。 */
export interface Packument {
  'dist-tags': Record<string, string>;
  versions: Record<string, { dependencies?: Record<string, string> | undefined; dist?: { tarball?: string; integrity?: string | undefined } | undefined }>;
}

export interface ResolvedPkg {
  name: string;
  version: string;
  /** registry 原始地址(镜像列表由 tarballMirrors 派生)。 */
  tarball: string;
  integrity?: string | undefined;
}

/* ---- semver(最小实现:闭包内实际出现的形态) ---- */

export function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('-')[0]!.split('.').map(Number);
  const pb = b.replace(/^v/, '').split('-')[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** range 是否接受 version(支持 精确 / latest / * / x / ^ / ~ / >=;不识别则 false)。 */
export function satisfies(range: string, version: string): boolean {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'latest' || r === 'x') return true;
  if (r === version) return true;
  const bound = /^(\^|~|>=?)\s*(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (bound !== null) {
    const op = bound[1]!;
    const major = Number(bound[2]);
    const minor = Number(bound[3]);
    const patch = Number(bound[4]);
    const c = cmpSemver(version, `${major}.${minor}.${patch}`);
    if (c < 0) return false;
    if (op === '>=') return true; // '>=' 下界即可:闭包内只以 '>=x.y.z <z' 复合形态出现,保守取下界
    if (op === '~') return cmpSemver(version, `${major}.${minor + 1}.0`) < 0;
    // '^':0.x 特判(0.2.3 允许 0.2.z),其余锁主版本
    if (major === 0) return minor === 0 ? cmpSemver(version, `0.0.${patch + 1}`) < 0 : cmpSemver(version, `0.${minor + 1}.0`) < 0;
    return cmpSemver(version, `${major + 1}.0.0`) < 0;
  }
  return false;
}

/** 从 packument 选出 spec(精确/latest/^/~/*)指向的版本;无匹配返回 ''。 */
export function pickVersion(doc: Packument, spec: string): string {
  const s = spec.trim();
  const tag = s === '' || s === 'latest' || s === '*' ? doc['dist-tags']?.latest : undefined;
  if (tag !== undefined && doc.versions[tag] !== undefined) return tag;
  if (doc.versions[s] !== undefined) return s;
  let best = '';
  for (const v of Object.keys(doc.versions)) {
    if (satisfies(s, v) && cmpSemver(v, best) > 0) best = v;
  }
  return best;
}

/* ---- 依赖闭包 ---- */

/**
 * 解析 root 及其全部传递依赖(BFS,按包名去重取首个解析结果 —— 与 npm 扁平
 * 布局一致)。getPackument 由调用方注入(fetch 网络 / 测试注入字典)。
 * 任一依赖无满足版本时抛错(带包名与 range,面向安装页错误文案)。
 */
export async function resolveClosure(
  root: { name: string; spec: string },
  getPackument: (name: string) => Promise<Packument>,
): Promise<ResolvedPkg[]> {
  const resolved = new Map<string, PkgVersionMeta>();
  const queue: Array<{ name: string; spec: string }> = [root];
  while (queue.length > 0) {
    const { name, spec } = queue.shift()!;
    if (resolved.has(name)) continue; // 已定版:后续 range 引用不再重解(npm 扁平语义)
    const doc = await getPackument(name);
    const version = pickVersion(doc, spec);
    const meta = version !== '' ? doc.versions[version] : undefined;
    if (meta === undefined || meta.dist?.tarball === undefined) {
      throw new Error(`no version of ${name} satisfies ${spec || 'latest'}`);
    }
    const item: PkgVersionMeta = {
      version,
      dependencies: meta.dependencies ?? {},
      tarball: meta.dist.tarball,
      integrity: meta.dist.integrity,
    };
    resolved.set(name, item);
    for (const [dep, range] of Object.entries(item.dependencies)) {
      if (!resolved.has(dep)) queue.push({ name: dep, spec: range });
    }
  }
  return [...resolved.entries()].map(([name, m]) => ({ name, version: m.version, tarball: m.tarball, integrity: m.integrity }));
}

/* ---- 镜像与布局 ---- */

const REGISTRY_HOSTS = /^(https?:\/\/[^/]+)\/(.*)$/;

/**
 * tarball 的镜像候选(顺序即回退顺序):原始地址 → 各 registry 同路径改写。
 * packument 里的 dist.tarball 恒指向发布源(registry.npmjs.org),国内网络
 * 不可达时按 registry 列表改写 host(路径不变 —— npmmirror 与 npmjs 同构)。
 */
export function tarballMirrors(tarball: string, registries: string[]): string[] {
  const m = REGISTRY_HOSTS.exec(tarball);
  const path = m?.[2] ?? '';
  const out = [tarball];
  for (const reg of registries) {
    const base = reg.replace(/\/+$/, '');
    if (base === m?.[1]) continue;
    const u = `${base}/${path}`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** 包在 node_modules 下的目标目录(scoped 包保持 @scope/name 两级)。 */
export function moduleDir(prefix: string, name: string): string {
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (name.startsWith('@') && parts.length !== 2) throw new Error(`invalid package name: ${name}`);
  if (!name.startsWith('@') && parts.length !== 1) throw new Error(`invalid package name: ${name}`);
  return [...parts].reduce((dir, p) => `${dir}\\${p}`, `${prefix}\\node_modules`);
}

/* ---- integrity ---- */

/** npm dist.integrity('sha512-base64') 校验;不匹配返回 false(未知算法返回 true 放行)。 */
export function integrityOk(data: Buffer, integrity?: string): boolean {
  if (integrity === undefined || integrity === '') return true;
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (m === null) return true;
  return createHash('sha512').update(data).digest('base64') === m[1];
}

/** 人类可读字节(安装进度文案用)。 */
export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
