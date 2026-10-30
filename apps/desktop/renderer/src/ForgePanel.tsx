/**
 * 仓库面板(任务 14-B)—— GitHub/AtomGit 双平台:登录卡 / 仓库列表 /
 * PR·Issue 双 tab / Release 区 / 新建表单 / 合并确认卡。
 *
 * 安全语义:renderer 只经 preload 白名单 IPC 调 main 的 forge 服务;
 * 写操作(合并/新建/发布/上传)一律先过确认卡;浏览器逃生口走 forge:open
 * 域名白名单(main 校验),不用 window.open。登录只转述 CLI 输出,令牌不入应用。
 */
import { useCallback, useEffect, useState } from 'react';
import { bridge, type ForgeHost, type ForgeHostStatusDto, type ForgeIssueDto, type ForgePrDto, type ForgeReleaseDto, type ForgeRepoDto, type ForgeStatusDto } from './bridge.ts';
import type { Strings } from './i18n.ts';

type FState = 'open' | 'closed' | 'all';
type NewForm = 'pr' | 'issue' | 'release' | null;
type MergeCtx = { pr: ForgePrDto; method: 'squash' | 'merge' } | null;

const HOST_LABEL: Record<ForgeHost, string> = { github: 'GitHub', atomgit: 'AtomGit' };
const isForgeErr = (r: unknown): r is { error: string; code: string } => typeof r === 'object' && r !== null && 'error' in r && !('ok' in r);
const errText = (r: unknown): string => isForgeErr(r) ? r.error : (r as { error?: string }).error ?? 'unknown';
/** IPC 返回(ForgeOk | {error})→ 数据;出错/失败分支给 null(调用方各显示空态)。 */
function forgeData<T>(r: { ok: true; data: T } | { ok: false; code: string; error: string } | { error: string; code: string }): T | null {
  if ('ok' in r && r.ok === true) return r.data;
  return null;
}

/** CLI 状态点/PR CI 点的统一三态(颜色 + 文字双通道)。 */
function Dot({ cls, label }: { cls: string; label: string }): React.ReactElement {
  return <span className={`forge-dot ${cls}`} aria-hidden="true" title={label} />;
}

/** 平台登录卡:登录态/用户名/登录按钮/未装指引。 */
function HostCard({ L, host, st, busy, lines, onLogin, onRefresh }: {
  L: Strings['forge']; host: ForgeHost; st: ForgeHostStatusDto; busy: boolean;
  lines: string[]; onLogin: (h: ForgeHost) => void; onRefresh: () => void;
}): React.ReactElement {
  const cli = host === 'github' ? 'gh' : 'ag';
  return (
    <div className="forge-host" data-host={host} data-testid={`forge-host-${host}`}>
      <div className="forge-host-head">
        <span className="forge-host-name">{HOST_LABEL[host]}</span>
        {st.logged
          ? <><Dot cls="ok" label={L.loggedAs(st.user)} /><span className="forge-user">{L.loggedAs(st.user)}</span></>
          : st.installed
            ? <><Dot cls="warn" label={L.notLoggedIn} /><span className="forge-user">{L.notLoggedIn}</span></>
            : <><Dot cls="off" label={L.cliMissing} /><span className="forge-user">{L.cliMissing}</span></>}
      </div>
      {st.installed && !st.logged && (
        <div className="forge-host-actions">
          <button className="btn primary sm" disabled={busy} onClick={() => onLogin(host)}>{busy ? L.loginRetry : L.login}</button>
        </div>
      )}
      {!st.installed && <div className="dock-note forge-install-hint">{L.installHint(cli)}</div>}
      {st.installed && !st.logged && lines.length > 0 && (
        <div className="forge-login-lines" aria-label={L.loginLineTitle}>
          <div className="empty-hint">{L.loginOpenHint}</div>
          {lines.slice(-6).map((l, i) => <div key={i} className="forge-login-line">{l}</div>)}
        </div>
      )}
      {st.installed && st.logged && (
        <div className="forge-host-actions">
          <button className="btn ghost sm" onClick={onRefresh}>{L.refresh}</button>
        </div>
      )}
    </div>
  );
}

