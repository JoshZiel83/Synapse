import crypto from "node:crypto"
import cronParser from "cron-parser"
import { v4 as uuidv4 } from "uuid"
import {
  assertIsoInstant,
  dateToIsoInstant,
  nowIsoInstant,
} from "@synapse/shared/datetime"
import { parseInstantString } from "../../infrastructure/datetime.js"
import type {
  AutomationEventSourceAccessGrant,
  CapabilityAccessTarget,
  AutomationCategory,
  AutomationCompletionStatus,
  AutomationCreatorKind,
  AutomationDelivery,
  AutomationExecution,
  AutomationEventProviderKind,
  AutomationPolicy,
  AutomationEventSource,
  AutomationEventSourceIntegration,
  AutomationEventSourceStatus,
  AutomationExecutionStatus,
  AutomationIntegrationIngressKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
  AutomationOccurrence,
  AutomationRule,
  AutomationSourceKind,
  AutomationStatus,
  AutomationTargetPolicy,
  AutomationTrigger,
  AutomationTriggerKind,
  AutomationWebhookEndpointCreateResult,
  CanonicalContentBlockInput,
  Timestamp,
} from "@synapse/shared"
import {
  AUTOMATION_RULE_CATEGORY,
  DEFAULT_CONVERSATION_TYPE_MASK,
  extractText,
  maskAllowsConversationType,
  resolveNarrowedConversationTypeMask,
  slugify,
  workspaceRef,
} from "@synapse/shared"
import {
  mergeAutomationRuleUpdatePayload,
  validateAutomationRuleCreatePayload,
} from "@synapse/shared/automation"
import { decrypt, encrypt } from "../../infrastructure/crypto/index.js"
import { type Executor } from "../../infrastructure/database/kysely.js"
import {
  appendAutomationAuditLog,
  applyAutomationPolicyAfterTrigger as applyAutomationPolicyAfterTriggerRepo,
  claimPendingAutomationExecutionRow,
  clearAutomationRuleError,
  existsAutomationEventSourceKey,
  existsAutomationExecution,
  expireAutomationRuleRows,
  insertAutomationDeliveryRow,
  insertAutomationEventSourceRow,
  insertAutomationTriggerRow,
  insertAutomationExecutionTarget,
  insertAutomationPolicyRow,
  insertAutomationRuleRow,
  insertAutomationWebhookEndpointReturningRow,
  insertIntegrationBindingRow,
  insertWebhookEndpointRow,
  getAutomationEventSourceRow,
  listActiveIntegrationSourceKeysForBinding as listActiveIntegrationSourceKeysForBindingRepo,
  listActiveEventSubscriptionRuleRowsByEventSource,
  listAutomationExecutionRows,
  listAutomationEventSourceRows,
  listAutomationOccurrenceRows,
  listAutomationRuleIds,
  listAutomationWebhookEndpointRows,
  listIntegrationAutomationEventSourceRowsByWebhookPathToken,
  loadAutomationRuleComponentRows,
  lockDueAutomationScheduleRows,
  loadAutomationEventSourceAccessBindingRows,
  markAutomationExecutionCompleted,
  markAutomationExecutionFailed,
  markAutomationExecutionSkipped,
  markAutomationRuleTriggered,
  normalizeAutomationDeliveryRow,
  normalizeAutomationEventSourceRow,
  normalizeAutomationExecutionWithOccurrenceRow,
  normalizeAutomationOccurrenceRow,
  normalizeAutomationPolicyRow,
  normalizeAutomationRuleRow,
  normalizeAutomationTriggerRow,
  normalizeAutomationWebhookEndpointRow,
  pauseActiveAutomationRule,
  pauseAutomationRuleRowsForInactiveCreators,
  pauseAutomationRuleRowsForEventSource,
  persistAutomationDeliveryTargets,
  resolveQueryRunner,
  revokeAutomationEventSourceAccessBindingById,
  runnerFor,
  selectActiveAutomationEventSourceId,
  selectActiveAutomationRuleEventMatchers,
  selectActiveWebhookEndpointId,
  selectAutomationOccurrenceRow,
  selectAutomationEventSourceReuseRow,
  selectAutomationIntegrationBindingRow,
  selectAutomationWebhookEndpointRow,
  selectExistingAutomationIntegrationBindingRow,
  selectWebhookAutomationEventSourceByPathToken,
  selectIntegrationEventSourceReuseRow,
  selectWorkspaceOwnerId,
  setAutomationEventSourceStatus,
  softDeleteAutomationEventSource,
  softDeleteAutomationRule,
  touchAutomationEventSourceTriggered,
  touchWebhookReceived,
  updateAutomationDeliveryRow,
  updateAutomationEventSourceAccessBindingMaskOverride,
  updateAutomationEventSourceRow,
  updateAutomationPolicyRow,
  updateAutomationRuleError,
  updateAutomationRuleRow,
  updateAutomationTriggerRow,
  updateAutomationTriggerSchedule,
  updateIntegrationBindingExternalSubscriptionId,
  updateIntegrationBindingTargetLabel,
  updateWebhookEndpointStatus,
  withAutomationTransaction,
  type QueryRunner,
  type SqlRunner,
} from "./repo.js"
import {
  createConversationEvent,
  getConversation,
  getConversationParticipant,
  listConversationParticipants,
} from "../chat/service.js"
import { hasConversationTransportBinding } from "../im/service/bindings.js"
import { buildNormalizedMessageContent } from "../chat/message-content.js"
import {
  buildIntegrationEventSourceTemplate,
  getIntegrationInstallation,
  integrationWebhookCallbackUrl,
  listIntegrationSourceKeysForWebhookIngress,
  normalizeIntegrationWebhookIngress,
  registerIntegrationWebhook,
  updateIntegrationWebhook,
  unregisterIntegrationWebhook,
} from "./integrations.js"
import { enqueueSessionWakeup } from "../session/runtime.js"
import { getSession } from "../session/service.js"
import { getWorkspaceMemberIdentityById } from "../chat/workspace-identity.js"
import {
  automationEventSourceAccessBindingHasTarget,
  mapAutomationEventSourceAccessBindingToGrant,
  normalizeAutomationEventSourceAccessBindingRow,
  readAutomationEventSourceAccessBindingTarget,
  type AutomationEventSourceBindingJoinedRow,
} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import { insertAutomationEventSourceAccessBindingReturningRowOn } from "../access/binding-storage.js"
import type {
  AutomationDeliveryDbRow,
  AutomationDeliveryRow,
  AutomationEventSourceDbRow,
  AutomationIntegrationBindingRow,
  AutomationOccurrenceDbRow,
  AutomationOccurrenceRow,
  AutomationPolicyDbRow,
  AutomationPolicyRow,
  AutomationRuleDbRow,
  AutomationRuleRow,
  AutomationTriggerDbRow,
  AutomationTriggerRow,
  AutomationWebhookEndpointRow,
} from "./repo.types.js"
export type {
  AutomationDeliveryRow,
  AutomationEventSourceRow,
  AutomationExecutionRow,
  AutomationOccurrenceRow,
  AutomationPolicyRow,
  AutomationRuleRow,
  AutomationTriggerRow,
  AutomationWebhookEndpointRow,
} from "./repo.types.js"

type AutomationTargetRow = {
  id: string
  execution_id: string
  conversation_id: string | null
  target_participant_id: string | null
  session_id: string | null
  target_actor_id: string | null
  created_item_id: string | null
  wakeup_id: string | null
  status: AutomationExecutionStatus
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
}

type AutomationEventSourceAccessRow = AutomationEventSourceBindingJoinedRow

type AutomationEventSourceAccessContext = {
  conversationId: string
  actorId?: string | null
}

type AutomationValidationError = Error & {
  issues: { path: string; message: string }[]
  statusCode: 400
}

function createAutomationValidationError(
  issues: { path: string; message: string }[]
): AutomationValidationError {
  const error = new Error(
    issues[0]?.message || "Invalid automation configuration"
  ) as AutomationValidationError
  error.name = "AutomationValidationError"
  error.issues = issues
  error.statusCode = 400
  return error
}

export interface AutomationCreatorInput {
  kind: AutomationCreatorKind
  workspaceMemberId?: string
  actorId?: string
  sessionId?: string
}

type AutomationOperatorInput = {
  workspaceMemberId?: string
  actorId?: string
}

async function resolveAutomationAuditUserId(params: {
  workspaceMemberId?: string
}) {
  if (!params.workspaceMemberId) {
    return null
  }
  const identity = await getWorkspaceMemberIdentityById(
    params.workspaceMemberId
  )
  return identity?.userId || null
}

export interface AutomationTriggerInput {
  triggerKind: AutomationTriggerKind
  eventSourceId?: string
  sourceKind?: AutomationSourceKind
  sourceLocator?: string
  matchKey?: string
  matcher?: Record<string, unknown>
  scheduleKind?: "cron" | "at" | "interval"
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: Timestamp
}

export interface AutomationPolicyInput {
  activeFrom?: Timestamp
  activeUntil?: Timestamp
  maxTriggerCount?: number
  completionStatus?: AutomationCompletionStatus
}

export interface AutomationDeliveryInput {
  message?: string
  wakeReason?: string
  messageBlocks?: CanonicalContentBlockInput[]
  targetPolicy?: AutomationTargetPolicy
  targetParticipantIds?: string[]
}

export interface CreateAutomationRuleInput {
  name: string
  description?: string
  status?: AutomationStatus
  conversationId: string
  trigger: AutomationTriggerInput
  policy?: AutomationPolicyInput
  delivery: AutomationDeliveryInput
  metadata?: Record<string, unknown>
}

export interface UpdateAutomationRuleInput extends Partial<
  Omit<CreateAutomationRuleInput, "trigger" | "delivery">
> {
  trigger?: Partial<AutomationTriggerInput>
  delivery?: Partial<AutomationDeliveryInput>
}

export interface AutomationEventEnvelope {
  workspaceId: string
  eventSourceId: string
  payload?: Record<string, unknown>
  sourceSnapshot?: Record<string, unknown>
  occurredAt?: Timestamp
  dedupeKey?: string
}

export interface AutomationEventSourceIntegrationInput {
  installationId: string
  provider: AutomationIntegrationProvider
  ingressKind?: AutomationIntegrationIngressKind
  targetKind: AutomationIntegrationTargetKind
  targetId: string
  targetLabel?: string
}

export interface CreateAutomationEventSourceInput {
  providerKind: AutomationEventProviderKind
  providerRef?: string
  integration?: AutomationEventSourceIntegrationInput
  sourceKey?: string
  name?: string
  description?: string
  recommendedUsage?: string
  payloadSchema?: Record<string, unknown>
  examplePayload?: Record<string, unknown>
  status?: AutomationEventSourceStatus
  metadata?: Record<string, unknown>
}

export interface UpdateAutomationEventSourceInput {
  providerRef?: string
  name?: string
  description?: string
  recommendedUsage?: string
  payloadSchema?: Record<string, unknown>
  examplePayload?: Record<string, unknown>
  status?: AutomationEventSourceStatus
  metadata?: Record<string, unknown>
}

export interface ScheduleDueRulesResult {
  scheduledExecutions: string[]
}

export interface ProcessAutomationExecutionResult {
  executionId: string
  createdItemId?: string
  wakeupCount: number
}

const AUTOMATION_SCHEDULER_INTERVAL_MS = 15_000
const MAX_SCHEDULER_BATCH_SIZE = 50

// Row -> view presenters live in presenter.ts (guard-layering r3/r4). They
// are imported here so existing call sites keep working with stable names.
import {
  decorateOccurrenceDisplay,
  presentDelivery,
  presentDueScheduleRowDates,
  presentEventSource,
  presentExecution,
  presentOccurrence,
  presentPolicy,
  presentRule,
  presentTrigger,
  presentWebhookEndpoint,
} from "./presenter.js"

function mergeUniqueIds(values: string[] | undefined) {
  return Array.from(new Set((values || []).filter(Boolean)))
}

