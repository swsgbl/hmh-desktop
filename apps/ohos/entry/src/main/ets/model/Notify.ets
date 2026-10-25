/**
 * #19 通知:approvalReq → notificationManager 发本地通知
 * 点击通知 → wantAgent 拉起 EntryAbility(路由到会话页)
 * 纯逻辑:通知 id 生成/去重窗口(同工具名 10s 内不重复轰炸)
 */
export interface NotifyDecision {
  shouldPublish: boolean
  notifyId: number
}

const DEDUP_WINDOW_MS = 10_000

/** 通知 id:hash 工具名 → 稳定正整数(同一工具复用同一 id,新内容覆盖旧通知) */
export function notifyIdFor(toolName: string): number {
  let h = 0
  for (let i = 0; i < toolName.length; i++) {
    h = (h * 31 + toolName.charCodeAt(i)) | 0
  }
  return (h >>> 0) % 100000 + 1
}

/** 去重窗口:同 id 在窗口内已发过则跳过(防 SSE 重连重放轰炸) */
export function shouldNotify(id: number, now: number, lastSent: Map<number, number>): NotifyDecision {
  const prev = lastSent.get(id)
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) {
    return { shouldPublish: false, notifyId: id } as NotifyDecision
  }
  lastSent.set(id, now)
  return { shouldPublish: true, notifyId: id } as NotifyDecision
}
