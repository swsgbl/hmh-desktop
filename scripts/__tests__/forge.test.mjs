/**
 * forge.ts 单测(任务 14-B)—— 仓库面板 gh/ag CLI 封装的白名单校验。
 *
 * 覆盖:参数拼装(gh --repo vs ag 位置参数)、auth status 解析、JSON 归一化、
 * 超时/非零退出/坏 JSON 的错误归一、上传/克隆路径门、登录行转发与 URL 外开。
 * spawn 走注入 seam(createForge(deps)),不碰真实 CLI/网络/凭据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildListArgs, buildActionArgs, parseAuthStatus, normalizeRepos, normalizePrs, normalizeReleases,
  extractUrl, validateLocalPath, resolveRepoOf, createForge, checkRepo, checkHost, checkState, resolveCli,
} from '../../apps/desktop/electron/main/forge.ts';

/* ---------- 1. 参数校验纯函数 ---------- */
test('checkHost/checkRepo/checkState:白名单逐参数校验', () => {
  assert.equal(checkHost('github'), 'github');
  assert.equal(checkHost('atomgit'), 'atomgit');
  assert.equal(checkHost('gitlab'), null);
  assert.equal(checkHost(''), null);
  assert.equal(checkRepo('hongfu/hmh-desktop'), 'hongfu/hmh-desktop');
  assert.equal(checkRepo('swsgbl/hmh-desktop'), 'swsgbl/hmh-desktop');
  assert.equal(checkRepo('rm -rf /'), null);
  assert.equal(checkRepo('a/b/c'), null);
  assert.equal(checkRepo(''), null);
  assert.equal(checkState('closed'), 'closed');
  assert.equal(checkState('all'), 'all');
  assert.equal(checkState('open'), 'open');
  assert.equal(checkState('evil'), 'open'); // 非法值回落安全默认
});

/* ---------- 2. 列表命令拼装(gh --repo / ag 位置参数) ---------- */
test('buildListArgs:repos 两平台形状', () => {
  const gh = buildListArgs('repos', 'github', '', 'open');
  assert.equal(gh[0], 'repo');
  assert.ok(gh.includes('--json'));
  assert.ok(gh.join(' ').includes('nameWithOwner'));
  const ag = buildListArgs('repos', 'atomgit', '', 'open');
  // ag 的 --json 是布尔 flag(无字段列表)
  assert.equal(ag.join(' ').indexOf('nameWithOwner'), -1);
});

test('buildListArgs:prs/issues/releases —— gh 用 --repo,ag 用位置参数', () => {
  const ghPr = buildListArgs('prs', 'github', 'o/r', 'closed');
  assert.deepEqual(ghPr.slice(0, 3), ['pr', 'list', '--repo']);
  assert.ok(ghPr.includes('o/r'));
  assert.ok(ghPr.join(' ').includes('isDraft'));
  const agPr = buildListArgs('prs', 'atomgit', 'o/r', 'closed');
  assert.equal(agPr[2], 'o/r'); // 位置参数
  assert.equal(agPr.join(' ').indexOf('--repo'), -1);
  const ghRel = buildListArgs('releases', 'github', 'o/r', 'open');
  assert.ok(ghRel.join(' ').includes('tagName'));
  const agRel = buildListArgs('releases', 'atomgit', 'o/r', 'open');
  assert.equal(agRel[2], 'o/r');
});