function generateSecret(length = 48) {
  return crypto.randomBytes(length).toString("base64url")
}

function secretHint(secret: string) {
  return secret.slice(0, 8)
}

function verifyPresentedSecret(secret: string, expectedSecret: string) {
  const provided = Buffer.from(secret, "utf8")
  const expected = Buffer.from(expectedSecret, "utf8")
  if (provided.length !== expected.length) {
    return false
  }
  return crypto.timingSafeEqual(provided, expected)
}

function buildWebhookSourceLocator(endpointId: string) {
  return `webhook:${endpointId}`
}

function buildEventSourceLocator(
  source: Pick<
    AutomationEventSource,
    "providerKind" | "providerRef" | "id" | "integration"
  >
) {
  if (source.providerKind === "integration" && source.integration) {
    return `integration:${source.integration.provider}:${source.integration.targetKind}:${source.integration.targetId}`
  }
  if (source.providerKind === "webhook" && source.providerRef) {
    return buildWebhookSourceLocator(source.providerRef)
  }
  if (source.providerRef) {
    return `${source.providerKind}:${source.providerRef}`
  }
  return `${source.providerKind}:${source.id}`
}

function eventSourceMatchKey(source: Pick<AutomationEventSource, "sourceKey">) {
  return source.sourceKey
}

function ensureEventSourceIsSubscribable(source: AutomationEventSource) {
  if (source.status !== "active") {
    throw new Error(`Event source ${source.id} is not active`)
  }
}

function ensureEventSourceIsEmittable(source: AutomationEventSource) {
  if (source.status === "disabled" || source.status === "archived") {
    throw new Error(`Event source ${source.id} is not available for emission`)
  }
}

function subsetMatch(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const actualValue = actual[key]
      if (
        !actualValue ||
        typeof actualValue !== "object" ||
        Array.isArray(actualValue)
      ) {
        return false
      }
      return subsetMatch(
        value as Record<string, unknown>,
        actualValue as Record<string, unknown>
      )
    }
    return actual[key] === value
  })
}

function normalizePolicyInput(
  input?: AutomationPolicyInput
): Omit<AutomationPolicyRow, "rule_id"> {
  return {
    active_from: input?.activeFrom
      ? parseInstantString(input.activeFrom)
      : null,
    active_until: input?.activeUntil
      ? parseInstantString(input.activeUntil)
      : null,
    max_trigger_count: input?.maxTriggerCount || null,
    trigger_count: 0,
    completion_status: input?.completionStatus || "completed",
    completed_at: null,
    metadata: {},
  }
}

function computeNextFireAt(input: {
  scheduleKind: "cron" | "at" | "interval"
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: Timestamp | null
  activeFrom?: Timestamp | null
  activeUntil?: Timestamp | null
  baseTime?: Date
  lastFiredAt?: Timestamp | null
}): Timestamp | null {
  const baseTime = input.baseTime || new Date()
  const startsAt = input.startsAt ? new Date(input.startsAt) : null
  const activeFrom = input.activeFrom ? new Date(input.activeFrom) : null
  const activeUntil = input.activeUntil ? new Date(input.activeUntil) : null
  const currentBase =
    activeFrom && activeFrom.getTime() > baseTime.getTime()
      ? activeFrom
      : baseTime

  if (input.scheduleKind === "at") {
    const candidate =
      startsAt || (input.scheduleExpr ? new Date(input.scheduleExpr) : null)
    if (!candidate) return null
    if (candidate.getTime() <= baseTime.getTime()) return null
    if (activeFrom && candidate.getTime() < activeFrom.getTime()) return null
    if (activeUntil && candidate.getTime() > activeUntil.getTime()) return null
    return dateToIsoInstant(candidate)
  }

  if (input.scheduleKind === "interval") {
    const intervalSeconds = input.intervalSeconds || 0
    if (intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be greater than 0")
    }
    const anchor = input.lastFiredAt
      ? new Date(input.lastFiredAt)
      : startsAt ||
        (activeFrom && activeFrom.getTime() > baseTime.getTime()
          ? activeFrom
          : new Date(baseTime.getTime() + intervalSeconds * 1000))
    const next = input.lastFiredAt
      ? new Date(anchor.getTime() + intervalSeconds * 1000)
      : anchor
    if (activeUntil && next.getTime() > activeUntil.getTime()) return null
    return dateToIsoInstant(next)
  }

  if (!input.scheduleExpr) {
    throw new Error("scheduleExpr is required for cron triggers")
  }

  const parsed = cronParser.parseExpression(input.scheduleExpr, {
    currentDate: currentBase,
    tz: input.scheduleTimezone || "UTC",
  })
  const next = parsed.next().toDate()
  if (activeUntil && next.getTime() > activeUntil.getTime()) return null
  return dateToIsoInstant(next)
}

async function normalizeTriggerInput(params: {
  workspaceId: string
  input: AutomationTriggerInput
  policy?: AutomationPolicyInput
  conversation: Record<string, unknown>
  creatorActorId?: string | null
}): Promise<Omit<AutomationTriggerRow, "rule_id">> {
  if (params.input.triggerKind === "schedule") {
    const input = params.input
    const scheduleKind =
      input.scheduleKind ||
      (input.startsAt ? "at" : input.intervalSeconds ? "interval" : "cron")
    const nextFireAt = computeNextFireAt({
      scheduleKind,
      scheduleExpr: input.scheduleExpr,
      scheduleTimezone: input.scheduleTimezone,
      intervalSeconds: input.intervalSeconds,
      startsAt: input.startsAt || null,
      activeFrom: params.policy?.activeFrom || null,
      activeUntil: params.policy?.activeUntil || null,
    })
    return {
      trigger_kind: "schedule",
      source_kind: "clock",
      event_source_id: null,
      source_locator: input.sourceLocator || null,
      match_key: null,
      matcher: input.matcher || {},
      schedule_kind: scheduleKind,
      schedule_expr: input.scheduleExpr || null,
      schedule_timezone: input.scheduleTimezone || "UTC",
      interval_seconds:
        scheduleKind === "interval" ? input.intervalSeconds || null : null,
      starts_at: input.startsAt ? parseInstantString(input.startsAt) : null,
      next_fire_at: nextFireAt ? parseInstantString(nextFireAt) : null,
      last_fired_at: null,
      metadata: {},
    }
  }

  const input = params.input
  if (!input.eventSourceId?.trim()) {
    throw new Error("event trigger requires eventSourceId")
  }
  const eventSource = await getAutomationEventSource(
    params.workspaceId,
    input.eventSourceId.trim()
  )
  if (!eventSource) {
    throw new Error(`Event source ${input.eventSourceId} not found`)
  }
  ensureEventSourceIsSubscribable(eventSource)
  await assertAutomationEventSourceAccessible({
    workspaceId: params.workspaceId,
    eventSourceId: eventSource.id,
    conversation: params.conversation,
    actorId: params.creatorActorId || null,
  })

  return {
    trigger_kind: "event",
    source_kind: eventSource.providerKind,
    event_source_id: eventSource.id,
    source_locator: buildEventSourceLocator(eventSource),
    match_key: eventSourceMatchKey(eventSource),
    matcher: input.matcher || {},
    schedule_kind: null,
    schedule_expr: null,
    schedule_timezone: null,
    interval_seconds: null,
    starts_at: null,
    next_fire_at: null,
    last_fired_at: null,
    metadata: {},
  }
}

async function normalizeDeliveryInput(input: AutomationDeliveryInput): Promise<
  Omit<AutomationDeliveryRow, "rule_id"> & {
    targetParticipantIds: string[]
  }
> {
  const normalizedMessage = await buildNormalizedMessageContent({
    content: input.message || "",
    contentBlocks: input.messageBlocks || [],
  })
  const targetParticipantIds = mergeUniqueIds(input.targetParticipantIds)

  const targetPolicy =
    input.targetPolicy ||
    (targetParticipantIds.length > 0 ? "specified_members" : "all_members")
  if (
    targetPolicy === "specified_members" &&
    targetParticipantIds.length === 0
  ) {
    throw new Error(
      "specified_members requires at least one target participant"
    )
  }

  return {
    message_text: normalizedMessage.normalizedContent,
    wake_reason_text:
      input.wakeReason?.trim() || normalizedMessage.normalizedContent || null,
    message_blocks: normalizedMessage.contentBlocks,
    target_policy: targetPolicy,
    metadata: normalizedMessage.normalizedMetadata,
    targetParticipantIds,
  }
}

async function loadAutomationRulesByIds(
  workspaceId: string,
  ruleIds: string[]
) {
  if (ruleIds.length === 0) return [] as AutomationRule[]
  const { rules, triggers, policies, deliveries, targetsByRule } =
    await loadAutomationRuleComponentRows(workspaceId, ruleIds)

  const triggerByRule = new Map(
    triggers.map((row) => {
      const triggerRow = normalizeAutomationTriggerRow(row)
      return [triggerRow.rule_id, presentTrigger(triggerRow)]
    })
  )
  const policyByRule = new Map(
    policies.map((row) => {
      const policyRow = normalizeAutomationPolicyRow(row)
      return [policyRow.rule_id, presentPolicy(policyRow)]
    })
  )
  const deliveryByRule = new Map(
    deliveries.map((row) => {
      const deliveryRow = normalizeAutomationDeliveryRow(row)
      return [
        deliveryRow.rule_id,
        presentDelivery(
          deliveryRow,
          targetsByRule.get(deliveryRow.rule_id) || []
        ),
      ]
    })
  )

  return rules
    .map((row) => {
      const ruleRow = normalizeAutomationRuleRow(row)
      const trigger = triggerByRule.get(ruleRow.id)
      const policy = policyByRule.get(ruleRow.id)
      const delivery = deliveryByRule.get(ruleRow.id)
      if (!trigger || !policy || !delivery) return null
      return presentRule(ruleRow, trigger, policy, delivery)
    })
    .filter((rule): rule is AutomationRule => Boolean(rule))
}

async function validateAutomationEventSourceProvider(
  workspaceId: string,
  providerKind: AutomationEventProviderKind,
  providerRef?: string
) {
  if (providerKind === "webhook") {
    const normalizedRef = providerRef?.trim()
    if (!normalizedRef) {
      throw new Error("webhook event sources require providerRef")
    }
    const endpointId = await selectActiveWebhookEndpointId(
      workspaceId,
      normalizedRef
    )
    if (!endpointId) {
      throw new Error(`Webhook endpoint ${normalizedRef} not found or inactive`)
    }
    return {
      providerRef: normalizedRef,
      webhookEndpointId: normalizedRef,
    }
  }

  if (providerKind === "device") {
    const normalizedRef = providerRef?.trim()
    if (!normalizedRef) {
      throw new Error("device event sources require providerRef")
    }
    return {
      providerRef: normalizedRef,
      webhookEndpointId: null,
    }
  }

  return {
    providerRef: providerRef?.trim() || null,
    webhookEndpointId: null,
  }
}

function slugifyAutomationEventSourceKey(value: string) {
  return slugify(value, { separator: ".", maxLength: 96, fallback: "source" })
}

async function allocateAutomationEventSourceKey(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string | null
  name: string
  explicitKey?: string
}) {
  const requestedKey = params.explicitKey?.trim()
  if (requestedKey) {
    return requestedKey
  }

  const baseKey = slugifyAutomationEventSourceKey(params.name)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate =
      attempt === 0
        ? baseKey
        : `${baseKey}.${crypto.randomBytes(2).toString("hex")}`
    const exists = await existsAutomationEventSourceKey({
      workspaceId: params.workspaceId,
      providerKind: params.providerKind,
      providerRef: params.providerRef,
      sourceKey: candidate,
    })
    if (!exists) {
      return candidate
    }
  }

  return `${baseKey}.${crypto.randomBytes(4).toString("hex")}`
}