/** 仓库行:名称/私有标/更新时间 + 行内三动作(克隆/浏览器/hmh)。 */
function RepoRow({ L, repo, busy, onPick, onClone, onBrowse, onAsk }: {
  L: Strings['forge']; repo: ForgeRepoDto; busy: boolean;
  onPick: (r: ForgeRepoDto) => void; onClone: (r: ForgeRepoDto) => void;
  onBrowse: (r: ForgeRepoDto) => void; onAsk: (r: ForgeRepoDto) => void;
}): React.ReactElement {
  return (
    <div className="forge-row repo" data-testid="forge-repo-row">
      <button className="forge-main" onClick={() => onPick(repo)} title={repo.description}>
        <span className="forge-name">{repo.fullName}</span>
        <span className="forge-meta">{repo.isPrivate ? <span className="forge-badge">{L.repoPrivate}</span> : null}{repo.updatedAt.slice(0, 10)}</span>
      </button>
      <div className="forge-actions">
        <button className="btn ghost sm" disabled={busy} onClick={() => void onClone(repo)}>{L.cloneWs}</button>
        <button className="btn ghost sm" onClick={() => void onBrowse(repo)}>{L.browse}</button>
        <button className="btn ghost sm" onClick={() => void onAsk(repo)}>{L.askAgent}</button>
      </div>
    </div>
  );
}

/** PR 行:编号/标题/状态点 + 查看/合并。 */
function PrRow({ L, pr, onMerge, onBrowse }: { L: Strings['forge']; pr: ForgePrDto; onMerge: (p: ForgePrDto) => void; onBrowse: (p: ForgePrDto) => void }): React.ReactElement {
  const ci = pr.state === 'open' ? 'ok' : 'off';
  return (
    <div className="forge-row" data-testid="forge-pr-row">
      <span className="forge-num">#{pr.number}</span>
      <span className="forge-title" title={pr.title}>{pr.isDraft ? `${L.prDraft} · ` : ''}{pr.title}</span>
      <Dot cls={ci} label={L.ciStatus(pr.state)} />
      <div className="forge-actions">
        <button className="btn ghost sm" onClick={() => void onBrowse(pr)}>{L.browse}</button>
        <button className="btn ghost sm" disabled={pr.state !== 'open'} onClick={() => onMerge(pr)}>{L.merge}</button>
      </div>
    </div>
  );
}

/** Issue 行:编号/标题/状态 + 查看。 */
function IssueRow({ L, it, onBrowse }: { L: Strings['forge']; it: ForgeIssueDto; onBrowse: (i: ForgeIssueDto) => void }): React.ReactElement {
  return (
    <div className="forge-row" data-testid="forge-issue-row">
      <span className="forge-num">#{it.number}</span>
      <span className="forge-title" title={it.title}>{it.title}</span>
      <span className={`forge-badge st-${it.state}`}>{it.state === 'open' ? L.stateOpen : L.stateClosed}</span>
      <div className="forge-actions">
        <button className="btn ghost sm" onClick={() => void onBrowse(it)}>{L.browse}</button>
      </div>
    </div>
  );
}

/** 新建表单弹层(pr/issue/release 共用骨架;release 多资产选择)。 */
function NewFormLayer({ L, kind, host, repo, busy, onSubmit, onClose, onPickFile, file }: {
  L: Strings['forge']; kind: 'pr' | 'issue' | 'release'; host: ForgeHost; repo: string; busy: boolean;
  onSubmit: (fields: Record<string, string | boolean>) => void; onClose: () => void;
  onPickFile: () => void; file: string;
}): React.ReactElement {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [tag, setTag] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [pre, setPre] = useState(false);
  const head2 = kind === 'pr' ? L.newPr : kind === 'issue' ? L.newIssue : L.newRelease;
  return (
    <div className="forge-form" role="dialog" aria-label={head2} data-testid="forge-form">
      <div className="forge-form-head">
        <span>{head2} · {HOST_LABEL[host]}/{repo}</span>
        <button className="btn ghost sm" aria-label={L.cancel} onClick={onClose}>✕</button>
      </div>
      {kind === 'release' ? (
        <>
          <input className="session-search" placeholder={L.fTag} value={tag} onChange={(e) => setTag(e.target.value)} aria-label={L.fTag} />
          <input className="session-search" placeholder={L.fName} value={name} onChange={(e) => setName(e.target.value)} aria-label={L.fName} />
          <textarea className="forge-ta" placeholder={L.fNotes} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label={L.fNotes} rows={5} />
          <label className="forge-check"><input type="checkbox" checked={pre} onChange={(e) => setPre(e.target.checked)} />{L.prerelease}</label>
          <div className="forge-file-row">
            <button className="btn ghost sm" onClick={onPickFile}>{L.pickFile}</button>
            <span className="forge-meta" title={file}>{file === '' ? L.fFile : file.split(/[\\/]/).pop() ?? ''}</span>
          </div>
        </>
      ) : (
        <>
          <input className="session-search" placeholder={L.fTitle} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={L.fTitle} />
          <textarea className="forge-ta" placeholder={L.fBody} value={body} onChange={(e) => setBody(e.target.value)} aria-label={L.fBody} rows={4} />
          {kind === 'pr' && (
            <div className="forge-two">
              <input className="session-search" placeholder={L.fBase} value={base} onChange={(e) => setBase(e.target.value)} aria-label={L.fBase} />
              <input className="session-search" placeholder={L.fHead} value={head} onChange={(e) => setHead(e.target.value)} aria-label={L.fHead} />
            </div>
          )}
        </>
      )}
      <div className="forge-form-actions">
        <button className="btn ghost" onClick={onClose}>{L.cancel}</button>
        <button
          className="btn primary"
          disabled={busy || (kind === 'release' ? tag.trim() === '' : title.trim() === '')}
          onClick={() => onSubmit({ title, body, base, head, tag, name, notes, prerelease: pre })}
        >{busy ? L.submitting : L.submit}</button>
      </div>
    </div>
  );
}