/* ---------- 3. 写操作命令拼装 ---------- */
test('buildActionArgs:pr_create/pr_merge/issue_create 形状与校验', () => {
  const gh = buildActionArgs('pr_create', 'github', { repo: 'o/r', title: 'T', body: 'B', base: 'main', head: 'dev' });
  assert.ok(gh.includes('--repo'));
  assert.ok(gh.includes('o/r') && gh.includes('T') && gh.includes('--base'));
  const ag = buildActionArgs('pr_create', 'atomgit', { repo: 'o/r', title: 'T', body: 'B' });
  assert.equal(ag[2], 'o/r');
  assert.equal(buildActionArgs('pr_create', 'github', { repo: 'o/r', title: '', body: '' }), null); // 空标题拒绝
  const m = buildActionArgs('pr_merge', 'github', { repo: 'o/r', number: '11', method: 'squash' });
  assert.ok(m.includes('--squash'));
  const m2 = buildActionArgs('pr_merge', 'atomgit', { repo: 'o/r', number: '11', method: 'merge' });
  assert.ok(m2.includes('--merge') && !m2.includes('--squash'));
  assert.equal(buildActionArgs('pr_merge', 'github', { repo: 'o/r', number: 'abc!', method: '' }), null); // number 非数字拒绝
  assert.ok(buildActionArgs('issue_create', 'github', { repo: 'o/r', title: 'I', body: '' }) !== null);
});

test('buildActionArgs:release_create/upload —— tag 白名单 + atomgit body 必填回退', () => {
  const gh = buildActionArgs('release_create', 'github', { repo: 'o/r', tag: 'v0.2.11', name: '', notes: '', prerelease: true });
  assert.ok(gh.includes('v0.2.11') && gh.includes('--prerelease'));
  const ag = buildActionArgs('release_create', 'atomgit', { repo: 'o/r', tag: 'v0.2.11', name: '', notes: '' });
  // atomgit body 必填:无 notes 回退 tag 文本
  const bi = ag.indexOf('--body');
  assert.equal(ag[bi + 1], 'v0.2.11');
  assert.equal(buildActionArgs('release_create', 'github', { repo: 'o/r', tag: 'v 0.1', notes: '' }), null); // 非法 tag 拒绝
  const up = buildActionArgs('release_upload', 'atomgit', { repo: 'o/r', tag: 'v1', file: 'C:/x.zip' });
  assert.ok(up.includes('v1') && up.includes('C:/x.zip'));
  assert.equal(buildActionArgs('release_upload', 'github', { repo: 'o/r', tag: 'v1', file: '' }), null);
  assert.deepEqual(buildActionArgs('repo_clone', 'github', { repo: 'o/r', dir: 'D:/ws' }), ['repo', 'clone', 'o/r', 'D:/ws']);
});

/* ---------- 4. auth status 解析 ---------- */
test('parseAuthStatus:gh/ag 两种文案的用户名解析', () => {
  assert.deepEqual(
    parseAuthStatus('github', 'github.com\n  ✓ Logged in to github.com account swsgbl (keyring)', '', 0),
    { installed: true, logged: true, user: 'swsgbl' },
  );
  assert.deepEqual(
    parseAuthStatus('atomgit', '', '✓ Logged in to atomgit.com as hongfu', 0),
    { installed: true, logged: true, user: 'hongfu' },
  );
  const out = parseAuthStatus('github', '', 'You are not logged into any GitHub account.', 1);
  assert.equal(out.logged, false);
  assert.equal(out.installed, true); // CLI 存在,只是未登录
});

/* ---------- 5. JSON 归一化(gh/ag 字段差异抹平) ---------- */
test('normalizeRepos:gh isPrivate / ag visibility + number→string', () => {
  const gh = normalizeRepos('github', [{ name: 'r', nameWithOwner: 'o/r', isPrivate: true, updatedAt: '2026', url: 'u', description: '' }]);
  assert.equal(gh[0].isPrivate, true);
  assert.equal(gh[0].fullName, 'o/r');
  const ag = normalizeRepos('atomgit', [{ name: 'r', fullName: 'hongfu/r', visibility: 'private', updatedAt: '2026' }]);
  assert.equal(ag[0].isPrivate, true);
  assert.equal(ag[0].url, 'https://atomgit.com/hongfu/r'); // 缺 url 兜底
  const agPub = normalizeRepos('atomgit', [{ name: 'r', fullName: 'hongfu/r', visibility: 'public' }]);
  assert.equal(agPub[0].isPrivate, false);
});

