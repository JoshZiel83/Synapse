import crypto from "node:crypto"
import cronParser from "cron-parser"
import { v4 as uuidv4 } from "uuid"
import {
  assertIsoInstant,
  dateToIsoInstant,
  fromExternalRfc3339,
  nowIsoInstant,
} from "@synapse/shared/datetime"
import { parseInstantString } from "../../infrastructure/datetime.js"
import type {
  AutomationEventSourceAccessStateSchemaType,
  AutomationCategory,
  AutomationCompletionStatus,
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
} from "@synapse/shared"
import {
  mergeAutomationRuleUpdatePayload,
  validateAutomationRuleCreatePayload,
} from "@synapse/shared/automation"
import { decrypt, encrypt } from "../../infrastructure/crypto/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import {
  type DatabaseTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  applyAutomationPolicyAfterTrigger as applyAutomationPolicyAfterTriggerRepo,
  claimPendingAutomationExecutionRow,
  clearAutomationRuleError,
  existsAutomationEventSourceKey,
  existsAutomationExecution,
  expireAutomationRuleRows,
  insertAutomationExecutionReturningRow,
  insertAutomationDeliveryRow,
  insertAutomationEventSourceRow,
  insertAutomationOccurrenceReturningRow,
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
  loadAutomationEventSourceAccessGrantRows,
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
  revokeAutomationEventSourceAccessGrantById,
  selectActiveAutomationEventSourceId,
  selectActiveAutomationRuleEventMatchers,
  selectActiveWebhookEndpointId,
  selectAutomationExecutionRowByRuleOccurrence,
  selectAutomationOccurrenceRow,
  selectAutomationOccurrenceRowByDedupeKey,
  selectAutomationEventSourceReuseRow,
  selectAutomationIntegrationBindingRow,
  selectAutomationWebhookEndpointRow,
  selectExistingAutomationIntegrationBindingRow,
  selectWebhookAutomationEventSourceByPathToken,
  selectIntegrationEventSourceReuseRow,
  setAutomationEventSourceStatus,
  softDeleteAutomationEventSource,
  softDeleteAutomationRule,
  touchAutomationEventSourceTriggered,
  touchWebhookReceived,
  updateAutomationDeliveryRow,
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
} from "./repo.js"
import { getConversation } from "../chat/conversation-record.js"
import { createConversationEvent } from "../chat/event-write.js"
import {
  getConversationParticipantUseCase as getConversationParticipant,
  listConversationParticipantsUseCase as listConversationParticipants,
} from "../chat/participant-roster.js"
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
import {
  readAutomationEventSourceAccessGrantTarget,
  type AutomationEventSourceGrantJoinedRow,
} from "../access/grant-target.js"
import {
  insertWorkspaceResourceRoot,
  listWorkspaceResourceGrantPresentationRows,
  updateWorkspaceResourceRoot,
  updateWorkspaceResourceRootDefault,
} from "../workspace-resources/repo.js"
import { presentGrant } from "../workspace-resources/presenter.js"
import { upsertAccessSubjectOnTrx } from "../access/subject-registry.js"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_KIND,
} from "@synapse/shared"
import type {
  AutomationDeliveryDbRow,
  AutomationDeliveryRow,
  AutomationEventSourceDbRow,
  AutomationIntegrationBindingRow,
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

export type AutomationEventSourceAccessRow = AutomationEventSourceGrantJoinedRow

export type AutomationEventSourceAccessContext = {
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
  // §4.1: the creator kind is no longer persisted on the detail row — owner /
  // created_by are derived from workspaceMemberId / actorId and minted as
  // access_subjects on the workspace_resources root. Kept on the input so existing
  // callers stay source-compatible.
  kind: "workspace_member" | "session" | "system"
  workspaceMemberId?: string
  actorId?: string
  sessionId?: string
}

type AutomationOperatorInput = {
  workspaceMemberId?: string
  actorId?: string
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

// Exported for the D3 runtime-status characterization test: only `active`
// sources are subscribable (deprecated/disabled/archived stop authorizing).
export function ensureEventSourceIsSubscribable(source: AutomationEventSource) {
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
    if (isObjectRecord(value)) {
      const actualValue = actual[key]
      if (!isObjectRecord(actualValue)) {
        return false
      }
      return subsetMatch(value, actualValue)
    }
    return actual[key] === value
  })
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
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

const log = createLogger("automation")

/** Tag an error so the controller maps it to HTTP 400 instead of a 500. */
function badScheduleInput(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 })
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
  // datetime-ok: schedule base defaults to the evaluation time ("now") when no
  // explicit baseTime is supplied — a deliberate default, not a bad-value mask.
  const baseTime = input.baseTime || new Date()
  // startsAt/activeFrom/activeUntil are canonical Timestamps (schema-validated);
  // parse via the single canonical parser (no second hand-rolled `new Date`).
  const startsAt = input.startsAt ? parseInstantString(input.startsAt) : null
  const activeFrom = input.activeFrom
    ? parseInstantString(input.activeFrom)
    : null
  const activeUntil = input.activeUntil
    ? parseInstantString(input.activeUntil)
    : null
  const currentBase =
    activeFrom && activeFrom.getTime() > baseTime.getTime()
      ? activeFrom
      : baseTime

  if (input.scheduleKind === "at") {
    // scheduleExpr is a raw, NON-canonical wire string here (schema only checks
    // length), so parse it through fromExternalRfc3339 — garbage throws and is
    // mapped to a 400 at create / parks the rule at schedule time, never a
    // silent null next-fire.
    const candidate =
      startsAt ||
      (input.scheduleExpr
        ? new Date(fromExternalRfc3339(input.scheduleExpr))
        : null)
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
      ? parseInstantString(input.lastFiredAt)
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
    const inferredScheduleKind = (() => {
      if (input.startsAt) return "at"
      if (input.intervalSeconds) return "interval"
      return "cron"
    })()
    const scheduleKind = input.scheduleKind || inferredScheduleKind
    // Bad cron / IANA timezone / interval input must fail as a clean 400 at the
    // create/update boundary, not as an uncaught 500 (and must never reach the
    // scheduler as a poison row).
    let nextFireAt: Timestamp | null
    try {
      nextFireAt = computeNextFireAt({
        scheduleKind,
        scheduleExpr: input.scheduleExpr,
        scheduleTimezone: input.scheduleTimezone,
        intervalSeconds: input.intervalSeconds,
        startsAt: input.startsAt || null,
        activeFrom: params.policy?.activeFrom || null,
        activeUntil: params.policy?.activeUntil || null,
      })
    } catch (err) {
      throw badScheduleInput(
        err instanceof Error ? err.message : "Invalid schedule configuration"
      )
    }
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
  reason: string
) {
  await pauseAutomationRuleRowsForEventSource({
    eventSourceId,
    reason,
    category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
  })
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

async function loadAutomationEventSourceAccessRows(
  workspaceId: string,
  eventSourceIds: string[],
  includeRevoked = false
) {
  const uniqueIds = Array.from(new Set(eventSourceIds.filter(Boolean)))
  if (uniqueIds.length === 0) {
    return new Map<string, AutomationEventSourceAccessRow[]>()
  }

  // P3: delegate the SELECT to the repo helper, which reads use-permission rows
  // from `workspace_resource_grants` joined to `access_subjects`. It returns
  // normalized AutomationEventSourceGrantJoinedRow rows; this function only has
  // to bucket them by event source.
  const rows = await loadAutomationEventSourceAccessGrantRows({
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

// Exported for characterization tests (plan §5: the matcher is the load-bearing
// item that must逐位 preserve semantics — actor LIVE, workspace LIVE,
// workspace_member / remote_agent INERT). Pure predicate over a decoded grant
// row + runtime context.
export function automationEventSourceGrantApplies(params: {
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

  const target = readAutomationEventSourceAccessGrantTarget(params.row)
  const subject = target.subject
  const scope = target.scope
  switch (subject.kind) {
    case "workspace":
      return (
        ((subject as { workspaceId: string }).workspaceId || null) ===
          ((params.conversation.workspaceId as string | null | undefined) ||
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

export async function listAutomationEventSourceAccessState(
  workspaceId: string,
  eventSourceId: string
): Promise<AutomationEventSourceAccessStateSchemaType> {
  const source = await getAutomationEventSource(workspaceId, eventSourceId)
  if (!source) {
    throw new Error("Automation event source not found")
  }

  // §4.1: automation event-source access is a `use`-permission grant set on the
  // source's workspace_resources root (workspaceResourceId == eventSourceId). Reuse the
  // unified workspace-resources grant presentation path so there is no parallel
  // resource-authz grant shape.
  //
  // The unified presenter returns every grant on the root (use AND manage). The
  // runtime matcher (`automationEventSourceGrantApplies`) is use-only, so a
  // `manage` grant must NOT inflate the reported `isAuthorized` /
  // `effectivePermissions` / `matchingGrantIds`. Filter to `use` grants so this
  // state mirrors what actually gates subscriptions.
  const rows = await listWorkspaceResourceGrantPresentationRows(eventSourceId)
  const grants = rows
    .map(presentGrant)
    .filter((grant) =>
      grant.permissions.includes(WORKSPACE_RESOURCE_GRANT_PERMISSION.USE)
    )
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

async function pauseAutomationRule(params: { ruleId: string; reason: string }) {
  await pauseActiveAutomationRule(params.ruleId, params.reason)
}

async function pauseAutomationRulesMissingEventSourceAccess(
  eventSourceId: string,
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
        reason,
      })
    }
  }
}

export async function revokeAutomationEventSourceAccess(input: {
  workspaceId: string
  eventSourceId: string
  grantId: string
  operator: AutomationOperatorInput
}) {
  const accessRows = await listAutomationEventSourceAccessRows(
    input.workspaceId,
    input.eventSourceId,
    true
  )
  const existing = accessRows.find((row) => row.id === input.grantId)
  if (!existing) {
    throw new Error("Automation event source access grant not found")
  }

  await revokeAutomationEventSourceAccessGrantById({
    grantId: input.grantId,
  })
  await pauseAutomationRulesMissingEventSourceAccess(
    input.eventSourceId,
    `Event source access grant ${input.grantId} was revoked`
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

/**
 * §4.1: resolve the (ownerSubjectId, createdBySubjectId) pair for a new
 * automation event-source root row. owner = the creating member's subject when
 * member-created (else null for actor/session-created sources); creator = the
 * member subject when present, otherwise the actor subject (NOT NULL — there is
 * always a member or actor creator). Subjects are minted on the same trx so the
 * root insert commits atomically with them.
 */
async function resolveAutomationEventSourceRootSubjects(
  trx: DatabaseTransaction,
  creator: AutomationCreatorInput
): Promise<{ ownerSubjectId: string | null; createdBySubjectId: string }> {
  const ownerSubjectId = creator.workspaceMemberId
    ? await upsertAccessSubjectOnTrx(trx, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        workspaceMemberId: creator.workspaceMemberId,
      })
    : null
  let createdBySubjectId = ownerSubjectId
  if (!createdBySubjectId) {
    if (!creator.actorId) {
      throw new Error(
        "automation event source creator must be a workspace member or actor"
      )
    }
    createdBySubjectId = await upsertAccessSubjectOnTrx(trx, {
      kind: SUBJECT_KIND.ACTOR,
      actorId: creator.actorId,
    })
  }
  return { ownerSubjectId, createdBySubjectId }
}

async function createIntegrationAutomationEventSource(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationEventSourceInput
) {
  if (!input.integration) {
    throw new Error(
      "integration event sources require integration configuration"
    )
  }
  const integration = input.integration

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
    const reusedName = input.name?.trim() || template.name
    // §4.1: display_name + status live on the workspace_resources root now.
    // Clear any soft-delete tombstone: the reuse probe can match a previously
    // soft-deleted source (its unique slot is still occupied), so resurrecting
    // it must make it visible to *_live reads again instead of dead-ending.
    await updateWorkspaceResourceRootDefault({
      id: existing.id,
      displayName: reusedName,
      status: nextStatus,
      deletedAt: null,
    })
    await updateAutomationEventSourceRow({
      workspaceId,
      eventSourceId: existing.id,
      values: {
        description: input.description?.trim() || template.description,
        recommendedUsage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payloadSchema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        examplePayload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
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

    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()
  const eventSourceName = input.name?.trim() || template.name
  await withAutomationTransaction(async (trx) => {
    // §4.1: the source's root row carries display_name/status/owner/creator;
    // it MUST be inserted first since automation_event_sources.id FK→
    // workspace_resources.id.
    const { ownerSubjectId, createdBySubjectId } =
      await resolveAutomationEventSourceRootSubjects(trx, creator)
    await insertWorkspaceResourceRoot(trx, {
      id: sourceId,
      workspaceId,
      kind: WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE,
      displayName: eventSourceName,
      status: initialStatus,
      ownerSubjectId,
      createdBySubjectId,
    })
    await insertAutomationEventSourceRow(
      {
        id: sourceId,
        workspaceId: workspaceId,
        providerKind: "integration",
        providerRef: null,
        webhookEndpointId: null,
        integrationBindingId: binding.id,
        sourceKey: normalizedSourceKey,
        description: input.description?.trim() || template.description,
        recommendedUsage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payloadSchema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        examplePayload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
        metadata: JSON.stringify({
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
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
    // §4.1: display_name + status live on the workspace_resources root now.
    // Clear any soft-delete tombstone so resurrecting a previously soft-deleted
    // source makes it visible to *_live reads again (see integration path).
    await updateWorkspaceResourceRootDefault({
      id: existing.id,
      displayName: input.name.trim(),
      status: input.status || "active",
      deletedAt: null,
    })
    await updateAutomationEventSourceRow({
      workspaceId,
      eventSourceId: existing.id,
      values: {
        providerRef: providerBinding.providerRef,
        webhookEndpointId: providerBinding.webhookEndpointId,
        description: input.description.trim(),
        recommendedUsage: input.recommendedUsage?.trim() || "",
        payloadSchema: JSON.stringify(input.payloadSchema || {}),
        examplePayload: JSON.stringify(input.examplePayload || {}),
        metadata: JSON.stringify(input.metadata || existing.metadata || {}),
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
  const initialStatus = input.status || "active"
  const sourceName = input.name.trim()
  const sourceDescription = input.description.trim()

  await withAutomationTransaction(async (trx) => {
    // §4.1: insert the workspace_resources root first (PK FK target for the detail
    // row), carrying display_name/status/owner/creator.
    const { ownerSubjectId, createdBySubjectId } =
      await resolveAutomationEventSourceRootSubjects(trx, creator)
    await insertWorkspaceResourceRoot(trx, {
      id: sourceId,
      workspaceId,
      kind: WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE,
      displayName: sourceName,
      status: initialStatus,
      ownerSubjectId,
      createdBySubjectId,
    })
    await insertAutomationEventSourceRow(
      {
        id: sourceId,
        workspaceId: workspaceId,
        providerKind: input.providerKind,
        providerRef: providerBinding.providerRef,
        webhookEndpointId: providerBinding.webhookEndpointId,
        sourceKey: normalizedSourceKey,
        description: sourceDescription,
        recommendedUsage: input.recommendedUsage?.trim() || "",
        payloadSchema: JSON.stringify(input.payloadSchema || {}),
        examplePayload: JSON.stringify(input.examplePayload || {}),
        metadata: JSON.stringify(input.metadata || {}),
      },
      trx
    )
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

  // display_name + status live on the workspace_resources ROOT (the fold moved
  // them off the automation_event_sources detail table); persist them there.
  await updateWorkspaceResourceRootDefault({
    id: eventSourceId,
    displayName: input.name?.trim() || existing.name,
    status: nextStatus,
  })
  await updateAutomationEventSourceRow({
    workspaceId,
    eventSourceId,
    values: {
      providerRef: providerBinding.providerRef,
      webhookEndpointId: providerBinding.webhookEndpointId,
      integrationBindingId: existing.integration?.bindingId || null,
      sourceKey: existing.sourceKey,
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
      `Event source ${eventSourceId} is ${nextStatus}`
    )
  }

  const updated = await getAutomationEventSource(workspaceId, eventSourceId)
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
    `Event source ${eventSourceId} was archived`
  )
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
  // datetime-ok: liveness evaluation defaults to "now" when no reference time
  // is supplied — a deliberate evaluation-time default, not a bad-value mask.
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
  // datetime-ok: a manually-created occurrence defaults its occurredAt to "now"
  // when the caller supplies none — a deliberate default, not a bad-value mask.
  const occurredAt = params.occurredAt || nowIsoInstant()
  const dedupeKey = params.dedupeKey?.trim() || null

  if (dedupeKey) {
    const existing = await selectAutomationOccurrenceRowByDedupeKey({
      workspaceId: params.workspaceId,
      sourceKind: params.sourceKind,
      eventSourceId: params.eventSourceId,
      dedupeKey,
      executor: params.client,
    })
    if (existing) {
      return presentOccurrence(normalizeAutomationOccurrenceRow(existing))
    }
  }

  const row = await insertAutomationOccurrenceReturningRow({
    id: uuidv4(),
    workspaceId: params.workspaceId,
    sourceKind: params.sourceKind,
    eventSourceId: params.eventSourceId,
    sourceLocator: params.sourceLocator,
    matchKey: params.matchKey,
    dedupeKey,
    sourceSnapshot: params.sourceSnapshot || {},
    payload: params.payload || {},
    occurredAt,
    executor: params.client,
  })

  return presentOccurrence(normalizeAutomationOccurrenceRow(row))
}

async function createAutomationExecution(params: {
  workspaceId: string
  ruleId: string
  occurrenceId: string
  client?: Executor
}) {
  const existing = await selectAutomationExecutionRowByRuleOccurrence({
    ruleId: params.ruleId,
    occurrenceId: params.occurrenceId,
    executor: params.client,
  })
  if (existing) {
    return {
      execution: presentExecution(existing),
      isNew: false,
    }
  }

  const row = await insertAutomationExecutionReturningRow({
    id: uuidv4(),
    workspaceId: params.workspaceId,
    ruleId: params.ruleId,
    occurrenceId: params.occurrenceId,
    executor: params.client,
  })
  return {
    execution: presentExecution(row),
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
      completedAt: (() => {
        if (mergedInput.status === "active") return null
        if (existing.policy.completedAt)
          return parseInstantString(existing.policy.completedAt)
        return null
      })(),
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

  const payload = params.payload || {}
  const sourceSnapshot: Record<string, unknown> = {
    endpointId: sourceRow.endpoint_id,
    endpointName: sourceRow.endpoint_name,
    ...(params.sourceSnapshot || {}),
  }
  const dedupeKey = params.dedupeKey
  const occurredAt = params.occurredAt

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
  // Poison rows (invalid schedule) collected during the batch and parked AFTER
  // it in independent transactions (MF-8).
  const poisonRules: { ruleId: string; lastFiredAt: Date | null }[] = []
  const batchSize = Math.max(1, Math.min(limit, MAX_SCHEDULER_BATCH_SIZE))

  await withAutomationTransaction(async (trx) => {
    await syncAutomationRuleLiveness({ client: trx })

    const dueRows = await lockDueAutomationScheduleRows(trx, batchSize)

    for (const row of dueRows) {
      const rowDates = presentDueScheduleRowDates(row)

      // Compute the next fire time FIRST and isolate per-row failures. A poison
      // row (invalid cron / IANA tz / interval that slipped past create-time
      // validation via a migration or direct write) must NOT roll back the
      // whole batch and then re-fire every cycle (the M3 scheduler deadlock).
      // Park it: clear next_fire_at so it leaves the due set, log loudly, and
      // continue with the rest of the batch.
      let nextFireAt: Timestamp | null
      try {
        nextFireAt = computeNextFireAt({
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
      } catch (err) {
        // Poison row (invalid cron/tz/interval that slipped past create-time
        // validation). Record it for parking in an INDEPENDENT transaction
        // AFTER this batch (MF-8): parking inside this shared batch txn would be
        // rolled back if a LATER row in the batch fails, re-arming the poison
        // loop. Skip it here so the rest of the batch still commits.
        log.error(
          { err, ruleId: row.ruleId, workspaceId: row.workspaceId },
          "automation.scheduler.compute_next_fire_failed_parking_rule"
        )
        poisonRules.push({ ruleId: row.ruleId, lastFiredAt: row.nextFireAt })
        continue
      }

      const occurrence = await createAutomationOccurrence({
        workspaceId: row.workspaceId,
        sourceKind: "clock",
        sourceLocator: row.scheduleTimezone || "UTC",
        // Canonical, timezone-independent idempotency key (M8): the raw Date's
        // toString() varies with process TZ/locale, so two API replicas could
        // derive different keys for the same fire and double-create.
        dedupeKey: `${row.ruleId}:${rowDates.nextFireAt}`,
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

      await updateAutomationTriggerSchedule(trx, row.ruleId, {
        lastFiredAt: row.nextFireAt,
        nextFireAt: nextFireAt ? parseInstantString(nextFireAt) : null,
      })
      if (isNew) {
        scheduledExecutions.push(execution.id)
      }
    }
  })

  // Park poison rows out-of-band (MF-8): clear next_fire_at so they leave the
  // due set even if the batch above partially failed and rolled back. Each park
  // is its own transaction so one failure can't block the others or re-arm the
  // poison loop.
  for (const { ruleId, lastFiredAt } of poisonRules) {
    try {
      await withAutomationTransaction((trx) =>
        updateAutomationTriggerSchedule(trx, ruleId, {
          lastFiredAt,
          nextFireAt: null,
        })
      )
      // Record an error so a parked rule is observable (not a silent zombie
      // that is still active but never fires). nextFireAt stays null above.
      await updateAutomationRuleError(ruleId, "schedule compute failed; parked")
    } catch (err) {
      log.error({ err, ruleId }, "automation.scheduler.park_poison_rule_failed")
    }
  }

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
      completeNow:
        rule.trigger.triggerKind === "schedule" && !rule.trigger.nextFireAt,
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
