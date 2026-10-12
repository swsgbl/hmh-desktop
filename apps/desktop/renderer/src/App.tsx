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
import { bridge, type BridgeState, type DiffDto, type FsListDto, type FsReadDto, type ProviderDetailDto, type SessionPreviewDto, type WorkspaceDto } from './bridge.ts';
import { useLocale } from './i18n.ts';
import { useTheme, type Theme } from './theme.ts';

interface SessionRow {
  id: string;
  title: string;
  task: string;
  outcome: string;
  turns: number;
  toolUses: number;
  updatedAt: string;
  cwd: string;
}

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; argsPreview: string; outputPreview?: string; isError?: boolean }
  | { kind: 'approval'; id: string; approvalId: string; tool: string; argsPreview: string; risk: string }
  | { kind: 'artifact'; id: string; relPath: string; title: string }
  | { kind: 'turnsum'; id: string; turns: number; tools: number; tokens: number | null }
  | { kind: 'error'; id: string; code: string; message: string; sessionId: string; runId: string };

type DockTab = 'overview' | 'files' | 'diff' | 'evidence' | 'logs' | 'remote';

export function App(): React.ReactElement {
  const { locale, L, setLocale } = useLocale();
  const { theme, setTheme } = useTheme();
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
  // Provider 设置(03 §七)
  const [providers, setProviders] = useState<ProviderDetailDto[]>([]);
  const [currentModel, setCurrentModel] = useState<string>('');
  const [chatProvider, setChatProvider] = useState<string>('');
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [providerForm, setProviderForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '' });
  const [providerHint, setProviderHint] = useState('');
  // 会话搜索(03 §六)+ 状态过滤(全部/运行中/已完成/失败)
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'ok' | 'failed'>('all');
  // 侧栏收缩(03 §六:左侧导航可收缩;本地偏好)+ 快捷键面板 + 运行中会话集合
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('hmh.sidebarCollapsed') === '1'; } catch { return false; }
  });
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set());
  // 工作区(03 §六)
  const [workspaces, setWorkspaces] = useState<{ current: string; items: WorkspaceDto[] } | null>(null);
  const [wsAddPath, setWsAddPath] = useState('');
  // @ 附件(03 §六 composer 附件)
  const [attOpen, setAttOpen] = useState(false);
  const [attQuery, setAttQuery] = useState('');
  const [attResults, setAttResults] = useState<Array<{ rel: string; path: string }>>([]);
  const [attachments, setAttachments] = useState<Array<{ rel: string; path: string }>>([]);
  // 图片附件(runtime vision 链:base64 dataUrl,≤3 张 ≤6MB,无需落盘)
  const [images, setImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  // 收藏(本地偏好)
  const [pinned, setPinned] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(window.localStorage.getItem('hmh.pinned') ?? '[]') as string[]); } catch { return new Set(); }
  });
  // 会话分组收起状态(按 cwd 键,本地偏好)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(window.localStorage.getItem('hmh.collapsedWs') ?? '[]') as string[]); } catch { return new Set(); }
  });
  const toggleGroup = useCallback((key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { window.localStorage.setItem('hmh.collapsedWs', JSON.stringify([...next])); } catch { /* 私有模式 */ }
      return next;
    });
  }, []);
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
      const p = env.payload as { text?: string; turns?: number; toolUses?: number; usage?: { promptTokens?: number; completionTokens?: number } };
      const tokens = p.usage !== undefined ? (p.usage.promptTokens ?? 0) + (p.usage.completionTokens ?? 0) : null;
      // turnsum 存结构化值,渲染时按当前语言格式化(切语言即时生效)
      setItems((prev) => [
        ...prev,
        { kind: 'assistant', id: env.eventId, text: String(p.text ?? '') },
        { kind: 'turnsum', id: `${env.eventId}-sum`, turns: p.turns ?? 0, tools: p.toolUses ?? 0, tokens },
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
          message: String(p?.message ?? ''),
          sessionId: env.sessionId, runId: env.runId,
        },
      ]);
    }
  }, []);

  useEffect(() => {
    if (bridge === undefined) return;
    const b = bridge; // 闭包内的判空收窄(TS 不跨 async 回调)
    // mount 快照兜底:host-state 的 ready 广播可能早于本页订阅(打包版 cjs
    // host 冷启动快于 React mount,广播即丢,hostState 永远停在 'stopped' ——
    // 引导层/Files/Diff/Evidence 全部空转)。get-state 快照带权威 hostState。
    void b.getState().then((s) => {
      setState(s);
      setHostState(s.hostState);
    });
    const offState = b.onHostState((s, info) => {
      setHostState(s);
      setHostInfo(info);
      // 每次就绪都重拉快照:mount 时拉的那份 hostVersion/hostPort 还是 null
      // (host 尚未起),不重拉就永远显示 "runtime ? · 127.0.0.1:?"。
      if (s === 'ready') {
        void b.getState().then(setState);
        void refreshSessions();
      }
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
      const mapped = r.sessions.map((s) => ({ id: s.id, title: s.title, task: s.task, outcome: s.outcome, turns: s.turns, toolUses: s.toolUses, updatedAt: s.updatedAt, cwd: s.cwd }));
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
    setItems((prev) => [...prev, { kind: 'user', id: `inj-${Date.now()}`, text: `${text}${L.composer.injectedSuffix}` }]);
  }, [draft, activeSession, L]);

  /** 会话导出(runtime 同源 builder;文件写入只在 main 的保存对话框后)。 */
  const exportSession = useCallback(async (id: string) => {
    if (bridge === undefined) return;
    const r = await bridge.exportSession(id, L.exportDialog.title);
    if ('ok' in r && r.ok === true && r.path !== undefined) {
      setExportHint(L.sidebar.exported(r.path));
      setTimeout(() => setExportHint(''), 4_000);
    } else if ('canceled' in r && r.canceled === true) {
      /* 用户取消 */
    } else if ('error' in r) {
      setExportHint(L.sidebar.exportFailed(r.error));
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, [L]);

  const [exportHint, setExportHint] = useState('');
  // runtime 连接(fake 时引导/徽章;真实入口信息)
  const [runtimeDismissed, setRuntimeDismissed] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const pickRuntime = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    setRuntimeBusy(true);
    const r = await bridge.browseRuntime(L.runtimeDialog.title);
    if ('ok' in r && r.ok === true && r.entry !== undefined) {
      await bridge.setRuntime(r.entry); // 热切换:main 停旧 host 按新入口拉起
      setRuntimeDismissed(true);
      void bridge.getState().then(setState);
    }
    setRuntimeBusy(false);
  }, [L]);

  const resetRuntimeAuto = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    setRuntimeBusy(true);
    await bridge.setRuntime(''); // 清除覆盖 → 回到自动发现
    void bridge.getState().then(setState);
    setRuntimeBusy(false);
  }, []);

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

  /** Provider 设置(03 §七:key 只显示 hasKey/末四位;保存直写 runtime,不回显)。 */
  const refreshProviders = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.providers();
    if ('providersDetail' in r && Array.isArray(r.providersDetail)) setProviders(r.providersDetail);
    if ('model' in r && typeof r.model === 'string') setCurrentModel(r.model);
    if ('chatProvider' in r && typeof r.chatProvider === 'string') setChatProvider(r.chatProvider);
    if ('busySessions' in r && Array.isArray(r.busySessions)) setBusySessions(new Set(r.busySessions));
  }, []);

  /** 模型切换(runtime POST /api/model:切 chat 路由,config 即时生效)。 */
  const switchModel = useCallback(async (name: string): Promise<void> => {
    if (bridge === undefined) return;
    setModelMenuOpen(false);
    const r = await bridge.modelSet(name);
    if ('ok' in r && r.ok === true) {
      void refreshProviders();
    } else if ('error' in r) {
      setExportHint(L.topbar.modelSwitchFailed(r.error));
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, [refreshProviders, L]);

  const saveProvider = useCallback(async () => {
    if (bridge === undefined) return;
    const { name, baseUrl, model, apiKey } = providerForm;
    if (name === '' || baseUrl === '' || model === '') {
      setProviderHint(L.settings.required);
      return;
    }
    const r = await bridge.providerSave(apiKey === '' ? { name, baseUrl, model } : { name, baseUrl, model, apiKey });
    if ('ok' in r && r.ok === true) {
      setProviderHint(L.settings.saved(name));
      setProviderForm({ name: '', baseUrl: '', model: '', apiKey: '' });
      void refreshProviders();
    } else {
      setProviderHint(L.settings.saveFailed('error' in r ? r.error : 'unknown'));
    }
  }, [providerForm, refreshProviders, L]);

  /** 会话归档/删除(runtime:archive/trash,可恢复)。 */
  const sessionOp = useCallback(async (id: string, op: 'archive' | 'delete') => {
    if (bridge === undefined) return;
    const r = await bridge.sessionOp(id, op);
    if ('ok' in r && r.ok === true) {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSession === id) { setActiveSession(''); setItems([]); }
      setExportHint(op === 'archive' ? L.sidebar.archived(id) : L.sidebar.deleted(id));
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, [activeSession, L]);

  /** 工作区(03 §六:runtime 单选 cwd;Files 面板顶部选择器)。 */
  const refreshWorkspaces = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.workspaces();
    if ('items' in r) setWorkspaces({ current: r.current, items: r.items });
  }, []);

  const useWorkspace = useCallback(async (id: string) => {
    if (bridge === undefined) return;
    const r = await bridge.workspaceUse(id);
    if ('ok' in r && r.ok === true) {
      void refreshWorkspaces();
      setFsData(null); // 置空触发 Files 面板的 useEffect 自动重载新工作区根
    }
  }, [refreshWorkspaces]);

  const addWorkspace = useCallback(async () => {
    if (bridge === undefined || wsAddPath.trim() === '') return;
    const path = wsAddPath.trim();
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const r = await bridge.workspaceAdd(name, path);
    if ('ok' in r && r.ok === true) {
      setWsAddPath('');
      void refreshWorkspaces();
    } else if ('error' in r) {
      setExportHint(L.dock.addWsFailed(r.error));
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, [wsAddPath, refreshWorkspaces, L]);

  /** 历史会话:加载 runtime 的 transcript 预览(最后 80 条)。 */
  const openSession = useCallback(async (id: string) => {
    setActiveSession(id);
    setItems([]);
    setStreaming('');
    setRunStatus(null);
    // 打开时自动展开其所属工作区组(收起状态里删掉该 cwd)
    const cwd = sessions.find((s) => s.id === id)?.cwd ?? '';
    if (cwd !== '') {
      setCollapsedGroups((prev) => {
        if (!prev.has(cwd)) return prev;
        const next = new Set(prev);
        next.delete(cwd);
        try { window.localStorage.setItem('hmh.collapsedWs', JSON.stringify([...next])); } catch { /* 私有模式 */ }
        return next;
      });
    }
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
  }, [sessions]);

  const newSession = useCallback(() => {
    const id = `web-${Date.now().toString(36)}`;
    setSessions((prev) => [{ id, title: L.sidebar.newSessionTitle, task: '', outcome: '', turns: 0, toolUses: 0, updatedAt: new Date().toISOString(), cwd: workspaces?.items.find((w) => w.id === workspaces.current)?.path ?? '' }, ...prev]);
    setActiveSession(id);
    setItems([]);
    setStreaming('');
    setRunStatus(null);
  }, [L, workspaces]);

  /* ---- 工作区管理(2026-10-11 对标 DSH:左栏工作区栏 + 新建会话选工作区) ----
     hmharness 语义:工作区是 runtime 级单选 cwd(/api/workspaces/use),
     切换影响后续任务;任务运行中切换会被 runtime 409 拒绝,UI 如实转达。 */
  const [wsMenuOpen, setWsMenuOpen] = useState(false);

  const switchWorkspace = useCallback(async (id: string): Promise<boolean> => {
    if (bridge === undefined) return false;
    const r = await bridge.workspaceUse(id);
    if ('ok' in r && r.ok === true) {
      void refreshWorkspaces();
      setFsData(null); // Files 面板跟随新工作区根
      return true;
    }
    if ('error' in r) {
      setExportHint(L.sidebar.wsAddFailed(r.error));
      setTimeout(() => setExportHint(''), 4_000);
    }
    return false;
  }, [refreshWorkspaces, L]);

  /** 在指定工作区新建会话(先切换 runtime cwd 再建)。 */
  const newSessionIn = useCallback(async (wsId: string): Promise<void> => {
    setWsMenuOpen(false);
    if (wsId !== workspaces?.current) await switchWorkspace(wsId);
    newSession();
  }, [workspaces, switchWorkspace, newSession]);

  /** 菜单里的"添加工作区":原生目录选择 → 注册 → 自动切换。 */
  const addWorkspaceBrowse = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    const picked = await bridge.pickDirectory(L.dirDialog.title);
    if (!('ok' in picked) || picked.ok !== true || picked.path === undefined) return;
    const path = picked.path;
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const r = await bridge.workspaceAdd(name, path);
    if ('ok' in r && r.ok === true) {
      const list = await bridge.workspaces();
      if ('items' in list) {
        setWorkspaces({ current: list.current, items: list.items });
        const hit = list.items.find((w) => w.path.toLowerCase() === path.toLowerCase());
        if (hit !== undefined) await switchWorkspace(hit.id);
      }
    } else if ('error' in r) {
      setExportHint(L.sidebar.wsAddFailed(r.error));
      setTimeout(() => setExportHint(''), 4_000);
    }
  }, [L, switchWorkspace]);

  // 应用菜单动作(查看→主题/语言/侧栏;帮助→快捷键;文件→新建)
  useEffect(() => {
    if (bridge === undefined) return;
    const off = bridge.onMenuAction((action) => {
      if (action === 'new-session') newSession();
      else if (action === 'shortcuts') setShortcutsOpen(true);
      else if (action === 'theme-dark') setTheme('dark');
      else if (action === 'theme-light') setTheme('light');
      else if (action === 'toggle-locale') setLocale(locale === 'zh' ? 'en' : 'zh');
      else if (action === 'toggle-sidebar') setSidebarCollapsed((v) => {
        try { window.localStorage.setItem('hmh.sidebarCollapsed', v ? '0' : '1'); } catch { /* 私有模式 */ }
        return !v;
      });
    });
    return off;
  }, [locale, newSession, setTheme, setLocale]);

  // Ctrl+K 命令面板 / Ctrl+N 新会话(03 §六;键盘优先)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newSession();
      } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.ctrlKey && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setCmdOpen(false);
        setSettingsOpen(false);
        setShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSession]);

  /** @ 附件搜索(runtime 授权路径来源)。 */
  const searchFiles = useCallback(async (q: string) => {
    if (bridge === undefined || q.trim() === '') { setAttResults([]); return; }
    const r = await bridge.fsSearch(q.trim());
    if ('results' in r) setAttResults(r.results.slice(0, 12));
  }, []);

  /** 图片附件:粘贴/拖放/上传的图片读成 dataUrl(runtime vision 协议)。
   *  类型白名单 PNG/JPEG/WebP、单张 ≤6MB、总数 ≤3(与 runtime 合同一致)。 */
  const addImageFiles = useCallback(async (files: File[]): Promise<string> => {
    const errs: string[] = [];
    for (const f of files) {
      const okType = f.type === 'image/png' || f.type === 'image/jpeg' || f.type === 'image/webp';
      if (!okType) { errs.push(L.composer.imgWrongType); continue; }
      if (f.size > 6 * 1024 * 1024) { errs.push(L.composer.imgTooLarge); continue; }
      if (images.length >= 3) { errs.push(L.composer.imgLimit); break; }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = (): void => resolve(String(fr.result));
        fr.onerror = (): void => reject(fr.error);
        fr.readAsDataURL(f);
      }).catch(() => '');
      if (dataUrl === '' || !dataUrl.startsWith('data:image/')) { errs.push(L.composer.imgWrongType); continue; }
      setImages((prev) => (prev.length >= 3 ? prev : [...prev, { name: f.name || `image-${prev.length + 1}.png`, dataUrl }]));
    }
    return errs[0] ?? '';
  }, [images.length, L]);

  /** 拖放文件:非图片(有磁盘路径)→ attachments;图片无路径 → images。 */
  const addDroppedFiles = useCallback((files: File[]): void => {
    const withPath = files.filter((f) => {
      const p = (f as File & { path?: string }).path;
      return typeof p === 'string' && p !== '';
    });
    if (withPath.length > 0) {
      setAttachments((prev) => {
        const next = [...prev];
        for (const f of withPath) {
          const p = (f as File & { path?: string }).path ?? '';
          if (!next.some((a) => a.path === p)) next.push({ rel: f.name || p.split(/[\\/]/).pop() || p, path: p });
        }
        return next.slice(0, 10);
      });
    }
    const noPath = files.filter((f) => (f as File & { path?: string }).path === undefined);
    if (noPath.length > 0) void addImageFiles(noPath).then((err) => { if (err !== '') setExportHint(err); });
  }, [addImageFiles]);

  /** 📎 上传本地文件(原生多选对话框;runtime 要求路径在工作区内)。 */
  const uploadFiles = useCallback(async (): Promise<void> => {
    if (bridge === undefined) return;
    const r = await bridge.pickFiles(L.filesDialog.title);
    if ('ok' in r && r.ok === true && Array.isArray(r.paths)) {
      setAttachments((prev) => {
        const next = [...prev];
        for (const p of r.paths ?? []) {
          if (!next.some((a) => a.path === p)) next.push({ rel: p.split(/[\\/]/).pop() ?? p, path: p });
        }
        return next.slice(0, 10);
      });
    }
  }, [L]);

  const togglePin = useCallback((id: string): void => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { window.localStorage.setItem('hmh.pinned', JSON.stringify([...next])); } catch { /* 私有模式 */ }
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    if (bridge === undefined || draft.trim() === '' || activeSession === '') return;
    const text = draft;
    const atts = attachments.map((a) => a.path);
    const imgs = images;
    setDraft('');
    setAttachments([]);
    setImages([]);
    setRunStatus('running');
    const imgNames = imgs.map((im) => `@${im.name}`).join(' ');
    setItems((prev) => [...prev, { kind: 'user', id: `local-${Date.now()}`, text: `${imgNames !== '' ? `${imgNames}\n` : ''}${attachments.length > 0 ? `${attachments.map((a) => `@${a.rel}`).join(' ')}\n` : ''}${text}` }]);
    const r = await bridge.sendTask(text, activeSession, 'ask', atts, imgs);
    if ('ok' in r && r.ok !== true) {
      setItems((prev) => [...prev, { kind: 'error', id: `send-${Date.now()}`, code: 'code' in r ? String(r.code) : 'SEND_FAILED', message: L.errors.sendFailed, sessionId: activeSession, runId: L.errors.noRun }]);
      setRunStatus(null);
    }
  }, [draft, activeSession, attachments, images, L]);

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
      setFsPreview({ name: r.rel ?? path, text: r.text, binary: false });
    } else if ('binary' in r && r.binary === true) {
      setFsPreview({ name: r.rel ?? path, text: L.dock.binary, binary: true });
    }
  }, [L]);

  // 手机远程控制(7788 web 守护;用户显式启动)
  const [remoteWeb, setRemoteWeb] = useState<{ up: boolean; version: string; lanIp: string; port: number; available: boolean } | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const refreshRemoteWeb = useCallback(async () => {
    if (bridge === undefined) return;
    const r = await bridge.remoteWebStatus();
    if ('up' in r) setRemoteWeb(r);
  }, []);
  const startRemoteWeb = useCallback(async () => {
    if (bridge === undefined) return;
    setRemoteBusy(true);
    const r = await bridge.remoteWebStart();
    if ('ok' in r && r.ok === true) { void refreshRemoteWeb(); }
    else if ('error' in r) { setExportHint(r.error); setTimeout(() => setExportHint(''), 5_000); }
    setRemoteBusy(false);
  }, [refreshRemoteWeb]);
  const stopRemoteWeb = useCallback(async () => {
    if (bridge === undefined) return;
    setRemoteBusy(true);
    await bridge.remoteWebStop();
    void refreshRemoteWeb();
    setRemoteBusy(false);
  }, [refreshRemoteWeb]);

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
    if (dockTab === 'files' && workspaces === null && hostState === 'ready') void refreshWorkspaces();
    if (dockTab === 'evidence' && cog === null && hostState === 'ready') void loadCog();
    if (dockTab === 'diff' && hostState === 'ready') void loadDiff();
    if (dockTab === 'remote') void refreshRemoteWeb();
  }, [dockTab, hostState, fsData, cog, workspaces, loadFs, loadCog, loadDiff, refreshWorkspaces, refreshRemoteWeb]);

  useEffect(() => {
    if (hostState === 'ready') void refreshProviders(); // 顶栏模型 + 首跑引导数据
  }, [hostState, refreshProviders]);

  const runCommand = useCallback((cmd: string): void => {
    setCmdOpen(false);
    if (cmd === 'new-session') newSession();
    else if (cmd === 'stop') void interrupt();
    else if (cmd.startsWith('tab:')) setDockTab(cmd.slice(4) as DockTab);
    else if (cmd === 'dock') setDockOpen((v) => !v);
  }, [newSession, interrupt]);

  const busy = runStatus === 'running' || runStatus === 'waiting_approval' || runStatus === 'planning' || runStatus === 'verifying';
  const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : L.dock.noData);

  /** 会话按工作区分组(2026-10-11:组头可展开/收起)。当前工作区组置顶,
   *  其余按组内最新活动排序;组内收藏优先;支持文本搜索与状态过滤。 */
  const sessionGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = sessions.filter((s) => {
      if (q !== '' && !s.id.toLowerCase().includes(q) && !s.title.toLowerCase().includes(q) && !s.task.toLowerCase().includes(q)) return false;
      if (statusFilter === 'running') return busySessions.has(s.id);
      if (statusFilter === 'ok') return s.outcome === 'ok';
      if (statusFilter === 'failed') return s.outcome === 'failed';
      return true;
    });
    const map = new Map<string, SessionRow[]>();
    for (const s of filtered) {
      const key = s.cwd || '';
      const arr = map.get(key);
      if (arr === undefined) map.set(key, [s]); else arr.push(s);
    }
    const curWsPath = workspaces?.items.find((w) => w.id === workspaces.current)?.path ?? '';
    const list = [...map.entries()].map(([cwd, items]) => ({
      cwd,
      name: cwd === '' ? L.sidebar.noWs : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd),
      items: [...items].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id))),
    }));
    list.sort((a, b) => {
      const aCur = a.cwd === curWsPath ? 1 : 0;
      const bCur = b.cwd === curWsPath ? 1 : 0;
      if (aCur !== bCur) return bCur - aCur;
      return (b.items[0]?.updatedAt ?? '').localeCompare(a.items[0]?.updatedAt ?? '');
    });
    return list;
  }, [sessions, search, statusFilter, busySessions, pinned, workspaces, L]);
  const statusLabel = (s: string): string => {
    switch (s) {
      case 'planning': return L.status.planning;
      case 'running': return L.status.running;
      case 'waiting_approval': return L.status.waitingApproval;
      case 'verifying': return L.status.verifying;
      case 'recovering': return L.status.recovering;
      case 'completed': return L.status.completed;
      case 'failed': return L.status.failed;
      case 'cancelled': return L.status.cancelled;
      case 'idle': return L.status.idle;
      case 'ready': return L.status.connected;
      case 'stopped': return L.status.stopped;
      case 'starting': return L.status.starting;
      case 'restarting': return L.status.restarting;
      default: return s;
    }
  };

  const hostBadge = useMemo(() => {
    const connected = hostState === 'ready';
    const label = connected ? L.status.connected : statusLabel(hostState);
    return {
      label,
      connected,
      detail: connected ? L.topbar.runtimeDetail(state?.hostVersion ?? '?', state?.hostPort ?? '?') : hostInfo.lastError ?? '',
    };
  }, [state, hostState, hostInfo, L]);

  return (
    <div className={`app-shell${sidebarCollapsed ? ' no-sidebar' : ''}`}>
      {shortcutsOpen && (
        <div className="cmdk-overlay" role="dialog" aria-label={L.shortcuts.title} onClick={() => setShortcutsOpen(false)}>
          <div className="cmdk" onClick={(e) => e.stopPropagation()}>
            <div className="cmdk-head">{L.shortcuts.title}(Ctrl + /)</div>
            {L.shortcuts.items.map((it) => (
              <div key={it.k} className="shortcut-row">
                <span className="shortcut-desc">{it.d}</span>
                <kbd className="shortcut-key">{it.k}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
      {state !== null && state.mode === 'fake' && hostState === 'ready' && !runtimeDismissed && (
        <div className="runtime-guide" role="dialog" aria-label={L.guide.dialogAria}>
          <div className="runtime-guide-card">
            <div className="runtime-guide-title">{L.guide.title}</div>
            <p className="runtime-guide-text">{L.guide.text}</p>
            <div className="runtime-guide-actions">
              <button className="btn primary" disabled={runtimeBusy} onClick={() => void pickRuntime()}>{L.guide.pick}</button>
              <button className="btn ghost" disabled={runtimeBusy} onClick={() => setRuntimeDismissed(true)}>{L.guide.dismiss}</button>
            </div>
          </div>
        </div>
      )}
      {cmdOpen && (
        <div className="cmdk-overlay" role="dialog" aria-label={L.cmdk.dialogAria} onClick={() => setCmdOpen(false)}>
          <div className="cmdk" onClick={(e) => e.stopPropagation()}>
            <div className="cmdk-head">{L.cmdk.head}</div>
            {[
              { cmd: 'new-session', label: L.cmdk.newSession },
              { cmd: 'tab:overview', label: L.cmdk.ctx(L.dock.tabOverview) },
              { cmd: 'tab:files', label: L.cmdk.ctx(L.dock.tabFiles) },
              { cmd: 'tab:diff', label: L.cmdk.ctx(L.dock.tabDiff) },
              { cmd: 'tab:evidence', label: L.cmdk.ctx(L.dock.tabEvidence) },
              { cmd: 'tab:logs', label: L.cmdk.ctx(L.dock.tabLogs) },
              { cmd: 'dock', label: L.cmdk.toggleDock },
              { cmd: 'stop', label: L.cmdk.stopTask },
            ].map((c) => (
              <button key={c.cmd} className="cmdk-item" onClick={() => runCommand(c.cmd)}>{c.label}</button>
            ))}
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="cmdk-overlay" role="dialog" aria-label={L.settings.title} onClick={() => setSettingsOpen(false)}>
          <div className="cmdk settings" onClick={(e) => e.stopPropagation()}>
            <div className="cmdk-head">{L.settings.title}</div>
            <div className="settings-section">{L.settings.runtimeSection}</div>
            <div className="settings-row">
              <span>{L.settings.mode}</span>
              <span className="runtime-mode">{state?.mode === 'real' ? L.settings.modeReal : L.settings.modeFake}</span>
            </div>
            {state?.runtimeEntry !== null && (
              <div className="settings-row">
                <span>{L.settings.entry}</span>
                <code className="runtime-entry" title={state?.runtimeEntry ?? ''}>{state?.runtimeEntry}</code>
              </div>
            )}
            <div className="settings-row">
              <span>{L.settings.switchRuntime}</span>
              <div className="seg">
                <button disabled={runtimeBusy} onClick={() => void pickRuntime()}>{L.settings.pickEntry}</button>
                <button disabled={runtimeBusy} onClick={() => void resetRuntimeAuto()}>{L.settings.resetAuto}</button>
              </div>
            </div>
            <div className="settings-note">{L.settings.shareNote}</div>
            <div className="settings-section">{L.settings.prefsSection}</div>
            <div className="settings-row">
              <span>{L.settings.appearance}</span>
              <div className="seg">
                {(['system', 'light', 'dark'] as Theme[]).map((t) => (
                  <button key={t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)} aria-pressed={theme === t}>
                    {t === 'system' ? L.settings.themeSystem : t === 'light' ? L.settings.themeLight : L.settings.themeDark}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <span>{L.settings.language}</span>
              <div className="seg">
                <button className={locale === 'zh' ? 'on' : ''} onClick={() => setLocale('zh')} aria-pressed={locale === 'zh'}>中文</button>
                <button className={locale === 'en' ? 'on' : ''} onClick={() => setLocale('en')} aria-pressed={locale === 'en'}>English</button>
              </div>
            </div>
            <div className="settings-row">
              <span>{L.settings.enterBehavior}</span>
              <div className="seg">
                <button className={enterSends ? 'on' : ''} onClick={() => setEnterBehavior(true)}>{L.settings.send}</button>
                <button className={!enterSends ? 'on' : ''} onClick={() => setEnterBehavior(false)}>{L.settings.newline}</button>
              </div>
            </div>
            <div className="settings-section">{L.settings.runtimeWriteSection}</div>
            <div className="settings-row">
              <span>{L.settings.approvalMode}</span>
              <div className="seg">
                <button className={approvalMode === 'ask' ? 'on' : ''} onClick={() => void switchApproval('ask')}>{L.settings.ask}</button>
                <button className={approvalMode === 'auto' ? 'on' : ''} onClick={() => void switchApproval('auto')}>{L.settings.auto}</button>
              </div>
            </div>
            <div className="settings-note">{L.settings.autoNote}</div>
            <div className="settings-section">{L.settings.providerSection}</div>
            <div className="provider-list">
              {providers.map((p) => (
                <div key={p.name} className="provider-row">
                  <span className="provider-name">{p.name}</span>
                  <span className="provider-model">{p.model}</span>
                  <span className="provider-key" title={L.settings.keyStatus}>{p.hasKey ? L.settings.hasKey(p.keyTail ?? '????') : L.settings.noKey}</span>
                </div>
              ))}
              {providers.length === 0 && <div className="empty-hint">{L.settings.noProvider}</div>}
            </div>
            <div className="provider-form">
              <input placeholder={L.settings.providerNamePh} value={providerForm.name} onChange={(e) => setProviderForm({ ...providerForm, name: e.target.value })} aria-label={L.settings.providerName} />
              <input placeholder={L.settings.providerBaseUrlPh} value={providerForm.baseUrl} onChange={(e) => setProviderForm({ ...providerForm, baseUrl: e.target.value })} aria-label={L.settings.providerBaseUrl} />
              <input placeholder={L.settings.providerModelPh} value={providerForm.model} onChange={(e) => setProviderForm({ ...providerForm, model: e.target.value })} aria-label={L.settings.providerModel} />
              <input type="password" placeholder={L.settings.providerKeyPh} value={providerForm.apiKey} onChange={(e) => setProviderForm({ ...providerForm, apiKey: e.target.value })} aria-label={L.settings.providerApiKey} />
              <button className="btn primary sm" onClick={() => void saveProvider()}>{L.settings.saveProvider}</button>
            </div>
            {providerHint !== '' && <div className="settings-note" role="status">{providerHint}</div>}
          </div>
        </div>
      )}
      <aside className="sidebar" aria-label={L.nav.sessions}>
        <div className="sidebar-head">
          <div className="new-session-group">
            <button className="btn primary grow" onClick={newSession} title={workspaces !== null ? L.sidebar.newInWs(workspaces.items.find((w) => w.id === workspaces.current)?.name ?? '') : ''}>{L.sidebar.newSession}</button>
            <button
              className="btn primary"
              aria-label={L.sidebar.pickWsFirst}
              title={L.sidebar.pickWsFirst}
              aria-expanded={wsMenuOpen}
              onClick={() => setWsMenuOpen((v) => !v)}
              disabled={workspaces === null}
            >▾</button>
          </div>
          <input
            className="session-search"
            type="search"
            placeholder={L.sidebar.searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={L.sidebar.searchPlaceholder}
          />
          <select
            className="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'running' | 'ok' | 'failed')}
            aria-label={L.sidebar.filterAria}
          >
            <option value="all">{L.sidebar.filterAll}</option>
            <option value="running">{L.sidebar.filterRunning}</option>
            <option value="ok">{L.sidebar.filterDone}</option>
            <option value="failed">{L.sidebar.filterFailed}</option>
          </select>
        </div>
        {/* 工作区管理栏(对标 DSH:切换/添加;runtime 语义=全局 cwd) */}
        <button
          className="workspace-bar"
          aria-label={L.sidebar.workspaceBarAria}
          aria-expanded={wsMenuOpen}
          onClick={() => setWsMenuOpen((v) => !v)}
        >
          <span className="ws-bar-label">{L.sidebar.workspaceBar}</span>
          <span className="ws-bar-name">{workspaces !== null ? (workspaces.items.find((w) => w.id === workspaces.current)?.name ?? L.dock.none) : L.dock.loading}</span>
          <span className="ws-bar-caret" aria-hidden="true">▾</span>
        </button>
        {wsMenuOpen && (
          <>
            <div className="ws-menu-backdrop" onClick={() => setWsMenuOpen(false)} aria-hidden="true" />
            <div className="ws-menu" role="menu" aria-label={L.sidebar.wsMenuAria}>
              {workspaces !== null && workspaces.items.map((w) => (
                <button
                  key={w.id}
                  role="menuitem"
                  className={`ws-menu-item${w.id === workspaces.current ? ' current' : ''}`}
                  onClick={() => void newSessionIn(w.id)}
                  title={L.sidebar.newInWs(w.name)}
                >
                  <span className="ws-menu-name">📁 {w.name}</span>
                  <span className="ws-menu-path">{w.path}</span>
                  {w.id === workspaces.current && <span className="ws-menu-check">✓ {L.sidebar.wsCurrent}</span>}
                </button>
              ))}
              <button role="menuitem" className="ws-menu-item add" onClick={() => { setWsMenuOpen(false); void addWorkspaceBrowse(); }}>
                <span className="ws-menu-name">{L.sidebar.wsAdd}</span>
              </button>
            </div>
          </>
        )}
        <div className="session-list" role="list">
          {sessionGroups.map((g) => {
            // 搜索时强制展开(过滤结果必须可见);打开会话时该组已自动展开
            const collapsed = collapsedGroups.has(g.cwd) && search.trim() === '';
            return (
              <div key={g.cwd || '(none)'} className="ws-group">
                <button
                  className="ws-group-head"
                  aria-expanded={!collapsed}
                  aria-label={L.sidebar.wsGroupAria(g.name, g.items.length)}
                  title={g.cwd !== '' ? L.sidebar.sessionIn(g.cwd) : ''}
                  onClick={() => toggleGroup(g.cwd)}
                >
                  <span className={`ws-group-caret${collapsed ? '' : ' open'}`} aria-hidden="true">▸</span>
                  <span className="ws-group-name">📁 {g.name}</span>
                  <span className="ws-group-count">{L.sidebar.sessionCountUnit(g.items.length)}</span>
                </button>
                {!collapsed && g.items.map((s) => (
                  <div key={s.id} role="listitem" className={`session-row${s.id === activeSession ? ' active' : ''}`}>
                    <button
                      className="session-item"
                      onClick={() => void openSession(s.id)}
                      aria-label={L.sidebar.openAria(s.title !== '' ? s.title : s.id)}
                    >
                      <span className="session-title">{pinned.has(s.id) ? L.sidebar.pinnedFirst : ''}{s.title !== '' ? s.title : s.task.slice(0, 40) || s.id}</span>
                      <span className="session-time">{busySessions.has(s.id) && <span className="session-running-dot" title={L.sidebar.runningTitle} aria-label={L.sidebar.runningTitle} />}{s.updatedAt.slice(0, 16).replace('T', ' ')}</span>
                    </button>
                    <button className={`session-export${pinned.has(s.id) ? ' pinned' : ''}`} aria-label={pinned.has(s.id) ? L.sidebar.unpinAria(s.id) : L.sidebar.pinAria(s.id)} title={L.sidebar.pinTitle} onClick={() => togglePin(s.id)}>{pinned.has(s.id) ? '★' : '☆'}</button>
                    <button className="session-export" aria-label={L.sidebar.exportAria(s.id)} title={L.sidebar.exportTitle} onClick={() => void exportSession(s.id)}>⤓</button>
                    <button className="session-export" aria-label={L.sidebar.archiveAria(s.id)} title={L.sidebar.archiveTitle} onClick={() => void sessionOp(s.id, 'archive')}>🗄</button>
                    <button className="session-export danger" aria-label={L.sidebar.deleteAria(s.id)} title={L.sidebar.deleteTitle} onClick={() => void sessionOp(s.id, 'delete')}>🗑</button>
                  </div>
                ))}
              </div>
            );
          })}
          {sessions.length === 0 && <div className="empty-hint">{L.sidebar.empty}</div>}
          {cursor !== null && (
            <button className="btn ghost sm more" onClick={() => void refreshSessions(cursor)}>{L.sidebar.loadMore}</button>
          )}
          {exportHint !== '' && <div className="export-hint" role="status">{exportHint}</div>}
        </div>
      </aside>

      <main className="workspace" aria-label={L.nav.workspace}>
        <header className="topbar">
          <button
            className="btn ghost icon-btn"
            aria-label={sidebarCollapsed ? L.topbar.expandSidebar : L.topbar.collapseSidebar}
            title={sidebarCollapsed ? L.topbar.expandSidebar : L.topbar.collapseSidebar}
            onClick={() => {
              setSidebarCollapsed((v) => {
                try { window.localStorage.setItem('hmh.sidebarCollapsed', v ? '0' : '1'); } catch { /* 私有模式 */ }
                return !v;
              });
            }}
          >{sidebarCollapsed ? '⇥' : '⇤'}</button>
          <span className={`host-dot ${hostBadge.connected ? 'on' : 'off'}`} aria-hidden="true" />
          <span className="host-label">{hostBadge.label}{hostBadge.detail !== '' ? ` · ${hostBadge.detail}` : ''}</span>
          {workspaces !== null && (
            <span className="topbar-ws" title={L.topbar.workspaceTitle}>{workspaces.items.find((w) => w.id === workspaces.current)?.name ?? L.dock.none}</span>
          )}
          {currentModel !== '' && (
            <span className="model-picker-anchor">
              <button
                className="topbar-model as-button"
                title={L.topbar.modelMenuTitle}
                aria-label={L.topbar.modelMenuAria}
                aria-expanded={modelMenuOpen}
                onClick={() => setModelMenuOpen((v) => !v)}
                disabled={providers.length < 2}
              >{currentModel} ▾</button>
              {modelMenuOpen && (
                <>
                  <div className="ws-menu-backdrop" onClick={() => setModelMenuOpen(false)} aria-hidden="true" />
                  <div className="ws-menu model-menu" role="menu" aria-label={L.topbar.modelMenuAria}>
                    {providers.map((p) => (
                      <button
                        key={p.name}
                        role="menuitem"
                        className={`ws-menu-item${p.name === chatProvider ? ' current' : ''}`}
                        onClick={() => void switchModel(p.name)}
                        title={p.baseUrl}
                      >
                        <span className="ws-menu-name">{p.model}</span>
                        <span className="ws-menu-path">{p.name}{p.hasKey ? '' : ' · no key'}</span>
                        {p.name === chatProvider && <span className="ws-menu-check">✓ {L.topbar.modelCurrent}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </span>
          )}
          <span className="spacer" />
          {state?.mode === 'fake' && (
            <button className="guide-pill" title={L.topbar.demoBadgeTitle} onClick={() => setRuntimeDismissed(false)}>{L.topbar.demoBadge}</button>
          )}
          {providers.length === 0 && hostState === 'ready' && state?.mode === 'real' && (
            <button className="guide-pill" onClick={() => setSettingsOpen(true)}>{L.topbar.noProvider}</button>
          )}
          {busy && runStatus !== null && (
            <span className={`status-chip status-${runStatus}`}>
              <span className="dot" aria-hidden="true" />
              {statusLabel(runStatus)}
            </span>
          )}
          {busy && <button className="btn danger" onClick={() => void interrupt()}>{L.topbar.stop}</button>}
          <span className={`approval-mode${approvalMode === 'auto' ? ' auto' : ''}`} title={L.topbar.approvalTitle}>{L.topbar.approval}:{approvalMode === 'ask' ? L.topbar.approvalAsk : L.topbar.approvalAuto}</span>
          <button className="btn ghost" aria-label={L.topbar.settingsAria} onClick={() => setSettingsOpen(true)}>⚙</button>
          <div className="seg lang-seg" role="group" aria-label={L.settings.language}>
            <button className={locale === 'zh' ? 'on' : ''} onClick={() => setLocale('zh')} aria-pressed={locale === 'zh'} title="中文">中</button>
            <button className={locale === 'en' ? 'on' : ''} onClick={() => setLocale('en')} aria-pressed={locale === 'en'} title="English">EN</button>
          </div>
          <button className="btn ghost" onClick={() => setDockOpen((v) => !v)} aria-expanded={dockOpen}>
            {dockOpen ? L.topbar.collapseDock : L.topbar.expandDock}
          </button>
        </header>

        <div className="stream" ref={streamRef} aria-live="polite">
          {items.length === 0 && streaming === '' && (
            <div className="empty-hint big">
              {activeSession === '' ? L.stream.emptyNoSession : L.stream.emptyWithSession}
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
                    {it.outputPreview === undefined ? <span className="tool-running">{L.stream.toolRunning}</span> : null}
                  </summary>
                  <pre className="tool-io">{it.argsPreview}</pre>
                  {it.outputPreview !== undefined && <pre className="tool-io out">{it.outputPreview}</pre>}
                </details>
              );
            }
            if (it.kind === 'approval') {
              return (
                <article key={it.id} className="turn approval-card" aria-label={L.stream.approvalAria}>
                  <div className="approval-head">
                    <span className="approval-icon">🛡</span> {L.stream.needApproval}:{it.tool}
                  </div>
                  <pre className="tool-io">{it.argsPreview}</pre>
                  <p className="approval-risk">{it.risk}</p>
                  <div className="approval-actions">
                    <button className="btn primary" disabled={approvalBusy} onClick={() => void approve(true)}>{L.stream.approve}</button>
                    <button className="btn danger" disabled={approvalBusy} onClick={() => void approve(false)}>{L.stream.reject}</button>
                  </div>
                </article>
              );
            }
            if (it.kind === 'artifact') {
              return (
                <div key={it.id} className="artifact-card" aria-label={L.stream.artifactAria}>
                  <span className="artifact-icon" aria-hidden="true">📦</span>
                  <span className="artifact-title">{it.title}</span>
                  <span className="artifact-hint">{L.stream.artifactHint}</span>
                </div>
              );
            }
            if (it.kind === 'turnsum') {
              return <div key={it.id} className="turn-sum" aria-label={L.stream.turnSumAria}>{L.stream.turnSum(it.turns, it.tools, it.tokens)}</div>;
            }
            return (
              <article key={it.id} className="turn system">
                <div className="status-chip status-failed"><span className="dot" aria-hidden="true" />{it.code}</div>
                <p className="turn-text">{it.message}</p>
                <div className="err-meta">{L.stream.errMeta(it.sessionId, it.runId)}</div>
              </article>
            );
          })}
          {streaming !== '' && (
            <article className="turn streaming">
              <p className="turn-text">{streaming}<span className="cursor" aria-hidden="true">▍</span></p>
            </article>
          )}
        </div>

        <footer
          className={`composer${dragOver ? ' dragover' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addDroppedFiles([...e.dataTransfer.files]); }}
        >
          {dragOver && <div className="drop-hint" aria-live="polite">{L.composer.dropHint}</div>}
          {attOpen && (
            <div className="att-picker" role="dialog" aria-label={L.composer.attachAriaDialog}>
              <input
                autoFocus
                className="session-search"
                placeholder={L.composer.attachSearchPh}
                value={attQuery}
                onChange={(e) => { setAttQuery(e.target.value); void searchFiles(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setAttOpen(false); setAttResults([]); } }}
                aria-label={L.composer.attachSearchAria}
              />
              <div className="att-results">
                {attResults.map((f) => (
                  <button key={f.path} className="fs-row" onClick={() => {
                    setAttachments((prev) => (prev.some((a) => a.path === f.path) ? prev : [...prev, f]));
                    setAttOpen(false); setAttQuery(''); setAttResults([]);
                  }}>📄 {f.rel}</button>
                ))}
                {attQuery !== '' && attResults.length === 0 && <div className="empty-hint">{L.composer.attachEmpty}</div>}
              </div>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="att-chips">
              {attachments.map((a) => (
                <span key={a.path} className="att-chip">
                  📄 {a.rel}
                  <button aria-label={L.composer.removeAttachAria(a.rel)} onClick={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}>✕</button>
                </span>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="att-chips">
              {images.map((im, i) => (
                <span key={im.dataUrl.slice(-64)} className="att-chip img" aria-label={L.composer.pasteImageAria(i + 1)}>
                  <img src={im.dataUrl} alt={im.name} className="att-thumb" />
                  <button aria-label={L.composer.removeImageAria(i + 1)} onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-row">
            <button className="btn ghost" aria-label={L.composer.attachAria} title={L.composer.attachTitle} onClick={() => setAttOpen((v) => !v)} disabled={activeSession === ''}>@</button>
            <button className="btn ghost" aria-label={L.composer.uploadAria} title={L.composer.uploadTitle} onClick={() => void uploadFiles()} disabled={activeSession === ''}>📎</button>
            <textarea
            value={draft}
            placeholder={activeSession === ''
              ? L.composer.phNoSession
              : busy
                ? L.composer.phBusy
                : enterSends
                  ? L.composer.phEnterSend
                  : L.composer.phCtrlEnter}
            disabled={activeSession === ''}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              e.preventDefault();
              void addImageFiles(files).then((err) => { if (err !== '') setExportHint(err); });
            }}
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
            aria-label={L.composer.inputAria}
          />
            <div className="composer-side">
              <button
                className={`btn send ${busy ? 'ghost' : 'primary'}`}
                onClick={() => (busy ? void inject() : void send())}
                disabled={draft.trim() === '' || activeSession === ''}
              >
                {busy ? L.composer.inject : L.composer.send}
              </button>
            </div>
          </div>
        </footer>
      </main>

      {dockOpen && (
        <aside className="dock" aria-label={L.nav.dock}>
          <div className="dock-tabs" role="tablist">
            {(['overview', 'files', 'diff', 'evidence', 'logs', 'remote'] as DockTab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={dockTab === t}
                className={`dock-tab${dockTab === t ? ' active' : ''}`}
                onClick={() => setDockTab(t)}
              >
                {t === 'overview' ? L.dock.tabOverview : t === 'files' ? L.dock.tabFiles : t === 'diff' ? L.dock.tabDiff : t === 'evidence' ? L.dock.tabEvidence : t === 'logs' ? L.dock.tabLogs : L.dock.tabRemote}
              </button>
            ))}
          </div>
          <div className="dock-body">
            {dockTab === 'overview' && (
              <>
                <div className="dock-row"><span className="dock-k">{L.dock.hostState}</span><span className="dock-v">{hostBadge.label}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.runtimeVersion}</span><span className="dock-v">{state?.hostVersion ?? L.dock.noData}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.mode}</span><span className="dock-v">{state?.mode ?? L.dock.none}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.sessionCount}</span><span className="dock-v">{sessions.length}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.currentSession}</span><span className="dock-v">{activeSession === '' ? L.dock.none : activeSession}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.runState}</span><span className="dock-v">{runStatus === null ? L.status.idle : statusLabel(runStatus)}</span></div>
                <div className="dock-note">{L.dock.overviewNote}</div>
              </>
            )}
            {dockTab === 'files' && (
              <div className="files-pane">
                {workspaces !== null && (
                  <div className="ws-picker">
                    <span className="ws-label">{L.dock.workspace}</span>
                    <select
                      value={workspaces.current}
                      onChange={(e) => void useWorkspace(e.target.value)}
                      aria-label={L.dock.wsSelectAria}
                    >
                      {workspaces.items.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                    <input
                      className="ws-add"
                      placeholder={L.dock.addWsPh}
                      value={wsAddPath}
                      onChange={(e) => setWsAddPath(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addWorkspace(); } }}
                      aria-label={L.dock.addWsAria}
                    />
                    <button
                      className="btn ghost sm"
                      aria-label={L.dock.browseAria}
                      onClick={() => {
                        if (bridge === undefined) return;
                        void bridge.pickDirectory(L.dirDialog.title).then((r) => {
                          if ('ok' in r && r.ok === true && r.path !== undefined) setWsAddPath(r.path);
                        });
                      }}
                    >{L.dock.browse}</button>
                  </div>
                )}
                <div className="fs-crumbs">
                  <button className="btn ghost sm" onClick={() => void loadFs(fsData?.parent ?? '')} disabled={fsData === null || fsData.parent === ''}>{L.dock.parent}</button>
                  <span className="fs-path">{fsPath === '' ? L.dock.wsRoot : fsPath}</span>
                </div>
                <div className="fs-list">
                  {(fsData?.dirs ?? []).map((d) => (
                    <button key={d.path} className="fs-row dir" onClick={() => void loadFs(d.path)}>📁 {d.name}</button>
                  ))}
                  {(fsData?.files ?? []).map((f) => (
                    <button key={f.path} className="fs-row" onClick={() => void previewFile(f.path)}>📄 {f.name}</button>
                  ))}
                  {fsData !== null && (fsData.dirs.length === 0 && (fsData.files ?? []).length === 0) && <div className="empty-hint">{L.dock.emptyDir}</div>}
                  {fsData === null && <div className="empty-hint">{hostState === 'ready' ? L.dock.loading : L.dock.hostNotConnected}</div>}
                </div>
                {fsPreview !== null && (
                  <div className="fs-preview">
                    <div className="fs-preview-head">{L.dock.previewHead(fsPreview.name)}</div>
                    <pre className="tool-io out">{fsPreview.text}</pre>
                  </div>
                )}
              </div>
            )}
            {dockTab === 'diff' && (
              <div className="diff-pane">
                {diff === null && <div className="empty-hint">{hostState === 'ready' ? L.dock.loading : L.dock.hostNotConnected}</div>}
                {diff !== null && !diff.git && <div className="empty-hint">{L.dock.notGit(diff.cwd)}</div>}
                {diff !== null && diff.git && (
                  <>
                    <div className="fs-preview-head">{L.dock.gitChanges(diff.cwd, diff.changed.length)}</div>
                    <div className="fs-list">
                      {diff.changed.map((c) => (
                        <div key={c.path} className="diff-row">
                          <span className={`diff-state ${c.state.includes('D') ? 'del' : c.state.includes('A') || c.state.includes('?') ? 'add' : 'mod'}`}>{c.state || 'M'}</span>
                          <span className="diff-path">{c.path}</span>
                        </div>
                      ))}
                      {diff.changed.length === 0 && <div className="empty-hint">{L.dock.noChanges}</div>}
                    </div>
                    {diff.stat !== '' && <pre className="tool-io out">{diff.stat}</pre>}
                  </>
                )}
              </div>
            )}
            {dockTab === 'evidence' && (
              <div className="evidence-pane">
                <div className="dock-row"><span className="dock-k">{L.dock.memoryLayers}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.memory as { layers?: unknown } | undefined)?.layers)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.memoryEntries}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.memory as { entries?: unknown } | undefined)?.entries)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.trajectories}</span><span className="dock-v">{cog === null ? L.dock.loading : num(cog.trajectories)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.auditEvents}</span><span className="dock-v">{cog === null ? L.dock.loading : num(cog.auditEvents)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.worldModelVer}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.worldModel as { version?: unknown } | undefined)?.version)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.wmBrier}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.worldModel as { brier?: unknown } | undefined)?.brier)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.calibPreds}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.calibration as { predictions?: unknown } | undefined)?.predictions)}</span></div>
                <div className="dock-row"><span className="dock-k">{L.dock.calibReli}</span><span className="dock-v">{cog === null ? L.dock.loading : num((cog.calibration as { reliability?: unknown } | undefined)?.reliability)}</span></div>
                <div className="dock-note">{L.dock.evidenceNote}</div>
              </div>
            )}
            {dockTab === 'logs' && (
              <div className="logs-pane">
                <div className="fs-preview-head">{L.dock.logsHead}</div>
                <div className="logs-list">
                  {logs.map((l, i) => (
                    <div key={`${i}-${l.text.slice(0, 20)}`} className="log-row">
                      <span className="log-sid">{l.sessionId.slice(0, 10)}</span>
                      <span className="log-text">{l.text}</span>
                    </div>
                  ))}
                  {logs.length === 0 && <div className="empty-hint">{L.dock.logsEmpty}</div>}
                </div>
              </div>
            )}
            {dockTab === 'remote' && (
              <div className="evidence-pane">
                <div className="fs-preview-head">{L.dock.remoteTitle}</div>
                <div className="dock-row">
                  <span className="dock-k">{L.dock.hostState}</span>
                  <span className="dock-v">{remoteWeb === null ? L.dock.loading : remoteWeb.up ? L.dock.remoteRunning(remoteWeb.version) : L.dock.remoteStopped}</span>
                </div>
                {remoteWeb !== null && remoteWeb.up && (
                  <div className="dock-row"><span className="dock-k">{L.dock.remoteLanUrl(`http://${remoteWeb.lanIp || '127.0.0.1'}:${remoteWeb.port}`)}</span></div>
                )}
                <div className="remote-actions">
                  {remoteWeb === null || remoteWeb.up ? (
                    <button className="btn danger" disabled={remoteBusy || remoteWeb === null} onClick={() => void stopRemoteWeb()}>{remoteBusy ? L.dock.loading : L.dock.remoteStop}</button>
                  ) : (
                    <button className="btn primary" disabled={remoteBusy || !remoteWeb.available} title={remoteWeb.available ? '' : L.dock.remoteNoRuntime} onClick={() => void startRemoteWeb()}>{remoteBusy ? L.dock.loading : L.dock.remoteStart}</button>
                  )}
                </div>
                <div className="dock-note">{L.dock.remoteSteps}</div>
                <div className="dock-note">{L.dock.remoteSecurityNote}</div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
