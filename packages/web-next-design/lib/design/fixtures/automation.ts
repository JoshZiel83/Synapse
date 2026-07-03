// Curated automation fixtures — realistic scheduled + event rules and a small
// reusable event-source registry, bound to real design chat conversations, so
// the redesigned Automations surface shows coherent data instead of the random
// faker output (which rendered "Invalid Date" and garbage counts).
import type {
  AutomationRule,
  AutomationEventSource,
  AutomationTrigger,
  AutomationPolicy,
  AutomationDelivery,
  AutomationOccurrence,
  AutomationWebhookEndpoint,
  Timestamp,
} from "@synapse/shared"
import type { AutomationRuleCreateInput } from "@synapse/shared/schemas"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId, designWorkspaceMemberId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const WS = designWorkspaceId

// ── Event source registry ────────────────────────────────────────────────────
function eventSource(
  o: Partial<AutomationEventSource> &
    Pick<AutomationEventSource, "id" | "providerKind" | "sourceKey" | "name">
): AutomationEventSource {
  return {
    workspaceId: WS,
    description: "",
    payloadSchema: {},
    examplePayload: {},
    status: "active",
    metadata: {},
    createdAt: ts("2026-06-10T08:00:00Z"),
    updatedAt: ts("2026-06-10T08:00:00Z"),
    ...o,
  }
}

export const designEventSources: AutomationEventSource[] = [
  eventSource({
    id: "es-github-push",
    providerKind: "integration",
    sourceKey: "github.push",
    name: "GitHub · Push",
    description: "synapse-ai/api 仓库的 push 事件",
    recommendedUsage: "当有人推送到主分支时触发部署或通知。",
    status: "active",
    lastTriggeredAt: ts("2026-06-30T14:12:00Z"),
    integration: {
      installationId: "inst-gh-1",
      provider: "github",
      ingressKind: "webhook",
      targetKind: "repository",
      targetId: "synapse-ai/api",
      targetLabel: "synapse-ai/api",
    },
    examplePayload: {
      ref: "refs/heads/main",
      repository: { name: "api", full_name: "synapse-ai/api" },
      pusher: { name: "linmo" },
      commits: [{ id: "a1b2c3d", message: "feat: add automations" }],
    },
  }),
  eventSource({
    id: "es-gitlab-mr",
    providerKind: "integration",
    sourceKey: "gitlab.merge_request",
    name: "GitLab · Merge Request",
    description: "web 仓库的 merge_request 事件",
    status: "active",
    integration: {
      installationId: "inst-gl-1",
      provider: "gitlab",
      ingressKind: "webhook",
      targetKind: "project",
      targetId: "synapse/web",
      targetLabel: "synapse/web",
    },
    examplePayload: {
      object_kind: "merge_request",
      object_attributes: {
        action: "open",
        target_branch: "main",
        state: "opened",
      },
    },
  }),
  eventSource({
    id: "es-webhook-deploy",
    providerKind: "webhook",
    providerRef: "deploy-hook",
    sourceKey: "webhook.deploy-hook",
    name: "部署回调 Webhook",
    description: "CI 部署完成后回调的通用 webhook",
    status: "active",
    lastTriggeredAt: ts("2026-06-29T22:40:00Z"),
    examplePayload: {
      event: "deploy.finished",
      environment: "production",
      status: "success",
    },
  }),
  eventSource({
    id: "es-internal-signup",
    providerKind: "internal",
    sourceKey: "internal.workspace.member_joined",
    name: "内部 · 新成员加入",
    description: "有新成员加入工作区时的内部事件",
    status: "active",
    examplePayload: {
      memberId: "wm-xxx",
      role: "member",
      invitedBy: "wm-viewer",
    },
  }),
  eventSource({
    id: "es-webhook-legacy",
    providerKind: "webhook",
    providerRef: "legacy-alerts",
    sourceKey: "webhook.legacy-alerts",
    name: "旧告警 Webhook",
    description: "已被监控平台迁移替代",
    status: "deprecated",
    examplePayload: { alert: "cpu_high", severity: "warning" },
  }),
]

