import crypto from "node:crypto"
import cronParser from "cron-parser"
import { v4 as uuidv4 } from "uuid"
import type {
  AccessGrant,
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
  AutomationWebhookEndpoint,
  AutomationWebhookEndpointCreateResult,
  CanonicalContentBlock,
} from "@synapse/shared"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  extractText,
  maskAllowsConversationType,
  normalizeCanonicalContentBlocks,
  nowISO,
  resolveAutomationOccurrenceDisplay,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared"
import {
  mergeAutomationRuleUpdatePayload,
  validateAutomationRuleCreatePayload,
} from "@synapse/shared/automation"
import { decrypt, encrypt } from "../../infrastructure/crypto/index.js"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import {
  createConversationEvent,
  getConversation,
  getConversationParticipant,
  listConversationParticipants,
} from "../chat/service.js"
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
  accessBindingHasTarget,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  readAccessBindingTarget,
  type AccessBindingRow,
} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import {
  insertAccessBindingReturningRowOn,
  loadAccessBindingRowsForResources,
  revokeGrant,
  updateGrantConversationTypeMaskOverride,
} from "../access/binding-storage.js"

type AutomationRuleRow = {
  id: string
  workspace_id: string
  conversation_id: string
  category: AutomationCategory
  status: AutomationStatus
  name: string
  description: string
  created_by_participant_id: string
  created_by_session_id: string | null
  last_triggered_at: string | null
  last_error_at: string | null
  last_error_message: string | null
  metadata: Record<string, unknown> | string | null
  created_at: string
  updated_at: string
}

type AutomationTriggerRow = {
  rule_id: string
  trigger_kind: AutomationTriggerKind
  source_kind: AutomationSourceKind
  event_source_id: string | null
  event_source_key?: string | null
  event_source_name?: string | null
  event_provider_kind?: AutomationEventProviderKind | null
  event_provider_ref?: string | null
  event_webhook_endpoint_id?: string | null
  event_integration_binding_id?: string | null
  event_integration_installation_id?: string | null
  event_integration_provider?: AutomationIntegrationProvider | null
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null
  event_integration_target_kind?: AutomationIntegrationTargetKind | null
  event_integration_target_id?: string | null
  event_integration_target_label?: string | null
  event_integration_webhook_endpoint_id?: string | null
  event_external_subscription_id?: string | null
  event_source_status?: AutomationEventSourceStatus | null
  source_locator: string | null
  match_key: string | null
  matcher: Record<string, unknown> | string | null
  schedule_kind: string | null
  schedule_expr: string | null
  schedule_timezone: string | null
  interval_seconds: number | null
  starts_at: string | null
  next_fire_at: string | null
  last_fired_at: string | null
  metadata: Record<string, unknown> | string | null
}

type AutomationPolicyRow = {
  rule_id: string
  active_from: string | null
  active_until: string | null
  max_trigger_count: number | null
  trigger_count: number
  completion_status: AutomationCompletionStatus
  completed_at: string | null
  metadata: Record<string, unknown> | string | null
}

type AutomationDeliveryRow = {
  rule_id: string
  message_text: string
  wake_reason_text: string | null
  message_blocks: unknown
  target_policy: AutomationTargetPolicy
  metadata: Record<string, unknown> | string | null
}

type AutomationEventSourceRow = {
  id: string
  workspace_id: string
  provider_kind: AutomationEventProviderKind
  provider_ref: string | null
  webhook_endpoint_id: string | null
  integration_binding_id: string | null
  integration_installation_id?: string | null
  integration_provider?: AutomationIntegrationProvider | null
  integration_ingress_kind?: AutomationIntegrationIngressKind | null
  integration_target_kind?: AutomationIntegrationTargetKind | null
  integration_target_id?: string | null
  integration_target_label?: string | null
  integration_webhook_endpoint_id?: string | null
  integration_external_subscription_id?: string | null
  source_key: string
  name: string
  description: string
  recommended_usage: string
  payload_schema: Record<string, unknown> | string | null
  example_payload: Record<string, unknown> | string | null
  status: AutomationEventSourceStatus
  created_by_kind: AutomationCreatorKind
  created_by_workspace_member_id: string | null
  created_by_actor_id: string | null
  created_by_session_id: string | null
  last_triggered_at: string | null
  metadata: Record<string, unknown> | string | null
  created_at: string
  updated_at: string
}

type AutomationOccurrenceRow = {
  id: string
  workspace_id: string
  source_kind: AutomationSourceKind
  event_source_id: string | null
  event_source_key?: string | null
  event_source_name?: string | null
  event_provider_ref?: string | null
  event_webhook_endpoint_id?: string | null
  event_integration_binding_id?: string | null
  event_integration_installation_id?: string | null
  event_integration_provider?: AutomationIntegrationProvider | null
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null
  event_integration_target_kind?: AutomationIntegrationTargetKind | null
  event_integration_target_id?: string | null
  event_integration_target_label?: string | null
  event_integration_webhook_endpoint_id?: string | null
  event_external_subscription_id?: string | null
  source_locator: string | null
  match_key: string | null
  dedupe_key: string | null
  source_snapshot: Record<string, unknown> | string | null
  payload: Record<string, unknown> | string | null
  occurred_at: string
  created_at: string
}

type AutomationExecutionRow = {
  id: string
  workspace_id: string
  rule_id: string
  execution_rule_name?: string | null
  occurrence_id: string
  occurrence_occurred_at?: string | null
  occurrence_source_kind?: AutomationSourceKind | null
  occurrence_event_source_name?: string | null
  occurrence_display_title?: string | null
  occurrence_display_summary?: string | null
  occurrence_display_description?: string | null
  status: AutomationExecutionStatus
  attempt_count: number
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

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
  created_at: string
  updated_at: string
}

type TargetParticipantRow = {
  rule_id: string
  target_participant_id: string
}

type AutomationEventSourceAccessRow = AccessBindingRow

type AutomationEventSourceAccessContext = {
  conversationId: string
  actorId?: string | null
}

type AutomationWebhookEndpointRow = {
  id: string
  workspace_id: string
  name: string
  status: AutomationWebhookEndpoint["status"]
  path_token: string
  secret_ciphertext?: string
  secret_hint: string
  metadata: Record<string, unknown> | string | null
  created_by_workspace_member_id: string | null
  last_received_at: string | null
  created_at: string
  updated_at: string
}

type AutomationIntegrationBindingRow = {
  id: string
  workspace_id: string
  installation_id: string
  provider: AutomationIntegrationProvider
  ingress_kind: AutomationIntegrationIngressKind
  target_kind: AutomationIntegrationTargetKind
  target_id: string
  target_label: string
  webhook_endpoint_id: string | null
  external_subscription_id: string | null
  metadata: Record<string, unknown> | string | null
  created_at: string
  updated_at: string
}

type AutomationValidationError = Error & {
  issues: { path: string; message: string }[]
  statusCode: 400
}

type SqlRunner = <T = any>(
  text: string,
  params?: unknown[]
) => Promise<{ rows: T[]; rowCount?: number | null }>

type QueryRunner = {
  run: SqlRunner
}

type QueryClient = { query: (text: string, params?: any[]) => Promise<any> }
type QueryRunnerLike = QueryRunner | QueryClient

function resolveQueryRunner(client?: QueryRunnerLike): QueryRunner {
  if (client && "run" in client) {
    return client
  }
  return client
    ? {
        run: <T = any>(text: string, params?: unknown[]) =>
          executeSqlOn<T>(client, text, params),
      }
    : {
        run: executeSql,
      }
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
  startsAt?: string
}

export interface AutomationPolicyInput {
  activeFrom?: string
  activeUntil?: string
  maxTriggerCount?: number
  completionStatus?: AutomationCompletionStatus
}

