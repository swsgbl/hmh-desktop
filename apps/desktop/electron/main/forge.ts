/**
 * 仓库面板后端(任务 14-B)—— GitHub/AtomGit 双平台 gh/ag CLI 的 main 进程封装。
 *
 * 安全不变量(开发计划 M0 出口门同源):
 *  - renderer 永不 spawn:所有调用走 index.ts 注册的 IPC 白名单,逐方法校验参数;
 *  - host 只认 'github'|'atomgit',repo 只认 owner/name 形态,state 只认 open|closed|all;
 *  - 登录绝不捕获/存储令牌:只 spawn 官方 CLI 的浏览器 OAuth 流程,转发其 stdout
 *    行给 renderer 展示 URL/设备码,并外开系统浏览器;令牌只落 CLI 自己的凭据库;
 *  - 所有命令 60s 超时(登录放宽到 3 分钟,等用户在浏览器完成);
 *  - 错误归一 { ok:false, code, error },error 截断防日志洪泛。
 *
 * 与 14-A(hmharness forge_* 工具)互通:renderer 的"让 hmh 处理"把仓库上下文
 * 填进 composer,由 agent 侧工具接手;本文件只服务面板自身的即时直操作。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, sep } from 'node:path';

export type ForgeHost = 'github' | 'atomgit';

export interface ForgeHostStatus { installed: boolean; logged: boolean; user: string }
export interface ForgeStatus { github: ForgeHostStatus; atomgit: ForgeHostStatus }
export interface ForgeRepo { name: string; fullName: string; isPrivate: boolean; updatedAt: string; url: string; description: string }
export interface ForgePr { number: string; title: string; state: string; isDraft: boolean; updatedAt: string; url: string }
export interface ForgeIssue { number: string; title: string; state: string; updatedAt: string; url: string }
export interface ForgeRelease { tag: string; name: string; createdAt: string; isDraft: boolean; isPrerelease: boolean }
export interface ForgeCliResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type ForgeOk<T> = { ok: true; data: T } | { ok: false; code: string; error: string }

/** 命令矩阵:两平台同族命令,差异只在 repo 传参(gh --repo / ag 位置参数)。 */
export const CLI_BIN: Record<ForgeHost, string> = { github: 'gh', atomgit: 'ag' };
const HOSTS: readonly ForgeHost[] = ['github', 'atomgit'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CMD_TIMEOUT_MS = 60_000;
const LOGIN_TIMEOUT_MS = 180_000;
const LIST_LIMIT = 50;
const PAGE_SIZE = 20;

/* ---- spawn seam(单测注入;生产实现 = where 解析 + 超时 kill) ---- */
export interface ForgeDeps {
  /** 跑一条 CLI 命令(超时强制 kill);onLine 收到 stdout 行(登录流程流式转发)。 */
  run(cmd: string, args: string[], timeoutMs: number, onLine?: (line: string) => void): Promise<ForgeCliResult>;
  /** 解析可执行文件完整路径;'' = 未安装。 */
  which(cmd: string): string;
}

export const defaultDeps: ForgeDeps = {
  run: (cmd, args, timeoutMs, onLine) =>
    new Promise((resolve) => {
      const r = resolveCli(cmd);
      const child = spawn(r.bin, [...r.prefix, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString();
        out = (out + text).slice(-200_000);
        if (onLine !== undefined) for (const line of text.split(/\r?\n/)) if (line.trim() !== '') onLine(line);
      });
      child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-60_000); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: `${err}${String(e)}`, timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err, timedOut }); });
    }),
  which: (cmd) => {
    try {
      // where 走 PATHEXT 解析;任一行命中即视为已安装(gh=exe;ag=npm shim 也算)
      const out = execFileSync('where', [cmd], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
      return (out.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim();
    } catch { return ''; }
  },
};

/** where 的全部候选行(小工具:which/resolveCli 共用)。 */
function whereLines(cmd: string): string[] {
  try {
    const out = execFileSync('where', [cmd], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  } catch { return []; }
}

/**
 * CLI 名 → 可 spawn 的形态(Windows 实测坑):
 *  - .exe(gh)→ 直接 spawn;
 *  - npm 全局 shim(ag 的 ag.cmd / 无扩展名 sh)→ CreateProcess 不能执行,
 *    且 shell:true 拼接有注入面(title/body 是用户输入)——解析 shim 里引用的
 *    node_modules/**.js 真身,用 node.exe <js> 直跑(无 shell,参数数组原样传)。
 */
export function resolveCli(cmd: string): { bin: string; prefix: string[] } {
  const lines = whereLines(cmd);
  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe !== undefined) return { bin: exe, prefix: [] };
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0];
  if (shim === undefined) return { bin: cmd, prefix: [] };
  try {
    const text = readFileSync(shim, 'utf8');
    const m = text.match(/node_modules[\\/][\w@.\-\\/]+?\.(?:js|mjs|cjs)/i);
    if (m !== null) {
      const js = join(dirname(shim), m[0].replace(/\//g, sep));
      if (existsSync(js)) {
        const nodeExe = whereLines('node').find((l) => /\.exe$/i.test(l)) ?? 'node';
        return { bin: nodeExe, prefix: [js] };
      }
    }
  } catch { /* shim 读不了:按原样 spawn(失败会归一成 CLI_ERROR/未装) */ }
  return { bin: shim, prefix: [] };
}

/* ---- 参数校验(每个 IPC 方法入口逐参数过一遍;返回 null=通过) ---- */
export function checkHost(host: unknown): ForgeHost | null {
  return host === 'github' || host === 'atomgit' ? host : null;
}
export function checkRepo(repo: unknown): string | null {
  return typeof repo === 'string' && REPO_RE.test(repo) && repo.length <= 140 ? repo : null;
}
export function checkState(state: unknown): 'open' | 'closed' | 'all' {
  return state === 'closed' || state === 'all' ? state : 'open';
}
export function checkStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 解析 stdout/stderr 里的第一个 http(s) URL(登录流程外开浏览器 + 展示)。 */
export function extractUrl(text: string): string {
  const m = text.match(/https:\/\/[^\s'")\]]+/);
  return m === null ? '' : m[0].replace(/[.,;]+$/, '');
}

/** auth status 文本 → 登录态 + 用户名(两平台文案:gh "account X" / ag "as X")。 */
export function parseAuthStatus(host: ForgeHost, stdout: string, stderr: string, code: number | null): ForgeHostStatus {
  const text = `${stdout}\n${stderr}`;
  const m = text.match(host === 'github' ? /Logged in to github\.com account (\S+)/ : /Logged in to atomgit\.com as (\S+)/);
  if (m !== null) return { installed: true, logged: true, user: (m[1] ?? '').replace(/[()]/g, '') };
  // exit≠0 且明确说未登录 → 已装未登录;能跑到这(而非 ENOENT)即 CLI 存在
  return { installed: true, logged: false, user: '' , ...(code === -1 && /ENOENT|spawn/i.test(text) ? { installed: false } : {}) };
}

/* ---- JSON 归一(gh/ag 字段差异抹平;字段缺失给安全默认) ---- */
type AnyRec = Record<string, unknown>;
const s = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const b = (v: unknown, dflt = false): boolean => typeof v === 'boolean' ? v : dflt;

export function normalizeRepos(host: ForgeHost, rows: AnyRec[]): ForgeRepo[] {
  return rows.map((r) => {
    const name = s(r.name);
    const fullName = s(r.nameWithOwner) || s(r.fullName) || name;
    return {
      name,
      fullName,
      isPrivate: host === 'github' ? b(r.isPrivate) : s(r.visibility) === 'private',
      updatedAt: s(r.updatedAt),
      url: s(r.url) || (host === 'github' ? `https://github.com/${fullName}` : `https://atomgit.com/${fullName}`),
      description: s(r.description),
    };
  });
}
export function normalizePrs(rows: AnyRec[]): ForgePr[] {
  return rows.map((r) => ({
    number: s(r.number),
    title: s(r.title),
    state: s(r.state).toLowerCase() || 'open',
    isDraft: b(r.isDraft) || b(r.draft),
    updatedAt: s(r.updatedAt),
    url: s(r.url),
  }));
}
export function normalizeIssues(rows: AnyRec[]): ForgeIssue[] {
  return rows.map((r) => ({
    number: s(r.number),
    title: s(r.title),
    state: s(r.state).toLowerCase() || 'open',
    updatedAt: s(r.updatedAt),
    url: s(r.url),
  }));
}
export function normalizeReleases(host: ForgeHost, rows: AnyRec[]): ForgeRelease[] {
  return rows.map((r) => ({
    tag: s(host === 'github' ? r.tagName : r.tag),
    name: s(r.name),
    createdAt: s(r.createdAt),
    isDraft: b(r.isDraft) || b(r.draft),
    isPrerelease: b(r.isPrerelease) || b(r.prerelease),
  }));
}

/* ---- 命令拼装(纯函数,单测锚点) ---- */
export function buildListArgs(kind: 'repos' | 'prs' | 'issues' | 'releases', host: ForgeHost, repo: string, state: string): string[] {
  if (kind === 'repos') {
    return host === 'github'
      ? ['repo', 'list', '--limit', String(LIST_LIMIT), '--json', 'name,nameWithOwner,isPrivate,updatedAt,url,description']
      : ['repo', 'list', '--limit', String(LIST_LIMIT), '--json'];
  }
  if (host === 'github') {
    const base = kind === 'prs' ? 'pr' : kind === 'issues' ? 'issue' : 'release';
    if (kind === 'releases') return ['release', 'list', '--repo', repo, '--limit', String(LIST_LIMIT), '--json', 'tagName,name,createdAt,isDraft,isPrerelease'];
    const fields = kind === 'prs' ? 'number,title,state,isDraft,updatedAt,url' : 'number,title,state,updatedAt,url';
    return [base, 'list', '--repo', repo, '--state', state, '--limit', String(LIST_LIMIT), '--json', fields];
  }
  if (kind === 'releases') return ['release', 'list', repo, '--json', '--limit', String(LIST_LIMIT)];
  const base = kind === 'prs' ? 'pr' : 'issue';
  return [base, 'list', repo, '--state', state, '--json', '--limit', String(LIST_LIMIT)];
}

export type ForgeActionKind = 'pr_create' | 'pr_merge' | 'issue_create' | 'release_create' | 'release_upload' | 'repo_clone';
export interface ForgeActionArgs {
  repo: string; number?: string; title?: string; body?: string; base?: string; head?: string;
  tag?: string; name?: string; notes?: string; prerelease?: boolean; file?: string; dir?: string; method?: string;
}

/** 写操作命令拼装(逐 kind 校验;返回 null = 参数不合法)。 */
export function buildActionArgs(kind: ForgeActionKind, host: ForgeHost, a: ForgeActionArgs): string[] | null {
  const R = (v: string | undefined): string[] => host === 'github' ? ['--repo', v ?? ''] : [v ?? ''];
  if (kind === 'pr_create') {
    const title = checkStr(a.title, 300); const body = checkStr(a.body, 20_000);
    const base = checkStr(a.base, 200); const head = checkStr(a.head, 200);
    if (title === '') return null;
    const args = host === 'github'
      ? ['pr', 'create', '--repo', a.repo, '--title', title, '--body', body]
      : ['pr', 'create', a.repo, '--title', title, '--body', body];
    if (base !== '') args.push('--base', base);
    if (head !== '') args.push('--head', head);
    return args;
  }
  if (kind === 'pr_merge') {
    const num = checkStr(a.number, 20).replace(/[^0-9]/g, '');
    if (num === '') return null;
    const squash = a.method !== 'merge'; // 默认 squash(与 gh 非交互要求一致)
    return host === 'github'
      ? ['pr', 'merge', '--repo', a.repo, num, squash ? '--squash' : '--merge']
      : ['pr', 'merge', a.repo, num, squash ? '--squash' : '--merge'];
  }
  if (kind === 'issue_create') {
    const title = checkStr(a.title, 300); const body = checkStr(a.body, 20_000);
    if (title === '') return null;
    return host === 'github'
      ? ['issue', 'create', '--repo', a.repo, '--title', title, '--body', body]
      : ['issue', 'create', a.repo, '--title', title, '--body', body];
  }
  if (kind === 'release_create') {
    const tag = checkStr(a.tag, 120); const name = checkStr(a.name, 300);
    // atomgit API 要求 body 非空:无 notes 时回退 tag 文本
    const notes = checkStr(a.notes, 60_000) || tag;
    if (!/^[A-Za-z0-9_.-]+$/.test(tag)) return null;
    return host === 'github'
      ? ['release', 'create', tag, '--repo', a.repo, '--title', name || tag, '--notes', notes, ...(a.prerelease === true ? ['--prerelease'] : [])]
      : ['release', 'create', a.repo, tag, '--name', name || tag, '--body', notes, ...(a.prerelease === true ? ['--prerelease'] : [])];
  }
  if (kind === 'release_upload') {
    const tag = checkStr(a.tag, 120); const file = checkStr(a.file, 1_000);
    if (!/^[A-Za-z0-9_.-]+$/.test(tag) || file === '') return null;
    return host === 'github'
      ? ['release', 'upload', tag, file, '--repo', a.repo]
      : ['release', 'upload', a.repo, tag, file];
  }
  // repo_clone:gh/ag 同形(clone OWNER/REPO <dir>)
  const dir = checkStr(a.dir, 1_000);
  if (dir === '') return null;
  return ['repo', 'clone', a.repo, dir];
}

/**
 * 上传/克隆的文件路径门:绝对路径 + 必须落在用户主目录或已注册工作区之下。
 * (面板的资产选择器只应碰用户自己的目录;防止把系统文件传上 release。)
 */
export function validateLocalPath(p: string, allowedRoots: readonly string[]): boolean {
  if (!isAbsolute(p)) return false;
  const home = homedir();
  const under = (root: string): boolean => {
    try { const r = join(root, ''); return p === r || p.startsWith(`${r}${sep}`); } catch { return false; }
  };
  if (under(home)) return true;
  return allowedRoots.some(under);
}

/** 工作区路径 → 平台仓库(owner/repo):读 .git/config 的 remote url(https/ssh 两种写法)。 */
export function resolveRepoOf(path: string): { host: ForgeHost; repo: string } | null {
  try {
    const cfg = readFileSync(join(path, '.git', 'config'), 'utf8');
    const urls = [...cfg.matchAll(/url\s*=\s*(\S+)/g)].map((m) => m[1] ?? '');
    for (const u of urls) {
      const gh = u.match(/(?:github\.com[/:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      if (gh !== null && (gh[1] ?? '') !== '') return { host: 'github', repo: gh[1] ?? '' };
      const ag = u.match(/(?:atomgit\.com[/:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      if (ag !== null && (ag[1] ?? '') !== '') return { host: 'atomgit', repo: ag[1] ?? '' };
    }
    return null;
  } catch { return null; }
}

/* ---- forge 服务对象(main 单例;单测注入 deps) ---- */
export interface ForgeOptions {
  /** 已注册工作区根列表(release_upload/repo_clone 的路径门 + 面板上下文)。 */
  allowedRoots?: () => string[];
  /** 登录流程行转发 + URL 外开(uiverify/单测可静默)。 */
  onLoginLine?: (host: ForgeHost, line: string) => void;
  openExternal?: (url: string) => void;
}

const bad = (code: string, error: string): { ok: false; code: string; error: string } => ({ ok: false, code, error: error.slice(0, 300) });
const ok = <T>(data: T): ForgeOk<T> => ({ ok: true, data });

export function createForge(deps: ForgeDeps = defaultDeps, opts: ForgeOptions = {}): ForgeService {
  const roots = (): string[] => (opts.allowedRoots?.() ?? []).filter((r) => typeof r === 'string' && r !== '');

  /** 归一 CLI 结果:超时/非零退出/坏 JSON → 结构化错误。 */
  async function cliJson<T>(host: ForgeHost, args: string[], normalizer: (rows: AnyRec[]) => T): Promise<ForgeOk<T>> {
    const r = await deps.run(CLI_BIN[host], args, CMD_TIMEOUT_MS);
    if (r.timedOut) return bad('TIMEOUT', `${CLI_BIN[host]} ${args[0]} 超时(${Math.round(CMD_TIMEOUT_MS / 1000)}s)`);
    if (r.code !== 0) return bad('CLI_ERROR', `${CLI_BIN[host]} ${args.slice(0, 3).join(' ')} 失败(${r.code}):${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (!Array.isArray(parsed)) return bad('BAD_JSON', 'CLI 输出非 JSON 数组');
      return ok(normalizer(parsed as AnyRec[]));
    } catch {
      return bad('BAD_JSON', 'CLI 输出无法解析为 JSON');
    }
  }

  return {
    async status(): Promise<ForgeStatus> {
      const one = async (host: ForgeHost): Promise<ForgeHostStatus> => {
        if (deps.which(CLI_BIN[host]) === '') return { installed: false, logged: false, user: '' };
        const r = await deps.run(CLI_BIN[host], ['auth', 'status'], 15_000);
        return parseAuthStatus(host, r.stdout, r.stderr, r.code);
      };
      const [github, atomgit] = await Promise.all(HOSTS.map(one) as [Promise<ForgeHostStatus>, Promise<ForgeHostStatus>]);
      return { github, atomgit };
    },

    repos: async (host, page) =>
      cliJson(host, buildListArgs('repos', host, '', 'open'), (rows) => {
        const all = normalizeRepos(host, rows);
        const p = Math.max(1, Math.min(20, page));
        return { repos: all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), hasMore: all.length > p * PAGE_SIZE };
      }),

    prs: (host, repo, state) => cliJson(host, buildListArgs('prs', host, repo, state), (rows) => ({ prs: normalizePrs(rows) })),
    issues: (host, repo, state) => cliJson(host, buildListArgs('issues', host, repo, state), (rows) => ({ issues: normalizeIssues(rows) })),
    releases: (host, repo) => cliJson(host, buildListArgs('releases', host, repo, 'open'), (rows) => ({ releases: normalizeReleases(host, rows) })),

    async action(kind, host, a): Promise<ForgeOk<{ url: string }>> {
      const args = buildActionArgs(kind, host, a);
      if (args === null) return bad('BAD_REQUEST', `写操作 ${kind} 参数不合法`);
      // 路径门:upload/clone 的本地路径必须在工作区/用户目录内且存在
      if ((kind === 'release_upload' || kind === 'repo_clone') && !validateLocalPath(a.file ?? a.dir ?? '', roots())) {
        return bad('BAD_REQUEST', '文件路径必须位于用户目录或已注册工作区内');
      }
      const r = await deps.run(CLI_BIN[host], args.filter((x) => x !== ''), CMD_TIMEOUT_MS);
      if (r.timedOut) return bad('TIMEOUT', `${CLI_BIN[host]} ${kind} 超时`);
      if (r.code !== 0) return bad('CLI_ERROR', `${kind} 失败(${r.code}):${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
      return ok({ url: extractUrl(`${r.stdout}\n${r.stderr}`) });
    },

    /** 登录:spawn 官方 OAuth 流程,stdout 行转发 + URL 外开;不捕获任何令牌。 */
    async login(host): Promise<ForgeOk<{ url: string }>> {
      const args = host === 'github' ? ['auth', 'login', '--web', '--git-protocol', 'https', '--skip-ssh-key'] : ['auth', 'login'];
      let opened = '';
      const r = await deps.run(CLI_BIN[host], args, LOGIN_TIMEOUT_MS, (line) => {
        opts.onLoginLine?.(host, line);
        const url = extractUrl(line);
        // 第一个 URL = 设备授权页:自动外开(任务书:外开系统浏览器);后续行只展示
        if (url !== '' && opened === '') { opened = url; opts.openExternal?.(url); }
      });
      if (r.timedOut) return bad('TIMEOUT', `登录超时(${Math.round(LOGIN_TIMEOUT_MS / 60_000)} 分钟)`);
      // 退出码非 0 不一定失败(用户 Ctrl-C);以事后的 forge:status 轮询为准
      return ok({ url: opened });
    },

    resolve(path) {
      const p = checkStr(path, 1_000);
      if (p === '' || !existsSync(p)) return null;
      return resolveRepoOf(p);
    },
  };
}

export interface ForgeService {
  status(): Promise<ForgeStatus>;
  repos(host: ForgeHost, page: number): Promise<ForgeOk<{ repos: ForgeRepo[]; hasMore: boolean }>>;
  prs(host: ForgeHost, repo: string, state: string): Promise<ForgeOk<{ prs: ForgePr[] }>>;
  issues(host: ForgeHost, repo: string, state: string): Promise<ForgeOk<{ issues: ForgeIssue[] }>>;
  releases(host: ForgeHost, repo: string): Promise<ForgeOk<{ releases: ForgeRelease[] }>>;
  action(kind: ForgeActionKind, host: ForgeHost, a: ForgeActionArgs): Promise<ForgeOk<{ url: string }>>;
  login(host: ForgeHost): Promise<ForgeOk<{ url: string }>>;
  resolve(path: string): { host: ForgeHost; repo: string } | null;
}

/* ---- UIVERIFY fixtures(fake 数据注入;不碰磁盘/网络/凭据) ---- */
export function forgeFixtures() {
  return {
    status: {
      github: { installed: true, logged: true, user: 'swsgbl' },
      // 无 CLI 指引态:atomgit 卡展示安装指引(单测断言"不自动装")
      atomgit: { installed: false, logged: false, user: '' },
    } satisfies ForgeStatus,
    repos: (host: ForgeHost): { repos: ForgeRepo[]; hasMore: boolean } => ({
      repos: host === 'github'
        ? [
            { name: 'hmh-desktop', fullName: 'swsgbl/hmh-desktop', isPrivate: false, updatedAt: '2026-10-29T23:41:04Z', url: 'https://github.com/swsgbl/hmh-desktop', description: 'HMH Desktop(monorepo)' },
            { name: 'ai-learning-os', fullName: 'swsgbl/ai-learning-os', isPrivate: true, updatedAt: '2026-10-29T15:29:52Z', url: 'https://github.com/swsgbl/ai-learning-os', description: 'AI learning OS' },
          ]
        : [
            { name: 'hmh-desktop', fullName: 'hongfu/hmh-desktop', isPrivate: false, updatedAt: '2026-10-29T22:41:49+08:00', url: 'https://atomgit.com/hongfu/hmh-desktop', description: 'HMH Desktop(atomgit 镜像仓)' },
          ],
      hasMore: false,
    }),
    prs: { prs: [{ number: '11', title: 'feat(desktop): 仓库面板(验收 fixture)', state: 'open', isDraft: false, updatedAt: '2026-10-30T09:00:00Z', url: 'https://github.com/swsgbl/hmh-desktop/pull/11' }] },
    issues: { issues: [{ number: '4', title: '仓库面板验收 fixture issue', state: 'open', updatedAt: '2026-10-30T09:00:00Z', url: 'https://github.com/swsgbl/hmh-desktop/issues/4' }] },
    releases: { releases: [{ tag: 'v0.2.10', name: 'v0.2.10 — 更新器 atomgit 国内首选+后台静默更新', createdAt: '2026-10-29T23:37:09+08:00', isDraft: false, isPrerelease: false }] },
    action: { ok: true as const, data: { url: 'https://example.invalid/forge-fixture' } },
    login: { ok: true as const, data: { url: 'https://example.invalid/forge-login-fixture' } },
    resolve: { host: 'github' as ForgeHost, repo: 'swsgbl/hmh-desktop' },
  };
}