async function pauseAutomationRulesForEventSource(
  eventSourceId: string,
  operator: AutomationOperatorInput,
  reason: string
) {
  const auditUserId = await resolveAutomationAuditUserId(operator)
  const affected = await pauseAutomationRuleRowsForEventSource({
    eventSourceId,
    reason,
    category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
  })

  for (const row of affected) {
    await appendAutomationAuditLog({
      workspaceId: row.workspaceId,
      userId: auditUserId,
      actorId: operator.actorId || null,
      action: "automation_rule.pause",
      resourceType: "automation_rule",
      resourceId: row.id,
      details: {
        reason,
        eventSourceId,
      },
    })
  }
}

function resolveAutomationEventSourceConversationMask(
  conversationTypeMaskOverride?: number | null
) {
  return resolveNarrowedConversationTypeMask(
    DEFAULT_CONVERSATION_TYPE_MASK,
    conversationTypeMaskOverride
  )
}

function bindingAllowsConversationType(params: {
  conversation: Record<string, unknown>
  conversationTypeMaskOverride?: number | null
}) {
  return maskAllowsConversationType(
    resolveAutomationEventSourceConversationMask(
      params.conversationTypeMaskOverride
    ),
    typeof params.conversation.kind === "string"
      ? params.conversation.kind
      : null,
    Boolean(params.conversation.is_im)
  )
}

function assertBindingMaskAllowsConversation(params: {
  conversation: Record<string, unknown>
  conversationTypeMaskOverride?: number | null
  errorMessage: string
}) {
  if (
    params.conversationTypeMaskOverride !== undefined &&
    params.conversationTypeMaskOverride !== null &&
    !bindingAllowsConversationType(params)
  ) {
    throw new Error(params.errorMessage)
  }
}

async function loadAutomationEventSourceAccessRows(
  workspaceId: string,
  eventSourceIds: string[],
  includeRevoked = false
) {
  const uniqueIds = Array.from(new Set(eventSourceIds.filter(Boolean)))
  if (uniqueIds.length === 0) {
    return new Map<string, AutomationEventSourceAccessRow[]>()
  }

  // P3: delegate the SELECT-with-access_subjects-JOIN to binding-storage. The
  // helper returns normalized AutomationEventSourceBindingRow rows; this function only has to
  // bucket them by event source.
  const rows = await loadAutomationEventSourceAccessBindingRows({
    resourceType: "automation_event_source",
    resourceIds: uniqueIds,
    workspaceId,
    includeRevoked,
  })

  const rowsBySource = new Map<string, AutomationEventSourceAccessRow[]>()
  for (const row of rows) {
    const existing = rowsBySource.get(row.resourceId) || []
    existing.push(row)
    rowsBySource.set(row.resourceId, existing)
  }
  return rowsBySource
}

async function listAutomationEventSourceAccessRows(
  workspaceId: string,
  eventSourceId: string,
  includeRevoked = false
) {
  const rowsBySource = await loadAutomationEventSourceAccessRows(
    workspaceId,
    [eventSourceId],
    includeRevoked
  )
  return rowsBySource.get(eventSourceId) || []
}

function automationEventSourceGrantApplies(params: {
  row: AutomationEventSourceAccessRow
  context: AutomationEventSourceAccessContext
  conversation: Record<string, unknown>
}) {
  if (
    !bindingAllowsConversationType({
      conversation: params.conversation,
      conversationTypeMaskOverride: params.row.conversationTypeMaskOverride,
    })
  ) {
    return false
  }

  const target = readAutomationEventSourceAccessBindingTarget(params.row)
  const subject = target.subject
  const scope = target.scope
  switch (subject.kind) {
    case "workspace":
      return (
        ((subject as { workspaceId: string }).workspaceId || null) ===
          ((params.conversation.workspace_id as string | null | undefined) ||
            null) ||
        ((subject as { workspaceId: string }).workspaceId || null) ===
          (params.row.workspaceId || null)
      )
    case "conversation":
      return (
        (subject as { conversationId: string }).conversationId ===
        params.context.conversationId
      )
    case "actor":
      if (scope?.kind === "conversation") {
        return (
          Boolean(params.context.actorId) &&
          (subject as { actorId: string }).actorId ===
            (params.context.actorId || null) &&
          (scope as { conversationId: string }).conversationId ===
            params.context.conversationId
        )
      }
      return (
        Boolean(params.context.actorId) &&
        (subject as { actorId: string }).actorId ===
          (params.context.actorId || null)
      )
    default:
      return false
  }
}

async function canAccessAutomationEventSource(params: {
  workspaceId: string
  eventSourceId: string
  conversation: Record<string, unknown>
  actorId?: string | null
}) {
  const rows = await listAutomationEventSourceAccessRows(
    params.workspaceId,
    params.eventSourceId
  )
  return rows.some((row) =>
    automationEventSourceGrantApplies({
      row,
      context: {
        conversationId: params.conversation.id as string,
        actorId: params.actorId || null,
      },
      conversation: params.conversation,
    })
  )
}

async function assertAutomationEventSourceAccessible(params: {
  workspaceId: string
  eventSourceId: string
  conversation: Record<string, unknown>
  actorId?: string | null
}) {
  const allowed = await canAccessAutomationEventSource(params)
  if (!allowed) {
    throw new Error(
      `Event source ${params.eventSourceId} is not authorized for this conversation and creator context`
    )
  }
}

function mapAutomationEventSourceAccessGrant(
  row: AutomationEventSourceAccessRow
): AutomationEventSourceAccessGrant {
  return mapAutomationEventSourceAccessBindingToGrant(
    row,
    "Automation event sources require explicit use access.",
    {
      effectiveConversationTypeMask:
        resolveAutomationEventSourceConversationMask(
          row.conversationTypeMaskOverride
        ),
    }
  )
}

export async function listAutomationEventSourceAccessState(
  workspaceId: string,
  eventSourceId: string
) {
  const source = await getAutomationEventSource(workspaceId, eventSourceId)
  if (!source) {
    throw new Error("Automation event source not found")
  }

  const rows = await listAutomationEventSourceAccessRows(
    workspaceId,
    eventSourceId
  )
  const grants = rows.map(mapAutomationEventSourceAccessGrant)
  const effectiveConversationTypeMask =
    resolveAutomationEventSourceConversationMask(null)

  return {
    grants,
    summary: {
      requiredPermissions: ["use"],
      suggestedAccessTargetType: "workspace" as const,
      reason:
        "Automation event source access controls which conversations and actors may create subscriptions.",
      conversationTypeMaskOverride: null,
      effectiveConversationTypeMask,
      effectivePermissions: grants.length > 0 ? ["use"] : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
      eventSourceId: source.id,
    },
  }
}

async function getBindingTargetConversation(target: CapabilityAccessTarget) {
  // D3: only `subject=conversation` or `scope=conversation` targets need a
  // conversation lookup.
  let conversationId: string | null = null
  if (target.scope?.kind === "conversation") {
    conversationId = (target.scope as { conversationId: string }).conversationId
  } else if (target.subject.kind === "conversation") {
    conversationId = (target.subject as { conversationId: string })
      .conversationId
  }
  if (!conversationId) return null
  return loadConversationWithImFlag(conversationId, { required: true })
}

/**
 * Load a conversation row and attach `is_im` (derived from the transport
 * binding) so the conversation-type mask check can resolve direct/group vs
 * im_direct/im_group. Returns null when missing unless { required: true }.
 */
async function loadConversationWithImFlag(
  conversationId: string,
  opts?: { required?: boolean }
): Promise<Record<string, unknown> | null> {
  const conversation = await getConversation(conversationId)
  if (!conversation) {
    if (opts?.required) {
      throw new Error(`Conversation ${conversationId} not found`)
    }
    return null
  }
  const isIm = await hasConversationTransportBinding({ conversationId })
  return { ...conversation, is_im: isIm }
}

export async function grantAutomationEventSourceAccess(input: {
  workspaceId: string
  eventSourceId: string
  accessTarget?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  grantedByWorkspaceMemberId?: string
  reason?: string
}) {
  const source = await getAutomationEventSource(
    input.workspaceId,
    input.eventSourceId
  )
  if (!source) {
    throw new Error("Automation event source not found")
  }

  const target = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: input.accessTarget || { subject: workspaceRef(input.workspaceId) },
  })
  const targetConversation = await getBindingTargetConversation(
    input.accessTarget || { subject: workspaceRef(input.workspaceId) }
  )
  if (targetConversation) {
    assertBindingMaskAllowsConversation({
      conversation: targetConversation,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      errorMessage:
        "Access grant conversation policy must allow the selected conversation type.",
    })
  }

  const existingRows = await listAutomationEventSourceAccessRows(
    input.workspaceId,
    input.eventSourceId
  )
  const existing = existingRows.find((row) =>
    automationEventSourceAccessBindingHasTarget(row, target)
  )
  if (existing) {
    return mapAutomationEventSourceAccessGrant(existing)
  }

  const inserted = await withAutomationTransaction(async (trx) => {
    const binding =
      await insertAutomationEventSourceAccessBindingReturningRowOn(trx, {
        workspaceId: input.workspaceId,
        resourceType: "automation_event_source",
        resourceId: input.eventSourceId,
        target,
        conversationTypeMaskOverride:
          input.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
        reason: input.reason || "Automation event source access grant",
      })

    return {
      binding,
    }
  })

  return mapAutomationEventSourceAccessGrant(
    normalizeAutomationEventSourceAccessBindingRow(inserted.binding)
  )
}

export async function updateAutomationEventSourceAccessGrant(input: {
  workspaceId: string
  eventSourceId: string
  bindingId: string
  conversationTypeMaskOverride?: number | null
}) {
  const accessRows = await listAutomationEventSourceAccessRows(
    input.workspaceId,
    input.eventSourceId,
    true
  )
  const existing = accessRows.find((row) => row.id === input.bindingId)
  if (!existing) {
    throw new Error("Automation event source access binding not found")
  }

  if (input.conversationTypeMaskOverride !== undefined) {
    const targetConversation = await getBindingTargetConversation(
      mapAutomationEventSourceAccessGrant(existing).target
    )
    if (targetConversation) {
      assertBindingMaskAllowsConversation({
        conversation: targetConversation,
        conversationTypeMaskOverride: input.conversationTypeMaskOverride,
        errorMessage:
          "Access grant conversation policy must allow the selected conversation type.",
      })
    }

    await updateAutomationEventSourceAccessBindingMaskOverride({
      bindingId: input.bindingId,
      workspaceId: input.workspaceId,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
    })
  }

  const updatedRows = await listAutomationEventSourceAccessRows(
    input.workspaceId,
    input.eventSourceId
  )
  const updated = updatedRows.find((row) => row.id === input.bindingId)
  if (!updated) {
    throw new Error("Automation event source access binding not found")
  }
  return mapAutomationEventSourceAccessGrant(updated)
}

async function pauseAutomationRule(params: {
  ruleId: string
  workspaceId: string
  reason: string
  operator: AutomationOperatorInput
}) {
  const auditUserId = await resolveAutomationAuditUserId(params.operator)
  const didPause = await pauseActiveAutomationRule(params.ruleId, params.reason)
  if (!didPause) {
    return
  }

  await appendAutomationAuditLog({
    workspaceId: params.workspaceId,
    userId: auditUserId,
    actorId: params.operator.actorId || null,
    action: "automation_rule.pause",
    resourceType: "automation_rule",
    resourceId: params.ruleId,
    details: { reason: params.reason },
  })
}

async function pauseAutomationRulesMissingEventSourceAccess(
  eventSourceId: string,
  operator: AutomationOperatorInput,
  reason: string
) {
  const rows = await listActiveEventSubscriptionRuleRowsByEventSource({
    eventSourceId,
    category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
  })

  for (const row of rows.map(normalizeAutomationRuleRow)) {
    const conversation = await loadConversationWithImFlag(row.conversation_id)
    const creatorParticipant = await getConversationParticipant({
      conversationId: row.conversation_id,
      participantId: row.created_by_participant_id,
    })
    const creatorActorId =
      creatorParticipant?.actorId && creatorParticipant.state === "active"
        ? (creatorParticipant.actorId as string)
        : null
    const stillAllowed =
      Boolean(conversation) &&
      (await canAccessAutomationEventSource({
        workspaceId: row.workspace_id,
        eventSourceId,
        conversation: conversation!,
        actorId: creatorActorId,
      }))
    if (!stillAllowed) {
      await pauseAutomationRule({
        ruleId: row.id,
        workspaceId: row.workspace_id,
        reason,
        operator,
      })
    }
  }
}