// ── Automation rules ─────────────────────────────────────────────────────────
const defaultPolicy = (
  o: Partial<AutomationPolicy> = {}
): AutomationPolicy => ({
  ruleId: "",
  triggerCount: 0,
  completionStatus: "completed",
  metadata: {},
  ...o,
})

function rule(o: {
  id: string
  name: string
  description?: string
  conversationId: string
  status: AutomationRule["status"]
  trigger: Partial<AutomationTrigger>
  delivery: Partial<AutomationDelivery>
  policy?: Partial<AutomationPolicy>
  lastTriggeredAt?: string
  lastErrorMessage?: string
  createdAt?: string
}): AutomationRule {
  const isEvent = o.trigger.triggerKind === "event"
  const category = isEvent ? "event_subscription" : "schedule"
  return {
    id: o.id,
    workspaceId: WS,
    authorityWorkspaceId: WS,
    conversationId: o.conversationId,
    category,
    status: o.status,
    name: o.name,
    description: o.description ?? "",
    createdByParticipantId: "pp-self",
    trigger: {
      ruleId: o.id,
      triggerKind: isEvent ? "event" : "schedule",
      sourceKind: isEvent
        ? (o.trigger.eventProviderKind ?? "webhook")
        : "clock",
      matcher: {},
      metadata: {},
      ...o.trigger,
    },
    policy: { ...defaultPolicy(o.policy), ruleId: o.id },
    delivery: {
      ruleId: o.id,
      messageText: "",
      messageBlocks: [],
      targetPolicy: "all_members",
      targetParticipantIds: [],
      metadata: {},
      ...o.delivery,
    },
    lastTriggeredAt: o.lastTriggeredAt ? ts(o.lastTriggeredAt) : undefined,
    lastErrorMessage: o.lastErrorMessage,
    lastErrorAt: o.lastErrorMessage ? ts("2026-06-30T03:00:00Z") : undefined,
    metadata: {},
    createdAt: ts(o.createdAt ?? "2026-06-15T09:00:00Z"),
    updatedAt: ts("2026-06-28T09:00:00Z"),
  }
}

export const designAutomationRules: AutomationRule[] = [
  rule({
    id: "ar-standup",
    name: "工作日站会提醒",
    conversationId: "cv-atlas",
    status: "active",
    lastTriggeredAt: "2026-06-30T01:00:00Z",
    trigger: {
      scheduleKind: "cron",
      scheduleExpr: "0 9 * * 1-5",
      scheduleTimezone: "Asia/Shanghai",
      nextFireAt: ts("2026-07-03T01:00:00Z"),
    },
    delivery: {
      messageText: "早上好，站会时间到啦，同步一下今天的计划 ☕️",
      wakeReasonText: "工作日站会",
    },
    policy: { triggerCount: 42 },
  }),
  rule({
    id: "ar-daily-report",
    name: "每日数据日报",
    conversationId: "cv-nova",
    status: "active",
    lastTriggeredAt: "2026-06-30T10:00:00Z",
    trigger: {
      scheduleKind: "cron",
      scheduleExpr: "0 18 * * *",
      scheduleTimezone: "Asia/Shanghai",
      nextFireAt: ts("2026-07-01T10:00:00Z"),
    },
    delivery: {
      messageText: "生成今天的核心指标日报并发到群里。",
      wakeReasonText: "生成每日数据日报",
      targetPolicy: "specified_members",
      targetParticipantIds: ["pp-nova"],
    },
    policy: { triggerCount: 128 },
  }),
  rule({
    id: "ar-hourly-poll",
    name: "每小时巡检",
    conversationId: "cv-files",
    status: "paused",
    trigger: {
      scheduleKind: "interval",
      intervalSeconds: 3600,
      nextFireAt: ts("2026-07-01T13:00:00Z"),
    },
    delivery: { messageText: "巡检一遍待处理素材，有异常回复我。" },
    policy: { triggerCount: 15 },
  }),
  rule({
    id: "ar-github-deploy",
    name: "主分支推送即通知",
    conversationId: "cv-atlas",
    status: "active",
    lastTriggeredAt: "2026-06-30T14:12:00Z",
    trigger: {
      triggerKind: "event",
      eventSourceId: "es-github-push",
      eventSourceKey: "github.push",
      eventSourceName: "GitHub · Push",
      eventProviderKind: "integration",
      matcher: { ref: "refs/heads/main" },
    },
    delivery: {
      messageText: "main 分支有新的推送，确认是否需要部署。",
      wakeReasonText: "GitHub main 推送",
    },
    policy: { triggerCount: 7 },
  }),
  rule({
    id: "ar-launch-once",
    name: "发布日一次性提醒",
    conversationId: "cv-feishu",
    status: "active",
    trigger: {
      scheduleKind: "at",
      startsAt: ts("2026-07-10T01:00:00Z"),
      scheduleTimezone: "Asia/Shanghai",
      nextFireAt: ts("2026-07-10T01:00:00Z"),
    },
    delivery: { messageText: "今天是发布日，走一遍上线检查清单 🚀" },
    policy: { triggerCount: 0, completionStatus: "completed" },
  }),
  rule({
    id: "ar-deploy-alert",
    name: "部署回调播报",
    conversationId: "cv-nova",
    status: "error",
    lastErrorMessage: "事件源 signing secret 校验失败（401）",
    trigger: {
      triggerKind: "event",
      eventSourceId: "es-webhook-deploy",
      eventSourceKey: "webhook.deploy-hook",
      eventSourceName: "部署回调 Webhook",
      eventProviderKind: "webhook",
      matcher: { status: "success", environment: "production" },
    },
    delivery: { messageText: "生产环境部署完成，通知相关同学。" },
    policy: { triggerCount: 3 },
  }),
]

