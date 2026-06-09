import crypto from "node:crypto"
import cronParser from "cron-parser"
import { v4 as uuidv4 } from "uuid"
import {
  assertIsoInstant,
  dateToIsoInstant,
  nowIsoInstant,
} from "@synapse/shared/datetime"
import {
  parseInstantString,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
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
  AutomationWebhookEndpoint,
  AutomationWebhookEndpointCreateResult,
  CanonicalContentBlock,
  Timestamp,
} from "@synapse/shared"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  extractText,
  maskAllowsConversationType,
  normalizeCanonicalContentBlocks,
  parseJsonObject,
  resolveAutomationOccurrenceDisplay,
  resolveNarrowedConversationTypeMask,
  slugify,
  workspaceRef,
} from "@synapse/shared"
import {
  mergeAutomationRuleUpdatePayload,
  validateAutomationRuleCreatePayload,
} from "@synapse/shared/automation"
import { decrypt, encrypt } from "../../infrastructure/crypto/index.js"
import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
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
  type AutomationEventSourceBindingRow,
} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import {
  insertAutomationEventSourceAccessBindingReturningRowOn,
  loadAutomationEventSourceAccessBindingRowsForSources,
  revokeAutomationEventSourceAccessBinding,
  updateAutomationEventSourceAccessGrantConversationTypeMaskOverride,
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
  last_triggered_at: Date | null
  last_error_at: Date | null
  last_error_message: string | null
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
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
  starts_at: Date | null
  next_fire_at: Date | null
  last_fired_at: Date | null
  metadata: Record<string, unknown> | string | null
}

type AutomationPolicyRow = {
  rule_id: string
  active_from: Date | null
  active_until: Date | null
  max_trigger_count: number | null
  trigger_count: number
  completion_status: AutomationCompletionStatus
  completed_at: Date | null
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
  last_triggered_at: Date | null
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
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
  occurred_at: Date
  created_at: Date
}

type AutomationExecutionRow = {
  id: string
  workspace_id: string
  rule_id: string
  execution_rule_name?: string | null
  occurrence_id: string
  occurrence_occurred_at?: Date | null
  occurrence_source_kind?: AutomationSourceKind | null
  occurrence_event_source_name?: string | null
  occurrence_display_title?: string | null
  occurrence_display_summary?: string | null
  occurrence_display_description?: string | null
  status: AutomationExecutionStatus
  attempt_count: number
  error_message: string | null
  started_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
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
  created_at: Date
  updated_at: Date
}

type TargetParticipantRow = {
  rule_id: string
  target_participant_id: string
}

type AutomationEventSourceAccessRow = AutomationEventSourceBindingRow

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
  last_received_at: Date | null
  created_at: Date
  updated_at: Date
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
  created_at: Date
  updated_at: Date
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

function runnerFor(executor: Executor): QueryRunner {
  return {
    run: <T = any>(text: string, params?: unknown[]) =>
      executor.executeQuery<T>(
        CompiledQuery.raw(text, params ? [...params] : [])
      ) as Promise<{ rows: T[]; rowCount?: number | null }>,
  }
}

function resolveQueryRunner(executor?: Executor): QueryRunner {
  return runnerFor(executor ?? db)
}

const runQuery: SqlRunner = (text, params) =>
  resolveQueryRunner().run(text, params)

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
    lastTriggeredAt: serializeOptionalInstant(row.last_triggered_at),
    lastErrorAt: serializeOptionalInstant(row.last_error_at),
    lastErrorMessage: row.last_error_message || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
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
    startsAt: serializeOptionalInstant(row.starts_at),
    nextFireAt: serializeOptionalInstant(row.next_fire_at),
    lastFiredAt: serializeOptionalInstant(row.last_fired_at),
    metadata: parseJsonObject(row.metadata),
  }
}