test('normalizePrs/normalizeReleases:number 统一字符串、draft/prerelease 双字段名', () => {
  const prs = normalizePrs([{ number: 11, title: 'T', state: 'OPEN', isDraft: false, updatedAt: '', url: '' }]);
  assert.equal(prs[0].number, '11');
  assert.equal(prs[0].state, 'open');
  const prsAg = normalizePrs([{ number: '7', title: 'T', state: 'open', draft: true }]);
  assert.equal(prsAg[0].isDraft, true);
  const gh = normalizeReleases('github', [{ tagName: 'v1', name: 'N', createdAt: '2026', isDraft: false, isPrerelease: true }]);
  assert.equal(gh[0].tag, 'v1');
  assert.equal(gh[0].isPrerelease, true);
  const ag = normalizeReleases('atomgit', [{ tag: 'v1', name: 'N', createdAt: '2026', prerelease: true }]);
  assert.equal(ag[0].tag, 'v1');
  assert.equal(ag[0].isPrerelease, true);
});

/* ---------- 6. URL 提取 ---------- */
test('extractUrl:CLI 输出里第一个 https URL(去尾标点)', () => {
  assert.equal(extractUrl('! First copy your one-time code: ABCD-1234\nOpen this URL: https://github.com/login/device.'), 'https://github.com/login/device');
  assert.equal(extractUrl('no url here'), '');
});

/* ---------- 7. 路径门(上传/克隆的本地路径限制) ---------- */
test('validateLocalPath:仅用户主目录/已注册工作区内的绝对路径放行', () => {
  assert.equal(validateLocalPath(join(homedir(), 'Downloads', 'x.zip'), []), true);
  assert.equal(validateLocalPath(join(homedir(), 'some', 'nested', 'dir'), []), true);
  assert.equal(validateLocalPath('C:\\Windows\\System32\\cmd.exe', []), false);
  assert.equal(validateLocalPath('relative/path.zip', []), false); // 相对路径一律拒绝
  const ws = process.platform === 'win32' ? 'D:\\workspaces\\proj' : '/tmp/ws-proj';
  assert.equal(validateLocalPath(join(ws, 'a', 'b.zip'), [ws]), true);
  // 前缀仿冒(D:\workspaces-proj 不是 D:\workspaces 之内)必须拒绝
  assert.equal(validateLocalPath(`${ws}-evil/x.zip`, [ws]), false);
});

/* ---------- 8. 工作区 → 仓库解析(.git/config remote) ---------- */
test('resolveRepoOf:https/ssh 两种 remote 写法,github/atomgit 双识别', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-resolve-'));
  try {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), [
      '[remote "origin"]',
      '\turl = https://github.com/swsgbl/hmh-desktop.git',
      '[remote "up"]',
      '\turl = git@atomgit.com:hongfu/hmh-desktop.git',
      '[core]',
      '\trepositoryformatversion = 0',
    ].join('\n'));
    // origin(第一 remote)是 github
    assert.deepEqual(resolveRepoOf(dir), { host: 'github', repo: 'swsgbl/hmh-desktop' });
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/r.git\n');
    assert.deepEqual(resolveRepoOf(dir), { host: 'github', repo: 'o/r' });
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://atomgit.com/hongfu/hmh-desktop.git\n');
    assert.deepEqual(resolveRepoOf(dir), { host: 'atomgit', repo: 'hongfu/hmh-desktop' });
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://gitee.com/x/y.git\n');
    assert.equal(resolveRepoOf(dir), null); // 非双平台 → null
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- 9. forge 服务(seam 注入):错误归一 / 分页 / 路径门 / 登录流 ---------- */
/** 造一个 seam:按 (cmd, args) 返回预设结果;未命中回 code 0 空 stdout。 */
function fakeDeps(table, log = []) {
  return {
    run: async (cmd, args, timeoutMs, onLine) => {
      log.push([cmd, ...args, `t=${timeoutMs}`]);
      const hit = table.find(([mk, ma]) => mk === cmd && JSON.stringify(ma) === JSON.stringify(args));
      if (hit === undefined) return { code: 0, stdout: '[]', stderr: '', timedOut: false };
      const r = hit[2];
      if (r.lines !== undefined) for (const l of r.lines) onLine?.(l);
      return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.timedOut ?? false };
    },
    which: (cmd) => cmd,
  };
}