/** 合并确认卡(写操作强制确认;method 默认 squash)。 */
function MergeConfirm({ L, pr, method, onMethod, onConfirm, onCancel, busy }: {
  L: Strings['forge']; pr: ForgePrDto; method: 'squash' | 'merge';
  onMethod: (m: 'squash' | 'merge') => void; onConfirm: () => void; onCancel: () => void; busy: boolean;
}): React.ReactElement {
  return (
    <div className="forge-confirm" role="alertdialog" aria-label={L.mergeTitle(pr.number)} data-testid="forge-merge-confirm">
      <div className="forge-form-head"><span>{L.mergeTitle(pr.number)} · {pr.title}</span></div>
      <div className="forge-confirm-body">
        <span className="dock-k">{L.mergeMethod}</span>
        <label className="forge-check"><input type="radio" name="forge-merge-method" checked={method === 'squash'} onChange={() => onMethod('squash')} />{L.mergeSquash}</label>
        <label className="forge-check"><input type="radio" name="forge-merge-method" checked={method === 'merge'} onChange={() => onMethod('merge')} />{L.mergeCommit}</label>
      </div>
      <div className="forge-form-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>{L.cancel}</button>
        <button className="btn primary" onClick={onConfirm} disabled={busy} data-testid="forge-merge-confirm-ok">{busy ? L.submitting : L.confirm}</button>
      </div>
    </div>
  );
}

/**
 * 仓库面板主体。挂 dock 'repos' 页签;所有 IPC 经 bridge(main forge.ts)。
 * onAskAgent 把仓库上下文填进 composer("让 hmh 处理"→ agent 侧 14-A 工具接手)。
 */
