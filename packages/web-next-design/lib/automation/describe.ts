// Humanize a trigger/delivery/status into the plain-language sentences the list
// and the editor summary show — so raw enums / cron / matcher JSON never leak to
// the surface. Shared by every automation view.
import { describeCron } from "./schedule"
import { describeMatcher } from "./matcher"

// Loose views so both the branded AutomationTrigger/Delivery and the editor's
// plain-string draft can be described without casts.
interface TriggerLike {
  triggerKind?: string
  scheduleKind?: string
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: string
  eventSourceName?: string
  eventSourceKey?: string
  matcher?: Record<string, unknown>
}
interface DeliveryLike {
  messageText?: string
  wakeReasonText?: string
  targetPolicy?: string
  targetParticipantIds?: string[]
}

export function formatInstant(value?: string, tz?: string): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz || undefined,
    }).format(d)
  } catch {
    return d.toISOString()
  }
}

export function describeInterval(sec: number): string {
  if (sec % 86400 === 0) return `每 ${sec / 86400} 天`
  if (sec % 3600 === 0) return `每 ${sec / 3600} 小时`
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟`
  return `每 ${sec} 秒`
}

export function describeSchedule(t: TriggerLike): string {
  if (t.scheduleKind === "cron" && t.scheduleExpr) {
    const tz = t.scheduleTimezone ? ` · ${t.scheduleTimezone}` : ""
    return `${describeCron(t.scheduleExpr)}${tz}`
  }
  if (t.scheduleKind === "interval" && t.intervalSeconds) {
    return describeInterval(t.intervalSeconds)
  }
  if (t.scheduleKind === "at") {
    const raw = t.startsAt ?? t.scheduleExpr
    return raw
      ? `一次性 · ${formatInstant(raw, t.scheduleTimezone)}`
      : "一次性 · 未设置时间"
  }
  return "未设置时间"
}

export function describeTrigger(t: TriggerLike): string {
  if (t.triggerKind === "event") {
    const src = t.eventSourceName || t.eventSourceKey || "事件源"
    const hasMatch = t.matcher && Object.keys(t.matcher).length > 0
    return hasMatch
      ? `当「${src}」触发，且 ${describeMatcher(t.matcher as Record<string, unknown>)}`
      : `当「${src}」触发`
  }
  return describeSchedule(t)
}

export function describeDelivery(d: DeliveryLike): string {
  const who =
    d.targetPolicy === "specified_members"
      ? `指定 ${d.targetParticipantIds?.length ?? 0} 位成员`
      : "会话全体成员"
  const text = d.messageText?.trim() || d.wakeReasonText?.trim() || "（空消息）"
  return `向${who}投递：${text}`
}

export interface StatusMeta {
  label: string
  tone: "green" | "muted" | "red" | "blue" | "amber"
}
export const STATUS_META: Record<string, StatusMeta> = {
  active: { label: "运行中", tone: "green" },
  paused: { label: "已暂停", tone: "muted" },
  error: { label: "出错", tone: "red" },
  archived: { label: "已归档", tone: "muted" },
  completed: { label: "已完成", tone: "blue" },
  expired: { label: "已过期", tone: "amber" },
}

export const CATEGORY_LABEL: Record<string, string> = {
  schedule: "定时",
  event_subscription: "事件",
}

export const TARGET_POLICY_LABEL: Record<string, string> = {
  all_members: "会话全体成员",
  specified_members: "指定成员",
}

export const PROVIDER_KIND_LABEL: Record<string, string> = {
  device: "设备",
  webhook: "Webhook",
  internal: "内部",
  integration: "集成",
}

export const SOURCE_STATUS_LABEL: Record<string, string> = {
  active: "启用",
  deprecated: "已弃用",
  disabled: "已停用",
  archived: "已归档",
}
