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
  | { kind: 'error'; id: string; code: string; message: string };

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
  // Ctrl+K 命令面板
  const [cmdOpen, setCmdOpen] = useState(false);
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
      setItems((prev) => [
        ...prev,
        { kind: 'error', id: env.eventId, code: String(p?.code ?? 'UNKNOWN'), message: String(p?.message ?? '任务失败') },
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

  // Ctrl+K 命令面板(键盘优先;输入框聚焦时不抢占)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [items, streaming]);

  const refreshSessions = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.sessions();
    if ('sessions' in r && Array.isArray(r.sessions)) {
      setSessions(r.sessions.map((s) => ({ id: s.id, title: s.title, task: s.task, turns: s.turns, toolUses: s.toolUses, updatedAt: s.updatedAt })));
    }
  }, []);

  useEffect(() => {
    if (hostState === 'ready') void refreshSessions();
  }, [hostState, refreshSessions]);

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

  const send = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    setDraft('');
    setRunStatus('running');
    setItems((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, text }]);
    const r = await bridge.sendTask(text, activeSession, 'ask');
    if ('ok' in r && r.ok !== true) {
      setItems((prev) => [...prev, { kind: 'error', id: `send-${Date.now()}`, code: 'code' in r ? String(r.code) : 'SEND_FAILED', message: '发送失败(host 未就绪或拒绝)' }]);
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
            <div className="cmdk-head">命令面板(Ctrl+K)</div>
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
      <aside className="sidebar" aria-label="会话导航">
        <div className="sidebar-head">
          <button className="btn primary" onClick={newSession}>+ 新建会话</button>
        </div>
        <div className="session-list" role="list">
          {sessions.map((s) => (
            <button
              key={s.id}
              role="listitem"
              className={`session-item${s.id === activeSession ? ' active' : ''}`}
              onClick={() => void openSession(s.id)}
            >
              <span className="session-title">{s.title !== '' ? s.title : s.task.slice(0, 40) || s.id}</span>
              <span className="session-time">{s.updatedAt.slice(0, 16).replace('T', ' ')}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className="empty-hint">点"新建会话"开始</div>}
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
          <span className="approval-mode">审批:ask</span>
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
            return (
              <article key={it.id} className="turn system">
                <div className="status-chip status-failed"><span className="dot" aria-hidden="true" />{it.code}</div>
                <p className="turn-text">{it.message}</p>
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
            placeholder={activeSession === '' ? '先新建会话…' : '描述目标(Enter 发送,Shift+Enter 换行)'}
            disabled={activeSession === ''}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label="任务输入"
          />
          <div className="composer-side">
            <button className="btn primary send" onClick={() => void send()} disabled={draft.trim() === '' || activeSession === '' || busy}>
              {busy ? '运行中…' : '发送'}
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