export async function revokeAutomationEventSourceAccess(input: {
  workspaceId: string
  eventSourceId: string
  bindingId: string
  operator: AutomationOperatorInput
}) {
  const accessRows = await listAutomationEventSourceAccessRows(
    input.workspaceId,
    input.eventSourceId,
    true
  )
  const existing = accessRows.find((row) => row.id === input.bindingId)
  if (!existing) {
    throw new Error("Automation event source access binding not found")
  }

  await revokeAutomationEventSourceAccessBindingById({
    bindingId: input.bindingId,
  })
  await pauseAutomationRulesMissingEventSourceAccess(
    input.eventSourceId,
    input.operator,
    `Event source access binding ${input.bindingId} was revoked`
  )
}

export async function getAutomationEventSource(
  workspaceId: string,
  eventSourceId: string
) {
  const row = await getAutomationEventSourceRow({ workspaceId, eventSourceId })
  return row ? presentEventSource(normalizeAutomationEventSourceRow(row)) : null
}

export async function listAutomationEventSources(
  workspaceId: string,
  filters?: {
    status?: AutomationEventSourceStatus
    providerKind?: AutomationEventProviderKind
    providerRef?: string
    sourceKey?: string
  },
  accessContext?: AutomationEventSourceAccessContext
) {
  const rows = await listAutomationEventSourceRows({ workspaceId, filters })
  const sources = rows
    .map(normalizeAutomationEventSourceRow)
    .map(presentEventSource)
  if (!accessContext) {
    return sources
  }

  const conversation = await loadConversationWithImFlag(
    accessContext.conversationId
  )
  if (!conversation) {
    return []
  }
  const accessRowsBySource = await loadAutomationEventSourceAccessRows(
    workspaceId,
    sources.map((source) => source.id)
  )

  return sources.filter((source) =>
    (accessRowsBySource.get(source.id) || []).some((row) =>
      automationEventSourceGrantApplies({
        row,
        context: accessContext,
        conversation,
      })
    )
  )
}

async function loadAutomationWebhookEndpointSecret(endpointId: string) {
  const row = await selectAutomationWebhookEndpointRow(endpointId)
  if (!row?.secret_ciphertext) {
    throw new Error(`Webhook endpoint ${endpointId} secret was not found`)
  }
  return {
    endpoint: presentWebhookEndpoint(
      normalizeAutomationWebhookEndpointRow(row)
    ),
    secret: decrypt(row.secret_ciphertext),
  }
}

async function getAutomationIntegrationBinding(bindingId: string) {
  return selectAutomationIntegrationBindingRow(bindingId)
}

function integrationEndpointName(
  provider: AutomationIntegrationProvider,
  targetLabel: string
) {
  return `${provider === "github" ? "GitHub" : "GitLab"} ${targetLabel} Endpoint`
}

function integrationWebhookName(
  provider: AutomationIntegrationProvider,
  targetLabel: string
) {
  return `${provider === "github" ? "GitHub" : "GitLab"} Events: ${targetLabel}`
}

function mapIntegrationBindingToSourceIntegration(
  binding: AutomationIntegrationBindingRow
): AutomationEventSourceIntegration {
  return {
    bindingId: binding.id,
    installationId: binding.installation_id,
    provider: binding.provider,
    ingressKind: binding.ingress_kind,
    targetKind: binding.target_kind,
    targetId: binding.target_id,
    targetLabel: binding.target_label,
    endpointId: binding.webhook_endpoint_id || undefined,
    externalSubscriptionId: binding.external_subscription_id || undefined,
  }
}

async function ensureAutomationIntegrationBinding(params: {
  workspaceId: string
  creator: AutomationCreatorInput
  installation: Awaited<ReturnType<typeof getIntegrationInstallation>>
  integration: AutomationEventSourceIntegrationInput
}) {
  const ingressKind = params.integration.ingressKind || "webhook"
  const targetId = params.integration.targetId.trim()
  const targetLabel = params.integration.targetLabel?.trim() || targetId
  const existing = await selectExistingAutomationIntegrationBindingRow({
    workspaceId: params.workspaceId,
    installationId: params.installation.id,
    provider: params.integration.provider,
    ingressKind,
    targetKind: params.integration.targetKind,
    targetId,
  })
  if (existing) {
    if (existing.target_label !== targetLabel) {
      await updateIntegrationBindingTargetLabel(existing.id, targetLabel)
      return getAutomationIntegrationBinding(existing.id)
    }
    return existing
  }

  const bindingId = uuidv4()
  const endpointId = ingressKind === "webhook" ? uuidv4() : null
  const pathToken =
    ingressKind === "webhook" ? crypto.randomBytes(18).toString("hex") : null
  const secret = ingressKind === "webhook" ? generateSecret() : null

  await withAutomationTransaction(async (trx) => {
    if (endpointId && pathToken && secret) {
      await insertWebhookEndpointRow(trx, {
        id: endpointId,
        workspaceId: params.workspaceId,
        name: integrationEndpointName(params.integration.provider, targetLabel),
        status: "disabled",
        pathToken: pathToken,
        secretCiphertext: encrypt(secret),
        secretHint: secretHint(secret),
        metadata: JSON.stringify({
          managedBy: "integration_binding",
          integrationProvider: params.integration.provider,
          integrationTargetKind: params.integration.targetKind,
          integrationTargetId: targetId,
          integrationTargetLabel: targetLabel,
        }),
        createdByWorkspaceMemberId: params.creator.workspaceMemberId || null,
      })
    }

    await insertIntegrationBindingRow(trx, {
      id: bindingId,
      workspaceId: params.workspaceId,
      installationId: params.installation.id,
      provider: params.integration.provider,
      ingressKind: ingressKind,
      targetKind: params.integration.targetKind,
      targetId: targetId,
      targetLabel: targetLabel,
      webhookEndpointId: endpointId,
      externalSubscriptionId: null,
      metadata: JSON.stringify({
        integrationProvider: params.integration.provider,
        integrationTargetKind: params.integration.targetKind,
      }),
    })
  })

  return getAutomationIntegrationBinding(bindingId)
}

async function listActiveIntegrationSourceKeysForBinding(bindingId: string) {
  return listActiveIntegrationSourceKeysForBindingRepo(bindingId)
}

