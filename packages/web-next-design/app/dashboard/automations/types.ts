// The editor's working draft — a superset of AutomationRuleCreateInput fields
// flattened for the form. compileDraft() maps it to the real create input.
import type { AutomationRuleCreateInput } from "@synapse/shared/schemas"

export interface RuleDraft {
  name: string
  conversationId: string
  trigger: {
    triggerKind: "schedule" | "event"
    scheduleKind: "cron" | "at" | "interval"
    scheduleExpr?: string
    scheduleTimezone?: string
    intervalSeconds?: number
    startsAt?: string
    eventSourceId?: string
    matcher: Record<string, unknown>
  }
  delivery: {
    message: string
    wakeEnabled: boolean
    wakeReason?: string
    targetPolicy: "all_members" | "specified_members"
    targetParticipantIds: string[]
  }
  policy: {
    activeFrom?: string
    activeUntil?: string
    maxTriggerCount?: number
  }
  startPaused: boolean
}

export function emptyDraft(conversationId = ""): RuleDraft {
  return {
    name: "",
    conversationId,
    trigger: {
      triggerKind: "schedule",
      scheduleKind: "cron",
      scheduleExpr: "0 9 * * *",
      scheduleTimezone: "Asia/Shanghai",
      matcher: {},
    },
    delivery: {
      message: "",
      wakeEnabled: false,
      targetPolicy: "all_members",
      targetParticipantIds: [],
    },
    policy: {},
    startPaused: false,
  }
}

export function compileDraft(d: RuleDraft): AutomationRuleCreateInput {
  const isEvent = d.trigger.triggerKind === "event"
  return {
    name: d.name.trim(),
    conversationId: d.conversationId,
    status: d.startPaused ? "paused" : "active",
    trigger: isEvent
      ? {
          triggerKind: "event",
          eventSourceId: d.trigger.eventSourceId,
          matcher: d.trigger.matcher,
        }
      : {
          triggerKind: "schedule",
          scheduleKind: d.trigger.scheduleKind,
          scheduleExpr:
            d.trigger.scheduleKind === "interval"
              ? undefined
              : d.trigger.scheduleExpr,
          scheduleTimezone:
            d.trigger.scheduleKind === "interval"
              ? undefined
              : d.trigger.scheduleTimezone,
          intervalSeconds:
            d.trigger.scheduleKind === "interval"
              ? d.trigger.intervalSeconds
              : undefined,
          startsAt:
            d.trigger.scheduleKind === "at" ? d.trigger.startsAt : undefined,
        },
    delivery: {
      message: d.delivery.message,
      wakeReason: d.delivery.wakeEnabled ? d.delivery.wakeReason : undefined,
      messageBlocks: [],
      targetPolicy: d.delivery.targetPolicy,
      targetParticipantIds:
        d.delivery.targetPolicy === "specified_members"
          ? d.delivery.targetParticipantIds
          : undefined,
    },
    policy: {
      activeFrom: d.policy.activeFrom,
      activeUntil: d.policy.activeUntil,
      maxTriggerCount: d.policy.maxTriggerCount,
    },
  }
}

// Is the draft coherent enough to save?
export function draftError(d: RuleDraft): string | null {
  if (!d.name.trim()) return "请填写自动化名称"
  if (!d.conversationId) return "请选择投递的会话"
  if (d.trigger.triggerKind === "event" && !d.trigger.eventSourceId)
    return "请选择一个事件源"
  if (d.trigger.triggerKind === "schedule") {
    if (d.trigger.scheduleKind === "interval" && !d.trigger.intervalSeconds)
      return "请设置间隔"
    if (d.trigger.scheduleKind === "at" && !d.trigger.startsAt)
      return "请选择触发时间"
    if (d.trigger.scheduleKind === "cron" && !d.trigger.scheduleExpr?.trim())
      return "请设置定时规则"
  }
  return null
}