function mapPolicyRow(row: AutomationPolicyRow): AutomationPolicy {
  return {
    ruleId: row.rule_id,
    activeFrom: serializeOptionalInstant(row.active_from),
    activeUntil: serializeOptionalInstant(row.active_until),
    maxTriggerCount: row.max_trigger_count || undefined,
    triggerCount: row.trigger_count,
    completionStatus: row.completion_status,
    completedAt: serializeOptionalInstant(row.completed_at),
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
    lastTriggeredAt: serializeOptionalInstant(row.last_triggered_at),
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
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
      occurredAt: serializeInstant(row.occurred_at),
      createdAt: serializeInstant(row.created_at),
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
    occurrenceOccurredAt: serializeOptionalInstant(row.occurrence_occurred_at),
    occurrenceSourceKind: row.occurrence_source_kind || undefined,
    occurrenceEventSourceName: row.occurrence_event_source_name || undefined,
    occurrenceTitle: row.occurrence_display_title || undefined,
    occurrenceSummary: row.occurrence_display_summary || undefined,
    occurrenceDescription: row.occurrence_display_description || undefined,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: serializeOptionalInstant(row.started_at),
    completedAt: serializeOptionalInstant(row.completed_at),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
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
    lastReceivedAt: serializeOptionalInstant(row.last_received_at),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
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

async function loadAutomationTargets(
  tableName: "automation_delivery_targets",
  ruleIds: string[]
) {
  if (ruleIds.length === 0) {
    return new Map<string, string[]>()
  }
  const result = await runQuery<TargetParticipantRow>(
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
    runQuery<AutomationRuleRow>(
      `SELECT *
       FROM automation_rules
       WHERE workspace_id = $1
         AND id = ANY($2)
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId, ruleIds]
    ),
    runQuery<AutomationTriggerRow>(
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
    runQuery<AutomationPolicyRow>(
      `SELECT *
       FROM automation_policies
       WHERE rule_id = ANY($1)`,
      [ruleIds]
    ),
    runQuery<AutomationDeliveryRow>(
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
    const endpointResult = await runBuilder(
      db,
      db
        .selectFrom("automation_webhook_endpoints")
        .select("id")
        .where("id", "=", normalizedRef)
        .where("workspace_id", "=", workspaceId)
        .where("status", "=", "active")
        .limit(1)
    )
    if (!endpointResult.rows[0]) {
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
    const existing = await runBuilder(
      db,
      db
        .selectFrom("automation_event_sources")
        .select("id")
        .where("workspace_id", "=", params.workspaceId)
        .where("provider_kind", "=", params.providerKind)
        .where(
          sql`COALESCE(provider_ref, '')`,
          "=",
          sql`COALESCE(${params.providerRef || null}, '')`
        )
        .where("source_key", "=", candidate)
        .limit(1)
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
  const affected = await runQuery<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $2
     FROM automation_triggers at
     WHERE at.rule_id = ar.id
       AND at.event_source_id = $1
       AND ar.category = 'event_subscription'
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
     RETURNING ar.id, ar.workspace_id`,
    [eventSourceId, reason]
  )

  for (const row of affected.rows) {
    await db
      .insertInto("audit_logs")
      .values({
        workspace_id: row.workspace_id,
        user_id: auditUserId,
        actor_id: operator.actorId || null,
        action: "automation_rule.pause",
        resource_type: "automation_rule",
        resource_id: row.id,
        details: JSON.stringify({
          reason,
          eventSourceId,
        }),
      })
      .execute()
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
  const rows = await loadAutomationEventSourceAccessBindingRowsForSources(db, {
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

  const target = readAutomationEventSourceAccessBindingTarget(params.row as any)
  const subject = target.subject
  const scope = target.scope
  switch (subject.kind) {
    case "workspace":
      return (
        ((subject as { workspaceId: string }).workspaceId || null) ===
          ((params.conversation.workspace_id as string | null | undefined) ||
            null) ||
        ((subject as { workspaceId: string }).workspaceId || null) ===
          (params.row.workspace_id || null)
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

  const inserted = await withDbTransaction(async (trx) => {
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
      binding: {
        ...binding,
        resource_id: binding.automation_event_source_id!,
      } as AutomationEventSourceBindingRow,
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

    await updateAutomationEventSourceAccessGrantConversationTypeMaskOverride(
      db,
      {
        bindingId: input.bindingId,
        workspaceId: input.workspaceId,
        conversationTypeMaskOverride:
          input.conversationTypeMaskOverride ?? null,
      }
    )
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
  const updated = await runBuilder(
    db,
    db
      .updateTable("automation_rules")
      .set({
        status: "paused",
        last_error_at: sql`NOW()`,
        last_error_message: params.reason,
      })
      .where("id", "=", params.ruleId)
      .where("status", "=", "active")
      .returning("id")
  )
  if (!updated.rows[0]) {
    return
  }

  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: params.workspaceId,
      user_id: auditUserId,
      actor_id: params.operator.actorId || null,
      action: "automation_rule.pause",
      resource_type: "automation_rule",
      resource_id: params.ruleId,
      details: JSON.stringify({ reason: params.reason }),
    })
    .execute()
}

async function pauseAutomationRulesMissingEventSourceAccess(
  eventSourceId: string,
  operator: AutomationOperatorInput,
  reason: string
) {
  const result = await runQuery<AutomationRuleRow>(
    `SELECT ar.*
     FROM automation_rules ar
     JOIN automation_triggers at
       ON at.rule_id = ar.id
     WHERE at.event_source_id = $1
       AND ar.category = 'event_subscription'
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL`,
    [eventSourceId]
  )

  for (const row of result.rows) {
    const conversation = await loadConversationWithImFlag(row.conversation_id)
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

  await revokeAutomationEventSourceAccessBinding(db, {
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
  const result = await runQuery<AutomationEventSourceRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")}
     FROM automation_event_sources aes
     ${automationEventSourceJoinClause("aes", "aib")}
     WHERE aes.workspace_id = $1
       AND aes.id = $2
       AND aes.deleted_at IS NULL
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
  let where = "aes.workspace_id = $1 AND aes.deleted_at IS NULL"

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

  const result = await runQuery<AutomationEventSourceRow>(
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
  const result = await runQuery<AutomationWebhookEndpointRow>(
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
  await db
    .updateTable("automation_webhook_endpoints")
    .set({
      status,
    })
    .where("id", "=", endpointId)
    .execute()
}

async function getAutomationIntegrationBinding(bindingId: string) {
  const result = await runQuery<AutomationIntegrationBindingRow>(
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
  const existingResult = await runQuery<AutomationIntegrationBindingRow>(
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
      await db
        .updateTable("automation_integration_bindings")
        .set({
          target_label: targetLabel,
        })
        .where("id", "=", existing.id)
        .execute()
      return getAutomationIntegrationBinding(existing.id)
    }
    return existing
  }

  const bindingId = uuidv4()
  const endpointId = ingressKind === "webhook" ? uuidv4() : null
  const pathToken =
    ingressKind === "webhook" ? crypto.randomBytes(18).toString("hex") : null
  const secret = ingressKind === "webhook" ? generateSecret() : null

  await withDbTransaction(async (trx) => {
    if (endpointId && pathToken && secret) {
      await trx
        .insertInto("automation_webhook_endpoints")
        .values({
          id: endpointId,
          workspace_id: params.workspaceId,
          name: integrationEndpointName(
            params.integration.provider,
            targetLabel
          ),
          status: "disabled",
          path_token: pathToken,
          secret_ciphertext: encrypt(secret),
          secret_hint: secretHint(secret),
          metadata: JSON.stringify({
            managedBy: "integration_binding",
            integrationProvider: params.integration.provider,
            integrationTargetKind: params.integration.targetKind,
            integrationTargetId: targetId,
            integrationTargetLabel: targetLabel,
          }),
          created_by_workspace_member_id:
            params.creator.workspaceMemberId || null,
          created_at: sql`NOW()`,
        })
        .execute()
    }

    await trx
      .insertInto("automation_integration_bindings")
      .values({
        id: bindingId,
        workspace_id: params.workspaceId,
        installation_id: params.installation.id,
        provider: params.integration.provider,
        ingress_kind: ingressKind,
        target_kind: params.integration.targetKind,
        target_id: targetId,
        target_label: targetLabel,
        webhook_endpoint_id: endpointId,
        external_subscription_id: null,
        metadata: JSON.stringify({
          integrationProvider: params.integration.provider,
          integrationTargetKind: params.integration.targetKind,
        }),
        created_at: sql`NOW()`,
      })
      .execute()
  })

  return getAutomationIntegrationBinding(bindingId)
}

async function listActiveIntegrationSourceKeysForBinding(bindingId: string) {
  const result = await runBuilder(
    db,
    db
      .selectFrom("automation_event_sources")
      .select("source_key")
      .where("provider_kind", "=", "integration")
      .where("integration_binding_id", "=", bindingId)
      .where("status", "in", ["active", "deprecated"])
      .orderBy("source_key", "asc")
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
    await db
      .updateTable("automation_integration_bindings")
      .set({
        external_subscription_id: null,
      })
      .where("id", "=", binding.id)
      .execute()
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

  await db
    .updateTable("automation_integration_bindings")
    .set({
      external_subscription_id: externalSubscriptionId,
    })
    .where("id", "=", binding.id)
    .execute()
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

  const existingResult = await runBuilder(
    db,
    db
      .selectFrom("automation_event_sources")
      .select(["id", "status", "metadata"])
      .where("workspace_id", "=", workspaceId)
      .where("provider_kind", "=", "integration")
      .where("integration_binding_id", "=", binding.id)
      .where("source_key", "=", normalizedSourceKey)
      .limit(1)
  )
  const existing = existingResult.rows[0]

  if (existing) {
    const nextStatus = input.status || "active"
    await db
      .updateTable("automation_event_sources")
      .set({
        name: input.name?.trim() || template.name,
        description: input.description?.trim() || template.description,
        recommended_usage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payload_schema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        example_payload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
        status: input.status || "active",
        metadata: JSON.stringify({
          ...parseJsonObject(existing.metadata),
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", existing.id)
      .execute()

    if (
      binding.ingress_kind === "webhook" &&
      (((existing.status === "disabled" || existing.status === "archived") &&
        (nextStatus === "active" || nextStatus === "deprecated")) ||
        ((existing.status === "active" || existing.status === "deprecated") &&
          (nextStatus === "disabled" || nextStatus === "archived")))
    ) {
      await reconcileIntegrationBindingWebhook(binding.id)
    }

    await db
      .insertInto("audit_logs")
      .values({
        workspace_id: workspaceId,
        user_id: auditUserId,
        actor_id: creator.actorId || null,
        action: "automation_event_source.update",
        resource_type: "automation_event_source",
        resource_id: existing.id,
        details: JSON.stringify({
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
      })
      .execute()
    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()
  await withDbTransaction(async (trx) => {
    await trx
      .insertInto("automation_event_sources")
      .values({
        id: sourceId,
        workspace_id: workspaceId,
        provider_kind: "integration",
        provider_ref: null,
        webhook_endpoint_id: null,
        integration_binding_id: binding.id,
        source_key: normalizedSourceKey,
        name: input.name?.trim() || template.name,
        description: input.description?.trim() || template.description,
        recommended_usage:
          input.recommendedUsage?.trim() || template.recommendedUsage || "",
        payload_schema: JSON.stringify(
          input.payloadSchema || template.payloadSchema || {}
        ),
        example_payload: JSON.stringify(
          input.examplePayload || template.examplePayload || {}
        ),
        status: initialStatus,
        created_by_kind: creator.kind,
        created_by_workspace_member_id: creator.workspaceMemberId || null,
        created_by_actor_id: creator.actorId || null,
        created_by_session_id: creator.sessionId || null,
        metadata: JSON.stringify({
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
        created_at: sql`NOW()`,
      })
      .execute()

    await trx
      .insertInto("audit_logs")
      .values({
        workspace_id: workspaceId,
        user_id: auditUserId,
        actor_id: creator.actorId || null,
        action: "automation_event_source.create",
        resource_type: "automation_event_source",
        resource_id: sourceId,
        details: JSON.stringify({
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
      })
      .execute()
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
    await db
      .updateTable("automation_event_sources")
      .set({ deleted_at: sql`NOW()` })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", sourceId)
      .where("deleted_at", "is", null)
      .execute()
      .catch(() => undefined)
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
  const existingResult = await runBuilder(
    db,
    db
      .selectFrom("automation_event_sources")
      .select(["id", "metadata"])
      .where("workspace_id", "=", workspaceId)
      .where("provider_kind", "=", input.providerKind)
      .where(
        sql`COALESCE(provider_ref, '')`,
        "=",
        sql`COALESCE(${providerBinding.providerRef}, '')`
      )
      .where("source_key", "=", normalizedSourceKey)
      .limit(1)
  )
  const existing = existingResult.rows[0]

  if (existing) {
    await db
      .updateTable("automation_event_sources")
      .set({
        provider_ref: providerBinding.providerRef,
        webhook_endpoint_id: providerBinding.webhookEndpointId,
        name: input.name.trim(),
        description: input.description.trim(),
        recommended_usage: input.recommendedUsage?.trim() || "",
        payload_schema: JSON.stringify(input.payloadSchema || {}),
        example_payload: JSON.stringify(input.examplePayload || {}),
        status: input.status || "active",
        metadata: JSON.stringify(input.metadata || existing.metadata || {}),
      })
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", existing.id)
      .execute()

    await db
      .insertInto("audit_logs")
      .values({
        workspace_id: workspaceId,
        user_id: auditUserId,
        actor_id: creator.actorId || null,
        action: "automation_event_source.update",
        resource_type: "automation_event_source",
        resource_id: existing.id,
        details: JSON.stringify({
          providerKind: input.providerKind,
          providerRef: providerBinding.providerRef,
          sourceKey: normalizedSourceKey,
          recommendedUsage: input.recommendedUsage?.trim() || "",
          status: input.status || "active",
          reusedExisting: true,
        }),
      })
      .execute()

    const updated = await getAutomationEventSource(workspaceId, existing.id)
    if (!updated) {
      throw new Error(
        `Automation event source ${existing.id} was not found after reuse`
      )
    }
    return updated
  }

  const sourceId = uuidv4()

  await db
    .insertInto("automation_event_sources")
    .values({
      id: sourceId,
      workspace_id: workspaceId,
      provider_kind: input.providerKind,
      provider_ref: providerBinding.providerRef,
      webhook_endpoint_id: providerBinding.webhookEndpointId,
      source_key: normalizedSourceKey,
      name: input.name.trim(),
      description: input.description.trim(),
      recommended_usage: input.recommendedUsage?.trim() || "",
      payload_schema: JSON.stringify(input.payloadSchema || {}),
      example_payload: JSON.stringify(input.examplePayload || {}),
      status: input.status || "active",
      created_by_kind: creator.kind,
      created_by_workspace_member_id: creator.workspaceMemberId || null,
      created_by_actor_id: creator.actorId || null,
      created_by_session_id: creator.sessionId || null,
      metadata: JSON.stringify(input.metadata || {}),
      created_at: sql`NOW()`,
    })
    .execute()

  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: workspaceId,
      user_id: auditUserId,
      actor_id: creator.actorId || null,
      action: "automation_event_source.create",
      resource_type: "automation_event_source",
      resource_id: sourceId,
      details: JSON.stringify({
        providerKind: input.providerKind,
        providerRef: providerBinding.providerRef,
        sourceKey: normalizedSourceKey,
        recommendedUsage: input.recommendedUsage?.trim() || "",
        status: input.status || "active",
      }),
    })
    .execute()

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

  await db
    .updateTable("automation_event_sources")
    .set({
      provider_ref: providerBinding.providerRef,
      webhook_endpoint_id: providerBinding.webhookEndpointId,
      integration_binding_id: existing.integration?.bindingId || null,
      source_key: existing.sourceKey,
      name: input.name?.trim() || existing.name,
      description:
        input.description !== undefined
          ? input.description.trim()
          : existing.description,
      recommended_usage:
        input.recommendedUsage !== undefined
          ? input.recommendedUsage.trim()
          : existing.recommendedUsage || "",
      payload_schema: JSON.stringify(
        input.payloadSchema !== undefined
          ? input.payloadSchema
          : existing.payloadSchema
      ),
      example_payload: JSON.stringify(
        input.examplePayload !== undefined
          ? input.examplePayload
          : existing.examplePayload
      ),
      status: nextStatus,
      metadata: JSON.stringify(
        input.metadata !== undefined ? input.metadata : existing.metadata
      ),
    })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", eventSourceId)
    .execute()

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

  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: workspaceId,
      user_id: auditUserId,
      actor_id: operator.actorId || null,
      action: "automation_event_source.update",
      resource_type: "automation_event_source",
      resource_id: eventSourceId,
      details: JSON.stringify({
        status: nextStatus,
        providerRef: providerBinding.providerRef,
        sourceKey: existing.sourceKey,
        recommendedUsage:
          input.recommendedUsage !== undefined
            ? input.recommendedUsage.trim()
            : existing.recommendedUsage || "",
      }),
    })
    .execute()

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

  await db
    .updateTable("automation_event_sources")
    .set({
      status: "archived",
    })
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", eventSourceId)
    .execute()

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

  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: workspaceId,
      user_id: auditUserId,
      actor_id: operator.actorId || null,
      action: "automation_event_source.archive",
      resource_type: "automation_event_source",
      resource_id: eventSourceId,
      details: JSON.stringify({ archived: true }),
    })
    .execute()
}

async function getAutomationEventSourceByWebhookPathToken(
  pathToken: string,
  sourceKey: string
) {
  const result = await runQuery<
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
       AND awe.deleted_at IS NULL
       AND aes.provider_kind = 'webhook'
       AND aes.source_key = $2
       AND aes.status IN ('active', 'deprecated')
       AND aes.deleted_at IS NULL
     LIMIT 1`,
    [pathToken, sourceKey]
  )
  return result.rows[0] || null
}

async function listIntegrationEventSourcesByWebhookPathToken(
  pathToken: string
) {
  const result = await runQuery<
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
       AND awe.deleted_at IS NULL
       AND aib.ingress_kind = 'webhook'
       AND aib.deleted_at IS NULL
       AND aes.provider_kind = 'integration'
       AND aes.status IN ('active', 'deprecated')
       AND aes.deleted_at IS NULL
     ORDER BY aes.created_at ASC`,
    [pathToken]
  )
  return result.rows
}

async function persistAutomationTargets(
  executor: Executor,
  tableName: "automation_delivery_targets",
  ruleId: string,
  targetParticipantIds: string[]
) {
  await runnerFor(executor).run(`DELETE FROM ${tableName} WHERE rule_id = $1`, [
    ruleId,
  ])
  for (const targetParticipantId of targetParticipantIds) {
    await runnerFor(executor).run(
      `INSERT INTO ${tableName} (id, rule_id, target_participant_id, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [uuidv4(), ruleId, targetParticipantId]
    )
  }
}

async function updateRuleError(ruleId: string, errorMessage: string | null) {
  await db
    .updateTable("automation_rules")
    .set({
      last_error_at: errorMessage ? new Date() : null,
      last_error_message: errorMessage,
    })
    .where("id", "=", ruleId)
    .execute()
}

async function expireAutomationRules(params: {
  referenceTime?: string
  workspaceId?: string
  client?: Executor
}) {
  const runner = resolveQueryRunner(params.client)
  const referenceTime = params.referenceTime || nowIsoInstant()
  const result = await runner.run<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'expired'
     FROM automation_policies ap
     WHERE ap.rule_id = ar.id
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
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
         SET completed_at = COALESCE(completed_at, $2)
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
  client?: Executor
}) {
  const runner = resolveQueryRunner(params.client)
  const result = await runner.run<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = 'Creator participant is no longer active'
     FROM conversation_participants cp
     WHERE cp.id = ar.created_by_participant_id
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
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
  client?: Executor
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
  client?: Executor
}) {
  const executor = params.client ?? db
  const policyResult = await runBuilder(
    executor,
    executor
      .updateTable("automation_policies")
      .set({
        trigger_count: sql`${sql.ref("trigger_count")} + 1`,
      })
      .where("rule_id", "=", params.ruleId)
      .returningAll()
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

  await executor
    .updateTable("automation_rules")
    .set({
      status: policy.completion_status,
    })
    .where("id", "=", params.ruleId)
    .execute()
  await executor
    .updateTable("automation_policies")
    .set({
      completed_at: sql`COALESCE(${sql.ref("completed_at")}, NOW())`,
    })
    .where("rule_id", "=", params.ruleId)
    .execute()
  await executor
    .insertInto("audit_logs")
    .values({
      workspace_id: params.workspaceId,
      action: "automation_rule.complete",
      resource_type: "automation_rule",
      resource_id: params.ruleId,
      details: JSON.stringify({
        executionId: params.executionId,
        occurrenceId: params.occurrenceId,
        triggerCount: policy.trigger_count,
        maxTriggerCount: policy.max_trigger_count,
        completionStatus: policy.completion_status,
        completionReason: reachedMax
          ? "max_trigger_count"
          : params.completionReason,
      }),
    })
    .execute()
}

async function touchWebhookReceived(endpointId: string) {
  await db
    .updateTable("automation_webhook_endpoints")
    .set({
      last_received_at: sql`NOW()`,
    })
    .where("id", "=", endpointId)
    .execute()
}

async function touchAutomationEventSourceTriggered(eventSourceId: string) {
  await db
    .updateTable("automation_event_sources")
    .set({
      last_triggered_at: sql`NOW()`,
    })
    .where("id", "=", eventSourceId)
    .execute()
}

async function resolveAutomationRulesForEvent(params: {
  workspaceId: string
  eventSourceId: string
  payload: Record<string, unknown>
  occurredAt: Timestamp
}) {
  const result = await runQuery<AutomationRuleRow & AutomationTriggerRow>(
    `SELECT ar.*, at.rule_id, at.trigger_kind, at.source_kind, at.event_source_id, at.source_locator, at.match_key, at.matcher,
            at.schedule_kind, at.schedule_expr, at.schedule_timezone, at.interval_seconds, at.starts_at,
            at.next_fire_at, at.last_fired_at, at.metadata AS trigger_metadata
     FROM automation_rules ar
     JOIN automation_triggers at ON at.rule_id = ar.id
     JOIN automation_policies ap ON ap.rule_id = ar.id
     WHERE ar.workspace_id = $1
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
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
  occurredAt?: Timestamp
  client?: Executor
}) {
  const runner = resolveQueryRunner(params.client)
  const occurredAt = params.occurredAt || nowIsoInstant()
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
  await db
    .insertInto("automation_execution_targets")
    .values({
      id: uuidv4(),
      execution_id: params.executionId,
      conversation_id: params.conversationId || null,
      target_participant_id: params.targetParticipantId || null,
      session_id: params.sessionId || null,
      target_actor_id: params.targetActorId || null,
      created_item_id: params.createdItemId || null,
      wakeup_id: params.wakeupId || null,
      status: params.status,
      metadata: JSON.stringify(params.metadata || {}),
      created_at: sql`NOW()`,
    })
    .execute()
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

  const result = await runBuilder(
    db,
    db
      .selectFrom("workspaces")
      .select("owner_id")
      .where("id", "=", rule.workspaceId)
      .limit(1)
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

  await withDbTransaction(async (trx) => {
    await trx
      .insertInto("automation_rules")
      .values({
        id: ruleId,
        workspace_id: workspaceId,
        conversation_id: input.conversationId,
        category,
        status: input.status || "active",
        name: input.name.trim(),
        description: (input.description || "").trim(),
        created_by_participant_id: creatorParticipant.id,
        created_by_session_id: creator.sessionId || null,
        metadata: JSON.stringify(input.metadata || {}),
        created_at: sql`NOW()`,
      })
      .execute()

    await trx
      .insertInto("automation_policies")
      .values({
        rule_id: ruleId,
        active_from: normalizedPolicy.active_from,
        active_until: normalizedPolicy.active_until,
        max_trigger_count: normalizedPolicy.max_trigger_count,
        trigger_count: normalizedPolicy.trigger_count,
        completion_status: normalizedPolicy.completion_status,
        completed_at: normalizedPolicy.completed_at,
        metadata: JSON.stringify(normalizedPolicy.metadata),
        created_at: sql`NOW()`,
      })
      .execute()

    await runnerFor(trx).run(
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

    await trx
      .insertInto("automation_deliveries")
      .values({
        rule_id: ruleId,
        message_text: normalizedDelivery.message_text,
        wake_reason_text: normalizedDelivery.wake_reason_text,
        message_blocks: JSON.stringify(normalizedDelivery.message_blocks),
        target_policy: normalizedDelivery.target_policy,
        metadata: JSON.stringify(normalizedDelivery.metadata),
        created_at: sql`NOW()`,
      })
      .execute()

    await persistAutomationTargets(
      trx,
      "automation_delivery_targets",
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await trx
      .insertInto("audit_logs")
      .values({
        workspace_id: workspaceId,
        user_id: auditUserId,
        actor_id: creator.actorId || null,
        action: "automation_rule.create",
        resource_type: "automation_rule",
        resource_id: ruleId,
        details: JSON.stringify({
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
      })
      .execute()
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
  let where = "workspace_id = $1 AND deleted_at IS NULL"

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

  const result = await runQuery<{ id: string }>(
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
    creatorActorId: creatorParticipant.actor_id as string | null | undefined,
  })

  await withDbTransaction(async (trx) => {
    const nextCategory: AutomationCategory =
      normalizedTrigger.trigger_kind === "schedule"
        ? "schedule"
        : "event_subscription"

    await trx
      .updateTable("automation_rules")
      .set({
        status: mergedInput.status || existing.status,
        category: nextCategory,
        name: mergedInput.name.trim(),
        description: (mergedInput.description || "").trim(),
        metadata: JSON.stringify(mergedInput.metadata || {}),
      })
      .where("id", "=", ruleId)
      .execute()

    await trx
      .updateTable("automation_policies")
      .set({
        active_from: normalizedPolicy.active_from,
        active_until: normalizedPolicy.active_until,
        max_trigger_count: normalizedPolicy.max_trigger_count,
        completion_status: normalizedPolicy.completion_status,
        completed_at:
          mergedInput.status === "active"
            ? null
            : existing.policy.completedAt
              ? parseInstantString(existing.policy.completedAt)
              : null,
        metadata: JSON.stringify(normalizedPolicy.metadata),
      })
      .where("rule_id", "=", ruleId)
      .execute()

    await runnerFor(trx).run(
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
           metadata = $14
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

    await trx
      .updateTable("automation_deliveries")
      .set({
        message_text: normalizedDelivery.message_text,
        wake_reason_text: normalizedDelivery.wake_reason_text,
        message_blocks: JSON.stringify(normalizedDelivery.message_blocks),
        target_policy: normalizedDelivery.target_policy,
        metadata: JSON.stringify(normalizedDelivery.metadata),
      })
      .where("rule_id", "=", ruleId)
      .execute()

    await persistAutomationTargets(
      trx,
      "automation_delivery_targets",
      ruleId,
      normalizedDelivery.targetParticipantIds
    )

    await trx
      .insertInto("audit_logs")
      .values({
        workspace_id: workspaceId,
        user_id: auditUserId,
        actor_id: operator.actorId || null,
        action: "automation_rule.update",
        resource_type: "automation_rule",
        resource_id: ruleId,
        details: JSON.stringify({
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
      })
      .execute()
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
  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: workspaceId,
      user_id: auditUserId,
      actor_id: operator.actorId || null,
      action: "automation_rule.delete",
      resource_type: "automation_rule",
      resource_id: ruleId,
      details: JSON.stringify({ deleted: true }),
    })
    .execute()
  // Soft delete (design §7.4): flip deleted_at (hard delete forbidden by
  // sd_reject_delete).
  await db
    .updateTable("automation_rules")
    .set({ deleted_at: sql`NOW()` })
    .where("id", "=", ruleId)
    .where("workspace_id", "=", workspaceId)
    .where("deleted_at", "is", null)
    .execute()
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
  const result = await runQuery<AutomationWebhookEndpointRow>(
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
  const result = await runQuery<AutomationWebhookEndpointRow>(
    `SELECT *
     FROM automation_webhook_endpoints
     WHERE workspace_id = $1
       AND deleted_at IS NULL
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
  const result = await runQuery<AutomationOccurrenceRow>(
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
  occurredAt?: Timestamp
}) {
  const result = await runBuilder(
    db,
    db
      .selectFrom("automation_event_sources")
      .select("id")
      .where("workspace_id", "=", params.workspaceId)
      .where("provider_kind", "=", params.providerKind)
      .where(
        sql`COALESCE(provider_ref, '')`,
        "=",
        sql`COALESCE(${params.providerRef || null}, '')`
      )
      .where("source_key", "=", params.sourceKey)
      .where("status", "in", ["active", "deprecated"])
      .where("deleted_at", "is", null)
      .limit(1)
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
  await db
    .insertInto("audit_logs")
    .values({
      workspace_id: input.workspaceId,
      action: "automation_event_source.trigger",
      resource_type: "automation_event_source",
      resource_id: eventSource.id,
      details: JSON.stringify({
        occurrenceId: occurrence.id,
        occurrenceTitle: decoratedOccurrence.displayTitle,
        executionCount: executions.length,
      }),
    })
    .execute()

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

  await withDbTransaction(async (trx) => {
    await syncAutomationRuleLiveness({ client: trx })

    const dueResult = await runnerFor(trx).run<{
      rule_id: string
      rule_name: string
      workspace_id: string
      schedule_kind: "cron" | "at" | "interval"
      schedule_expr: string | null
      schedule_timezone: string | null
      interval_seconds: number | null
      starts_at: Date | null
      active_from: Date | null
      active_until: Date | null
      next_fire_at: Date
      last_fired_at: Date | null
    }>(
      `SELECT at.rule_id, ar.name AS rule_name, ar.workspace_id, at.schedule_kind, at.schedule_expr, at.schedule_timezone,
              at.interval_seconds, at.starts_at, ap.active_from, ap.active_until, at.next_fire_at, at.last_fired_at
       FROM automation_triggers at
       JOIN automation_rules ar ON ar.id = at.rule_id
       JOIN automation_policies ap ON ap.rule_id = ar.id
       WHERE at.trigger_kind = 'schedule'
         AND ar.status = 'active'
         AND ar.deleted_at IS NULL
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
          startsAt: serializeOptionalInstant(row.starts_at),
          activeFrom: serializeOptionalInstant(row.active_from),
          activeUntil: serializeOptionalInstant(row.active_until),
          scheduledAt: serializeInstant(row.next_fire_at),
        },
        payload: {},
        occurredAt: serializeInstant(row.next_fire_at),
        client: trx,
      })

      const { execution, isNew } = await createAutomationExecution({
        workspaceId: row.workspace_id,
        ruleId: row.rule_id,
        occurrenceId: occurrence.id,
        client: trx,
      })

      const nextFireAt = computeNextFireAt({
        scheduleKind: row.schedule_kind,
        scheduleExpr: row.schedule_expr || undefined,
        scheduleTimezone: row.schedule_timezone || undefined,
        intervalSeconds: row.interval_seconds || undefined,
        startsAt: serializeOptionalInstant(row.starts_at) ?? null,
        activeFrom: serializeOptionalInstant(row.active_from) ?? null,
        activeUntil: serializeOptionalInstant(row.active_until) ?? null,
        baseTime: row.next_fire_at,
        lastFiredAt: serializeInstant(row.next_fire_at),
      })

      await trx
        .updateTable("automation_triggers")
        .set({
          last_fired_at: row.next_fire_at,
          next_fire_at: nextFireAt ? parseInstantString(nextFireAt) : null,
        })
        .where("rule_id", "=", row.rule_id)
        .execute()
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
  const executionResult = await runQuery<AutomationExecutionRow>(
    `UPDATE automation_executions
     SET status = 'running',
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, NOW())
     WHERE id = $1
       AND status = 'pending'
     RETURNING *`,
    [executionId]
  )
  const executionRow = executionResult.rows[0]
  if (!executionRow) {
    const existingResult = await runBuilder(
      db,
      db
        .selectFrom("automation_executions")
        .select("id")
        .where("id", "=", executionId)
        .limit(1)
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
  const occurrenceResult = await runQuery<AutomationOccurrenceRow>(
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
      await db
        .updateTable("automation_executions")
        .set({
          status: "skipped",
          error_message: `Automation rule is ${rule.status}`,
          completed_at: sql`NOW()`,
        })
        .where("id", "=", executionId)
        .execute()
      return {
        executionId,
        wakeupCount: 0,
      }
    }

    const creatorParticipant = await resolveCreatorParticipant(rule)
    const { restrictedAudienceParticipantIds, targetParticipants } =
      await resolveDeliveryTargets(rule)
    if (targetParticipants.length === 0) {
      await db
        .updateTable("automation_executions")
        .set({
          status: "skipped",
          error_message:
            "No active target participants matched this automation",
          completed_at: sql`NOW()`,
        })
        .where("id", "=", executionId)
        .execute()
      await db
        .updateTable("automation_rules")
        .set({
          last_error_at: null,
          last_error_message: null,
        })
        .where("id", "=", rule.id)
        .execute()
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

    await db
      .updateTable("automation_executions")
      .set({
        status: "completed",
        error_message: null,
        completed_at: sql`NOW()`,
      })
      .where("id", "=", executionId)
      .execute()
    await db
      .updateTable("automation_rules")
      .set({
        last_triggered_at: sql`NOW()`,
        last_error_at: null,
        last_error_message: null,
      })
      .where("id", "=", rule.id)
      .execute()
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
    await db
      .insertInto("audit_logs")
      .values({
        workspace_id: rule.workspaceId,
        user_id: (await resolveOperatorUserId(rule)) || null,
        actor_id: creatorParticipant?.actor_id || null,
        action: "automation_rule.trigger",
        resource_type: "automation_rule",
        resource_id: rule.id,
        details: JSON.stringify({
          executionId,
          occurrenceId: occurrence.id,
          createdItemId,
          wakeupCount,
          targetCount: targetParticipants.length,
        }),
      })
      .execute()

    return {
      executionId,
      createdItemId,
      wakeupCount,
    }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .updateTable("automation_executions")
      .set({
        status: "failed",
        error_message: message,
        completed_at: sql`NOW()`,
      })
      .where("id", "=", executionId)
      .execute()
    await updateRuleError(rule.id, message)
    throw error
  }
}

export async function listAutomationExecutions(
  workspaceId: string,
  ruleId: string,
  limit = 50
) {
  const result = await runQuery<AutomationExecutionRow>(
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
            occurrence_created_at?: Date | null
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