// Echo a create-input back as a full rule so the editor shows a coherent result
// (the sandbox mock is stateless — this isn't persisted across refetches).
let created = 0
export function buildRuleFromInput(
  data: AutomationRuleCreateInput
): AutomationRule {
  created += 1
  const id = `ar-new-${created}`
  const tk = data.trigger.triggerKind
  const category = tk === "event" ? "event_subscription" : "schedule"
  const src = data.trigger.eventSourceId
    ? designEventSources.find((s) => s.id === data.trigger.eventSourceId)
    : undefined
  return {
    id,
    workspaceId: WS,
    authorityWorkspaceId: WS,
    conversationId: data.conversationId,
    category,
    status: data.status ?? "active",
    name: data.name,
    description: data.description ?? "",
    createdByParticipantId: "pp-self",
    trigger: {
      ruleId: id,
      triggerKind: tk,
      sourceKind:
        data.trigger.sourceKind ??
        (tk === "event" ? (src?.providerKind ?? "webhook") : "clock"),
      eventSourceId: data.trigger.eventSourceId,
      eventSourceKey: src?.sourceKey,
      eventSourceName: src?.name,
      eventProviderKind: src?.providerKind,
      matcher: (data.trigger.matcher as Record<string, unknown>) ?? {},
      scheduleKind: data.trigger.scheduleKind,
      scheduleExpr: data.trigger.scheduleExpr,
      scheduleTimezone: data.trigger.scheduleTimezone,
      intervalSeconds: data.trigger.intervalSeconds,
      startsAt: data.trigger.startsAt as Timestamp | undefined,
      metadata: {},
    },
    policy: {
      ruleId: id,
      activeFrom: data.policy?.activeFrom as Timestamp | undefined,
      activeUntil: data.policy?.activeUntil as Timestamp | undefined,
      maxTriggerCount: data.policy?.maxTriggerCount,
      triggerCount: 0,
      completionStatus: data.policy?.completionStatus ?? "completed",
      metadata: {},
    },
    delivery: {
      ruleId: id,
      messageText: data.delivery.message ?? "",
      wakeReasonText: data.delivery.wakeReason,
      messageBlocks: [],
      targetPolicy: data.delivery.targetPolicy ?? "all_members",
      targetParticipantIds: data.delivery.targetParticipantIds ?? [],
      metadata: {},
    },
    metadata: {},
    createdAt: ts("2026-07-01T12:00:00Z"),
    updatedAt: ts("2026-07-01T12:00:00Z"),
  }
}

