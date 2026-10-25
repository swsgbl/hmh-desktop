/**
 * i18n ArkTS 版(与 tests/i18n-dict.ts 同构;词条语义 1:1 抄 desktop i18n.ts 子集)
 * 运行时查表:页面持有 locale 引用,切换后重渲染。
 */
export type Locale = 'zh' | 'en'

const zh: Record<string, string> = {
  'status.running': '运行中', 'status.connected': '已连接', 'status.completed': '已完成',
  'status.failed': '失败', 'status.idle': '空闲', 'status.stopped': '已停止',
  'side.new': '+ 新建会话', 'side.search': '搜索会话…', 'side.empty': '点"新建会话"开始',
  'side.loadMore': '加载更多', 'side.noWs': '未记录工作区',
  'side.filterAll': '全部', 'side.filterRunning': '运行中', 'side.filterDone': '已完成', 'side.filterFailed': '失败',
  'side.pin': '收藏/取消收藏', 'side.export': '导出 Markdown', 'side.archive': '归档(可恢复)',
  'side.delete': '删除(移入回收站,可恢复)',
  'stream.emptyNo': '新建一个会话,或从左侧选择',
  'stream.needAppr': '需要审批', 'stream.approve': '批准', 'stream.reject': '拒绝',
  'stream.toolRunning': ' 执行中…',
  'stream.artifactHint': '交付物(工作区相对路径;可在 Files 面板预览)',
  'stream.taskFailed': '任务失败',
  'comp.send': '发送', 'comp.inject': '注入运行中任务', 'comp.attach': '@ 引用工作区文件',
  'comp.phNoSession': '先新建会话…', 'comp.phBusy': '任务运行中——输入将注入当前任务',
  'comp.phEnter': '描述目标(Enter 发送)',
  'top.model': '当前 chat 模型', 'top.approval': '审批', 'top.approvalAsk': 'ask(默认)', 'top.approvalAuto': 'auto',
  'set.title': '设置', 'set.theme': '外观', 'set.themeSystem': '跟随系统', 'set.themeLight': '浅色', 'set.themeDark': '深色',
  'set.lang': '语言', 'set.approvalMode': '审批模式',
  'set.autoNote': 'auto 即时生效并持久;破坏性操作仍受 runtime 审批门约束。',
  'set.providerSection': 'Provider(runtime config.json;密钥只显示末四位)',
  'set.noProvider': '暂无 provider',
  'dock.overview': '总览', 'dock.files': '文件', 'dock.logs': '日志',
  'dock.hostState': 'host 状态', 'dock.rtVer': 'runtime 版本', 'dock.mode': '模式', 'dock.sessCount': '会话数',
  'dock.runState': '运行状态', 'dock.noData': '无数据', 'dock.none': '—',
  'dock.overviewNote': '工具轨迹默认折叠;证据缺失显示"无数据",不假填 0。',
  'dock.logsHead': '运行日志(runtime line 流,最近 200 条)',
  'dock.logsEmpty': '(暂无日志——跑一个任务后实时累积)',
  'dock.notGit': '非 git 工作区', 'dock.gitChanges': 'git 变更', 'dock.noChanges': '(无变更)',
  'dock.ws': '工作区',
  'err.sendFailed': '发送失败(host 未就绪或拒绝)',
}

const en: Record<string, string> = {
  'status.running': 'Running', 'status.connected': 'Connected', 'status.completed': 'Completed',
  'status.failed': 'Failed', 'status.idle': 'Idle', 'status.stopped': 'Stopped',
  'side.new': '+ New Session', 'side.search': 'Search sessions…', 'side.empty': 'Click "New Session" to start',
  'side.loadMore': 'Load more', 'side.noWs': 'No workspace recorded',
  'side.filterAll': 'All', 'side.filterRunning': 'Running', 'side.filterDone': 'Done', 'side.filterFailed': 'Failed',
  'side.pin': 'Pin / unpin', 'side.export': 'Export Markdown', 'side.archive': 'Archive (recoverable)',
  'side.delete': 'Delete (trash, recoverable)',
  'stream.emptyNo': 'New session, or pick from the left',
  'stream.needAppr': 'Approval needed', 'stream.approve': 'Approve', 'stream.reject': 'Reject',
  'stream.toolRunning': ' running…',
  'stream.artifactHint': 'Deliverable (workspace-relative path; preview in Files)',
  'stream.taskFailed': 'Task failed',
  'comp.send': 'Send', 'comp.inject': 'Inject into running task', 'comp.attach': '@ Reference workspace file',
  'comp.phNoSession': 'New session first…', 'comp.phBusy': 'Task running — input will be injected',
  'comp.phEnter': 'Describe the goal (Enter to send)',
  'top.model': 'Current chat model', 'top.approval': 'Approval', 'top.approvalAsk': 'ask (default)', 'top.approvalAuto': 'auto',
  'set.title': 'Settings', 'set.theme': 'Appearance', 'set.themeSystem': 'System', 'set.themeLight': 'Light', 'set.themeDark': 'Dark',
  'set.lang': 'Language', 'set.approvalMode': 'Approval mode',
  'set.autoNote': 'auto applies instantly and persists; destructive ops still gated by runtime.',
  'set.providerSection': 'Provider (runtime config.json; key shows last 4 only)',
  'set.noProvider': 'No provider',
  'dock.overview': 'Overview', 'dock.files': 'Files', 'dock.logs': 'Logs',
  'dock.hostState': 'host state', 'dock.rtVer': 'runtime version', 'dock.mode': 'Mode', 'dock.sessCount': 'Sessions',
  'dock.runState': 'Run state', 'dock.noData': 'no data', 'dock.none': '—',
  'dock.overviewNote': 'Tool traces collapsed by default; missing evidence shows "no data", never fake zeros.',
  'dock.logsHead': 'Run logs (runtime line stream, last 200)',
  'dock.logsEmpty': '(no logs yet — accumulates as tasks run)',
  'dock.notGit': 'not a git workspace', 'dock.gitChanges': 'git changes', 'dock.noChanges': '(no changes)',
  'dock.ws': 'Workspace',
  'err.sendFailed': 'Send failed (host not ready or refused)',
}

export function t(key: string, locale: Locale): string {
  const d = locale === 'en' ? en : zh
  const v = d[key]
  return v !== undefined ? v : (zh[key] !== undefined ? zh[key] : key)
}

/** 系统语言 → locale(zh* → zh,其余 en)。 */
export function pickLocale(sysLang: string): Locale {
  return sysLang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}