export interface AutomationDeliveryInput {
  message?: string
  wakeReason?: string
  messageBlocks?: CanonicalContentBlock[]
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
  occurredAt?: string
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeContentBlocks(value: unknown): CanonicalContentBlock[] {
  if (!Array.isArray(value)) return []
  return normalizeCanonicalContentBlocks(value as any[])
}

function mapEventSourceIntegration(row: {
  integration_binding_id?: string | null
  integration_webhook_endpoint_id?: string | null
  integration_installation_id?: string | null
  integration_provider?: AutomationIntegrationProvider | null
  integration_ingress_kind?: AutomationIntegrationIngressKind | null
  integration_target_kind?: AutomationIntegrationTargetKind | null
  integration_target_id?: string | null
  integration_target_label?: string | null
  integration_external_subscription_id?: string | null
}): AutomationEventSourceIntegration | undefined {
  if (
    !row.integration_installation_id ||
    !row.integration_provider ||
    !row.integration_ingress_kind ||
    !row.integration_target_kind ||
    !row.integration_target_id ||
    !row.integration_target_label
  ) {
    return undefined
  }

  return {
    bindingId: row.integration_binding_id || undefined,
    installationId: row.integration_installation_id,
    provider: row.integration_provider,
    ingressKind: row.integration_ingress_kind,
    targetKind: row.integration_target_kind,
    targetId: row.integration_target_id,
    targetLabel: row.integration_target_label,
    endpointId: row.integration_webhook_endpoint_id || undefined,
    externalSubscriptionId:
      row.integration_external_subscription_id || undefined,
  }
}

function mapRuleRow(
  row: AutomationRuleRow,
  trigger: AutomationTrigger,
  policy: AutomationPolicy,
  delivery: AutomationDelivery
): AutomationRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    authorityWorkspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    category: row.category,
    status: row.status,
    name: row.name,
    description: row.description,
    createdByParticipantId: row.created_by_participant_id,
    createdBySessionId: row.created_by_session_id || undefined,
    trigger,
    policy,
    delivery,
    lastTriggeredAt: row.last_triggered_at || undefined,
    lastErrorAt: row.last_error_at || undefined,
    lastErrorMessage: row.last_error_message || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTriggerRow(row: AutomationTriggerRow): AutomationTrigger {
  return {
    ruleId: row.rule_id,
    triggerKind: row.trigger_kind,
    sourceKind: row.source_kind,
    eventSourceId: row.event_source_id || undefined,
    eventSourceKey:
      (row as AutomationTriggerRow & { event_source_key?: string | null })
        .event_source_key || undefined,
    eventSourceName:
      (row as AutomationTriggerRow & { event_source_name?: string | null })
        .event_source_name || undefined,
    eventProviderKind:
      (
        row as AutomationTriggerRow & {
          event_provider_kind?: AutomationEventProviderKind | null
        }
      ).event_provider_kind || undefined,
    eventProviderRef:
      (row as AutomationTriggerRow & { event_provider_ref?: string | null })
        .event_provider_ref || undefined,
    eventSourceIntegration: mapEventSourceIntegration({
      integration_binding_id: row.event_integration_binding_id,
      integration_webhook_endpoint_id:
        row.event_integration_webhook_endpoint_id,
      integration_installation_id: row.event_integration_installation_id,
      integration_provider: row.event_integration_provider,
      integration_ingress_kind: row.event_integration_ingress_kind,
      integration_target_kind: row.event_integration_target_kind,
      integration_target_id: row.event_integration_target_id,
      integration_target_label: row.event_integration_target_label,
      integration_external_subscription_id: row.event_external_subscription_id,
    }),
    eventSourceStatus:
      (
        row as AutomationTriggerRow & {
          event_source_status?: AutomationEventSourceStatus | null
        }
      ).event_source_status || undefined,
    sourceLocator: row.source_locator || undefined,
    matchKey: row.match_key || undefined,
    matcher: parseJsonObject(row.matcher),
    scheduleKind:
      (row.schedule_kind as AutomationTrigger["scheduleKind"]) || undefined,
    scheduleExpr: row.schedule_expr || undefined,
    scheduleTimezone: row.schedule_timezone || undefined,
    intervalSeconds: row.interval_seconds || undefined,
    startsAt: row.starts_at || undefined,
    nextFireAt: row.next_fire_at || undefined,
    lastFiredAt: row.last_fired_at || undefined,
    metadata: parseJsonObject(row.metadata),
  }
}

function mapPolicyRow(row: AutomationPolicyRow): AutomationPolicy {
  return {
    ruleId: row.rule_id,
    activeFrom: row.active_from || undefined,
    activeUntil: row.active_until || undefined,
    maxTriggerCount: row.max_trigger_count || undefined,
    triggerCount: row.trigger_count,
    completionStatus: row.completion_status,
    completedAt: row.completed_at || undefined,
    metadata: parseJsonObject(row.metadata),
  }
}

function mapDeliveryRow(
  row: AutomationDeliveryRow,
  targetParticipantIds: string[]
): AutomationDelivery {
  return {
    ruleId: row.rule_id,
    messageText: row.message_text || "",
    wakeReasonText: row.wake_reason_text || undefined,
    messageBlocks: normalizeContentBlocks(row.message_blocks),
    targetPolicy: row.target_policy,
    targetParticipantIds,
    metadata: parseJsonObject(row.metadata),
  }
}

function mapEventSourceRow(
  row: AutomationEventSourceRow
): AutomationEventSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    providerKind: row.provider_kind,
    providerRef: row.provider_ref || undefined,
    integration: mapEventSourceIntegration(row),
    sourceKey: row.source_key,
    name: row.name,
    description: row.description,
    recommendedUsage: row.recommended_usage || undefined,
    payloadSchema: parseJsonObject(row.payload_schema),
    examplePayload: parseJsonObject(row.example_payload),
    status: row.status,
    createdByKind: row.created_by_kind,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    createdByActorId: row.created_by_actor_id || undefined,
    createdBySessionId: row.created_by_session_id || undefined,
    lastTriggeredAt: row.last_triggered_at || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function defaultOccurrenceTitle(
  occurrence: Pick<
    AutomationOccurrence,
    "eventSourceName" | "matchKey" | "sourceLocator" | "sourceKind"
  >
) {
  return (
    occurrence.eventSourceName ||
    occurrence.matchKey ||
    occurrence.sourceLocator ||
    occurrence.sourceKind
  )
}

function defaultOccurrenceSummary(payload: Record<string, unknown>) {
  const payloadKeys = Object.keys(payload || {})
  if (payloadKeys.length === 0) {
    return "No payload fields"
  }
  return payloadKeys.slice(0, 6).join(", ")
}

function decorateOccurrenceDisplay(
  occurrence: AutomationOccurrence,
  options?: { eventProviderRef?: string }
): AutomationOccurrence {
  const display = resolveAutomationOccurrenceDisplay({
    sourceKind: occurrence.sourceKind,
    eventDefinitionKey: occurrence.eventSourceKey,
    sourceName: occurrence.eventSourceName,
    providerRef: options?.eventProviderRef,
    sourceSnapshot: occurrence.sourceSnapshot,
    payload: occurrence.payload,
    occurredAt: occurrence.occurredAt,
  })

  return {
    ...occurrence,
    displayTitle: display?.title || defaultOccurrenceTitle(occurrence),
    displaySummary:
      display?.summary || defaultOccurrenceSummary(occurrence.payload),
    displayDescription: display?.description || undefined,
  }
}

function mapOccurrenceRow(row: AutomationOccurrenceRow): AutomationOccurrence {
  return decorateOccurrenceDisplay(
    {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceKind: row.source_kind,
      eventSourceId: row.event_source_id || undefined,
      eventSourceKey:
        (row as AutomationOccurrenceRow & { event_source_key?: string | null })
          .event_source_key || undefined,
      eventSourceName:
        (row as AutomationOccurrenceRow & { event_source_name?: string | null })
          .event_source_name || undefined,
      eventSourceIntegration: mapEventSourceIntegration({
        integration_binding_id: row.event_integration_binding_id,
        integration_webhook_endpoint_id:
          row.event_integration_webhook_endpoint_id,
        integration_installation_id: row.event_integration_installation_id,
        integration_provider: row.event_integration_provider,
        integration_ingress_kind: row.event_integration_ingress_kind,
        integration_target_kind: row.event_integration_target_kind,
        integration_target_id: row.event_integration_target_id,
        integration_target_label: row.event_integration_target_label,
        integration_external_subscription_id:
          row.event_external_subscription_id,
      }),
      sourceLocator: row.source_locator || undefined,
      matchKey: row.match_key || undefined,
      dedupeKey: row.dedupe_key || undefined,
      sourceSnapshot: parseJsonObject(row.source_snapshot),
      payload: parseJsonObject(row.payload),
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
    },
    {
      eventProviderRef:
        (
          row as AutomationOccurrenceRow & {
            event_provider_ref?: string | null
          }
        ).event_provider_ref || undefined,
    }
  )
}

function mapExecutionRow(row: AutomationExecutionRow): AutomationExecution {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    occurrenceId: row.occurrence_id,
    occurrenceOccurredAt: row.occurrence_occurred_at || undefined,
    occurrenceSourceKind: row.occurrence_source_kind || undefined,
    occurrenceEventSourceName: row.occurrence_event_source_name || undefined,
    occurrenceTitle: row.occurrence_display_title || undefined,
    occurrenceSummary: row.occurrence_display_summary || undefined,
    occurrenceDescription: row.occurrence_display_description || undefined,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapWebhookEndpointRow(
  row: AutomationWebhookEndpointRow
): AutomationWebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    pathToken: row.path_token,
    secretHint: row.secret_hint,
    metadata: parseJsonObject(row.metadata),
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    lastReceivedAt: row.last_received_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function automationEventSourceJoinClause(
  eventSourceAlias = "aes",
  bindingAlias = "aib"
) {
  return `LEFT JOIN automation_integration_bindings ${bindingAlias} ON ${bindingAlias}.id = ${eventSourceAlias}.integration_binding_id`
}

function automationEventSourceSelectClause(
  eventSourceAlias = "aes",
  bindingAlias = "aib"
) {
  return `${eventSourceAlias}.*,
          ${bindingAlias}.installation_id AS integration_installation_id,
          ${bindingAlias}.provider AS integration_provider,
          ${bindingAlias}.ingress_kind AS integration_ingress_kind,
          ${bindingAlias}.target_kind AS integration_target_kind,
          ${bindingAlias}.target_id AS integration_target_id,
          ${bindingAlias}.target_label AS integration_target_label,
          ${bindingAlias}.webhook_endpoint_id AS integration_webhook_endpoint_id,
          ${bindingAlias}.external_subscription_id AS integration_external_subscription_id`
}

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
    active_from: input?.activeFrom || null,
    active_until: input?.activeUntil || null,
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
  startsAt?: string | null
  activeFrom?: string | null
  activeUntil?: string | null
  baseTime?: Date
  lastFiredAt?: string | null
}): string | null {
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
    return candidate.toISOString()
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
    return next.toISOString()
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
  return next.toISOString()
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
      starts_at: input.startsAt || null,
      next_fire_at: nextFireAt,
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

async function loadAutomationTargets(
  tableName: "automation_delivery_targets",
  ruleIds: string[]
) {
  if (ruleIds.length === 0) {
    return new Map<string, string[]>()
  }
  const result = await executeSql<TargetParticipantRow>(
    `SELECT rule_id, target_participant_id
     FROM ${tableName}
     WHERE rule_id = ANY($1)
     ORDER BY created_at ASC`,
    [ruleIds]
  )
  const mapped = new Map<string, string[]>()
  for (const row of result.rows) {
    const existing = mapped.get(row.rule_id) || []
    existing.push(row.target_participant_id)
    mapped.set(row.rule_id, existing)
  }
  return mapped
}

async function loadAutomationRulesByIds(
  workspaceId: string,
  ruleIds: string[]
) {
  if (ruleIds.length === 0) return [] as AutomationRule[]
  const [
    rulesResult,
    triggersResult,
    policiesResult,
    deliveriesResult,
    targetsByRule,
  ] = await Promise.all([
    executeSql<AutomationRuleRow>(
      `SELECT *
       FROM automation_rules
       WHERE workspace_id = $1
         AND id = ANY($2)
       ORDER BY created_at DESC`,
      [workspaceId, ruleIds]
    ),
    executeSql<AutomationTriggerRow>(
      `SELECT at.*,
              aes.source_key AS event_source_key,
              aes.name AS event_source_name,
              aes.provider_kind AS event_provider_kind,
              aes.provider_ref AS event_provider_ref,
              aes.webhook_endpoint_id AS event_webhook_endpoint_id,
              aes.integration_binding_id AS event_integration_binding_id,
              aib.installation_id AS event_integration_installation_id,
              aib.provider AS event_integration_provider,
              aib.ingress_kind AS event_integration_ingress_kind,
              aib.target_kind AS event_integration_target_kind,
              aib.target_id AS event_integration_target_id,
              aib.target_label AS event_integration_target_label,
              aib.webhook_endpoint_id AS event_integration_webhook_endpoint_id,
              aib.external_subscription_id AS event_external_subscription_id,
              aes.status AS event_source_status
       FROM automation_triggers
       at
       LEFT JOIN automation_event_sources aes ON aes.id = at.event_source_id
       LEFT JOIN automation_integration_bindings aib ON aib.id = aes.integration_binding_id
       WHERE at.rule_id = ANY($1)`,
      [ruleIds]
    ),
    executeSql<AutomationPolicyRow>(
      `SELECT *
       FROM automation_policies
       WHERE rule_id = ANY($1)`,
      [ruleIds]
    ),
    executeSql<AutomationDeliveryRow>(
      `SELECT *
       FROM automation_deliveries
       WHERE rule_id = ANY($1)`,
      [ruleIds]
    ),
    loadAutomationTargets("automation_delivery_targets", ruleIds),
  ])

  const triggerByRule = new Map(
    triggersResult.rows.map((row) => [row.rule_id, mapTriggerRow(row)])
  )
  const policyByRule = new Map(
    policiesResult.rows.map((row) => [row.rule_id, mapPolicyRow(row)])
  )
  const deliveryByRule = new Map(
    deliveriesResult.rows.map((row) => [
      row.rule_id,
      mapDeliveryRow(row, targetsByRule.get(row.rule_id) || []),
    ])
  )

  return rulesResult.rows
    .map((row) => {
      const trigger = triggerByRule.get(row.id)
      const policy = policyByRule.get(row.id)
      const delivery = deliveryByRule.get(row.id)
      if (!trigger || !policy || !delivery) return null
      return mapRuleRow(row, trigger, policy, delivery)
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
    const endpointResult = await executeSql<{ id: string }>(
      `SELECT id
       FROM automation_webhook_endpoints
       WHERE id = $1
         AND workspace_id = $2
         AND status = 'active'
       LIMIT 1`,
      [normalizedRef, workspaceId]
    )
    if (!endpointResult.rows[0]) {
      throw new Error(`Webhook endpoint ${normalizedRef} not found or inactive`)
    }
    return {
      providerRef: normalizedRef,
      webhookEndpointId: normalizedRef,
    }
  }

  if (providerKind === "relay") {
    const normalizedRef = providerRef?.trim()
    if (!normalizedRef) {
      throw new Error("relay event sources require providerRef")
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
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 96)
  return slug || "source"
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
    const existing = await executeSql<{ id: string }>(
      `SELECT id
       FROM automation_event_sources
       WHERE workspace_id = $1
         AND provider_kind = $2
         AND COALESCE(provider_ref, '') = COALESCE($3, '')
         AND source_key = $4
       LIMIT 1`,
      [
        params.workspaceId,
        params.providerKind,
        params.providerRef || null,
        candidate,
      ]
    )
    if (!existing.rows[0]) {
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
  const affected = await executeSql<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $2,
         updated_at = NOW()
     FROM automation_triggers at
     WHERE at.rule_id = ar.id
       AND at.event_source_id = $1
       AND ar.category = 'event_subscription'
       AND ar.status = 'active'
     RETURNING ar.id, ar.workspace_id`,
    [eventSourceId, reason]
  )

  for (const row of affected.rows) {
    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.pause', 'automation_rule', $4, $5)`,
      [
        row.workspace_id,
        auditUserId,
        operator.actorId || null,
        row.id,
        JSON.stringify({
          reason,
          eventSourceId,
        }),
      ]
    )
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
    typeof params.conversation.boundary === "string"
      ? params.conversation.boundary
      : null
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
  // helper returns normalized AccessBindingRow rows; this function only has to
  // bucket them by event source.
  const rows = await loadAccessBindingRowsForResources(db, {
    resourceType: "automation_event_source",
    resourceIds: uniqueIds,
    workspaceId,
    includeRevoked,
  })

  const rowsBySource = new Map<string, AutomationEventSourceAccessRow[]>()
  for (const row of rows) {
    const existing = rowsBySource.get(row.resource_id) || []
    existing.push(row)
    rowsBySource.set(row.resource_id, existing)
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
      conversationTypeMaskOverride: params.row.conversation_type_mask_override,
    })
  ) {
    return false
  }

  const target = readAccessBindingTarget(params.row)
  switch (target.targetType) {
    case "workspace":
      return (
        (params.row.subject_workspace_id || null) ===
          ((params.conversation.internal_workspace_id as
            | string
            | null
            | undefined) || null) ||
        (params.row.subject_workspace_id || null) ===
          (params.row.workspace_id || null)
      )
    case "conversation":
      return target.subjectConversationId === params.context.conversationId
    case "actor":
      return (
        Boolean(params.context.actorId) &&
        target.subjectActorId === (params.context.actorId || null)
      )
    case "actor_in_conversation":
      return (
        Boolean(params.context.actorId) &&
        target.subjectActorId === (params.context.actorId || null) &&
        target.subjectConversationId === params.context.conversationId
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
) {
  return mapAccessBindingToGrant(
    row,
    "Automation event sources require explicit use access.",
    {
      effectiveConversationTypeMask:
        resolveAutomationEventSourceConversationMask(
          row.conversation_type_mask_override
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
  if (
    target.type !== "conversation" &&
    target.type !== "actor_in_conversation"
  ) {
    return null
  }
  if (!target.conversationId) {
    throw new Error("conversationId is required for the selected access target")
  }
  const conversation = await getConversation(target.conversationId)
  if (!conversation) {
    throw new Error(`Conversation ${target.conversationId} not found`)
  }
  return conversation
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
    target: input.accessTarget || { type: "workspace" },
  })
  const targetConversation = await getBindingTargetConversation(
    input.accessTarget || { type: "workspace" }
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
    accessBindingHasTarget(row, target)
  )
  if (existing) {
    return mapAutomationEventSourceAccessGrant(existing)
  }

  const inserted = await transaction(async (client) => {
    const binding = await insertAccessBindingReturningRowOn(client, {
      workspaceId: input.workspaceId,
      resourceType: "automation_event_source",
      resourceId: input.eventSourceId,
      target,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || "Automation event source access grant",
    })

    return {
      binding: {
        ...binding,
        resource_id: binding.automation_event_source_id!,
      } as AccessBindingRow,
    }
  })

  return mapAutomationEventSourceAccessGrant(
    normalizeAccessBindingRow(inserted.binding)
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

    await updateGrantConversationTypeMaskOverride(db, {
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
  const updated = await executeSql<{ id: string }>(
    `UPDATE automation_rules
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $2,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'active'
     RETURNING id`,
    [params.ruleId, params.reason]
  )
  if (!updated.rows[0]) {
    return
  }

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_rule.pause', 'automation_rule', $4, $5)`,
    [
      params.workspaceId,
      auditUserId,
      params.operator.actorId || null,
      params.ruleId,
      JSON.stringify({ reason: params.reason }),
    ]
  )
}

async function pauseAutomationRulesMissingEventSourceAccess(
  eventSourceId: string,
  operator: AutomationOperatorInput,
  reason: string
) {
  const result = await executeSql<AutomationRuleRow>(
    `SELECT ar.*
     FROM automation_rules ar
     JOIN automation_triggers at
       ON at.rule_id = ar.id
     WHERE at.event_source_id = $1
       AND ar.category = 'event_subscription'
       AND ar.status = 'active'`,
    [eventSourceId]
  )

  for (const row of result.rows) {
    const conversation = await getConversation(row.conversation_id)
    const creatorParticipant = await getConversationParticipant({
      conversationId: row.conversation_id,
      participantId: row.created_by_participant_id,
    })
    const creatorActorId =
      creatorParticipant?.actor_id && creatorParticipant.state === "active"
        ? (creatorParticipant.actor_id as string)
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

  await revokeGrant(db, { bindingId: input.bindingId })
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
  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")}
     FROM automation_event_sources aes
     ${automationEventSourceJoinClause("aes", "aib")}
     WHERE aes.workspace_id = $1
       AND aes.id = $2
     LIMIT 1`,
    [workspaceId, eventSourceId]
  )
  return result.rows[0] ? mapEventSourceRow(result.rows[0]) : null
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
  const values: unknown[] = [workspaceId]
  let where = "aes.workspace_id = $1"

  if (filters?.status) {
    values.push(filters.status)
    where += ` AND aes.status = $${values.length}`
  }
  if (filters?.providerKind) {
    values.push(filters.providerKind)
    where += ` AND aes.provider_kind = $${values.length}`
  }
  if (filters?.providerRef !== undefined) {
    values.push(filters.providerRef)
    where += ` AND COALESCE(aes.provider_ref, '') = COALESCE($${values.length}, '')`
  }
  if (filters?.sourceKey) {
    values.push(filters.sourceKey)
    where += ` AND aes.source_key = $${values.length}`
  }

  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")}
     FROM automation_event_sources aes
     ${automationEventSourceJoinClause("aes", "aib")}
     WHERE ${where}
     ORDER BY aes.created_at DESC`,
    values
  )
  const sources = result.rows.map(mapEventSourceRow)
  if (!accessContext) {
    return sources
  }

  const conversation = await getConversation(accessContext.conversationId)
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
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `SELECT *
     FROM automation_webhook_endpoints
     WHERE id = $1
     LIMIT 1`,
    [endpointId]
  )
  const row = result.rows[0]
  if (!row?.secret_ciphertext) {
    throw new Error(`Webhook endpoint ${endpointId} secret was not found`)
  }
  return {
    endpoint: mapWebhookEndpointRow(row),
    secret: decrypt(row.secret_ciphertext),
  }
}

async function updateWebhookEndpointStatus(
  endpointId: string,
  status: AutomationWebhookEndpoint["status"]
) {
  await executeSql(
    `UPDATE automation_webhook_endpoints
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [endpointId, status]
  )
}

async function getAutomationIntegrationBinding(bindingId: string) {
  const result = await executeSql<AutomationIntegrationBindingRow>(
    `SELECT *
     FROM automation_integration_bindings
     WHERE id = $1
     LIMIT 1`,
    [bindingId]
  )
  return result.rows[0] || null
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
  const existingResult = await executeSql<AutomationIntegrationBindingRow>(
    `SELECT *
     FROM automation_integration_bindings
     WHERE workspace_id = $1
       AND installation_id = $2
       AND provider = $3
       AND ingress_kind = $4
       AND target_kind = $5
       AND target_id = $6
     LIMIT 1`,
    [
      params.workspaceId,
      params.installation.id,
      params.integration.provider,
      ingressKind,
      params.integration.targetKind,
      targetId,
    ]
  )
  const existing = existingResult.rows[0]
  if (existing) {
    if (existing.target_label !== targetLabel) {
      await executeSql(
        `UPDATE automation_integration_bindings
         SET target_label = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, targetLabel]
      )
      return getAutomationIntegrationBinding(existing.id)
    }
    return existing
  }

  const bindingId = uuidv4()
  const endpointId = ingressKind === "webhook" ? uuidv4() : null
  const pathToken =
    ingressKind === "webhook" ? crypto.randomBytes(18).toString("hex") : null
  const secret = ingressKind === "webhook" ? generateSecret() : null

  await transaction(async (client) => {
    if (endpointId && pathToken && secret) {
      await executeSqlOn(
        client,
        `INSERT INTO automation_webhook_endpoints
           (id, workspace_id, name, status, path_token, secret_ciphertext, secret_hint, metadata, created_by_workspace_member_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'disabled', $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          endpointId,
          params.workspaceId,
          integrationEndpointName(params.integration.provider, targetLabel),
          pathToken,
          encrypt(secret),
          secretHint(secret),
          JSON.stringify({
            managedBy: "integration_binding",
            integrationProvider: params.integration.provider,
            integrationTargetKind: params.integration.targetKind,
            integrationTargetId: targetId,
            integrationTargetLabel: targetLabel,
          }),
          params.creator.workspaceMemberId || null,
        ]
      )
    }

    await executeSqlOn(
      client,
      `INSERT INTO automation_integration_bindings
         (id, workspace_id, installation_id, provider, ingress_kind, target_kind, target_id, target_label,
          webhook_endpoint_id, external_subscription_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NOW(), NOW())`,
      [
        bindingId,
        params.workspaceId,
        params.installation.id,
        params.integration.provider,
        ingressKind,
        params.integration.targetKind,
        targetId,
        targetLabel,
        endpointId,
        JSON.stringify({
          integrationProvider: params.integration.provider,
          integrationTargetKind: params.integration.targetKind,
        }),
      ]
    )
  })

  return getAutomationIntegrationBinding(bindingId)
}

async function listActiveIntegrationSourceKeysForBinding(bindingId: string) {
  const result = await executeSql<{ source_key: string }>(
    `SELECT source_key
     FROM automation_event_sources
     WHERE provider_kind = 'integration'
       AND integration_binding_id = $1
       AND status IN ('active', 'deprecated')
     ORDER BY source_key ASC`,
    [bindingId]
  )
  return Array.from(
    new Set(result.rows.map((row) => row.source_key).filter(Boolean))
  )
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
    await executeSql(
      `UPDATE automation_integration_bindings
       SET external_subscription_id = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [binding.id]
    )
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

  await executeSql(
    `UPDATE automation_integration_bindings
     SET external_subscription_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [binding.id, externalSubscriptionId]
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

  const existingResult = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = 'integration'
       AND integration_binding_id = $2
       AND source_key = $3
     LIMIT 1`,
    [workspaceId, binding.id, normalizedSourceKey]
  )
  const existing = existingResult.rows[0]

  if (existing) {
    const nextStatus = input.status || "active"
    await executeSql(
      `UPDATE automation_event_sources
       SET name = $3,
           description = $4,
           recommended_usage = $5,
           payload_schema = $6,
           example_payload = $7,
           status = $8,
           metadata = $9,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2`,
      [
        workspaceId,
        existing.id,
        input.name?.trim() || template.name,
        input.description?.trim() || template.description,
        input.recommendedUsage?.trim() || template.recommendedUsage || "",
        JSON.stringify(input.payloadSchema || template.payloadSchema || {}),
        JSON.stringify(input.examplePayload || template.examplePayload || {}),
        input.status || "active",
        JSON.stringify({
          ...parseJsonObject(existing.metadata),
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      ]
    )

    if (
      binding.ingress_kind === "webhook" &&
      (((existing.status === "disabled" || existing.status === "archived") &&
        (nextStatus === "active" || nextStatus === "deprecated")) ||
        ((existing.status === "active" || existing.status === "deprecated") &&
          (nextStatus === "disabled" || nextStatus === "archived")))
    ) {
      await reconcileIntegrationBindingWebhook(binding.id)
    }

    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        auditUserId,
        creator.actorId || null,
        existing.id,
        JSON.stringify({
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
        }),
      ]
    )
    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()
  await transaction(async (client) => {
    await executeSqlOn(
      client,
      `INSERT INTO automation_event_sources
         (id, workspace_id, provider_kind, provider_ref, webhook_endpoint_id, integration_binding_id, source_key,
          name, description, recommended_usage, payload_schema, example_payload, status, created_by_kind,
          created_by_workspace_member_id, created_by_actor_id, created_by_session_id, metadata, created_at, updated_at)
       VALUES ($1, $2, 'integration', NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        sourceId,
        workspaceId,
        binding.id,
        normalizedSourceKey,
        input.name?.trim() || template.name,
        input.description?.trim() || template.description,
        input.recommendedUsage?.trim() || template.recommendedUsage || "",
        JSON.stringify(input.payloadSchema || template.payloadSchema || {}),
        JSON.stringify(input.examplePayload || template.examplePayload || {}),
        initialStatus,
        creator.kind,
        creator.workspaceMemberId || null,
        creator.actorId || null,
        creator.sessionId || null,
        JSON.stringify({
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      ]
    )

    await executeSqlOn(
      client,
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.create', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        auditUserId,
        creator.actorId || null,
        sourceId,
        JSON.stringify({
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
        }),
      ]
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
    await executeSql(
      `DELETE FROM automation_event_sources
       WHERE workspace_id = $1
         AND id = $2`,
      [workspaceId, sourceId]
    ).catch(() => undefined)
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
  const existingResult = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = $2
       AND COALESCE(provider_ref, '') = COALESCE($3, '')
       AND source_key = $4
     LIMIT 1`,
    [
      workspaceId,
      input.providerKind,
      providerBinding.providerRef,
      normalizedSourceKey,
    ]
  )
  const existing = existingResult.rows[0]

  if (existing) {
    await executeSql(
      `UPDATE automation_event_sources
       SET provider_ref = $3,
           webhook_endpoint_id = $4,
           name = $5,
           description = $6,
           recommended_usage = $7,
           payload_schema = $8,
           example_payload = $9,
           status = $10,
           metadata = $11,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2`,
      [
        workspaceId,
        existing.id,
        providerBinding.providerRef,
        providerBinding.webhookEndpointId,
        input.name.trim(),
        input.description.trim(),
        input.recommendedUsage?.trim() || "",
        JSON.stringify(input.payloadSchema || {}),
        JSON.stringify(input.examplePayload || {}),
        input.status || "active",
        JSON.stringify(input.metadata || existing.metadata || {}),
      ]
    )

    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        auditUserId,
        creator.actorId || null,
        existing.id,
        JSON.stringify({
          providerKind: input.providerKind,
          providerRef: providerBinding.providerRef,
          sourceKey: normalizedSourceKey,
          recommendedUsage: input.recommendedUsage?.trim() || "",
          status: input.status || "active",
          reusedExisting: true,
        }),
      ]
    )

    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()

  await executeSql(
    `INSERT INTO automation_event_sources
       (id, workspace_id, provider_kind, provider_ref, webhook_endpoint_id, source_key, name, description, recommended_usage,
        payload_schema, example_payload, status, created_by_kind, created_by_workspace_member_id, created_by_actor_id,
        created_by_session_id, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())`,
    [
      sourceId,
      workspaceId,
      input.providerKind,
      providerBinding.providerRef,
      providerBinding.webhookEndpointId,
      normalizedSourceKey,
      input.name.trim(),
      input.description.trim(),
      input.recommendedUsage?.trim() || "",
      JSON.stringify(input.payloadSchema || {}),
      JSON.stringify(input.examplePayload || {}),
      input.status || "active",
      creator.kind,
      creator.workspaceMemberId || null,
      creator.actorId || null,
      creator.sessionId || null,
      JSON.stringify(input.metadata || {}),
    ]
  )

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.create', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      auditUserId,
      creator.actorId || null,
      sourceId,
      JSON.stringify({
        providerKind: input.providerKind,
        providerRef: providerBinding.providerRef,
        sourceKey: normalizedSourceKey,
        recommendedUsage: input.recommendedUsage?.trim() || "",
        status: input.status || "active",
      }),
    ]
  )

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

  await executeSql(
    `UPDATE automation_event_sources
     SET provider_ref = $3,
         webhook_endpoint_id = $4,
         integration_binding_id = $5,
         source_key = $6,
         name = $7,
         description = $8,
         recommended_usage = $9,
         payload_schema = $10,
         example_payload = $11,
         status = $12,
         metadata = $13,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2`,
    [
      workspaceId,
      eventSourceId,
      providerBinding.providerRef,
      providerBinding.webhookEndpointId,
      existing.integration?.bindingId || null,
      existing.sourceKey,
      input.name?.trim() || existing.name,
      input.description !== undefined
        ? input.description.trim()
        : existing.description,
      input.recommendedUsage !== undefined
        ? input.recommendedUsage.trim()
        : existing.recommendedUsage || "",
      JSON.stringify(
        input.payloadSchema !== undefined
          ? input.payloadSchema
          : existing.payloadSchema
      ),
      JSON.stringify(
        input.examplePayload !== undefined
          ? input.examplePayload
          : existing.examplePayload
      ),
      nextStatus,
      JSON.stringify(
        input.metadata !== undefined ? input.metadata : existing.metadata
      ),
    ]
  )

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

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      auditUserId,
      operator.actorId || null,
      eventSourceId,
      JSON.stringify({
        status: nextStatus,
        providerRef: providerBinding.providerRef,
        sourceKey: existing.sourceKey,
        recommendedUsage:
          input.recommendedUsage !== undefined
            ? input.recommendedUsage.trim()
            : existing.recommendedUsage || "",
      }),
    ]
  )

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

  await executeSql(
    `UPDATE automation_event_sources
     SET status = 'archived',
         updated_at = NOW()
    WHERE workspace_id = $1
      AND id = $2`,
    [workspaceId, eventSourceId]
  )

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

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.archive', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      auditUserId,
      operator.actorId || null,
      eventSourceId,
      JSON.stringify({ archived: true }),
    ]
  )
}

async function getAutomationEventSourceByWebhookPathToken(
  pathToken: string,
  sourceKey: string
) {
  const result = await executeSql<
    AutomationEventSourceRow & {
      endpoint_secret_ciphertext: string
      endpoint_name: string
      endpoint_id: string
    }
  >(
    `SELECT aes.*,
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_event_sources aes
     JOIN automation_webhook_endpoints awe
       ON awe.id = aes.webhook_endpoint_id
     WHERE awe.path_token = $1
       AND awe.status = 'active'
       AND aes.provider_kind = 'webhook'
       AND aes.source_key = $2
       AND aes.status IN ('active', 'deprecated')
     LIMIT 1`,
    [pathToken, sourceKey]
  )
  return result.rows[0] || null
}

async function listIntegrationEventSourcesByWebhookPathToken(
  pathToken: string
) {
  const result = await executeSql<
    AutomationEventSourceRow & {
      endpoint_secret_ciphertext: string
      endpoint_name: string
      endpoint_id: string
    }
  >(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")},
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_integration_bindings aib
     JOIN automation_webhook_endpoints awe
       ON awe.id = aib.webhook_endpoint_id
     JOIN automation_event_sources aes
       ON aes.integration_binding_id = aib.id
     WHERE awe.path_token = $1
       AND awe.status = 'active'
       AND aib.ingress_kind = 'webhook'
       AND aes.provider_kind = 'integration'
       AND aes.status IN ('active', 'deprecated')
     ORDER BY aes.created_at ASC`,
    [pathToken]
  )
  return result.rows
}

async function persistAutomationTargets(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  tableName: "automation_delivery_targets",
  ruleId: string,
  targetParticipantIds: string[]
) {
  await executeSqlOn(client, `DELETE FROM ${tableName} WHERE rule_id = $1`, [
    ruleId,
  ])
  for (const targetParticipantId of targetParticipantIds) {
    await executeSqlOn(
      client,
      `INSERT INTO ${tableName} (id, rule_id, target_participant_id, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [uuidv4(), ruleId, targetParticipantId]
    )
  }
}

async function updateRuleError(ruleId: string, errorMessage: string | null) {
  await executeSql(
    `UPDATE automation_rules
     SET last_error_at = $2,
         last_error_message = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [ruleId, errorMessage ? nowISO() : null, errorMessage]
  )
}

async function expireAutomationRules(params: {
  referenceTime?: string
  workspaceId?: string
  client?: QueryRunnerLike
}) {
  const runner = resolveQueryRunner(params.client)
  const referenceTime = params.referenceTime || nowISO()
  const result = await runner.run<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'expired',
         updated_at = NOW()
     FROM automation_policies ap
     WHERE ap.rule_id = ar.id
       AND ar.status = 'active'
       AND ap.active_until IS NOT NULL
       AND ap.active_until < $1
       ${params.workspaceId ? "AND ar.workspace_id = $2" : ""}
     RETURNING ar.id, ar.workspace_id`,
    params.workspaceId ? [referenceTime, params.workspaceId] : [referenceTime]
  )

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `UPDATE automation_policies
         SET completed_at = COALESCE(completed_at, $2),
             updated_at = NOW()
         WHERE rule_id = $1`,
        [row.id, referenceTime]
      )
    )
  )

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
         VALUES ($1, 'automation_rule.expire', 'automation_rule', $2, $3)`,
        [
          row.workspace_id,
          row.id,
          JSON.stringify({
            referenceTime,
          }),
        ]
      )
    )
  )
}

async function pauseAutomationRulesForInactiveCreators(params: {
  workspaceId?: string
  client?: QueryRunnerLike
}) {
  const runner = resolveQueryRunner(params.client)
  const result = await runner.run<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = 'Creator participant is no longer active',
         updated_at = NOW()
     FROM conversation_participants cp
     WHERE cp.id = ar.created_by_participant_id
       AND ar.status = 'active'
       AND cp.state <> 'active'
       ${params.workspaceId ? "AND ar.workspace_id = $1" : ""}
     RETURNING ar.id, ar.workspace_id`,
    params.workspaceId ? [params.workspaceId] : []
  )

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
         VALUES ($1, 'automation_rule.pause', 'automation_rule', $2, $3)`,
        [
          row.workspace_id,
          row.id,
          JSON.stringify({
            reason: "Creator participant is no longer active",
          }),
        ]
      )
    )
  )
}

async function syncAutomationRuleLiveness(params: {
  referenceTime?: string
  workspaceId?: string
  client?: QueryRunnerLike
}) {
  await expireAutomationRules(params)
  await pauseAutomationRulesForInactiveCreators({
    workspaceId: params.workspaceId,
    client: params.client,
  })
}

async function applyAutomationPolicyAfterTrigger(params: {
  ruleId: string
  workspaceId: string
  occurrenceId: string
  executionId: string
  completeNow?: boolean
  completionReason: "max_trigger_count" | "schedule_exhausted"
  client?: QueryRunnerLike
}) {
  const runner = resolveQueryRunner(params.client)
  const policyResult = await runner.run<AutomationPolicyRow>(
    `UPDATE automation_policies
     SET trigger_count = trigger_count + 1,
         updated_at = NOW()
     WHERE rule_id = $1
     RETURNING *`,
    [params.ruleId]
  )
  const policy = policyResult.rows[0]
  if (!policy) {
    throw new Error(`Automation policy for ${params.ruleId} not found`)
  }

  const reachedMax =
    policy.max_trigger_count !== null &&
    policy.trigger_count >= policy.max_trigger_count
  const shouldComplete = Boolean(params.completeNow || reachedMax)
  if (!shouldComplete) {
    return
  }

  await runner.run(
    `UPDATE automation_rules
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [params.ruleId, policy.completion_status]
  )
  await runner.run(
    `UPDATE automation_policies
     SET completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE rule_id = $1`,
    [params.ruleId]
  )
  await runner.run(
    `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
     VALUES ($1, 'automation_rule.complete', 'automation_rule', $2, $3)`,
    [
      params.workspaceId,
      params.ruleId,
      JSON.stringify({
        executionId: params.executionId,
        occurrenceId: params.occurrenceId,
        triggerCount: policy.trigger_count,
        maxTriggerCount: policy.max_trigger_count,
        completionStatus: policy.completion_status,
        completionReason: reachedMax
          ? "max_trigger_count"
          : params.completionReason,
      }),
    ]
  )
}

