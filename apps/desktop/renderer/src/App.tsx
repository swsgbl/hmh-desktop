/**
 * HMH Desktop renderer(阶段E:会话纵切片)。
 * 左栏会话导航 / 中栏聊天流(含工具折叠卡与审批卡)/ 右 Context Dock /
 * 底部 Composer。所有外部字符串只按文本渲染(React 文本节点天然转义)。
 * 事件按 sessionId 过滤;approval 的权威在 runtime,UI 只转述与转发。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope, RunStatus } from '@hmh-desktop/contracts';
import { bridge, type BridgeState } from './bridge.ts';

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

export function App(): React.ReactElement {
  const [state, setState] = useState<BridgeState | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeSession, setActiveSession] = useState<string>('');
  const [items, setItems] = useState<Item[]>([]);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [dockOpen, setDockOpen] = useState(true);
  const [hostState, setHostState] = useState<string>('stopped');
  const [hostInfo, setHostInfo] = useState<{ restartCount: number; lastError?: string }>({ restartCount: 0 });
  const [approvalBusy, setApprovalBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const applyEnvelope = useCallback((env: EventEnvelope) => {
    if (env.kind === 'run.started') {
      setRunStatus('running');
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
      const p = env.payload as { text?: string };
      setItems((prev) => [
        ...prev,
        { kind: 'assistant', id: env.eventId, text: String(p.text ?? '') },
      ]);
    } else if (env.kind === 'run.failed') {
      setRunStatus('failed');
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
    return () => { offState(); offEvents(); };
  }, [applyEnvelope]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [items]);

  const refreshSessions = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.sessions();
    if ('sessions' in r && Array.isArray(r.sessions)) setSessions(r.sessions);
  }, []);

  useEffect(() => {
    if (hostState === 'ready') void refreshSessions();
  }, [hostState, refreshSessions]);

  const newSession = useCallback(async () => {
    if (bridge === undefined) return;
    const id = `web-${Date.now().toString(36)}`;
    setSessions((prev) => [{ id, title: '新会话', task: '', turns: 0, toolUses: 0, updatedAt: new Date().toISOString() }, ...prev]);
    setActiveSession(id);
    setItems([]);
    setRunStatus(null);
  }, []);

  const send = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    setDraft('');
    setRunStatus('running');
    setItems((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, text }]);
    const r = await bridge.sendTask(text, activeSession, 'ask');
    if (!('ok' in r) || r.ok !== true) {
      setItems((prev) => [...prev, { kind: 'error', id: `send-${Date.now()}`, code: 'code' in r ? String(r.code) : 'SEND_FAILED', message: '发送失败(host 未就绪或拒绝)' }]);
      setRunStatus(null);
    }
  }, [draft, activeSession]);

  const approve = useCallback(async (granted: boolean) => {
    if (bridge === undefined || activeSession === '') return;
    setApprovalBusy(true);
    await bridge.approve(granted, activeSession);
    // 卡片消失由后续事件驱动(run.completed / tool.*);先解除按钮锁定
    setTimeout(() => setApprovalBusy(false), 400);
    setItems((prev) => prev.map((it) => (it.kind === 'approval' ? { ...it, kind: 'approval' } : it)));
  }, [activeSession]);

  const interrupt = useCallback(async () => {
    if (bridge === undefined || activeSession === '') return;
    await bridge.interrupt(activeSession);
    setRunStatus(null);
  }, [activeSession]);

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

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="会话导航">
        <div className="sidebar-head">
          <button className="btn primary" onClick={() => void newSession()}>+ 新建会话</button>
        </div>
        <div className="session-list" role="list">
          {sessions.map((s) => (
            <button
              key={s.id}
              role="listitem"
              className={`session-item${s.id === activeSession ? ' active' : ''}`}
              onClick={() => { setActiveSession(s.id); setItems([]); setRunStatus(null); }}
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
          {busy && (
            <button className="btn danger" onClick={() => void interrupt()}>停止</button>
          )}
          <span className="approval-mode">审批:ask</span>
          <button className="btn ghost" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen}>
            {dockOpen ? '收起上下文' : '展开上下文'}
          </button>
        </header>

        <div className="stream" ref={streamRef} aria-live="polite">
          {items.length === 0 && (
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
            <button role="tab" className="dock-tab active">Overview</button>
            <button role="tab" className="dock-tab">Files</button>
            <button role="tab" className="dock-tab">Diff</button>
            <button role="tab" className="dock-tab">Evidence</button>
            <button role="tab" className="dock-tab">Logs</button>
          </div>
          <div className="dock-body">
            <div className="dock-row"><span className="dock-k">host 状态</span><span className="dock-v">{hostBadge.label}</span></div>
            <div className="dock-row"><span className="dock-k">runtime 版本</span><span className="dock-v">{state?.hostVersion ?? '无数据'}</span></div>
            <div className="dock-row"><span className="dock-k">模式</span><span className="dock-v">{state?.mode ?? '—'}</span></div>
            <div className="dock-row"><span className="dock-k">会话数</span><span className="dock-v">{sessions.length}</span></div>
            <div className="dock-row"><span className="dock-k">当前会话</span><span className="dock-v">{activeSession === '' ? '—' : activeSession}</span></div>
            <div className="dock-row"><span className="dock-k">运行状态</span><span className="dock-v">{runStatus === null ? '空闲' : STATUS_LABEL[runStatus] ?? runStatus}</span></div>
            <div className="dock-note">工具轨迹默认折叠;证据缺失显示"无数据",不假填 0。</div>
          </div>
        </aside>
      )}
    </div>
  );
}
