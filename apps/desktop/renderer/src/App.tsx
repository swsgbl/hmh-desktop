/**
 * HMH Desktop renderer(阶段E+ M4/M5)。
 * 左栏会话导航 / 中栏聊天流(流式 delta、工具折叠卡、审批卡)/ 右 Context Dock
 * (Overview / Files / Evidence)/ 底部 Composer。
 * 所有外部字符串只按文本渲染(React 文本节点天然转义)。
 * 事件按 sessionId 过滤;审批的权威在 runtime,UI 只转述与转发;
 * Files/Evidence 的路径与数据全部来自后端授权 DTO。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope, RunStatus } from '@hmh-desktop/contracts';
import { bridge, type BridgeState, type DiffDto, type FsListDto, type FsReadDto, type SessionPreviewDto } from './bridge.ts';

const STATUS_LABEL: Record<string, string> = {
  planning: '规划中',
  running: '运行中',
  waiting_approval: '等待审批',
  verifying: '验证中',
  recovering: '恢复中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

interface SessionRow {
  id: string;
  title: string;
  task: string;
  turns: number;
  toolUses: number;
  updatedAt: string;
}

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; argsPreview: string; outputPreview?: string; isError?: boolean }
  | { kind: 'approval'; id: string; approvalId: string; tool: string; argsPreview: string; risk: string }
  | { kind: 'artifact'; id: string; relPath: string; title: string }
  | { kind: 'error'; id: string; code: string; message: string; sessionId: string; runId: string };

type DockTab = 'overview' | 'files' | 'diff' | 'evidence' | 'logs';

export function App(): React.ReactElement {
  const [state, setState] = useState<BridgeState | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeSession, setActiveSession] = useState<string>('');
  const [items, setItems] = useState<Item[]>([]);
  const [streaming, setStreaming] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [dockOpen, setDockOpen] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>('overview');
  const [hostState, setHostState] = useState<string>('stopped');
  const [hostInfo, setHostInfo] = useState<{ restartCount: number; lastError?: string }>({ restartCount: 0 });
  const [approvalBusy, setApprovalBusy] = useState(false);
  // Files 面板(M4)
  const [fsPath, setFsPath] = useState('');
  const [fsData, setFsData] = useState<FsListDto | null>(null);
  const [fsPreview, setFsPreview] = useState<{ name: string; text: string; binary: boolean } | null>(null);
  // Evidence 面板(M5)
  const [cog, setCog] = useState<Record<string, unknown> | null>(null);
  // Diff 面板(M4)
  const [diff, setDiff] = useState<DiffDto | null>(null);
  // Logs 面板:runtime 的 line 流(运行日志,最近 200 条)
  const [logs, setLogs] = useState<Array<{ sessionId: string; text: string }>>([]);
  // Ctrl+K 命令面板 / 设置弹层 / 分页游标 / 本地偏好
  const [cmdOpen, setCmdOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [enterSends, setEnterSends] = useState<boolean>(() => {
    try { return window.localStorage.getItem('hmh.enterSends') !== 'newline'; } catch { return true; }
  });
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto'>('ask');
  const streamRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef('');
  activeRef.current = activeSession;

  const applyEnvelope = useCallback((env: EventEnvelope) => {
    if (env.kind === 'run.started') {
      setRunStatus('running');
      setStreaming('');
      setItems((prev) => [
        ...prev,
        { kind: 'user', id: env.eventId, text: String((env.payload as { task?: string }).task ?? '') },
      ]);
    } else if (env.kind === 'tool.started') {
      const p = env.payload as { name?: string; argsPreview?: string };
      setItems((prev) => [...prev, { kind: 'tool', id: env.eventId, name: String(p.name ?? ''), argsPreview: String(p.argsPreview ?? '') }]);
    } else if (env.kind === 'tool.completed') {
      const p = env.payload as { name?: string; outputPreview?: string; isError?: boolean };
      setItems((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const it = next[i]!;
          if (it.kind === 'tool' && it.name === String(p.name ?? '') && it.outputPreview === undefined) {
            next[i] = { ...it, outputPreview: String(p.outputPreview ?? ''), isError: p.isError === true };
            break;
          }
        }
        return next;
      });
    } else if (env.kind === 'approval.required') {
      setRunStatus('waiting_approval');
      const p = env.payload as { approvalId?: string; tool?: string; argsPreview?: string; risk?: string };
      setItems((prev) => [...prev, {
        kind: 'approval', id: env.eventId,
        approvalId: String(p.approvalId ?? ''),
        tool: String(p.tool ?? ''),
        argsPreview: String(p.argsPreview ?? ''),
        risk: String(p.risk ?? ''),
      }]);
    } else if (env.kind === 'artifact.created') {
      const a = (env.payload as { artifact?: { relPath?: string; title?: string; kind?: string } }).artifact;
      if (a !== undefined) {
        setItems((prev) => [...prev, { kind: 'artifact', id: env.eventId, relPath: String(a.relPath ?? ''), title: String(a.title ?? a.relPath ?? '') }]);
      }
    } else if (env.kind === 'run.completed') {
      setRunStatus('completed');
      setStreaming('');
      const p = env.payload as { text?: string };
      setItems((prev) => [
        ...prev,
        { kind: 'assistant', id: env.eventId, text: String(p.text ?? '') },
      ]);
    } else if (env.kind === 'run.failed') {
      setRunStatus('failed');
      setStreaming('');
      const p = (env.payload as { error?: { code?: string; message?: string } }).error;
      // DoD:错误 UI 中 sessionId/runId 可追踪(恢复/导出不静默分叉)
      setItems((prev) => [
        ...prev,
        {
          kind: 'error', id: env.eventId,
          code: String(p?.code ?? 'UNKNOWN'),
          message: String(p?.message ?? '任务失败'),
          sessionId: env.sessionId, runId: env.runId,
        },
      ]);
    }
  }, []);

  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.getState().then(setState);
    const offState = bridge.onHostState((s, info) => {
      setHostState(s);
      setHostInfo(info);
      if (s === 'ready') void refreshSessions();
    });
    const offEvents = bridge.onEventBatches((batch) => {
      for (const env of batch) applyEnvelope(env);
    });
    // 高频流块:当前会话的 text delta 拼接;line 帧进 Logs 面板
    const offChunks = bridge.onStreamChunks((c) => {
      if (c.kind === 'text' && c.sessionId === activeRef.current && c.chunk !== '') {
        setStreaming((prev) => (prev + c.chunk).slice(-40_000));
      } else if (c.kind === 'line' && c.chunk !== '') {
        setLogs((prev) => [...prev.slice(-199), { sessionId: c.sessionId, text: c.chunk }]);
      }
    });
    return () => { offState(); offEvents(); offChunks(); };
  }, [applyEnvelope]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [items, streaming]);

  const refreshSessions = useCallback(async (cur: string | null = null) => {
    if (bridge === undefined) return;
    const r = await bridge.sessions();
    if ('sessions' in r && Array.isArray(r.sessions)) {
      const mapped = r.sessions.map((s) => ({ id: s.id, title: s.title, task: s.task, turns: s.turns, toolUses: s.toolUses, updatedAt: s.updatedAt }));
      setSessions((prev) => (cur === null ? mapped : [...prev, ...mapped.filter((m) => !prev.some((p) => p.id === m.id))]));
      setCursor('nextCursor' in r && typeof r.nextCursor === 'string' ? r.nextCursor : null);
    }
  }, []);

  useEffect(() => {
    if (hostState === 'ready') void refreshSessions(null);
  }, [hostState, refreshSessions]);

  /** 运行中注入(03 §六:输入在长任务时仍可用;非幂等动作由用户显式触发)。 */
  const inject = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    setDraft('');
    await bridge.inject(text, activeSession);
    setItems((prev) => [...prev, { kind: 'user', id: `inj-${Date.now()}`, text: `${text}(已注入运行中任务)` }]);
  }, [draft, activeSession]);

  /** 会话导出(runtime 同源 builder;文件写入只在 main 的保存对话框后)。 */
  const exportSession = useCallback(async (id: string) => {
    if (bridge === undefined) return;
    const r = await bridge.exportSession(id);
    if ('ok' in r && r.ok === true && r.path !== undefined) {
      setExportHint(`已导出:${r.path}`);
      setTimeout(() => setExportHint(''), 4_000);
    } else if ('canceled' in r && r.canceled === true) {
      /* 用户取消 */
    } else if ('error' in r) {
      setExportHint(`导出失败:${r.error}`);
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, []);

  const [exportHint, setExportHint] = useState('');

  /** 审批模式(权威在 runtime;切换显式且即时生效)。 */
  useEffect(() => {
    if (bridge === undefined || hostState !== 'ready') return;
    void bridge.approvalGet().then((r) => {
      if ('settings' in r && r.settings?.approval === 'auto') setApprovalMode('auto');
      else setApprovalMode('ask');
    });
  }, [hostState]);

  const switchApproval = useCallback(async (mode: 'ask' | 'auto') => {
    if (bridge === undefined) return;
    await bridge.approvalSet(mode);
    setApprovalMode(mode);
  }, []);

  const setEnterBehavior = useCallback((sends: boolean): void => {
    setEnterSends(sends);
    try { window.localStorage.setItem('hmh.enterSends', sends ? 'send' : 'newline'); } catch { /* 私有模式 */ }
  }, []);

  /** 历史会话:加载 runtime 的 transcript 预览(最后 80 条)。 */
  const openSession = useCallback(async (id: string) => {
    setActiveSession(id);
    setItems([]);
    setStreaming('');
    setRunStatus(null);
    if (bridge === undefined) return;
    const r = await bridge.sessionPreview(id);
    if ('messages' in r && Array.isArray(r.messages)) {
      const loaded: Item[] = [];
      for (const m of r.messages) {
        if (m.role === 'user') loaded.push({ kind: 'user', id: `h-u-${loaded.length}`, text: m.text });
        else if (m.role === 'assistant') loaded.push({ kind: 'assistant', id: `h-a-${loaded.length}`, text: m.text });
      }
      setItems(loaded.slice(-40));
    }
  }, []);

  const newSession = useCallback(() => {
    const id = `web-${Date.now().toString(36)}`;
    setSessions((prev) => [{ id, title: '新会话', task: '', turns: 0, toolUses: 0, updatedAt: new Date().toISOString() }, ...prev]);
    setActiveSession(id);
    setItems([]);
    setStreaming('');
    setRunStatus(null);
  }, []);

  // Ctrl+K 命令面板 / Ctrl+N 新会话(03 §六;键盘优先)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newSession();
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSession]);

  const send = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    setDraft('');
    setRunStatus('running');
    setItems((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, text }]);
    const r = await bridge.sendTask(text, activeSession, 'ask');
    if ('ok' in r && r.ok !== true) {
      setItems((prev) => [...prev, { kind: 'error', id: `send-${Date.now()}`, code: 'code' in r ? String(r.code) : 'SEND_FAILED', message: '发送失败(host 未就绪或拒绝)', sessionId: activeSession, runId: '(未建立运行)' }]);
      setRunStatus(null);
    }
  }, [draft, activeSession]);

  const approve = useCallback(async (granted: boolean) => {
    if (bridge === undefined || activeSession === '') return;
    setApprovalBusy(true);
    await bridge.approve(granted, activeSession);
    setTimeout(() => setApprovalBusy(false), 400);
  }, [activeSession]);

  const interrupt = useCallback(async () => {
    if (bridge === undefined || activeSession === '') return;
    await bridge.interrupt(activeSession);
    setRunStatus(null);
  }, [activeSession]);

  /* ---- M4:Files 面板 ---- */
  const loadFs = useCallback(async (path: string) => {
    if (bridge === undefined) return;
    setFsPreview(null);
    const r = await bridge.fsList(path);
    if ('dirs' in r) {
      setFsData(r);
      setFsPath(r.path);
    }
  }, []);

  const previewFile = useCallback(async (path: string) => {
    if (bridge === undefined) return;
    const r = await bridge.fsRead(path);
    if ('text' in r && r.text !== undefined) {
      setFsPreview({ name: r.rel ?? path, text: r.text, binary: r.binary === true });
    } else if ('binary' in r && r.binary === true) {
      setFsPreview({ name: r.rel ?? path, text: '(二进制文件)', binary: true });
    }
  }, []);

  /* ---- M5:Evidence 面板 ---- */
  const loadCog = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.cognitive();
    if (!('error' in r)) setCog(r);
  }, []);

  /** Diff 面板(M4):只读 git 变更(会话 cwd)。 */
  const loadDiff = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.diff(activeSession);
    if (!('error' in r)) setDiff(r);
  }, [activeSession]);

  useEffect(() => {
    if (dockTab === 'files' && fsData === null && hostState === 'ready') void loadFs('');
    if (dockTab === 'evidence' && cog === null && hostState === 'ready') void loadCog();
    if (dockTab === 'diff' && hostState === 'ready') void loadDiff();
  }, [dockTab, hostState, fsData, cog, loadFs, loadCog, loadDiff]);

  const runCommand = useCallback((cmd: string): void => {
    setCmdOpen(false);
    if (cmd === 'new-session') newSession();
    else if (cmd === 'stop') void interrupt();
    else if (cmd.startsWith('tab:')) setDockTab(cmd.slice(4) as DockTab);
    else if (cmd === 'dock') setDockOpen((v) => !v);
  }, [newSession, interrupt]);

  const hostBadge = useMemo(() => {
    const label = state !== null && hostState === 'ready' ? '已连接' : STATUS_LABEL[hostState] ?? hostState;
    const connected = hostState === 'ready';
    return {
      label,
      connected,
      detail: connected ? `runtime ${state?.hostVersion ?? '?'} · 127.0.0.1:${state?.hostPort ?? '?'}` : hostInfo.lastError ?? '',
    };
  }, [state, hostState, hostInfo]);

  const busy = runStatus === 'running' || runStatus === 'waiting_approval' || runStatus === 'planning' || runStatus === 'verifying';
  const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '无数据');

  return (
    <div className="app-shell">
      {cmdOpen && (
        <div className="cmdk-overlay" role="dialog" aria-label="命令面板" onClick={() => setCmdOpen(false)}>
          <div className="cmdk" onClick={(e) => e.stopPropagation()}>
            <div className="cmdk-head">命令面板(Ctrl+K · Ctrl+N 新会话)</div>
            {[
              { cmd: 'new-session', label: '新建会话' },
              { cmd: 'tab:overview', label: '上下文:Overview' },
              { cmd: 'tab:files', label: '上下文:Files' },
              { cmd: 'tab:diff', label: '上下文:Diff' },
              { cmd: 'tab:evidence', label: '上下文:Evidence' },
              { cmd: 'tab:logs', label: '上下文:Logs' },
              { cmd: 'dock', label: '切换右栏显示' },
              { cmd: 'stop', label: '停止当前任务' },
            ].map((c) => (
              <button key={c.cmd} className="cmdk-item" onClick={() => runCommand(c.cmd)}>{c.label}</button>
            ))}
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="cmdk-overlay" role="dialog" aria-label="设置" onClick={() => setSettingsOpen(false)}>
          <div className="cmdk settings" onClick={(e) => e.stopPropagation()}>
            <div className="cmdk-head">设置</div>
            <div className="settings-section">应用偏好(本地存储)</div>
            <div className="settings-row">
              <span>Enter 键行为</span>
              <div className="seg">
                <button className={enterSends ? 'on' : ''} onClick={() => setEnterBehavior(true)}>发送</button>
                <button className={!enterSends ? 'on' : ''} onClick={() => setEnterBehavior(false)}>换行(Ctrl+Enter 发送)</button>
              </div>
            </div>
            <div className="settings-section">运行时(写入 hmharness config)</div>
            <div className="settings-row">
              <span>审批模式</span>
              <div className="seg">
                <button className={approvalMode === 'ask' ? 'on' : ''} onClick={() => void switchApproval('ask')}>ask(默认,安全)</button>
                <button className={approvalMode === 'auto' ? 'on' : ''} onClick={() => void switchApproval('auto')}>auto(自动批准)</button>
              </div>
            </div>
            <div className="settings-note">auto 即时生效并持久;破坏性操作仍受 runtime 审批门约束。</div>
          </div>
        </div>
      )}
      <aside className="sidebar" aria-label="会话导航">
        <div className="sidebar-head">
          <button className="btn primary" onClick={newSession}>+ 新建会话</button>
        </div>
        <div className="session-list" role="list">
          {sessions.map((s) => (
            <div key={s.id} role="listitem" className={`session-row${s.id === activeSession ? ' active' : ''}`}>
              <button
                className="session-item"
                onClick={() => void openSession(s.id)}
                aria-label={`打开会话 ${s.title !== '' ? s.title : s.id}`}
              >
                <span className="session-title">{s.title !== '' ? s.title : s.task.slice(0, 40) || s.id}</span>
                <span className="session-time">{s.updatedAt.slice(0, 16).replace('T', ' ')}</span>
              </button>
              <button className="session-export" aria-label={`导出会话 ${s.id} 为 Markdown`} title="导出 Markdown" onClick={() => void exportSession(s.id)}>⤓</button>
            </div>
          ))}
          {sessions.length === 0 && <div className="empty-hint">点"新建会话"开始</div>}
          {cursor !== null && (
            <button className="btn ghost sm more" onClick={() => void refreshSessions(cursor)}>加载更多</button>
          )}
          {exportHint !== '' && <div className="export-hint" role="status">{exportHint}</div>}
        </div>
      </aside>

      <main className="workspace" aria-label="主工作区">
        <header className="topbar">
          <span className={`host-dot ${hostBadge.connected ? 'on' : 'off'}`} aria-hidden="true" />
          <span className="host-label">{hostBadge.label}{hostBadge.detail !== '' ? ` · ${hostBadge.detail}` : ''}</span>
          <span className="spacer" />
          {busy && runStatus !== null && (
            <span className={`status-chip status-${runStatus}`}>
              <span className="dot" aria-hidden="true" />
              {STATUS_LABEL[runStatus] ?? runStatus}
            </span>
          )}
          {busy && <button className="btn danger" onClick={() => void interrupt()}>停止</button>}
          <span className={`approval-mode${approvalMode === 'auto' ? ' auto' : ''}`} title="点击设置切换">审批:{approvalMode === 'ask' ? 'ask(默认)' : 'auto'}</span>
          <button className="btn ghost" aria-label="设置" onClick={() => setSettingsOpen(true)}>⚙</button>
          <button className="btn ghost" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen}>
            {dockOpen ? '收起上下文' : '展开上下文'}
          </button>
        </header>

        <div className="stream" ref={streamRef} aria-live="polite">
          {items.length === 0 && streaming === '' && (
            <div className="empty-hint big">
              {activeSession === '' ? '新建一个会话,或从左侧选择' : '输入你的目标,回车发送 · Shift+Enter 换行'}
            </div>
          )}
          {items.map((it) => {
            if (it.kind === 'user') {
              return (
                <article key={it.id} className="turn user">
                  <p className="turn-text">{it.text}</p>
                </article>
              );
            }
            if (it.kind === 'assistant') {
              return (
                <article key={it.id} className="turn">
                  <p className="turn-text">{it.text}</p>
                </article>
              );
            }
            if (it.kind === 'tool') {
              return (
                <details key={it.id} className="tool-card">
                  <summary>
                    <span className={`tool-badge${it.isError === true ? ' err' : ''}`}>{it.isError === true ? '✕' : '⚙'}</span>
                    {it.name}
                    {it.outputPreview === undefined ? <span className="tool-running"> 执行中…</span> : null}
                  </summary>
                  <pre className="tool-io">{it.argsPreview}</pre>
                  {it.outputPreview !== undefined && <pre className="tool-io out">{it.outputPreview}</pre>}
                </details>
              );
            }
            if (it.kind === 'approval') {
              return (
                <article key={it.id} className="turn approval-card" aria-label="等待审批">
                  <div className="approval-head">
                    <span className="approval-icon">🛡</span> 需要审批:{it.tool}
                  </div>
                  <pre className="tool-io">{it.argsPreview}</pre>
                  <p className="approval-risk">{it.risk}</p>
                  <div className="approval-actions">
                    <button className="btn primary" disabled={approvalBusy} onClick={() => void approve(true)}>批准</button>
                    <button className="btn danger" disabled={approvalBusy} onClick={() => void approve(false)}>拒绝</button>
                  </div>
                </article>
              );
            }
            if (it.kind === 'artifact') {
              return (
                <div key={it.id} className="artifact-card" aria-label="交付物">
                  <span className="artifact-icon" aria-hidden="true">📦</span>
                  <span className="artifact-title">{it.title}</span>
                  <span className="artifact-hint">交付物(工作区相对路径;可在 Files 面板预览)</span>
                </div>
              );
            }
            return (
              <article key={it.id} className="turn system">
                <div className="status-chip status-failed"><span className="dot" aria-hidden="true" />{it.code}</div>
                <p className="turn-text">{it.message}</p>
                <div className="err-meta">会话 {it.sessionId} · 运行 {it.runId}(恢复/导出跟随原会话)</div>
              </article>
            );
          })}
          {streaming !== '' && (
            <article className="turn streaming">
              <p className="turn-text">{streaming}<span className="cursor" aria-hidden="true">▍</span></p>
            </article>
          )}
        </div>

        <footer className="composer">
          <textarea
            value={draft}
            placeholder={activeSession === ''
              ? '先新建会话(Ctrl+N)…'
              : busy
                ? '任务运行中——输入将注入当前任务(Enter 注入)'
                : enterSends
                  ? '描述目标(Enter 发送,Shift+Enter 换行)'
                  : '描述目标(Enter 换行,Ctrl+Enter 发送)'}
            disabled={activeSession === ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
              const withCtrl = e.ctrlKey || e.metaKey;
              const shouldAct = busy ? plain || withCtrl : (enterSends ? plain : withCtrl);
              if (shouldAct) {
                e.preventDefault();
                if (busy) void inject();
                else void send();
              }
            }}
            aria-label="任务输入"
          />
          <div className="composer-side">
            <button
              className={`btn send ${busy ? 'ghost' : 'primary'}`}
              onClick={() => (busy ? void inject() : void send())}
              disabled={draft.trim() === '' || activeSession === ''}
            >
              {busy ? '注入运行中任务' : '发送'}
            </button>
          </div>
        </footer>
      </main>

      {dockOpen && (
        <aside className="dock" aria-label="上下文面板">
          <div className="dock-tabs" role="tablist">
            {(['overview', 'files', 'diff', 'evidence', 'logs'] as DockTab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={dockTab === t}
                className={`dock-tab${dockTab === t ? ' active' : ''}`}
                onClick={() => setDockTab(t)}
              >
                {t === 'overview' ? 'Overview' : t === 'files' ? 'Files' : t === 'diff' ? 'Diff' : t === 'evidence' ? 'Evidence' : 'Logs'}
              </button>
            ))}
          </div>
          <div className="dock-body">
            {dockTab === 'overview' && (
              <>
                <div className="dock-row"><span className="dock-k">host 状态</span><span className="dock-v">{hostBadge.label}</span></div>
                <div className="dock-row"><span className="dock-k">runtime 版本</span><span className="dock-v">{state?.hostVersion ?? '无数据'}</span></div>
                <div className="dock-row"><span className="dock-k">模式</span><span className="dock-v">{state?.mode ?? '—'}</span></div>
                <div className="dock-row"><span className="dock-k">会话数</span><span className="dock-v">{sessions.length}</span></div>
                <div className="dock-row"><span className="dock-k">当前会话</span><span className="dock-v">{activeSession === '' ? '—' : activeSession}</span></div>
                <div className="dock-row"><span className="dock-k">运行状态</span><span className="dock-v">{runStatus === null ? '空闲' : STATUS_LABEL[runStatus] ?? runStatus}</span></div>
                <div className="dock-note">工具轨迹默认折叠;证据缺失显示"无数据",不假填 0。</div>
              </>
            )}
            {dockTab === 'files' && (
              <div className="files-pane">
                <div className="fs-crumbs">
                  <button className="btn ghost sm" onClick={() => void loadFs(fsData?.parent ?? '')} disabled={fsData === null || fsData.parent === ''}>↑ 上级</button>
                  <span className="fs-path">{fsPath === '' ? '(选择工作区根)' : fsPath}</span>
                </div>
                <div className="fs-list">
                  {(fsData?.dirs ?? []).map((d) => (
                    <button key={d.path} className="fs-row dir" onClick={() => void loadFs(d.path)}>📁 {d.name}</button>
                  ))}
                  {(fsData?.files ?? []).map((f) => (
                    <button key={f.path} className="fs-row" onClick={() => void previewFile(f.path)}>📄 {f.name}</button>
                  ))}
                  {fsData !== null && (fsData.dirs.length === 0 && (fsData.files ?? []).length === 0) && <div className="empty-hint">(空目录)</div>}
                  {fsData === null && <div className="empty-hint">{hostState === 'ready' ? '加载中…' : 'host 未连接'}</div>}
                </div>
                {fsPreview !== null && (
                  <div className="fs-preview">
                    <div className="fs-preview-head">{fsPreview.name}(预览,64KB 上限)</div>
                    <pre className="tool-io out">{fsPreview.text}</pre>
                  </div>
                )}
              </div>
            )}
            {dockTab === 'diff' && (
              <div className="diff-pane">
                {diff === null && <div className="empty-hint">{hostState === 'ready' ? '加载中…' : 'host 未连接'}</div>}
                {diff !== null && !diff.git && <div className="empty-hint">非 git 工作区({diff.cwd})</div>}
                {diff !== null && diff.git && (
                  <>
                    <div className="fs-preview-head">{diff.cwd}(git 变更 {diff.changed.length} 项,只读)</div>
                    <div className="fs-list">
                      {diff.changed.map((c) => (
                        <div key={c.path} className="diff-row">
                          <span className={`diff-state ${c.state.includes('D') ? 'del' : c.state.includes('A') || c.state.includes('?') ? 'add' : 'mod'}`}>{c.state || 'M'}</span>
                          <span className="diff-path">{c.path}</span>
                        </div>
                      ))}
                      {diff.changed.length === 0 && <div className="empty-hint">(无变更)</div>}
                    </div>
                    {diff.stat !== '' && <pre className="tool-io out">{diff.stat}</pre>}
                  </>
                )}
              </div>
            )}
            {dockTab === 'evidence' && (
              <div className="evidence-pane">
                <div className="dock-row"><span className="dock-k">记忆层</span><span className="dock-v">{cog === null ? '加载中…' : num((cog.memory as { layers?: unknown } | undefined)?.layers)}</span></div>
                <div className="dock-row"><span className="dock-k">记忆条目</span><span className="dock-v">{cog === null ? '…' : num((cog.memory as { entries?: unknown } | undefined)?.entries)}</span></div>
                <div className="dock-row"><span className="dock-k">轨迹数</span><span className="dock-v">{cog === null ? '…' : num(cog.trajectories)}</span></div>
                <div className="dock-row"><span className="dock-k">审计事件</span><span className="dock-v">{cog === null ? '…' : num(cog.auditEvents)}</span></div>
                <div className="dock-row"><span className="dock-k">世界模型版本</span><span className="dock-v">{cog === null ? '…' : num((cog.worldModel as { version?: unknown } | undefined)?.version)}</span></div>
                <div className="dock-row"><span className="dock-k">WM Brier</span><span className="dock-v">{cog === null ? '…' : num((cog.worldModel as { brier?: unknown } | undefined)?.brier)}</span></div>
                <div className="dock-row"><span className="dock-k">校准预测数</span><span className="dock-v">{cog === null ? '…' : num((cog.calibration as { predictions?: unknown } | undefined)?.predictions)}</span></div>
                <div className="dock-row"><span className="dock-k">校准可靠性</span><span className="dock-v">{cog === null ? '…' : num((cog.calibration as { reliability?: unknown } | undefined)?.reliability)}</span></div>
                <div className="dock-note">只显示结构化事实;Brier 是预测校准指标,不代表任务成功率(审核报告 P0-D 口径)。</div>
              </div>
            )}
            {dockTab === 'logs' && (
              <div className="logs-pane">
                <div className="fs-preview-head">运行日志(runtime line 流,最近 200 条)</div>
                <div className="logs-list">
                  {logs.map((l, i) => (
                    <div key={`${i}-${l.text.slice(0, 20)}`} className="log-row">
                      <span className="log-sid">{l.sessionId.slice(0, 10)}</span>
                      <span className="log-text">{l.text}</span>
                    </div>
                  ))}
                  {logs.length === 0 && <div className="empty-hint">(暂无日志——跑一个任务后实时累积)</div>}
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
