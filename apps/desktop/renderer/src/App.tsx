/**
 * HMH Desktop renderer 骨架(信息架构文档 03 §六):
 * 左栏会话导航 / 中栏聊天流 / 右 Context Dock(可折叠)/ 底部 Composer。
 * 所有外部字符串只按文本渲染(React 文本节点天然转义;无 dangerouslySetInnerHTML)。
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

interface Turn {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status?: RunStatus;
}

export function App(): React.ReactElement {
  const [state, setState] = useState<BridgeState | null>(null);
  const [activeSession, setActiveSession] = useState<string>('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [dockOpen, setDockOpen] = useState(true);
  const [hostState, setHostState] = useState<string>('stopped');
  const streamRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (bridge === undefined) return;
    void bridge.getState().then(setState);
    const offState = bridge.onHostState((s) => setHostState(s));
    const offEvents = bridge.onEventBatches((batch) => {
      setTurns((prev) => {
        const next = [...prev];
        for (const env of batch) {
          if (env.kind === 'run.started') {
            next.push({ id: env.eventId, sessionId: env.sessionId, role: 'user', text: String((env.payload as { task?: string }).task ?? '') });
            next.push({ id: env.eventId + '-r', sessionId: env.sessionId, role: 'assistant', text: '…', status: 'running' });
          } else if (env.kind === 'run.completed') {
            next.push({ id: env.eventId, sessionId: env.sessionId, role: 'assistant', text: String((env.payload as { text?: string }).text ?? '') });
          } else if (env.kind === 'run.failed') {
            next.push({ id: env.eventId, sessionId: env.sessionId, role: 'system', text: `任务失败:${String((env.payload as { error?: { message?: string } }).error?.message ?? '未知错误')}`, status: 'failed' });
          }
        }
        return next.slice(-500);
      });
    });
    return () => { offState(); offEvents(); };
  }, []);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [turns]);

  const newSession = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.newSession();
    setActiveSession(r.id);
    setTurns([]);
  }, []);

  const send = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    setDraft('');
    setTurns((prev) => [...prev, { id: `local-${Date.now()}`, sessionId: activeSession, role: 'user', text }]);
    await bridge.sendTask(text, activeSession);
  }, [draft, activeSession]);

  const hostBadge = useMemo(() => {
    const s = state === null ? hostState : hostState;
    const label = STATUS_LABEL[s] ?? s;
    const connected = s === 'ready';
    return { label, connected, version: state?.hostVersion ?? null, port: state?.hostPort ?? null };
  }, [state, hostState]);

  const visibleTurns = turns.filter((t) => t.sessionId === activeSession);

  return (
    <div className="app-shell">
      {/* 左栏:工作区/会话 */}
      <aside className="sidebar" aria-label="会话导航">
        <div className="sidebar-head">
          <button className="btn primary" onClick={() => void newSession()}>+ 新建会话</button>
        </div>
        <div className="session-list" role="list">
          {(state?.sessions ?? []).map((s) => (
            <button
              key={s.id}
              role="listitem"
              className={`session-item${s.id === activeSession ? ' active' : ''}`}
              onClick={() => { setActiveSession(s.id); setTurns([]); }}
            >
              <span className="session-title">{s.title}</span>
              <span className="session-time">{s.createdAt.slice(0, 10)}</span>
            </button>
          ))}
          {activeSession === '' && <div className="empty-hint">点击"新建会话"开始</div>}
        </div>
      </aside>

      {/* 主工作区 */}
      <main className="workspace" aria-label="主工作区">
        <header className="topbar">
          <span className={`host-dot ${hostBadge.connected ? 'on' : 'off'}`} aria-hidden="true" />
          <span className="host-label">{hostBadge.connected ? `已连接 · runtime ${hostBadge.version ?? '?'} · 127.0.0.1:${hostBadge.port ?? '?'}` : `host ${hostBadge.label}`}</span>
          <span className="spacer" />
          <span className="approval-mode">审批:ask(默认)</span>
          <button className="btn ghost" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen}>
            {dockOpen ? '收起上下文' : '展开上下文'}
          </button>
        </header>

        <div className="stream" ref={streamRef} aria-live="polite">
          {visibleTurns.length === 0 && (
            <div className="empty-hint big">
              {activeSession === '' ? '新建一个会话,或从左侧选择' : '输入你的目标,回车发送 · Shift+Enter 换行'}
            </div>
          )}
          {visibleTurns.map((t) => (
            <article key={t.id} className={`turn ${t.role}`}>
              {t.status !== undefined && (
                <div className={`status-chip status-${t.status}`}>
                  <span className="dot" aria-hidden="true" />
                  {STATUS_LABEL[t.status] ?? t.status}
                </div>
              )}
              <p className="turn-text">{t.text}</p>
            </article>
          ))}
        </div>

        {/* Composer */}
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
          <button className="btn primary send" onClick={() => void send()} disabled={draft.trim() === '' || activeSession === ''}>
            发送
          </button>
        </footer>
      </main>

      {/* 右侧 Context Dock */}
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
            <div className="dock-row"><span className="dock-k">runtime 版本</span><span className="dock-v">{hostBadge.version ?? '无数据'}</span></div>
            <div className="dock-row"><span className="dock-k">会话</span><span className="dock-v">{state?.sessions.length ?? 0}</span></div>
            <div className="dock-note">工具轨迹默认折叠;证据缺失显示"无数据",不假填 0。</div>
          </div>
        </aside>
      )}
    </div>
  );
}