async function reconcileIntegrationBindingWebhook(
  bindingId: string
): Promise<AutomationIntegrationBindingRow | null> {
  const binding = await getAutomationIntegrationBinding(bindingId)
  if (!binding) {
    return null
  }
  if (binding.ingress_kind !== "webhook" || !binding.webhook_endpoint_id) {
    return binding
  }

  const sourceKeys = await listActiveIntegrationSourceKeysForBinding(binding.id)
  const { endpoint, secret } = await loadAutomationWebhookEndpointSecret(
    binding.webhook_endpoint_id
  )
  const integration = mapIntegrationBindingToSourceIntegration(binding)

  if (sourceKeys.length === 0) {
    if (binding.external_subscription_id) {
      const installation = await getIntegrationInstallation(
        binding.workspace_id,
        binding.installation_id,
        binding.provider,
        { allowInactive: true }
      )
      await unregisterIntegrationWebhook({
        installation,
        integration,
      })
    }
    await updateIntegrationBindingExternalSubscriptionId(binding.id, null)
    await updateWebhookEndpointStatus(endpoint.id, "disabled")
    return getAutomationIntegrationBinding(binding.id)
  }

  const installation = await getIntegrationInstallation(
    binding.workspace_id,
    binding.installation_id,
    binding.provider,
    { allowInactive: true }
  )
  const callbackUrl = integrationWebhookCallbackUrl(endpoint.pathToken)
  const name = integrationWebhookName(binding.provider, binding.target_label)
  const description = `Managed ${binding.provider} automation webhook for ${binding.target_label}.`
  let externalSubscriptionId = binding.external_subscription_id || null

  if (externalSubscriptionId) {
    try {
      await updateIntegrationWebhook({
        installation,
        integration,
        sourceKeys,
        callbackUrl,
        secret,
        name,
        description,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("404")) {
        throw error
      }
      externalSubscriptionId = await registerIntegrationWebhook({
        installation,
        sourceKeys,
        targetKind: binding.target_kind,
        targetId: binding.target_id,
        targetLabel: binding.target_label,
        callbackUrl,
        secret,
        name,
        description,
      })
    }
  } else {
    externalSubscriptionId = await registerIntegrationWebhook({
      installation,
      sourceKeys,
      targetKind: binding.target_kind,
      targetId: binding.target_id,
      targetLabel: binding.target_label,
      callbackUrl,
      secret,
      name,
      description,
    })
  }

  await updateIntegrationBindingExternalSubscriptionId(
    binding.id,
    externalSubscriptionId
  )
  await updateWebhookEndpointStatus(endpoint.id, "active")
  return getAutomationIntegrationBinding(binding.id)
}

async function createIntegrationAutomationEventSource(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationEventSourceInput
) {
  const auditUserId = await resolveAutomationAuditUserId(creator)
  if (!input.integration) {
    throw new Error(
      "integration event sources require integration configuration"
    )
  }
  const integration = input.integration

  const ingressKind = integration.ingressKind || "webhook"
  const installation = await getIntegrationInstallation(
    workspaceId,
    integration.installationId,
    integration.provider
  )
  const normalizedSourceKey = input.sourceKey?.trim()
  if (!normalizedSourceKey) {
    throw new Error("integration event sources require sourceKey")
  }

  const binding = await ensureAutomationIntegrationBinding({
    workspaceId,
    creator,
    installation,
    integration,
  })
  if (!binding) {
    throw new Error("Failed to resolve automation integration binding")
  }

  const targetId = binding.target_id
  const targetLabel = binding.target_label
  const initialStatus = input.status || "active"
  const template = buildIntegrationEventSourceTemplate({
    provider: integration.provider,
    sourceKey: normalizedSourceKey,
    targetKind: integration.targetKind,
    targetId,
    targetLabel,
  })

  const existing = await selectIntegrationEventSourceReuseRow({
    workspaceId,
    bindingId: binding.id,
    sourceKey: normalizedSourceKey,
  })

  if (existing) {
    const nextStatus = input.status || "active"
    await updateAutomationEventSourceRow({
      workspaceId,
      eventSourceId: existing.id,
      values: {
        name: input.name?.trim() || template.name,
        description: input.description?.trim() || template.description,
        recommendedUsage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payloadSchema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        examplePayload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
        status: input.status || "active",
        metadata: JSON.stringify({
          ...existing.metadata,
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      },
    })

    if (
      binding.ingress_kind === "webhook" &&
      (((existing.status === "disabled" || existing.status === "archived") &&
        (nextStatus === "active" || nextStatus === "deprecated")) ||
        ((existing.status === "active" || existing.status === "deprecated") &&
          (nextStatus === "disabled" || nextStatus === "archived")))
    ) {
      await reconcileIntegrationBindingWebhook(binding.id)
    }

    await appendAutomationAuditLog({
      workspaceId: workspaceId,
      userId: auditUserId,
      actorId: creator.actorId || null,
      action: "automation_event_source.update",
      resourceType: "automation_event_source",
      resourceId: existing.id,
      details: {
        providerKind: "integration",
        sourceKey: normalizedSourceKey,
        integration: {
          bindingId: binding.id,
          installationId: installation.id,
          provider: integration.provider,
          ingressKind,
          targetKind: integration.targetKind,
          targetId,
          targetLabel,
        },
        reusedExisting: true,
        status: nextStatus,
      },
    })
    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()
  await withAutomationTransaction(async (trx) => {
    await insertAutomationEventSourceRow(
      {
        id: sourceId,
        workspaceId: workspaceId,
        providerKind: "integration",
        providerRef: null,
        webhookEndpointId: null,
        integrationBindingId: binding.id,
        sourceKey: normalizedSourceKey,
        name: input.name?.trim() || template.name,
        description: input.description?.trim() || template.description,
        recommendedUsage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payloadSchema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        examplePayload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
        status: initialStatus,
        createdByKind: creator.kind,
        createdByWorkspaceMemberId: creator.workspaceMemberId || null,
        createdByActorId: creator.actorId || null,
        createdBySessionId: creator.sessionId || null,
        metadata: JSON.stringify({
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      },
      trx
    )

    await appendAutomationAuditLog(
      {
        workspaceId: workspaceId,
        userId: auditUserId,
        actorId: creator.actorId || null,
        action: "automation_event_source.create",
        resourceType: "automation_event_source",
        resourceId: sourceId,
        details: {
          providerKind: "integration",
          sourceKey: normalizedSourceKey,
          integration: {
            bindingId: binding.id,
            installationId: installation.id,
            provider: integration.provider,
            ingressKind,
            targetKind: integration.targetKind,
            targetId,
            targetLabel,
          },
          status: initialStatus,
        },
      },
      trx
    )
  })

  try {
    if (
      binding.ingress_kind === "webhook" &&
      initialStatus !== "disabled" &&
      initialStatus !== "archived"
    ) {
      await reconcileIntegrationBindingWebhook(binding.id)
    }
  } catch (error) {
    // Saga compensating rollback: the just-created event source never became
    // usable. Soft-delete it (hard delete forbidden by sd_reject_delete); an
    // offline purge reclaims the tombstone later.
    await softDeleteAutomationEventSource(workspaceId, sourceId)
    throw error
  }

  const created = await getAutomationEventSource(workspaceId, sourceId)
  if (!created) {
    throw new Error(`Automation event source ${sourceId} was not persisted`)
  }
  return created
}

export async function createAutomationEventSource(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationEventSourceInput
) {
  const auditUserId = await resolveAutomationAuditUserId(creator)
  if (input.providerKind === "integration") {
    return createIntegrationAutomationEventSource(workspaceId, creator, input)
  }

  if (!input.name?.trim() || !input.description?.trim()) {
    throw new Error("name and description are required")
  }

  const providerBinding = await validateAutomationEventSourceProvider(
    workspaceId,
    input.providerKind,
    input.providerRef
  )
  const normalizedSourceKey = await allocateAutomationEventSourceKey({
    workspaceId,
    providerKind: input.providerKind,
    providerRef: providerBinding.providerRef,
    name: input.name,
    explicitKey: input.sourceKey,
  })
  const existing = await selectAutomationEventSourceReuseRow({
    workspaceId,
    providerKind: input.providerKind,
    providerRef: providerBinding.providerRef,
    sourceKey: normalizedSourceKey,
  })

  if (existing) {
    await updateAutomationEventSourceRow({
      workspaceId,
      eventSourceId: existing.id,
      values: {
        providerRef: providerBinding.providerRef,
        webhookEndpointId: providerBinding.webhookEndpointId,
        name: input.name.trim(),
        description: input.description.trim(),
        recommendedUsage: input.recommendedUsage?.trim() || "",
        payloadSchema: JSON.stringify(input.payloadSchema || {}),
        examplePayload: JSON.stringify(input.examplePayload || {}),
        status: input.status || "active",
        metadata: JSON.stringify(input.metadata || existing.metadata || {}),
      },
    })

    await appendAutomationAuditLog({
      workspaceId: workspaceId,
      userId: auditUserId,
      actorId: creator.actorId || null,
      action: "automation_event_source.update",
      resourceType: "automation_event_source",
      resourceId: existing.id,
      details: {
        providerKind: input.providerKind,
        providerRef: providerBinding.providerRef,
        sourceKey: normalizedSourceKey,
        recommendedUsage: input.recommendedUsage?.trim() || "",
        status: input.status || "active",
        reusedExisting: true,
      },
    })

    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()

  await insertAutomationEventSourceRow({
    id: sourceId,
    workspaceId: workspaceId,
    providerKind: input.providerKind,
    providerRef: providerBinding.providerRef,
    webhookEndpointId: providerBinding.webhookEndpointId,
    sourceKey: normalizedSourceKey,
    name: input.name.trim(),
    description: input.description.trim(),
    recommendedUsage: input.recommendedUsage?.trim() || "",
    payloadSchema: JSON.stringify(input.payloadSchema || {}),
    examplePayload: JSON.stringify(input.examplePayload || {}),
    status: input.status || "active",
    createdByKind: creator.kind,
    createdByWorkspaceMemberId: creator.workspaceMemberId || null,
    createdByActorId: creator.actorId || null,
    createdBySessionId: creator.sessionId || null,
    metadata: JSON.stringify(input.metadata || {}),
  })

  await appendAutomationAuditLog({
    workspaceId: workspaceId,
    userId: auditUserId,
    actorId: creator.actorId || null,
    action: "automation_event_source.create",
    resourceType: "automation_event_source",
    resourceId: sourceId,
    details: {
      providerKind: input.providerKind,
      providerRef: providerBinding.providerRef,
      sourceKey: normalizedSourceKey,
      recommendedUsage: input.recommendedUsage?.trim() || "",
      status: input.status || "active",
    },
  })

  const created = await getAutomationEventSource(workspaceId, sourceId)
  if (!created) {
    throw new Error(`Automation event source ${sourceId} was not persisted`)
  }
  return created
}

export async function updateAutomationEventSource(
  workspaceId: string,
  eventSourceId: string,
  operator: AutomationOperatorInput,
  input: UpdateAutomationEventSourceInput
) {
  const auditUserId = await resolveAutomationAuditUserId(operator)
  const existing = await getAutomationEventSource(workspaceId, eventSourceId)
  if (!existing) {
    throw new Error("Automation event source not found")
  }

  if (
    existing.providerKind === "integration" &&
    input.providerRef !== undefined
  ) {
    throw new Error(
      "integration event sources do not support providerRef updates"
    )
  }

  const providerBinding =
    existing.providerKind === "integration"
      ? {
          providerRef: existing.providerRef || null,
          webhookEndpointId: null,
        }
      : await validateAutomationEventSourceProvider(
          workspaceId,
          existing.providerKind,
          input.providerRef !== undefined
            ? input.providerRef
            : existing.providerRef
        )
  const nextStatus = input.status || existing.status

  await updateAutomationEventSourceRow({
    workspaceId,
    eventSourceId,
    values: {
      providerRef: providerBinding.providerRef,
      webhookEndpointId: providerBinding.webhookEndpointId,
      integrationBindingId: existing.integration?.bindingId || null,
      sourceKey: existing.sourceKey,
      name: input.name?.trim() || existing.name,
      description:
        input.description !== undefined
          ? input.description.trim()
          : existing.description,
      recommendedUsage:
        input.recommendedUsage !== undefined
          ? input.recommendedUsage.trim()
          : existing.recommendedUsage || "",
      payloadSchema: JSON.stringify(
        input.payloadSchema !== undefined
          ? input.payloadSchema
          : existing.payloadSchema
      ),
      examplePayload: JSON.stringify(
        input.examplePayload !== undefined
          ? input.examplePayload
          : existing.examplePayload
      ),
      status: nextStatus,
      metadata: JSON.stringify(
        input.metadata !== undefined ? input.metadata : existing.metadata
      ),
    },
  })

  const integrationStatusChanged =
    existing.providerKind === "integration" &&
    existing.integration?.bindingId &&
    existing.integration.ingressKind === "webhook" &&
    existing.status !== nextStatus &&
    (((existing.status === "active" || existing.status === "deprecated") &&
      (nextStatus === "disabled" || nextStatus === "archived")) ||
      ((existing.status === "disabled" || existing.status === "archived") &&
        (nextStatus === "active" || nextStatus === "deprecated")))

  if (integrationStatusChanged) {
    await reconcileIntegrationBindingWebhook(existing.integration!.bindingId!)
  }

  if (
    (nextStatus === "disabled" || nextStatus === "archived") &&
    existing.status !== nextStatus
  ) {
    await pauseAutomationRulesForEventSource(
      eventSourceId,
      operator,
      `Event source ${eventSourceId} is ${nextStatus}`
    )
  }

  await appendAutomationAuditLog({
    workspaceId: workspaceId,
    userId: auditUserId,
    actorId: operator.actorId || null,
    action: "automation_event_source.update",
    resourceType: "automation_event_source",
    resourceId: eventSourceId,
    details: {
      status: nextStatus,
      providerRef: providerBinding.providerRef,
      sourceKey: existing.sourceKey,
      recommendedUsage:
        input.recommendedUsage !== undefined
          ? input.recommendedUsage.trim()
          : existing.recommendedUsage || "",
    },
  })

  let updated = await getAutomationEventSource(workspaceId, eventSourceId)
  if (!updated) {
    throw new Error(
      `Automation event source ${eventSourceId} was not found after update`
    )
  }
  return updated
}

export async function archiveAutomationEventSource(
  workspaceId: string,
  eventSourceId: string,
  operator: AutomationOperatorInput
) {
  const auditUserId = await resolveAutomationAuditUserId(operator)
  const existing = await getAutomationEventSource(workspaceId, eventSourceId)
  if (!existing) {
    throw new Error("Automation event source not found")
  }

  await setAutomationEventSourceStatus({
    workspaceId,
    eventSourceId,
    status: "archived",
  })

  if (
    existing.providerKind === "integration" &&
    existing.integration?.ingressKind === "webhook" &&
    existing.integration.bindingId
  ) {
    await reconcileIntegrationBindingWebhook(existing.integration.bindingId)
  }

  await pauseAutomationRulesForEventSource(
    eventSourceId,
    operator,
    `Event source ${eventSourceId} was archived`
  )

  await appendAutomationAuditLog({
    workspaceId: workspaceId,
    userId: auditUserId,
    actorId: operator.actorId || null,
    action: "automation_event_source.archive",
    resourceType: "automation_event_source",
    resourceId: eventSourceId,
    details: { archived: true },
  })
}

async function getAutomationEventSourceByWebhookPathToken(
  pathToken: string,
  sourceKey: string
) {
  return selectWebhookAutomationEventSourceByPathToken({
    pathToken,
    sourceKey,
  })
}

async function listIntegrationEventSourcesByWebhookPathToken(
  pathToken: string
) {
  return listIntegrationAutomationEventSourceRowsByWebhookPathToken({
    pathToken,
  })
}

async function expireAutomationRules(params: {
  referenceTime?: Timestamp
  workspaceId?: string
  client?: Executor
}) {
  const referenceTime = params.referenceTime || nowIsoInstant()
  await expireAutomationRuleRows({
    referenceTime,
    workspaceId: params.workspaceId,
    executor: params.client,
  })
}

async function pauseAutomationRulesForInactiveCreators(params: {
  workspaceId?: string
  client?: Executor
}) {
  await pauseAutomationRuleRowsForInactiveCreators({
    workspaceId: params.workspaceId,
    executor: params.client,
  })
}

async function syncAutomationRuleLiveness(params: {
  referenceTime?: Timestamp
  workspaceId?: string
  client?: Executor
}) {
  await expireAutomationRules(params)
  await pauseAutomationRulesForInactiveCreators({
    workspaceId: params.workspaceId,
    client: params.client,
  })
}

async function resolveAutomationRulesForEvent(params: {
  workspaceId: string
  eventSourceId: string
  payload: Record<string, unknown>
  occurredAt: Timestamp
}) {
  const candidates = await selectActiveAutomationRuleEventMatchers(params)
  return candidates.filter((entry) =>
    subsetMatch(entry.matcher, params.payload)
  )
}

async function createAutomationOccurrence(params: {
  workspaceId: string
  sourceKind: AutomationSourceKind
  eventSourceId?: string
  eventSourceKey?: string
  eventSourceName?: string
  sourceLocator?: string
  matchKey?: string
  dedupeKey?: string
  sourceSnapshot?: Record<string, unknown>
  payload?: Record<string, unknown>
  occurredAt?: Timestamp
  client?: Executor
}) {
  const runner = resolveQueryRunner(params.client)
  const occurredAt = params.occurredAt || nowIsoInstant()
  const dedupeKey = params.dedupeKey?.trim() || null

  if (dedupeKey) {
    const existing = await runner.run<AutomationOccurrenceDbRow>(
      `SELECT *
       FROM automation_occurrences
       WHERE workspace_id = $1
         AND ${params.eventSourceId ? "event_source_id = $2" : "source_kind = $2"}
         AND dedupe_key = $3
       LIMIT 1`,
      [params.workspaceId, params.eventSourceId || params.sourceKind, dedupeKey]
    )
    if (existing.rows[0]) {
      return presentOccurrence(
        normalizeAutomationOccurrenceRow(existing.rows[0])
      )
    }
  }

  const result = await runner.run<AutomationOccurrenceDbRow>(
    `INSERT INTO automation_occurrences
       (id, workspace_id, source_kind, event_source_id, source_locator, match_key, dedupe_key, source_snapshot, payload, occurred_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.sourceKind,
      params.eventSourceId || null,
      params.sourceLocator || null,
      params.matchKey || null,
      dedupeKey,
      JSON.stringify(params.sourceSnapshot || {}),
      JSON.stringify(params.payload || {}),
      occurredAt,
    ]
  )

  return presentOccurrence(normalizeAutomationOccurrenceRow(result.rows[0]!))
}

async function createAutomationExecution(params: {
  workspaceId: string
  ruleId: string
  occurrenceId: string
  client?: Executor
}) {
  const runner = resolveQueryRunner(params.client)
  const existing = await runner.run(
    `SELECT *
     FROM automation_executions
     WHERE rule_id = $1
       AND occurrence_id = $2
     LIMIT 1`,
    [params.ruleId, params.occurrenceId]
  )
  if (existing.rows[0]) {
    return {
      execution: presentExecution(existing.rows[0]),
      isNew: false,
    }
  }

  const result = await runner.run(
    `INSERT INTO automation_executions
       (id, workspace_id, rule_id, occurrence_id, status, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, NOW(), NOW())
     RETURNING *`,
    [uuidv4(), params.workspaceId, params.ruleId, params.occurrenceId]
  )
  return {
    execution: presentExecution(result.rows[0]!),
    isNew: true,
  }
}

async function recordExecutionTarget(params: {
  executionId: string
  conversationId?: string
  targetParticipantId?: string
  sessionId?: string
  targetActorId?: string
  createdItemId?: string
  wakeupId?: string
  status: AutomationExecutionStatus
  metadata?: Record<string, unknown>
}) {
  await insertAutomationExecutionTarget({
    id: uuidv4(),
    executionId: params.executionId,
    conversationId: params.conversationId || null,
    targetParticipantId: params.targetParticipantId || null,
    sessionId: params.sessionId || null,
    targetActorId: params.targetActorId || null,
    createdItemId: params.createdItemId || null,
    wakeupId: params.wakeupId || null,
    status: params.status,
    metadata: params.metadata || {},
  })
}

function buildAutomationNoticePayload(params: {
  rule: AutomationRule
  executionId: string
  occurrence: AutomationOccurrence
}) {
  return {
    automationId: params.rule.id,
    executionId: params.executionId,
    occurrenceId: params.occurrence.id,
    category: params.rule.category,
    sourceKind: params.occurrence.sourceKind,
    eventSourceId: params.occurrence.eventSourceId,
    eventSourceName:
      params.occurrence.eventSourceName || params.rule.trigger.eventSourceName,
    sourceLabel:
      params.occurrence.displayTitle ||
      params.occurrence.eventSourceName ||
      params.rule.trigger.eventSourceName ||
      params.occurrence.matchKey ||
      params.occurrence.sourceLocator ||
      params.occurrence.sourceKind,
    sourceTitle: params.occurrence.displayTitle,
    sourceSummary: params.occurrence.displaySummary,
    sourceDescription: params.occurrence.displayDescription,
    occurredAt: params.occurrence.occurredAt,
    message: params.rule.delivery.messageText,
    messageBlocks: params.rule.delivery.messageBlocks,
  }
}

async function resolveOperatorUserId(rule: AutomationRule) {
  const creatorParticipant = await getConversationParticipant({
    conversationId: rule.conversationId,
    participantId: rule.createdByParticipantId,
  })
  if (creatorParticipant?.workspaceMemberId) {
    const identity = await getWorkspaceMemberIdentityById(
      creatorParticipant.workspaceMemberId as string
    )
    if (identity?.userId) return identity.userId
  }

  const members = await listConversationParticipants(rule.conversationId)
  const firstUser = members.find(
    (member: any) => member.state === "active" && member.workspaceMemberId
  )
  if (firstUser?.workspaceMemberId) {
    const workspaceMember = await getWorkspaceMemberIdentityById(
      firstUser.workspaceMemberId as string
    )
    if (workspaceMember) {
      return workspaceMember.userId
    }
  }

  return selectWorkspaceOwnerId(rule.workspaceId)
}

async function resolveCreatorParticipant(rule: AutomationRule) {
  return getConversationParticipant({
    conversationId: rule.conversationId,
    participantId: rule.createdByParticipantId,
  })
}

async function resolveDeliveryTargets(rule: AutomationRule) {
  const members = await listConversationParticipants(rule.conversationId)
  const activeParticipants = members.filter(
    (member: any) => member.state === "active"
  )
  if (rule.delivery.targetPolicy === "all_members") {
    return {
      restrictedAudienceParticipantIds: activeParticipants.map(
        (member: any) => member.id as string
      ),
      targetParticipants: activeParticipants,
    }
  }

  const configuredTargetIds = new Set(rule.delivery.targetParticipantIds)
  const targetParticipants = activeParticipants.filter((member: any) =>
    configuredTargetIds.has(member.id as string)
  )

  return {
    restrictedAudienceParticipantIds: targetParticipants.map(
      (member: any) => member.id as string
    ),
    targetParticipants,
  }
}

async function createAutomationNotice(params: {
  rule: AutomationRule
  executionId: string
  occurrence: AutomationOccurrence
  restrictedAudienceParticipantIds: string[]
}) {
  const payload = buildAutomationNoticePayload(params)
  const timelinePolicy =
    params.rule.delivery.targetPolicy === "specified_members"
      ? "targeted_members"
      : "all_members"
  const contextPolicy =
    params.rule.delivery.targetPolicy === "specified_members"
      ? "targeted_members"
      : "shared"
  const created = await createConversationEvent({
    workspaceId: params.rule.workspaceId,
    conversationId: params.rule.conversationId,
    eventType: "automation_notice",
    timelinePolicy,
    contextPolicy,
    metadata: {
      automationId: params.rule.id,
      executionId: params.executionId,
      occurrenceId: params.occurrence.id,
    },
    eventPayload: payload,
    restrictedAudienceParticipantIds:
      timelinePolicy === "targeted_members"
        ? params.restrictedAudienceParticipantIds
        : undefined,
    contextTargetParticipantIds:
      contextPolicy === "targeted_members"
        ? params.restrictedAudienceParticipantIds
        : undefined,
  })
  return created.item.id as string
}

async function wakeAutomationTargets(params: {
  rule: AutomationRule
  executionId: string
  occurrence: AutomationOccurrence
  createdItemId: string
  targetParticipants: any[]
}) {
  let wakeupCount = 0

  for (const participant of params.targetParticipants) {
    let wakeupId: string | undefined
    const actorId = participant.actorId as string | undefined
    const sessionId =
      participant.sessionId && participant.state === "active"
        ? (participant.sessionId as string)
        : undefined

    if (actorId && sessionId) {
      const wakeup = await enqueueSessionWakeup({
        sessionId,
        actorId,
        workspaceId: params.rule.workspaceId,
        sourceType: "automation",
        sourceItemId: params.createdItemId,
        sourceParticipantType: "system",
        sourceName: params.rule.name,
        summary: params.rule.delivery.messageText || params.rule.name,
        reasonText:
          params.rule.delivery.wakeReasonText ||
          params.rule.delivery.messageText ||
          params.rule.name,
        automationExecutionId: params.executionId,
        automationOccurrenceId: params.occurrence.id,
        trigger: "automation",
        metadata: {
          automationId: params.rule.id,
        },
      })
      wakeupId = wakeup.id as string
      wakeupCount += 1
    }

    await recordExecutionTarget({
      executionId: params.executionId,
      conversationId: params.rule.conversationId,
      targetParticipantId: participant.id as string,
      sessionId,
      targetActorId: actorId,
      createdItemId: params.createdItemId,
      wakeupId,
      status: "completed",
      metadata: {
        targetActive: participant.state === "active",
        wakeupScheduled: Boolean(wakeupId),
      },
    })
  }

  return wakeupCount
}

export function getAutomationSchedulerIntervalMs() {
  return AUTOMATION_SCHEDULER_INTERVAL_MS
}

async function resolveConversationCreatorParticipant(
  creator: AutomationCreatorInput | AutomationOperatorInput,
  conversationId: string
) {
  if (creator.actorId) {
    const actorParticipant = await getConversationParticipant({
      conversationId,
      actorId: creator.actorId,
    })
    if (actorParticipant?.id && actorParticipant.state === "active") {
      return actorParticipant
    }
  }

  if (creator.workspaceMemberId) {
    const memberParticipant = await getConversationParticipant({
      conversationId,
      workspaceMemberId: creator.workspaceMemberId,
    })
    if (memberParticipant?.id && memberParticipant.state === "active") {
      return memberParticipant
    }
  }

  throw new Error(
    "Creator must be an active participant in the target conversation"
  )
}

async function validateAutomationDeliveryTargets(params: {
  conversationId: string
  creatorParticipant: any
  delivery: Awaited<ReturnType<typeof normalizeDeliveryInput>>
}) {
  const activeParticipants = (
    await listConversationParticipants(params.conversationId)
  ).filter((participant: any) => participant.state === "active")
  const participantsById = new Map(
    activeParticipants.map((participant: any) => [
      participant.id as string,
      participant,
    ])
  )

  for (const targetParticipantId of params.delivery.targetParticipantIds) {
    if (!participantsById.has(targetParticipantId)) {
      throw new Error(
        `Target participant ${targetParticipantId} is not in conversation ${params.conversationId}`
      )
    }
  }

  if (params.creatorParticipant.participant_type === "actor") {
    if (params.delivery.target_policy !== "specified_members") {
      throw new Error(
        "Actor-created automations must target the creator actor only"
      )
    }
    if (
      params.delivery.targetParticipantIds.length !== 1 ||
      params.delivery.targetParticipantIds[0] !== params.creatorParticipant.id
    ) {
      throw new Error(
        "Actor-created automations must target the creator actor only"
      )
    }
  }
}

export async function createAutomationRule(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationRuleInput
) {
  const issues = validateAutomationRuleCreatePayload(input as any)
  if (issues.length > 0) {
    throw createAutomationValidationError(issues)
  }

  const conversation = await loadConversationWithImFlag(input.conversationId, {
    required: true,
  })
  if (!conversation) {
    throw new Error(`Conversation ${input.conversationId} not found`)
  }
  const creatorParticipant = await resolveConversationCreatorParticipant(
    creator,
    input.conversationId
  )
  const auditUserId = await resolveAutomationAuditUserId(creator)
  const ruleId = uuidv4()
  const category: AutomationCategory =
    input.trigger.triggerKind === "schedule"
      ? AUTOMATION_RULE_CATEGORY.SCHEDULE
      : AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION
  const normalizedPolicy = normalizePolicyInput(input.policy)
  const normalizedDelivery = await normalizeDeliveryInput(input.delivery)
  await validateAutomationDeliveryTargets({
    conversationId: input.conversationId,
    creatorParticipant,
    delivery: normalizedDelivery,
  })
  const normalizedTrigger = await normalizeTriggerInput({
    workspaceId,
    input: input.trigger,
    policy: input.policy,
    conversation,
    creatorActorId: creatorParticipant.actorId as string | null | undefined,
  })

  await withAutomationTransaction(async (trx) => {
    await insertAutomationRuleRow(trx, {
      id: ruleId,
      workspaceId: workspaceId,
      conversationId: input.conversationId,
      category,
      status: input.status || "active",
      name: input.name.trim(),
      description: (input.description || "").trim(),
      createdByParticipantId: creatorParticipant.id,
      createdBySessionId: creator.sessionId || null,
      metadata: JSON.stringify(input.metadata || {}),
    })

    await insertAutomationPolicyRow(trx, {
      ruleId: ruleId,
      activeFrom: normalizedPolicy.active_from,
      activeUntil: normalizedPolicy.active_until,
      maxTriggerCount: normalizedPolicy.max_trigger_count,
      triggerCount: normalizedPolicy.trigger_count,
      completionStatus: normalizedPolicy.completion_status,
      completedAt: normalizedPolicy.completed_at,
      metadata: JSON.stringify(normalizedPolicy.metadata),
    })

    await insertAutomationTriggerRow(trx, ruleId, normalizedTrigger)

    await insertAutomationDeliveryRow(trx, {
      ruleId: ruleId,
      messageText: normalizedDelivery.message_text,
      wakeReasonText: normalizedDelivery.wake_reason_text,
      messageBlocks: JSON.stringify(normalizedDelivery.message_blocks),
      targetPolicy: normalizedDelivery.target_policy,
      metadata: JSON.stringify(normalizedDelivery.metadata),
    })

    await persistAutomationDeliveryTargets(
      trx,
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await appendAutomationAuditLog(
      {
        workspaceId: workspaceId,
        userId: auditUserId,
        actorId: creator.actorId || null,
        action: "automation_rule.create",
        resourceType: "automation_rule",
        resourceId: ruleId,
        details: {
          category,
          triggerKind: normalizedTrigger.trigger_kind,
          policy: {
            activeFrom: normalizedPolicy.active_from,
            activeUntil: normalizedPolicy.active_until,
            maxTriggerCount: normalizedPolicy.max_trigger_count,
            completionStatus: normalizedPolicy.completion_status,
          },
          sourceKind: normalizedTrigger.source_kind,
          eventSourceId: normalizedTrigger.event_source_id,
          conversationId: input.conversationId,
          targetPolicy: normalizedDelivery.target_policy,
          targetCount: normalizedDelivery.targetParticipantIds.length,
        },
      },
      trx
    )
  })

  const [rule] = await loadAutomationRulesByIds(workspaceId, [ruleId])
  if (!rule) {
    throw new Error(`Automation rule ${ruleId} was not persisted`)
  }
  return rule
}

export async function listAutomationRules(
  workspaceId: string,
  filters?: {
    status?: AutomationStatus
    category?: AutomationCategory
    conversationId?: string
  }
) {
  await syncAutomationRuleLiveness({ workspaceId })

  const ruleIds = await listAutomationRuleIds({ workspaceId, filters })
  return loadAutomationRulesByIds(workspaceId, ruleIds)
}

export async function getAutomationRule(workspaceId: string, ruleId: string) {
  await syncAutomationRuleLiveness({ workspaceId })
  const [rule] = await loadAutomationRulesByIds(workspaceId, [ruleId])
  return rule || null
}

export async function updateAutomationRule(
  workspaceId: string,
  ruleId: string,
  operator: AutomationOperatorInput,
  input: UpdateAutomationRuleInput
) {
  const auditUserId = await resolveAutomationAuditUserId(operator)
  const existing = await getAutomationRule(workspaceId, ruleId)
  if (!existing) {
    throw new Error("Automation rule not found")
  }

  const mergedInput = mergeAutomationRuleUpdatePayload(existing, input)
  const issues = validateAutomationRuleCreatePayload(mergedInput)
  if (issues.length > 0) {
    throw createAutomationValidationError(issues)
  }
  if (mergedInput.conversationId !== existing.conversationId) {
    throw createAutomationValidationError([
      {
        path: "conversationId",
        message: "Automation rules cannot be moved to another conversation",
      },
    ])
  }

  const creatorParticipant = await resolveCreatorParticipant(existing)
  if (!creatorParticipant?.id) {
    throw new Error("Automation creator participant no longer exists")
  }
  const conversation = await loadConversationWithImFlag(
    existing.conversationId,
    { required: true }
  )
  if (!conversation) {
    throw new Error(`Conversation ${existing.conversationId} not found`)
  }
  const normalizedPolicy = normalizePolicyInput(mergedInput.policy)
  const normalizedDelivery = await normalizeDeliveryInput(mergedInput.delivery)
  await validateAutomationDeliveryTargets({
    conversationId: existing.conversationId,
    creatorParticipant,
    delivery: normalizedDelivery,
  })
  const normalizedTrigger = await normalizeTriggerInput({
    workspaceId,
    input: mergedInput.trigger,
    policy: mergedInput.policy,
    conversation,
    creatorActorId: creatorParticipant.actorId as string | null | undefined,
  })

  await withAutomationTransaction(async (trx) => {
    const nextCategory: AutomationCategory =
      normalizedTrigger.trigger_kind === "schedule"
        ? AUTOMATION_RULE_CATEGORY.SCHEDULE
        : AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION

    await updateAutomationRuleRow(trx, ruleId, {
      status: mergedInput.status || existing.status,
      category: nextCategory,
      name: mergedInput.name.trim(),
      description: (mergedInput.description || "").trim(),
      metadata: JSON.stringify(mergedInput.metadata || {}),
    })

    await updateAutomationPolicyRow(trx, ruleId, {
      activeFrom: normalizedPolicy.active_from,
      activeUntil: normalizedPolicy.active_until,
      maxTriggerCount: normalizedPolicy.max_trigger_count,
      completionStatus: normalizedPolicy.completion_status,
      completedAt:
        mergedInput.status === "active"
          ? null
          : existing.policy.completedAt
            ? parseInstantString(existing.policy.completedAt)
            : null,
      metadata: JSON.stringify(normalizedPolicy.metadata),
    })

    await updateAutomationTriggerRow(trx, ruleId, normalizedTrigger)

    await updateAutomationDeliveryRow(trx, ruleId, {
      messageText: normalizedDelivery.message_text,
      wakeReasonText: normalizedDelivery.wake_reason_text,
      messageBlocks: JSON.stringify(normalizedDelivery.message_blocks),
      targetPolicy: normalizedDelivery.target_policy,
      metadata: JSON.stringify(normalizedDelivery.metadata),
    })

    await persistAutomationDeliveryTargets(
      trx,
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await appendAutomationAuditLog(
      {
        workspaceId: workspaceId,
        userId: auditUserId,
        actorId: operator.actorId || null,
        action: "automation_rule.update",
        resourceType: "automation_rule",
        resourceId: ruleId,
        details: {
          triggerKind: normalizedTrigger.trigger_kind,
          policy: {
            activeFrom: normalizedPolicy.active_from,
            activeUntil: normalizedPolicy.active_until,
            maxTriggerCount: normalizedPolicy.max_trigger_count,
            completionStatus: normalizedPolicy.completion_status,
          },
          sourceKind: normalizedTrigger.source_kind,
          eventSourceId: normalizedTrigger.event_source_id,
          targetPolicy: normalizedDelivery.target_policy,
          targetCount: normalizedDelivery.targetParticipantIds.length,
        },
      },
      trx
    )
  })

  const updated = await getAutomationRule(workspaceId, ruleId)
  if (!updated) {
    throw new Error(`Automation rule ${ruleId} was not found after update`)
  }
  return updated
}

export async function deleteAutomationRule(
  workspaceId: string,
  ruleId: string,
  operator: AutomationOperatorInput
) {
  const auditUserId = await resolveAutomationAuditUserId(operator)
  await appendAutomationAuditLog({
    workspaceId: workspaceId,
    userId: auditUserId,
    actorId: operator.actorId || null,
    action: "automation_rule.delete",
    resourceType: "automation_rule",
    resourceId: ruleId,
    details: { deleted: true },
  })
  // Soft delete (design §7.4): flip deleted_at (hard delete forbidden by
  // sd_reject_delete).
  await softDeleteAutomationRule(workspaceId, ruleId)
}

export async function createAutomationWebhookEndpoint(
  workspaceId: string,
  createdByWorkspaceMemberId: string,
  params: {
    name: string
    metadata?: Record<string, unknown>
  }
): Promise<AutomationWebhookEndpointCreateResult> {
  const secret = generateSecret()
  const row = await insertAutomationWebhookEndpointReturningRow({
    id: uuidv4(),
    workspaceId,
    name: params.name.trim(),
    status: "active",
    pathToken: crypto.randomBytes(18).toString("hex"),
    secretCiphertext: encrypt(secret),
    secretHint: secretHint(secret),
    metadata: params.metadata || {},
    createdByWorkspaceMemberId,
  })

  return {
    endpoint: presentWebhookEndpoint(
      normalizeAutomationWebhookEndpointRow(row)
    ),
    secret,
  }
}

export async function listAutomationWebhookEndpoints(workspaceId: string) {
  const rows = await listAutomationWebhookEndpointRows(workspaceId)
  return rows.map(normalizeAutomationWebhookEndpointRow)
}

export async function listAutomationOccurrences(
  workspaceId: string,
  filters?: {
    eventSourceId?: string
    limit?: number
  }
) {
  const rows = await listAutomationOccurrenceRows({ workspaceId, filters })

  return rows.map((row) =>
    presentOccurrence(normalizeAutomationOccurrenceRow(row))
  )
}

export async function ingestAutomationProviderEvent(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string
  sourceKey: string
  payload?: Record<string, unknown>
  sourceSnapshot?: Record<string, unknown>
  dedupeKey?: string
  occurredAt?: Timestamp
}) {
  const eventSourceId = await selectActiveAutomationEventSourceId({
    workspaceId: params.workspaceId,
    providerKind: params.providerKind,
    providerRef: params.providerRef || null,
    sourceKey: params.sourceKey,
  })
  if (!eventSourceId) {
    return null
  }

  return ingestAutomationEvent({
    workspaceId: params.workspaceId,
    eventSourceId: eventSourceId,
    payload: params.payload,
    sourceSnapshot: params.sourceSnapshot,
    dedupeKey: params.dedupeKey,
    occurredAt: params.occurredAt,
  })
}

export async function ingestAutomationEvent(input: AutomationEventEnvelope) {
  const eventSource = await getAutomationEventSource(
    input.workspaceId,
    input.eventSourceId
  )
  if (!eventSource) {
    throw new Error(`Event source ${input.eventSourceId} not found`)
  }
  ensureEventSourceIsEmittable(eventSource)

  const payload = input.payload || {}
  const storedOccurrence = await createAutomationOccurrence({
    workspaceId: input.workspaceId,
    sourceKind: eventSource.providerKind,
    eventSourceId: eventSource.id,
    sourceLocator: buildEventSourceLocator(eventSource),
    matchKey: eventSourceMatchKey(eventSource),
    dedupeKey: input.dedupeKey,
    sourceSnapshot: {
      eventSourceId: eventSource.id,
      eventSourceName: eventSource.name,
      providerKind: eventSource.providerKind,
      providerRef: eventSource.providerRef || null,
      sourceKey: eventSource.sourceKey,
      ...(eventSource.integration
        ? {
            integrationInstallationId: eventSource.integration.installationId,
            integrationProvider: eventSource.integration.provider,
            integrationIngressKind: eventSource.integration.ingressKind,
            integrationTargetKind: eventSource.integration.targetKind,
            integrationTargetId: eventSource.integration.targetId,
            integrationTargetLabel: eventSource.integration.targetLabel,
            integrationEndpointId: eventSource.integration.endpointId || null,
            externalSubscriptionId:
              eventSource.integration.externalSubscriptionId || null,
          }
        : {}),
      ...(input.sourceSnapshot || {}),
    },
    payload,
    occurredAt: input.occurredAt,
  })
  const occurrence: AutomationOccurrence = {
    ...storedOccurrence,
    eventSourceId: eventSource.id,
    eventSourceKey: eventSource.sourceKey,
    eventSourceName: eventSource.name,
    eventSourceIntegration: eventSource.integration,
    sourceKind: eventSource.providerKind,
    sourceLocator: buildEventSourceLocator(eventSource),
    matchKey: eventSource.sourceKey,
  }
  const decoratedOccurrence = decorateOccurrenceDisplay(occurrence, {
    eventProviderRef: eventSource.providerRef,
  })

  await syncAutomationRuleLiveness({
    workspaceId: input.workspaceId,
    referenceTime: occurrence.occurredAt,
  })
  const matches = await resolveAutomationRulesForEvent({
    workspaceId: input.workspaceId,
    eventSourceId: eventSource.id,
    payload,
    occurredAt: occurrence.occurredAt,
  })

  const executions = [] as AutomationExecution[]
  for (const match of matches) {
    const { execution, isNew } = await createAutomationExecution({
      workspaceId: input.workspaceId,
      ruleId: match.ruleId,
      occurrenceId: occurrence.id,
    })
    if (!isNew) {
      continue
    }
    executions.push(execution)
  }

  await touchAutomationEventSourceTriggered(eventSource.id)
  await appendAutomationAuditLog({
    workspaceId: input.workspaceId,
    action: "automation_event_source.trigger",
    resourceType: "automation_event_source",
    resourceId: eventSource.id,
    details: {
      occurrenceId: occurrence.id,
      occurrenceTitle: decoratedOccurrence.displayTitle,
      executionCount: executions.length,
    },
  })

  return {
    occurrence: decoratedOccurrence,
    executions,
  }
}

export async function ingestAutomationWebhookEvent(params: {
  pathToken: string
  sourceKey: string
  secret?: string
  headers?: Record<string, unknown>
  rawBody?: string
  payload?: Record<string, unknown>
  sourceSnapshot?: Record<string, unknown>
  dedupeKey?: string
  occurredAt?: Timestamp
}) {
  const sourceRow = await getAutomationEventSourceByWebhookPathToken(
    params.pathToken,
    params.sourceKey
  )
  if (!sourceRow) {
    throw new Error("Webhook event source not found")
  }
  if (!sourceRow.endpoint_secret_ciphertext) {
    throw new Error("Webhook endpoint secret is unavailable")
  }
  const endpointSecret = decrypt(sourceRow.endpoint_secret_ciphertext)

  let payload = params.payload || {}
  let sourceSnapshot: Record<string, unknown> = {
    endpointId: sourceRow.endpoint_id,
    endpointName: sourceRow.endpoint_name,
    ...(params.sourceSnapshot || {}),
  }
  let dedupeKey = params.dedupeKey
  let occurredAt = params.occurredAt

  if (!params.secret || !verifyPresentedSecret(params.secret, endpointSecret)) {
    throw new Error("Invalid webhook secret")
  }

  await touchWebhookReceived(sourceRow.endpoint_id)

  return ingestAutomationEvent({
    workspaceId: sourceRow.workspace_id,
    eventSourceId: sourceRow.id,
    payload,
    sourceSnapshot,
    dedupeKey,
    occurredAt,
  })
}

export async function ingestIntegrationAutomationWebhookEvent(params: {
  pathToken: string
  headers?: Record<string, unknown>
  rawBody?: string
  payload?: Record<string, unknown>
}) {
  const sourceRows = await listIntegrationEventSourcesByWebhookPathToken(
    params.pathToken
  )
  const sourceRow = sourceRows[0]
  if (!sourceRow) {
    throw new Error("Integration webhook binding not found")
  }
  if (!sourceRow.endpoint_secret_ciphertext) {
    throw new Error("Webhook endpoint secret is unavailable")
  }

  const endpointSecret = decrypt(sourceRow.endpoint_secret_ciphertext)
  const source = presentEventSource(sourceRow)
  if (!source.integration) {
    throw new Error("Integration webhook ingress requires integration metadata")
  }

  const normalized = normalizeIntegrationWebhookIngress({
    integration: source.integration,
    secret: endpointSecret,
    headers: params.headers || {},
    rawBody: params.rawBody,
    body: params.payload || {},
  })
  if (normalized.ignore) {
    return {
      ignored: true as const,
      occurrences: [],
      executions: [],
    }
  }

  await touchWebhookReceived(sourceRow.endpoint_id)
  const matchingSourceKeys = listIntegrationSourceKeysForWebhookIngress({
    provider: source.integration.provider,
    headers: params.headers || {},
    payload: normalized.payload,
  })
  const matchingRows = sourceRows.filter((row) =>
    matchingSourceKeys.includes(row.source_key)
  )
  if (matchingRows.length === 0) {
    return {
      ignored: true as const,
      occurrences: [],
      executions: [],
    }
  }

  const sharedSourceSnapshot: Record<string, unknown> = {
    endpointId: sourceRow.endpoint_id,
    endpointName: sourceRow.endpoint_name,
    ...(normalized.sourceSnapshot || {}),
  }
  const occurrences: AutomationOccurrence[] = []
  const executions: AutomationExecution[] = []

  for (const row of matchingRows) {
    const result = await ingestAutomationEvent({
      workspaceId: row.workspace_id,
      eventSourceId: row.id,
      payload: normalized.payload,
      sourceSnapshot: sharedSourceSnapshot,
      dedupeKey: normalized.dedupeKey,
      occurredAt: normalized.occurredAt
        ? assertIsoInstant(normalized.occurredAt)
        : undefined,
    })
    occurrences.push(result.occurrence)
    executions.push(...result.executions)
  }

  return {
    ignored: false as const,
    occurrences,
    executions,
  }
}

export async function scheduleDueAutomationExecutions(
  limit = MAX_SCHEDULER_BATCH_SIZE
): Promise<ScheduleDueRulesResult> {
  const scheduledExecutions: string[] = []
  const batchSize = Math.max(1, Math.min(limit, MAX_SCHEDULER_BATCH_SIZE))

  await withAutomationTransaction(async (trx) => {
    await syncAutomationRuleLiveness({ client: trx })

    const dueRows = await lockDueAutomationScheduleRows(trx, batchSize)

    for (const row of dueRows) {
      const rowDates = presentDueScheduleRowDates(row)
      const occurrence = await createAutomationOccurrence({
        workspaceId: row.workspaceId,
        sourceKind: "clock",
        sourceLocator: row.scheduleTimezone || "UTC",
        dedupeKey: `${row.ruleId}:${row.nextFireAt}`,
        sourceSnapshot: {
          ruleId: row.ruleId,
          ruleName: row.ruleName,
          scheduleKind: row.scheduleKind,
          scheduleExpr: row.scheduleExpr,
          scheduleTimezone: row.scheduleTimezone,
          intervalSeconds: row.intervalSeconds,
          startsAt: rowDates.startsAt,
          activeFrom: rowDates.activeFrom,
          activeUntil: rowDates.activeUntil,
          scheduledAt: rowDates.nextFireAt,
        },
        payload: {},
        occurredAt: rowDates.nextFireAt,
        client: trx,
      })

      const { execution, isNew } = await createAutomationExecution({
        workspaceId: row.workspaceId,
        ruleId: row.ruleId,
        occurrenceId: occurrence.id,
        client: trx,
      })

      const nextFireAt = computeNextFireAt({
        scheduleKind: row.scheduleKind,
        scheduleExpr: row.scheduleExpr || undefined,
        scheduleTimezone: row.scheduleTimezone || undefined,
        intervalSeconds: row.intervalSeconds || undefined,
        startsAt: rowDates.startsAt ?? null,
        activeFrom: rowDates.activeFrom ?? null,
        activeUntil: rowDates.activeUntil ?? null,
        baseTime: row.nextFireAt,
        lastFiredAt: rowDates.nextFireAt,
      })

      await updateAutomationTriggerSchedule(trx, row.ruleId, {
        lastFiredAt: row.nextFireAt,
        nextFireAt: nextFireAt ? parseInstantString(nextFireAt) : null,
      })
      if (isNew) {
        scheduledExecutions.push(execution.id)
      }
    }
  })

  return { scheduledExecutions }
}

export async function processAutomationExecution(
  executionId: string
): Promise<ProcessAutomationExecutionResult> {
  const executionRow = await claimPendingAutomationExecutionRow(executionId)
  if (!executionRow) {
    const exists = await existsAutomationExecution(executionId)
    if (!exists) {
      throw new Error(`Automation execution ${executionId} not found`)
    }
    return {
      executionId,
      wakeupCount: 0,
    }
  }

  const execution = presentExecution(executionRow)
  const occurrenceRow = await selectAutomationOccurrenceRow(
    execution.occurrenceId
  )
  const occurrence = occurrenceRow
    ? presentOccurrence(normalizeAutomationOccurrenceRow(occurrenceRow))
    : null
  if (!occurrence) {
    throw new Error(`Automation occurrence ${execution.occurrenceId} not found`)
  }

  await syncAutomationRuleLiveness({ workspaceId: execution.workspaceId })
  const rule = await getAutomationRule(execution.workspaceId, execution.ruleId)
  if (!rule) {
    throw new Error(`Automation rule ${execution.ruleId} not found`)
  }

  try {
    if (rule.status !== "active") {
      await markAutomationExecutionSkipped(
        executionId,
        `Automation rule is ${rule.status}`
      )
      return {
        executionId,
        wakeupCount: 0,
      }
    }

    const creatorParticipant = await resolveCreatorParticipant(rule)
    const { restrictedAudienceParticipantIds, targetParticipants } =
      await resolveDeliveryTargets(rule)
    if (targetParticipants.length === 0) {
      await markAutomationExecutionSkipped(
        executionId,
        "No active target participants matched this automation"
      )
      await clearAutomationRuleError(rule.id)
      return {
        executionId,
        wakeupCount: 0,
      }
    }

    const createdItemId = await createAutomationNotice({
      rule,
      executionId,
      occurrence,
      restrictedAudienceParticipantIds,
    })

    const wakeupCount = await wakeAutomationTargets({
      rule,
      executionId,
      occurrence,
      createdItemId,
      targetParticipants,
    })

    await markAutomationExecutionCompleted(executionId)
    await markAutomationRuleTriggered(rule.id)
    await applyAutomationPolicyAfterTriggerRepo({
      ruleId: rule.id,
      workspaceId: rule.workspaceId,
      occurrenceId: occurrence.id,
      executionId,
      completeNow:
        rule.trigger.triggerKind === "schedule" && !rule.trigger.nextFireAt,
      completionReason:
        rule.trigger.triggerKind === "schedule"
          ? "schedule_exhausted"
          : "max_trigger_count",
    })
    await appendAutomationAuditLog({
      workspaceId: rule.workspaceId,
      userId: (await resolveOperatorUserId(rule)) || null,
      actorId: creatorParticipant?.actorId || null,
      action: "automation_rule.trigger",
      resourceType: "automation_rule",
      resourceId: rule.id,
      details: {
        executionId,
        occurrenceId: occurrence.id,
        createdItemId,
        wakeupCount,
        targetCount: targetParticipants.length,
      },
    })

    return {
      executionId,
      createdItemId,
      wakeupCount,
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error)
    await markAutomationExecutionFailed(executionId, message)
    await updateAutomationRuleError(rule.id, message)
    throw error
  }
}

export async function listAutomationExecutions(
  workspaceId: string,
  ruleId: string,
  limit = 50
) {
  const rows = await listAutomationExecutionRows({ workspaceId, ruleId, limit })

  return rows.map(normalizeAutomationExecutionWithOccurrenceRow)
}