async function touchWebhookReceived(endpointId: string) {
  await executeSql(
    `UPDATE automation_webhook_endpoints
     SET last_received_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [endpointId]
  )
}

async function touchAutomationEventSourceTriggered(eventSourceId: string) {
  await executeSql(
    `UPDATE automation_event_sources
     SET last_triggered_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [eventSourceId]
  )
}

async function resolveAutomationRulesForEvent(params: {
  workspaceId: string
  eventSourceId: string
  payload: Record<string, unknown>
  occurredAt: string
}) {
  const result = await executeSql<AutomationRuleRow & AutomationTriggerRow>(
    `SELECT ar.*, at.rule_id, at.trigger_kind, at.source_kind, at.event_source_id, at.source_locator, at.match_key, at.matcher,
            at.schedule_kind, at.schedule_expr, at.schedule_timezone, at.interval_seconds, at.starts_at,
            at.next_fire_at, at.last_fired_at, at.metadata AS trigger_metadata
     FROM automation_rules ar
     JOIN automation_triggers at ON at.rule_id = ar.id
     JOIN automation_policies ap ON ap.rule_id = ar.id
     WHERE ar.workspace_id = $1
       AND ar.status = 'active'
       AND at.trigger_kind = 'event'
       AND at.event_source_id = $2
       AND (ap.active_from IS NULL OR ap.active_from <= $3)
       AND (ap.active_until IS NULL OR ap.active_until >= $3)
       AND (ap.max_trigger_count IS NULL OR ap.trigger_count < ap.max_trigger_count)`,
    [params.workspaceId, params.eventSourceId, params.occurredAt]
  )

  return result.rows
    .map((row) => ({
      ruleId: row.id,
      matcher: parseJsonObject(row.matcher),
    }))
    .filter((entry) => subsetMatch(entry.matcher, params.payload))
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
  occurredAt?: string
  client?: QueryRunnerLike
}) {
  const runner = resolveQueryRunner(params.client)
  const occurredAt = params.occurredAt || nowISO()
  const dedupeKey = params.dedupeKey?.trim() || null

  if (dedupeKey) {
    const existing = await runner.run(
      `SELECT *
       FROM automation_occurrences
       WHERE workspace_id = $1
         AND ${params.eventSourceId ? "event_source_id = $2" : "source_kind = $2"}
         AND dedupe_key = $3
       LIMIT 1`,
      [params.workspaceId, params.eventSourceId || params.sourceKind, dedupeKey]
    )
    if (existing.rows[0]) {
      return mapOccurrenceRow(existing.rows[0])
    }
  }

  const result = await runner.run(
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

  return mapOccurrenceRow(result.rows[0]!)
}

async function createAutomationExecution(params: {
  workspaceId: string
  ruleId: string
  occurrenceId: string
  client?: QueryRunnerLike
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
      execution: mapExecutionRow(existing.rows[0]),
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
    execution: mapExecutionRow(result.rows[0]!),
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
  const result = await executeSql<AutomationTargetRow>(
    `INSERT INTO automation_execution_targets
       (id, execution_id, conversation_id, target_participant_id, session_id, target_actor_id, created_item_id, wakeup_id,
        status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.executionId,
      params.conversationId || null,
      params.targetParticipantId || null,
      params.sessionId || null,
      params.targetActorId || null,
      params.createdItemId || null,
      params.wakeupId || null,
      params.status,
      JSON.stringify(params.metadata || {}),
    ]
  )
  return result.rows[0]
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
  if (creatorParticipant?.workspace_member_id) {
    const identity = await getWorkspaceMemberIdentityById(
      creatorParticipant.workspace_member_id as string
    )
    if (identity?.userId) return identity.userId
  }

  const members = await listConversationParticipants(rule.conversationId)
  const firstUser = members.find(
    (member: any) => member.state === "active" && member.workspace_member_id
  )
  if (firstUser?.workspace_member_id) {
    const workspaceMember = await getWorkspaceMemberIdentityById(
      firstUser.workspace_member_id as string
    )
    if (workspaceMember) {
      return workspaceMember.userId
    }
  }

  const result = await executeSql<{ owner_id: string }>(
    `SELECT owner_id
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [rule.workspaceId]
  )
  return result.rows[0]?.owner_id || null
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
    const actorId = participant.actor_id as string | undefined
    const sessionId =
      participant.session_id && participant.state === "active"
        ? (participant.session_id as string)
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

  const conversation = await getConversation(input.conversationId)
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
    input.trigger.triggerKind === "schedule" ? "schedule" : "event_subscription"
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
    creatorActorId: creatorParticipant.actor_id as string | null | undefined,
  })

  await transaction(async (client) => {
    await executeSqlOn(
      client,
      `INSERT INTO automation_rules
         (id, workspace_id, conversation_id, category, status, name, description, created_by_participant_id,
          created_by_session_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
      [
        ruleId,
        workspaceId,
        input.conversationId,
        category,
        input.status || "active",
        input.name.trim(),
        (input.description || "").trim(),
        creatorParticipant.id,
        creator.sessionId || null,
        JSON.stringify(input.metadata || {}),
      ]
    )

    await executeSqlOn(
      client,
      `INSERT INTO automation_policies
         (rule_id, active_from, active_until, max_trigger_count, trigger_count, completion_status, completed_at,
          metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        ruleId,
        normalizedPolicy.active_from,
        normalizedPolicy.active_until,
        normalizedPolicy.max_trigger_count,
        normalizedPolicy.trigger_count,
        normalizedPolicy.completion_status,
        normalizedPolicy.completed_at,
        JSON.stringify(normalizedPolicy.metadata),
      ]
    )

    await executeSqlOn(
      client,
      `INSERT INTO automation_triggers
         (rule_id, trigger_kind, source_kind, event_source_id, source_locator, match_key, matcher, schedule_kind, schedule_expr,
          schedule_timezone, interval_seconds, starts_at, next_fire_at, last_fired_at, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        ruleId,
        normalizedTrigger.trigger_kind,
        normalizedTrigger.source_kind,
        normalizedTrigger.event_source_id,
        normalizedTrigger.source_locator,
        normalizedTrigger.match_key,
        JSON.stringify(normalizedTrigger.matcher),
        normalizedTrigger.schedule_kind,
        normalizedTrigger.schedule_expr,
        normalizedTrigger.schedule_timezone,
        normalizedTrigger.interval_seconds,
        normalizedTrigger.starts_at,
        normalizedTrigger.next_fire_at,
        normalizedTrigger.last_fired_at,
        JSON.stringify(normalizedTrigger.metadata),
      ]
    )

    await executeSqlOn(
      client,
      `INSERT INTO automation_deliveries
         (rule_id, message_text, wake_reason_text, message_blocks, target_policy, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [
        ruleId,
        normalizedDelivery.message_text,
        normalizedDelivery.wake_reason_text,
        JSON.stringify(normalizedDelivery.message_blocks),
        normalizedDelivery.target_policy,
        JSON.stringify(normalizedDelivery.metadata),
      ]
    )

    await persistAutomationTargets(
      client,
      "automation_delivery_targets",
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await executeSqlOn(
      client,
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.create', 'automation_rule', $4, $5)`,
      [
        workspaceId,
        auditUserId,
        creator.actorId || null,
        ruleId,
        JSON.stringify({
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
        }),
      ]
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

  const values: unknown[] = [workspaceId]
  let where = "workspace_id = $1"

  if (filters?.status) {
    values.push(filters.status)
    where += ` AND status = $${values.length}`
  }
  if (filters?.category) {
    values.push(filters.category)
    where += ` AND category = $${values.length}`
  }
  if (filters?.conversationId) {
    values.push(filters.conversationId)
    where += ` AND conversation_id = $${values.length}`
  }

  const result = await executeSql<{ id: string }>(
    `SELECT id
     FROM automation_rules
     WHERE ${where}
     ORDER BY created_at DESC`,
    values
  )
  return loadAutomationRulesByIds(
    workspaceId,
    result.rows.map((row) => row.id)
  )
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
  const conversation = await getConversation(existing.conversationId)
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
    creatorActorId: creatorParticipant.actor_id as string | null | undefined,
  })

  await transaction(async (client) => {
    const nextCategory: AutomationCategory =
      normalizedTrigger.trigger_kind === "schedule"
        ? "schedule"
        : "event_subscription"

    await executeSqlOn(
      client,
      `UPDATE automation_rules
       SET status = $2,
           category = $3,
           name = $4,
           description = $5,
           metadata = $6,
           updated_at = NOW()
       WHERE id = $1`,
      [
        ruleId,
        mergedInput.status || existing.status,
        nextCategory,
        mergedInput.name.trim(),
        (mergedInput.description || "").trim(),
        JSON.stringify(mergedInput.metadata || {}),
      ]
    )

    await executeSqlOn(
      client,
      `UPDATE automation_policies
       SET active_from = $2,
           active_until = $3,
           max_trigger_count = $4,
           completion_status = $5,
           completed_at = $6,
           metadata = $7,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedPolicy.active_from,
        normalizedPolicy.active_until,
        normalizedPolicy.max_trigger_count,
        normalizedPolicy.completion_status,
        mergedInput.status === "active"
          ? null
          : existing.policy.completedAt || null,
        JSON.stringify(normalizedPolicy.metadata),
      ]
    )

    await executeSqlOn(
      client,
      `UPDATE automation_triggers
       SET trigger_kind = $2,
           source_kind = $3,
           event_source_id = $4,
           source_locator = $5,
           match_key = $6,
           matcher = $7,
           schedule_kind = $8,
           schedule_expr = $9,
           schedule_timezone = $10,
           interval_seconds = $11,
           starts_at = $12,
           next_fire_at = $13,
           metadata = $14,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedTrigger.trigger_kind,
        normalizedTrigger.source_kind,
        normalizedTrigger.event_source_id,
        normalizedTrigger.source_locator,
        normalizedTrigger.match_key,
        JSON.stringify(normalizedTrigger.matcher),
        normalizedTrigger.schedule_kind,
        normalizedTrigger.schedule_expr,
        normalizedTrigger.schedule_timezone,
        normalizedTrigger.interval_seconds,
        normalizedTrigger.starts_at,
        normalizedTrigger.next_fire_at,
        JSON.stringify(normalizedTrigger.metadata),
      ]
    )

    await executeSqlOn(
      client,
      `UPDATE automation_deliveries
       SET message_text = $2,
           wake_reason_text = $3,
           message_blocks = $4,
           target_policy = $5,
           metadata = $6,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedDelivery.message_text,
        normalizedDelivery.wake_reason_text,
        JSON.stringify(normalizedDelivery.message_blocks),
        normalizedDelivery.target_policy,
        JSON.stringify(normalizedDelivery.metadata),
      ]
    )

    await persistAutomationTargets(
      client,
      "automation_delivery_targets",
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await executeSqlOn(
      client,
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.update', 'automation_rule', $4, $5)`,
      [
        workspaceId,
        auditUserId,
        operator.actorId || null,
        ruleId,
        JSON.stringify({
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
        }),
      ]
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
  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_rule.delete', 'automation_rule', $4, $5)`,
    [
      workspaceId,
      auditUserId,
      operator.actorId || null,
      ruleId,
      JSON.stringify({ deleted: true }),
    ]
  )
  await executeSql(
    `DELETE FROM automation_rules
     WHERE id = $1
       AND workspace_id = $2`,
    [ruleId, workspaceId]
  )
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
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `INSERT INTO automation_webhook_endpoints
       (id, workspace_id, name, status, path_token, secret_ciphertext, secret_hint, metadata, created_by_workspace_member_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      workspaceId,
      params.name.trim(),
      crypto.randomBytes(18).toString("hex"),
      encrypt(secret),
      secretHint(secret),
      JSON.stringify(params.metadata || {}),
      createdByWorkspaceMemberId,
    ]
  )

  return {
    endpoint: mapWebhookEndpointRow(result.rows[0]!),
    secret,
  }
}

export async function listAutomationWebhookEndpoints(workspaceId: string) {
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `SELECT *
     FROM automation_webhook_endpoints
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId]
  )
  return result.rows.map(mapWebhookEndpointRow)
}

export async function listAutomationOccurrences(
  workspaceId: string,
  filters?: {
    eventSourceId?: string
    limit?: number
  }
) {
  const values: unknown[] = [workspaceId]
  let where = "ao.workspace_id = $1"

  if (filters?.eventSourceId) {
    values.push(filters.eventSourceId)
    where += ` AND ao.event_source_id = $${values.length}`
  }

  values.push(Math.max(1, Math.min(filters?.limit || 50, 200)))
  const result = await executeSql<AutomationOccurrenceRow>(
    `SELECT ao.*,
            aes.source_key AS event_source_key,
            aes.name AS event_source_name,
            aes.provider_ref AS event_provider_ref,
            aes.webhook_endpoint_id AS event_webhook_endpoint_id,
            aes.integration_binding_id AS event_integration_binding_id,
            aib.installation_id AS event_integration_installation_id,
            aib.provider AS event_integration_provider,
            aib.ingress_kind AS event_integration_ingress_kind,
            aib.target_kind AS event_integration_target_kind,
            aib.target_id AS event_integration_target_id,
            aib.target_label AS event_integration_target_label,
            aib.webhook_endpoint_id AS event_integration_webhook_endpoint_id,
            aib.external_subscription_id AS event_external_subscription_id
     FROM automation_occurrences ao
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     LEFT JOIN automation_integration_bindings aib ON aib.id = aes.integration_binding_id
     WHERE ${where}
     ORDER BY ao.created_at DESC
     LIMIT $${values.length}`,
    values
  )

  return result.rows.map(mapOccurrenceRow)
}

export async function ingestAutomationProviderEvent(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string
  sourceKey: string
  payload?: Record<string, unknown>
  sourceSnapshot?: Record<string, unknown>
  dedupeKey?: string
  occurredAt?: string
}) {
  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = $2
       AND COALESCE(provider_ref, '') = COALESCE($3, '')
       AND source_key = $4
       AND status IN ('active', 'deprecated')
     LIMIT 1`,
    [
      params.workspaceId,
      params.providerKind,
      params.providerRef || null,
      params.sourceKey,
    ]
  )
  const eventSource = result.rows[0]
  if (!eventSource) {
    return null
  }

  return ingestAutomationEvent({
    workspaceId: params.workspaceId,
    eventSourceId: eventSource.id,
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
  await executeSql(
    `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
     VALUES ($1, 'automation_event_source.trigger', 'automation_event_source', $2, $3)`,
    [
      input.workspaceId,
      eventSource.id,
      JSON.stringify({
        occurrenceId: occurrence.id,
        occurrenceTitle: decoratedOccurrence.displayTitle,
        executionCount: executions.length,
      }),
    ]
  )

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
  occurredAt?: string
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
  const source = mapEventSourceRow(sourceRow)
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
      occurredAt: normalized.occurredAt,
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

  await transaction(async (client) => {
    await syncAutomationRuleLiveness({ client })

    const dueResult = await executeSqlOn<{
      rule_id: string
      rule_name: string
      workspace_id: string
      schedule_kind: "cron" | "at" | "interval"
      schedule_expr: string | null
      schedule_timezone: string | null
      interval_seconds: number | null
      starts_at: string | null
      active_from: string | null
      active_until: string | null
      next_fire_at: string
      last_fired_at: string | null
    }>(
      client,
      `SELECT at.rule_id, ar.name AS rule_name, ar.workspace_id, at.schedule_kind, at.schedule_expr, at.schedule_timezone,
              at.interval_seconds, at.starts_at, ap.active_from, ap.active_until, at.next_fire_at, at.last_fired_at
       FROM automation_triggers at
       JOIN automation_rules ar ON ar.id = at.rule_id
       JOIN automation_policies ap ON ap.rule_id = ar.id
       WHERE at.trigger_kind = 'schedule'
         AND ar.status = 'active'
         AND at.next_fire_at IS NOT NULL
         AND at.next_fire_at <= NOW()
         AND (ap.active_from IS NULL OR ap.active_from <= at.next_fire_at)
         AND (ap.active_until IS NULL OR ap.active_until >= at.next_fire_at)
         AND (ap.max_trigger_count IS NULL OR ap.trigger_count < ap.max_trigger_count)
       ORDER BY at.next_fire_at ASC
       LIMIT $1
       FOR UPDATE OF at SKIP LOCKED`,
      [batchSize]
    )

    for (const row of dueResult.rows) {
      const occurrence = await createAutomationOccurrence({
        workspaceId: row.workspace_id,
        sourceKind: "clock",
        sourceLocator: row.schedule_timezone || "UTC",
        dedupeKey: `${row.rule_id}:${row.next_fire_at}`,
        sourceSnapshot: {
          ruleId: row.rule_id,
          ruleName: row.rule_name,
          scheduleKind: row.schedule_kind,
          scheduleExpr: row.schedule_expr,
          scheduleTimezone: row.schedule_timezone,
          intervalSeconds: row.interval_seconds,
          startsAt: row.starts_at,
          activeFrom: row.active_from,
          activeUntil: row.active_until,
          scheduledAt: row.next_fire_at,
        },
        payload: {},
        occurredAt: row.next_fire_at,
        client,
      })

      const { execution, isNew } = await createAutomationExecution({
        workspaceId: row.workspace_id,
        ruleId: row.rule_id,
        occurrenceId: occurrence.id,
        client,
      })

      const nextFireAt = computeNextFireAt({
        scheduleKind: row.schedule_kind,
        scheduleExpr: row.schedule_expr || undefined,
        scheduleTimezone: row.schedule_timezone || undefined,
        intervalSeconds: row.interval_seconds || undefined,
        startsAt: row.starts_at,
        activeFrom: row.active_from,
        activeUntil: row.active_until,
        baseTime: new Date(row.next_fire_at),
        lastFiredAt: row.next_fire_at,
      })

      await executeSqlOn(
        client,
        `UPDATE automation_triggers
         SET last_fired_at = $2,
             next_fire_at = $3,
             updated_at = NOW()
         WHERE rule_id = $1`,
        [row.rule_id, row.next_fire_at, nextFireAt]
      )
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
  const executionResult = await executeSql<AutomationExecutionRow>(
    `UPDATE automation_executions
     SET status = 'running',
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'pending'
     RETURNING *`,
    [executionId]
  )
  const executionRow = executionResult.rows[0]
  if (!executionRow) {
    const existingResult = await executeSql<AutomationExecutionRow>(
      `SELECT *
       FROM automation_executions
       WHERE id = $1
       LIMIT 1`,
      [executionId]
    )
    if (!existingResult.rows[0]) {
      throw new Error(`Automation execution ${executionId} not found`)
    }
    return {
      executionId,
      wakeupCount: 0,
    }
  }

  const execution = mapExecutionRow(executionRow)
  const occurrenceResult = await executeSql<AutomationOccurrenceRow>(
    `SELECT ao.*,
            aes.source_key AS event_source_key,
            aes.name AS event_source_name,
            aes.provider_ref AS event_provider_ref
     FROM automation_occurrences
     ao
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     WHERE ao.id = $1
     LIMIT 1`,
    [execution.occurrenceId]
  )
  const occurrence = occurrenceResult.rows[0]
    ? mapOccurrenceRow(occurrenceResult.rows[0])
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
      await executeSql(
        `UPDATE automation_executions
         SET status = 'skipped',
             error_message = $2,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [executionId, `Automation rule is ${rule.status}`]
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
      await executeSql(
        `UPDATE automation_executions
         SET status = 'skipped',
             error_message = $2,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [executionId, "No active target participants matched this automation"]
      )
      await executeSql(
        `UPDATE automation_rules
         SET last_error_at = NULL,
             last_error_message = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [rule.id]
      )
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

    await executeSql(
      `UPDATE automation_executions
       SET status = 'completed',
           error_message = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [executionId]
    )
    await executeSql(
      `UPDATE automation_rules
       SET last_triggered_at = NOW(),
           last_error_at = NULL,
           last_error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [rule.id]
    )
    await applyAutomationPolicyAfterTrigger({
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
    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.trigger', 'automation_rule', $4, $5)`,
      [
        rule.workspaceId,
        (await resolveOperatorUserId(rule)) || null,
        creatorParticipant?.actor_id || null,
        rule.id,
        JSON.stringify({
          executionId,
          occurrenceId: occurrence.id,
          createdItemId,
          wakeupCount,
          targetCount: targetParticipants.length,
        }),
      ]
    )

    return {
      executionId,
      createdItemId,
      wakeupCount,
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error)
    await executeSql(
      `UPDATE automation_executions
       SET status = 'failed',
           error_message = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [executionId, message]
    )
    await updateRuleError(rule.id, message)
    throw error
  }
}

export async function listAutomationExecutions(
  workspaceId: string,
  ruleId: string,
  limit = 50
) {
  const result = await executeSql<AutomationExecutionRow>(
    `SELECT ae.*,
            ar.name AS execution_rule_name,
            ao.occurred_at AS occurrence_occurred_at,
            ao.source_kind AS occurrence_source_kind,
            aes.name AS occurrence_event_source_name,
            aes.source_key AS event_source_key,
            aes.provider_ref AS event_provider_ref,
            ao.source_snapshot,
            ao.payload,
            ao.source_locator,
            ao.match_key,
            ao.dedupe_key,
            ao.created_at AS occurrence_created_at
     FROM automation_executions ae
     LEFT JOIN automation_rules ar ON ar.id = ae.rule_id
     LEFT JOIN automation_occurrences ao ON ao.id = ae.occurrence_id
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     WHERE ae.workspace_id = $1
       AND ae.rule_id = $2
     ORDER BY ae.created_at DESC
     LIMIT $3`,
    [workspaceId, ruleId, Math.max(1, Math.min(limit, 200))]
  )

  return result.rows.map((row) => {
    const execution = mapExecutionRow(row)
    if (!row.occurrence_id || !row.occurrence_occurred_at) {
      return execution
    }

    const rawSourceSnapshot = (
      row as AutomationExecutionRow & {
        source_snapshot?: Record<string, unknown> | string | null
      }
    ).source_snapshot
    const parsedSourceSnapshot = parseJsonObject(rawSourceSnapshot)
    const mergedSourceSnapshot = {
      ...parsedSourceSnapshot,
      ruleName:
        (typeof parsedSourceSnapshot.ruleName === "string" &&
        parsedSourceSnapshot.ruleName.trim()
          ? parsedSourceSnapshot.ruleName.trim()
          : null) ||
        row.execution_rule_name ||
        undefined,
    }

    const occurrence = mapOccurrenceRow({
      id: row.occurrence_id,
      workspace_id: row.workspace_id,
      source_kind: row.occurrence_source_kind || "internal",
      event_source_id: null,
      event_source_key:
        (row as AutomationExecutionRow & { event_source_key?: string | null })
          .event_source_key || null,
      event_source_name: row.occurrence_event_source_name || null,
      event_provider_ref:
        (row as AutomationExecutionRow & { event_provider_ref?: string | null })
          .event_provider_ref || null,
      source_locator:
        (row as AutomationExecutionRow & { source_locator?: string | null })
          .source_locator || null,
      match_key:
        (row as AutomationExecutionRow & { match_key?: string | null })
          .match_key || null,
      dedupe_key:
        (row as AutomationExecutionRow & { dedupe_key?: string | null })
          .dedupe_key || null,
      source_snapshot: mergedSourceSnapshot,
      payload:
        (
          row as AutomationExecutionRow & {
            payload?: Record<string, unknown> | string | null
          }
        ).payload || {},
      occurred_at: row.occurrence_occurred_at,
      created_at:
        (
          row as AutomationExecutionRow & {
            occurrence_created_at?: string | null
          }
        ).occurrence_created_at || row.occurrence_occurred_at,
    })

    return {
      ...execution,
      occurrenceOccurredAt: occurrence.occurredAt,
      occurrenceSourceKind: occurrence.sourceKind,
      occurrenceEventSourceName: occurrence.eventSourceName,
      occurrenceTitle: occurrence.displayTitle,
      occurrenceSummary: occurrence.displaySummary,
      occurrenceDescription: occurrence.displayDescription,
    }
  })
}