// ── Occurrences (event history, drives the source detail / debugging log) ─────
let occSeq = 0
function occ(
  eventSourceId: string,
  eventSourceKey: string,
  eventSourceName: string,
  displayTitle: string,
  payload: Record<string, unknown>,
  at: string
): AutomationOccurrence {
  occSeq += 1
  return {
    id: `occ-${occSeq}`,
    workspaceId: WS,
    sourceKind: eventSourceKey.startsWith("webhook")
      ? "webhook"
      : "integration",
    eventSourceId,
    eventSourceKey,
    eventSourceName,
    displayTitle,
    displaySummary: displayTitle,
    dedupeKey: `${eventSourceId}:${at}`,
    sourceSnapshot: {},
    payload,
    occurredAt: ts(at),
    createdAt: ts(at),
  }
}

export const designOccurrences: Record<string, AutomationOccurrence[]> = {
  "es-github-push": [
    occ(
      "es-github-push",
      "github.push",
      "GitHub · Push",
      "push 到 main（linmo）",
      {
        ref: "refs/heads/main",
        repository: { name: "api", full_name: "synapse-ai/api" },
        pusher: { name: "linmo" },
      },
      "2026-06-30T14:12:00Z"
    ),
    occ(
      "es-github-push",
      "github.push",
      "GitHub · Push",
      "push 到 feature/x（chen）",
      {
        ref: "refs/heads/feature/x",
        repository: { name: "api", full_name: "synapse-ai/api" },
        pusher: { name: "chen" },
      },
      "2026-06-30T11:03:00Z"
    ),
    occ(
      "es-github-push",
      "github.push",
      "GitHub · Push",
      "push 到 main（nova）",
      {
        ref: "refs/heads/main",
        repository: { name: "api", full_name: "synapse-ai/api" },
        pusher: { name: "nova" },
      },
      "2026-06-29T18:40:00Z"
    ),
  ],
  "es-webhook-deploy": [
    occ(
      "es-webhook-deploy",
      "webhook.deploy-hook",
      "部署回调 Webhook",
      "production 部署成功",
      {
        event: "deploy.finished",
        environment: "production",
        status: "success",
      },
      "2026-06-29T22:40:00Z"
    ),
    occ(
      "es-webhook-deploy",
      "webhook.deploy-hook",
      "部署回调 Webhook",
      "staging 部署失败",
      { event: "deploy.finished", environment: "staging", status: "failed" },
      "2026-06-29T21:10:00Z"
    ),
  ],
}

// ── Webhook endpoints (net-new entity; no ApiClient method — curated) ─────────
function endpoint(
  pathToken: string,
  name: string,
  status: AutomationWebhookEndpoint["status"],
  lastReceivedAt?: string
): AutomationWebhookEndpoint {
  return {
    id: `whep-${pathToken}`,
    workspaceId: WS,
    name,
    status,
    pathToken,
    secretHint: "whsec_••••••••4f2a",
    metadata: {},
    lastReceivedAt: lastReceivedAt ? ts(lastReceivedAt) : undefined,
    createdAt: ts("2026-06-10T08:00:00Z"),
    updatedAt: ts("2026-06-10T08:00:00Z"),
  }
}

export const designWebhookEndpoints: Record<string, AutomationWebhookEndpoint> =
  {
    "deploy-hook": endpoint(
      "deploy-hook",
      "部署回调",
      "active",
      "2026-06-29T22:40:00Z"
    ),
    "legacy-alerts": endpoint("legacy-alerts", "旧告警", "disabled"),
  }

// How many rules subscribe to a source (reuse-aware lifecycle guards).
export function sourceSubscriberCount(sourceId: string): number {
  return designAutomationRules.filter(
    (r) => r.trigger.eventSourceId === sourceId
  ).length
}