test('createForge:repos 超时/非零退出/坏 JSON → 结构化错误', async () => {
  const rows = JSON.stringify(Array.from({ length: 45 }, (_, i) => ({ name: `r${i}`, fullName: `o/r${i}`, visibility: 'public' })));
  // 正常 + 分页(45 条 → 3 页,每页 20)
  const okDeps = fakeDeps([[ 'ag', ['repo', 'list', '--limit', '50', '--json'], { stdout: rows }]]);
  const f1 = createForge(okDeps);
  const p1 = await f1.repos('atomgit', 1);
  assert.equal(p1.ok, true);
  assert.equal(p1.data.repos.length, 20);
  assert.equal(p1.data.hasMore, true);
  const p3 = await f1.repos('atomgit', 3);
  assert.equal(p3.data.repos.length, 5);
  assert.equal(p3.data.hasMore, false);
  // 超时
  const f2 = createForge(fakeDeps([['ag', ['repo', 'list', '--limit', '50', '--json'], { timedOut: true }]]));
  const t = await f2.repos('atomgit', 1);
  assert.equal(t.ok, false);
  assert.equal(t.code, 'TIMEOUT');
  // 非零退出(stderr 尾行进 error)
  const f3 = createForge(fakeDeps([['ag', ['repo', 'list', '--limit', '50', '--json'], { code: 1, stderr: 'boom\nsecond' }]]));
  const e = await f3.repos('atomgit', 1);
  assert.equal(e.ok, false);
  assert.equal(e.code, 'CLI_ERROR');
  assert.ok(e.error.includes('second'));
  // 坏 JSON
  const f4 = createForge(fakeDeps([['ag', ['repo', 'list', '--limit', '50', '--json'], { stdout: 'not json' }]]));
  const j = await f4.repos('atomgit', 1);
  assert.equal(j.code, 'BAD_JSON');
});

test('createForge:prs/issues/releases 走对应命令并归一化', async () => {
  const deps = fakeDeps([
    ['gh', ['pr', 'list', '--repo', 'o/r', '--state', 'open', '--limit', '50', '--json', 'number,title,state,isDraft,updatedAt,url'], { stdout: JSON.stringify([{ number: 11, title: 'T', state: 'OPEN', isDraft: false, updatedAt: '', url: 'u' }]) }],
    ['gh', ['issue', 'list', '--repo', 'o/r', '--state', 'open', '--limit', '50', '--json', 'number,title,state,updatedAt,url'], { stdout: JSON.stringify([{ number: 3, title: 'I', state: 'open' }]) }],
    ['gh', ['release', 'list', '--repo', 'o/r', '--limit', '50', '--json', 'tagName,name,createdAt,isDraft,isPrerelease'], { stdout: JSON.stringify([{ tagName: 'v0.2.10', name: 'N', createdAt: '2026', isDraft: false, isPrerelease: false }]) }],
  ]);
  const f = createForge(deps);
  const prs = await f.prs('github', 'o/r', 'open');
  assert.equal(prs.ok, true);
  assert.equal(prs.data.prs[0].number, '11');
  const iss = await f.issues('github', 'o/r', 'open');
  assert.equal(iss.data.issues[0].number, '3');
  const rel = await f.releases('github', 'o/r');
  assert.equal(rel.data.releases[0].tag, 'v0.2.10');
});