export function ForgePanel({ L, onAskAgent, onCloned }: {
  L: Strings; onAskAgent: (text: string) => void; onCloned: () => void;
}): React.ReactElement {
  const F = L.forge;
  const [status, setStatus] = useState<ForgeStatusDto | null>(null);
  const [host, setHost] = useState<ForgeHost>('github');
  const [repos, setRepos] = useState<ForgeRepoDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<{ repo: string } | null>(null);
  const [sub, setSub] = useState<'prs' | 'issues'>('prs');
  const [st, setSt] = useState<FState>('open');
  const [prs, setPrs] = useState<ForgePrDto[]>([]);
  const [issues, setIssues] = useState<ForgeIssueDto[]>([]);
  const [rels, setRels] = useState<ForgeReleaseDto[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState<ForgeHost | null>(null);
  const [lines, setLines] = useState<Partial<Record<ForgeHost, string[]>>>({});
  const [form, setForm] = useState<NewForm>(null);
  const [file, setFile] = useState('');
  const [merge, setMerge] = useState<MergeCtx>(null);
  const [toast, setToast] = useState('');

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    const r = await bridge.forgeStatus();
    if (isForgeErr(r)) { setErr(r.error); return; }
    setStatus(r);
    // 切到已登录的平台,避免默认 github 却未登录
    if (r.github.logged === false && r.atomgit.logged) setHost('atomgit');
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  // 登录输出流(转述 CLI 的 URL/设备码行;令牌永不过来)
  useEffect(() => {
    if (bridge === undefined) return;
    return bridge.onForgeLoginOutput((h, line) => {
      setLines((prev) => ({ ...prev, [h]: [...(prev[h as ForgeHost] ?? []), line].slice(-30) }));
    });
  }, []);

  const loadRepos = useCallback(async (h: ForgeHost, p: number): Promise<void> => {
    if (bridge === undefined) return;
    setBusy(true); setErr('');
    const r = await bridge.forgeRepos(h, p);
    const d = forgeData(r);
    if (d === null) setErr(errText(r));
    else { setRepos(d.repos); setHasMore(d.hasMore); setPage(p); }
    setBusy(false);
  }, []);

  useEffect(() => {
    if (status !== null && status[host].logged && repos.length === 0 && !sel) void loadRepos(host, 1);
  }, [status, host, repos.length, sel, loadRepos]);

  const loadSub = useCallback(async (): Promise<void> => {
    if (bridge === undefined || sel === null) return;
    setBusy(true); setErr('');
    if (sub === 'prs') {
      const r = await bridge.forgePrs(host, sel.repo, st);
      const d = forgeData(r);
      if (d === null) setErr(errText(r));
      else setPrs(d.prs);
    } else {
      const r = await bridge.forgeIssues(host, sel.repo, st);
      const d = forgeData(r);
      if (d === null) setErr(errText(r));
      else setIssues(d.issues);
    }
    const rr = forgeData(await bridge.forgeReleases(host, sel.repo));
    if (rr !== null) setRels(rr.releases);
    setBusy(false);
  }, [host, sel, sub, st]);

  useEffect(() => { if (sel !== null) void loadSub(); }, [sel, sub, st, loadSub]);

  const doLogin = async (h: ForgeHost): Promise<void> => {
    if (bridge === undefined) return;
    setLoginBusy(h); setErr(''); setLines((p) => ({ ...p, [h]: [] }));
    const r = await bridge.forgeLogin(h);
    setLoginBusy(null);
    if (isForgeErr(r)) setErr(F.loginFailed(r.error));
    // 登录结果以 status 为准:refresh 后 useEffect 会自动拉仓库列表
    await refreshStatus();
  };

  const doAction = async (kind: string, h: ForgeHost, args: Record<string, unknown>, okMsg: (url: string) => string): Promise<void> => {
    if (bridge === undefined) return;
    setBusy(true); setErr('');
    const r = await bridge.forgeAction(kind, h, args);
    setBusy(false);
    const d = forgeData(r);
    if (d === null) { setErr(F.failed(errText(r))); return; }
    setToast(okMsg(d.url));
    setTimeout(() => setToast(''), 6_000);
  };

  const doClone = async (repo: ForgeRepoDto): Promise<void> => {
    if (bridge === undefined) return;
    const dir = await bridge.pickDirectory(F.clonePickDir);
    if (!('ok' in dir) || dir.ok !== true || dir.path === undefined || dir.canceled === true) return;
    await doAction('repo_clone', host, { repo: repo.fullName, dir }, () => F.cloneDone(`${dir.path}\\${repo.name}`));
    // 克隆即注册为工作区(复用既有 workspaceAdd 语义)
    await bridge.workspaceAdd(repo.name, `${dir.path}\\${repo.name}`);
    onCloned();
  };

  const openUrl = async (url: string): Promise<void> => {
    if (bridge === undefined || url === '') return;
    await bridge.forgeOpen(url);
  };

  if (bridge === undefined) return <div className="forge-pane"><div className="empty-hint">{F.title}</div></div>;
  const b = bridge;
  const hst = status?.[host];

  return (
    <div className="forge-pane" data-testid="forge-pane">
      {status !== null && (
        <div className="forge-hosts">
          <HostCard L={F} host="github" st={status.github} busy={loginBusy === 'github'} lines={lines.github ?? []} onLogin={(h) => void doLogin(h)} onRefresh={() => void refreshStatus()} />
          <HostCard L={F} host="atomgit" st={status.atomgit} busy={loginBusy === 'atomgit'} lines={lines.atomgit ?? []} onLogin={(h) => void doLogin(h)} onRefresh={() => void refreshStatus()} />
        </div>
      )}
      {status === null && <div className="empty-hint">{L.dock.loading}</div>}

      {sel === null && status !== null && (
        <>
          <div className="forge-host-chips" role="tablist">
            {(['github', 'atomgit'] as ForgeHost[]).map((h) => (
              <button key={h} role="tab" aria-selected={host === h} className={`forge-chip${host === h ? ' active' : ''}`} onClick={() => { setHost(h); setRepos([]); if (status[h].logged) void loadRepos(h, 1); }}>{HOST_LABEL[h]}</button>
            ))}
          </div>
          <div className="forge-head">{F.myRepos}</div>
          {err !== '' && <div className="forge-err" role="alert">{F.loadFailed(err)}</div>}
          {hst?.logged === true && (
            <>
              {repos.map((r) => (
                <RepoRow key={r.fullName} L={F} repo={r} busy={busy}
                  onPick={(x) => { setSel({ repo: x.fullName }); setSub('prs'); setSt('open'); }}
                  onClone={(x) => void doClone(x)} onBrowse={(x) => void openUrl(x.url)}
                  onAsk={(x) => onAskAgent(F.askPrefix(x.fullName))} />
              ))}
              {repos.length === 0 && !busy && <div className="empty-hint">{F.emptyRepos}</div>}
              <div className="forge-pager">
                <button className="btn ghost sm" disabled={page <= 1 || busy} onClick={() => void loadRepos(host, page - 1)}>{F.prevPage}</button>
                <span className="forge-meta">{page}</span>
                <button className="btn ghost sm" disabled={!hasMore || busy} onClick={() => void loadRepos(host, page + 1)}>{F.nextPage}</button>
              </div>
            </>
          )}
        </>
      )}

      {sel !== null && (
        <>
          <button className="btn ghost sm forge-back" onClick={() => { setSel(null); setPrs([]); setIssues([]); setRels([]); void loadRepos(host, page); }}>{F.backToList}</button>
          <div className="forge-head">{HOST_LABEL[host]}/{sel.repo}</div>
          <div className="forge-host-chips" role="tablist">
            <button role="tab" aria-selected={sub === 'prs'} className={`forge-chip${sub === 'prs' ? ' active' : ''}`} onClick={() => setSub('prs')}>{F.tabPrs}</button>
            <button role="tab" aria-selected={sub === 'issues'} className={`forge-chip${sub === 'issues' ? ' active' : ''}`} onClick={() => setSub('issues')}>{F.tabIssues}</button>
            {(['open', 'closed', 'all'] as FState[]).map((s) => (
              <button key={s} className={`forge-chip sm${st === s ? ' active' : ''}`} onClick={() => setSt(s)}>{s === 'open' ? F.stateOpen : s === 'closed' ? F.stateClosed : F.stateAll}</button>
            ))}
            <button className="btn ghost sm" disabled={busy} onClick={() => { setFile(''); setForm(sub === 'prs' ? 'pr' : 'issue'); }}>{sub === 'prs' ? F.newPr : F.newIssue}</button>
          </div>
          {err !== '' && <div className="forge-err" role="alert">{F.loadFailed(err)}</div>}
          {sub === 'prs' ? (
            <>
              {prs.map((p) => <PrRow key={p.number} L={F} pr={p} onMerge={(x) => setMerge({ pr: x, method: 'squash' })} onBrowse={(x) => void openUrl(x.url)} />)}
              {prs.length === 0 && !busy && <div className="empty-hint">{F.emptyRepos}</div>}
            </>
          ) : (
            <>
              {issues.map((i) => <IssueRow key={i.number} L={F} it={i} onBrowse={(x) => void openUrl(x.url)} />)}
              {issues.length === 0 && !busy && <div className="empty-hint">{F.emptyRepos}</div>}
            </>
          )}
          <div className="forge-head">{F.releasesTitle}
            <button className="btn ghost sm" disabled={busy} onClick={() => { setFile(''); setForm('release'); }}>{F.newRelease}</button>
          </div>
          {rels.map((r) => (
            <div key={r.tag} className="forge-row" data-testid="forge-release-row">
              <span className="forge-tag">{r.tag}</span>
              <span className="forge-title" title={r.name}>{r.name}</span>
              {r.isDraft && <span className="forge-badge">{F.tagDraft}</span>}
              {r.isPrerelease && <span className="forge-badge">{F.tagPre}</span>}
              <span className="forge-meta">{r.createdAt.slice(0, 10)}</span>
            </div>
          ))}
          {rels.length === 0 && !busy && <div className="empty-hint">{F.releasesEmpty}</div>}
        </>
      )}

      {toast !== '' && <div className="forge-toast" role="status">{toast}</div>}

      {merge !== null && (
        <MergeConfirm L={F} pr={merge.pr} method={merge.method} busy={busy}
          onMethod={(m) => setMerge({ ...merge, method: m })}
          onConfirm={() => { const m = merge; setMerge(null); void doAction('pr_merge', host, { repo: sel?.repo, number: m.pr.number, method: m.method }, F.done); }}
          onCancel={() => setMerge(null)} />
      )}

      {form !== null && sel !== null && (
        <NewFormLayer L={F} kind={form} host={host} repo={sel.repo} busy={busy} file={file}
          onPickFile={() => { void b.pickFiles(F.pickFile).then((r) => { if ('ok' in r && r.ok === true && r.paths !== undefined && r.paths.length > 0) setFile(r.paths[0] ?? ''); }); }}
          onClose={() => setForm(null)}
          onSubmit={(f) => {
            const kind = form; setForm(null);
            if (kind === 'pr') void doAction('pr_create', host, { repo: sel.repo, title: f.title, body: f.body, base: f.base, head: f.head }, F.done).then(loadSub);
            else if (kind === 'issue') void doAction('issue_create', host, { repo: sel.repo, title: f.title, body: f.body }, F.done).then(loadSub);
            else void doAction('release_create', host, { repo: sel.repo, tag: f.tag, name: f.name, notes: f.notes, prerelease: f.prerelease }, F.done)
              .then(async () => { if (file !== '') await doAction('release_upload', host, { repo: sel.repo, tag: f.tag, file }, F.done); })
              .then(loadSub);
          }} />
      )}
    </div>
  );
}

/**
 * composer 的 `/repo` 斜杠面板:当前工作区关联仓库的 PR/Issue 一览(只读快捷入口)。
 * 解析链:forge:resolve 读工作区 .git/config → 失败则提示未关联;完整操作进仓库页签。
 */
export function RepoSlashPanel({ L, wsPath, onOpenPanel }: {
  L: Strings; wsPath: string; onOpenPanel: () => void;
}): React.ReactElement {
  const F = L.forge;
  const b = bridge;
  const [ctx, setCtx] = useState<{ host: ForgeHost; repo: string } | null>(null);
  const [rows, setRows] = useState<Array<{ kind: 'pr' | 'issue'; number: string; title: string; url: string }>>([]);

  useEffect(() => {
    let alive = true;
    if (b === undefined || wsPath === '') { setCtx(null); return; }
    void b.forgeResolve(wsPath).then(async (r) => {
      if (!alive || r === null || 'error' in r) { setCtx(null); return; }
      setCtx(r);
      // 一览:开放 PR + 开放 Issue 各前 5(只读)
      const pd = forgeData(await b.forgePrs(r.host, r.repo, 'open'));
      const id = forgeData(await b.forgeIssues(r.host, r.repo, 'open'));
      if (!alive) return;
      const prRows = (pd?.prs ?? []).slice(0, 5).map((p) => ({ kind: 'pr' as const, number: p.number, title: p.title, url: p.url }));
      const isRows = (id?.issues ?? []).slice(0, 5).map((i) => ({ kind: 'issue' as const, number: i.number, title: i.title, url: i.url }));
      setRows([...prRows, ...isRows]);
    });
    return () => { alive = false; };
  }, [b, wsPath]);

  return (
    <div className="repo-slash" data-testid="repo-slash" role="dialog" aria-label={F.panelTitle}>
      <div className="forge-form-head">
        <span>{F.panelTitle}{ctx !== null ? ` · ${HOST_LABEL[ctx.host]}/${ctx.repo}` : ''}</span>
        <button className="btn ghost sm" onClick={onOpenPanel}>{F.openPanel}</button>
      </div>
      {ctx === null && <div className="empty-hint">{F.panelNone}</div>}
      {ctx !== null && rows.length === 0 && <div className="empty-hint">{F.emptyRepos}</div>}
      {rows.map((r) => (
        <div key={`${r.kind}-${r.number}`} className={`forge-row slash ${r.kind}`} data-testid="repo-slash-row">
          <span className="forge-num">{r.kind === 'pr' ? '!' : '#'}{r.number}</span>
          <span className="forge-title" title={r.title}>{r.title}</span>
          <button className="btn ghost sm" onClick={() => { if (b !== undefined) void b.forgeOpen(r.url); }}>{F.browse}</button>
        </div>
      ))}
    </div>
  );
}