test('createForge:action 路径门 —— repo_clone 的 dir 必须在允许根内', async () => {
  const home = homedir();
  const deps = fakeDeps([['gh', ['repo', 'clone', 'o/r', join(home, 'ws')], { stdout: 'cloned' }]]);
  const f = createForge(deps);
  const ok = await f.action('repo_clone', 'github', { repo: 'o/r', dir: join(home, 'ws') });
  assert.equal(ok.ok, true);
  const bad = await f.action('repo_clone', 'github', { repo: 'o/r', dir: 'C:\\Windows\\temp' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'BAD_REQUEST');
  // upload 同门
  const badUp = await f.action('release_upload', 'github', { repo: 'o/r', tag: 'v1', file: 'C:\\Windows\\sys.zip' });
  assert.equal(badUp.code, 'BAD_REQUEST');
});

test('createForge:login —— 行转发、首个 URL 外开、登录 180s 超时档、令牌永不上行', async () => {
  const seen = [];
  const opened = [];
  const calls = [];
  const deps = {
    run: async (cmd, args, timeoutMs, onLine) => {
      calls.push([cmd, ...args, timeoutMs]);
      for (const l of ['! First copy your one-time code: ABCD-1234', 'Open this URL to continue: https://github.com/login/device', '✓ Authentication complete.']) onLine?.(l);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    which: () => '',
  };
  const f = createForge(deps, {
    onLoginLine: (host, line) => seen.push([host, line]),
    openExternal: (url) => opened.push(url),
  });
  const r = await f.login('github');
  assert.equal(r.ok, true);
  assert.equal(r.data.url, 'https://github.com/login/device'); // 只回 URL,无令牌字段
  assert.deepEqual(opened, ['https://github.com/login/device']); // 首个 URL 自动外开一次
  assert.equal(seen.length, 3);
  assert.equal(seen[0][0], 'github');
  assert.equal(calls[0][calls[0].length - 1], 180_000); // 登录档超时(3 分钟),非命令默认 60s
  assert.equal(JSON.stringify(Object.keys(r.data)), JSON.stringify(['url'])); // 返回体只有 url 键
});

test('createForge:status —— which 未命中 → installed:false;auth 文案 → 用户名', async () => {
  const deps = {
    run: async () => ({ code: 0, stdout: '  ✓ Logged in to github.com account swsgbl (keyring)', stderr: '', timedOut: false }),
    which: (cmd) => (cmd === 'gh' ? 'C:/gh.exe' : ''),
  };
  const f = createForge(deps);
  const st = await f.status();
  assert.deepEqual(st.github, { installed: true, logged: true, user: 'swsgbl' });
  assert.deepEqual(st.atomgit, { installed: false, logged: false, user: '' }); // 未装 CLI
});

/* ---------- 10. Windows npm shim 解析(ag 实机坑:.cmd/无扩展名不能直接 spawn) ---------- */
test('resolveCli:npm .cmd shim → node.exe + node_modules 真身脚本(无 shell,免注入)', () => {
  if (process.platform !== 'win32') return; // Windows 专属解析路径
  const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'));
  const prevPath = process.env.PATH;
  try {
    mkdirSync(join(dir, 'node_modules', '@scope', 'cli', 'bin'), { recursive: true });
    const js = join(dir, 'node_modules', '@scope', 'cli', 'bin', 'ag.js');
    writeFileSync(js, '#!/usr/bin/env node\nprocess.exit(0);\n');
    // npm 标准模板:shim 引用 node_modules 真身
    writeFileSync(join(dir, 'ag.cmd'), `@ECHO off\nSET dp0=%~dp0\n"%_prog%"  "%dp0%\\node_modules\\@scope\\cli\\bin\\ag.js" %*\n`);
    process.env.PATH = `${dir};${prevPath ?? ''}`;
    const r = resolveCli('ag');
    assert.ok(/node(\.exe)?$/i.test(r.bin), `bin 应是 node 可执行,得 ${r.bin}`);
    assert.equal(r.prefix.length, 1);
    assert.equal(r.prefix[0].toLowerCase(), js.toLowerCase());
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCli:裸命令名(未知)→ 原样返回由 spawn 失败兜底', () => {
  const r = resolveCli('forge-definitely-missing-cli-xyz');
  assert.equal(r.prefix.length, 0);
});
