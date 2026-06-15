// automation/repo.ts — DB-touching helpers for the automation module.
//
// The only automation file (alongside repo.types.ts) permitted to import the db
// client (guard r8). Owns the integration-installation row read PLUS the
// module's raw-SQL runner layer, the withDbTransaction wrapper, the shared
// audit-log writer, and thin Kysely/runBuilder query helpers that the service
// composes. Selected DB JSONB business fields are decoded here before service
// orchestration consumes them. round-6 P1-6.
//
// Atomicity: every helper here that participates in a write transaction takes an
// injected `run: Executor` (or a `runner: QueryRunner` built from `runnerFor`)
// so the service can thread the trx the same statement runs on. The
// auto-committing defaults (`db`) are only used outside transactions.

import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { parseJsonObject } from "@synapse/shared"
import type {
  AutomationEventProviderKind,
  AutomationEventSourceStatus,
  AutomationExecutionStatus,
  AutomationIntegrationIngressKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
  AutomationSourceKind,
  AutomationWebhookEndpoint,
  Timestamp,
} from "@synapse/shared"
import {
  loadAutomationEventSourceAccessBindingRowsForSources,
  revokeAutomationEventSourceAccessBinding,
  updateAutomationEventSourceAccessGrantConversationTypeMaskOverride,
} from "../access/binding-storage.js"
import type { AutomationEventSourceBindingJoinedRow } from "../access/bindings.js"
import type {
  AutomationDeliveryDbRow,
  AutomationDeliveryRow,
  AutomationEventSourceDbRow,
  AutomationEventSourceRow,
  AutomationExecutionWithOccurrenceDbRow,
  AutomationExecutionWithOccurrenceRow,
  AutomationExecutionRow,
  AutomationIntegrationBindingRow,
  AutomationOccurrenceDbRow,
  AutomationOccurrenceRow,
  AutomationPolicyDbRow,
  AutomationPolicyRow,
  AutomationRuleDbRow,
  AutomationRuleRow,
  AutomationTriggerDbRow,
  AutomationTriggerRow,
  AutomationWebhookEndpointDbRow,
  AutomationWebhookEndpointRow,
  AutomationWebhookEventSourceRow,
} from "./repo.types.js"

export type {
  AutomationDeliveryDbRow,
  AutomationDeliveryRow,
  AutomationEventSourceDbRow,
  AutomationEventSourceRow,
  AutomationExecutionWithOccurrenceDbRow,
  AutomationExecutionWithOccurrenceRow,
  AutomationExecutionRow,
  AutomationIntegrationBindingRow,
  AutomationOccurrenceDbRow,
  AutomationOccurrenceRow,
  AutomationPolicyDbRow,
  AutomationPolicyRow,
  AutomationRuleDbRow,
  AutomationRuleRow,
  AutomationTriggerDbRow,
  AutomationTriggerRow,
  AutomationWebhookEndpointDbRow,
  AutomationWebhookEndpointRow,
  AutomationWebhookEventSourceRow,
} from "./repo.types.js"

export type IntegrationInstallationRow = {
  installationId: string
  workspaceId: string
  installationStatus: "active" | "disabled" | "error" | "archived"
  configData: Record<string, unknown>
  orgSlug: string
  itemSlug: string
  specMetadata: Record<string, unknown>
}

export type AutomationEventSourceReuseRow = {
  id: string
  metadata: Record<string, unknown>
}

export type IntegrationAutomationEventSourceReuseRow =
  AutomationEventSourceReuseRow & {
    status: AutomationEventSourceStatus
  }

export type AutomationRuleEventMatcherRecord = {
  ruleId: string
  matcher: Record<string, unknown>
}

export type AutomationPausedRuleRow = {
  id: string
  workspaceId: string
}

export type DueAutomationScheduleRow = {
  ruleId: string
  ruleName: string
  workspaceId: string
  scheduleKind: "cron" | "at" | "interval"
  scheduleExpr: string | null
  scheduleTimezone: string | null
  intervalSeconds: number | null
  startsAt: Date | null
  activeFrom: Date | null
  activeUntil: Date | null
  nextFireAt: Date
  lastFiredAt: Date | null
}

export type AutomationRuleLivenessMutationRow = {
  id: string
  workspaceId: string
}

type AutomationRuleComponentRawRow = {
  id: string
  workspaceId: string
  conversationId: string
  category: AutomationRuleDbRow["category"]
  status: AutomationRuleDbRow["status"]
  name: string
  description: string
  createdByParticipantId: string
  createdBySessionId: string | null
  lastTriggeredAt: Date | null
  lastErrorAt: Date | null
  lastErrorMessage: string | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

type AutomationTriggerComponentRawRow = {
  ruleId: string
  triggerKind: AutomationTriggerDbRow["trigger_kind"]
  sourceKind: AutomationTriggerDbRow["source_kind"]
  eventSourceId: string | null
  eventSourceKey?: string | null
  eventSourceName?: string | null
  eventProviderKind?: AutomationTriggerDbRow["event_provider_kind"]
  eventProviderRef?: string | null
  eventWebhookEndpointId?: string | null
  eventIntegrationBindingId?: string | null
  eventIntegrationInstallationId?: string | null
  eventIntegrationProvider?: AutomationTriggerDbRow["event_integration_provider"]
  eventIntegrationIngressKind?: AutomationTriggerDbRow["event_integration_ingress_kind"]
  eventIntegrationTargetKind?: AutomationTriggerDbRow["event_integration_target_kind"]
  eventIntegrationTargetId?: string | null
  eventIntegrationTargetLabel?: string | null
  eventIntegrationWebhookEndpointId?: string | null
  eventExternalSubscriptionId?: string | null
  eventSourceStatus?: AutomationTriggerDbRow["event_source_status"]
  sourceLocator: string | null
  matchKey: string | null
  matcher: unknown
  scheduleKind: string | null
  scheduleExpr: string | null
  scheduleTimezone: string | null
  intervalSeconds: number | null
  startsAt: Date | null
  nextFireAt: Date | null
  lastFiredAt: Date | null
  metadata: unknown
}

type AutomationPolicyComponentRawRow = {
  ruleId: string
  activeFrom: Date | null
  activeUntil: Date | null
  maxTriggerCount: number | null
  triggerCount: number
  completionStatus: AutomationPolicyDbRow["completion_status"]
  completedAt: Date | null
  metadata: unknown
}

type AutomationDeliveryComponentRawRow = {
  ruleId: string
  messageText: string
  wakeReasonText: string | null
  messageBlocks: unknown
  targetPolicy: AutomationDeliveryDbRow["target_policy"]
  metadata: unknown
}

type AutomationDeliveryTargetRawRow = {
  ruleId: string
  targetParticipantId: string
}

type AutomationEventSourceComponentRawRow = {
  id: string
  workspaceId: string
  providerKind: AutomationEventSourceDbRow["provider_kind"]
  providerRef: string | null
  webhookEndpointId: string | null
  integrationBindingId: string | null
  integrationInstallationId?: string | null
  integrationProvider?: AutomationEventSourceDbRow["integration_provider"]
  integrationIngressKind?: AutomationEventSourceDbRow["integration_ingress_kind"]
  integrationTargetKind?: AutomationEventSourceDbRow["integration_target_kind"]
  integrationTargetId?: string | null
  integrationTargetLabel?: string | null
  integrationWebhookEndpointId?: string | null
  integrationExternalSubscriptionId?: string | null
  sourceKey: string
  name: string
  description: string
  recommendedUsage: string
  payloadSchema: unknown
  examplePayload: unknown
  status: AutomationEventSourceDbRow["status"]
  createdByKind: AutomationEventSourceDbRow["created_by_kind"]
  createdByWorkspaceMemberId: string | null
  createdByActorId: string | null
  createdBySessionId: string | null
  lastTriggeredAt: Date | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

type AutomationWebhookEndpointRawRow = {
  id: string
  workspaceId: string
  name: string
  status: AutomationWebhookEndpoint["status"]
  pathToken: string
  secretCiphertext?: string | null
  secretHint: string
  metadata: unknown
  createdByWorkspaceMemberId: string | null
  lastReceivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type AutomationIntegrationBindingRawRow = {
  id: string
  workspaceId: string
  installationId: string
  provider: AutomationIntegrationBindingRow["provider"]
  ingressKind: AutomationIntegrationBindingRow["ingress_kind"]
  targetKind: AutomationIntegrationBindingRow["target_kind"]
  targetId: string
  targetLabel: string
  webhookEndpointId: string | null
  externalSubscriptionId: string | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

type AutomationWebhookEventSourceRawRow =
  AutomationEventSourceComponentRawRow & {
    endpointSecretCiphertext: string
    endpointName: string
    endpointId: string
  }

type AutomationOccurrenceRawRow = {
  id: string
  workspaceId: string
  sourceKind: AutomationOccurrenceDbRow["source_kind"]
  eventSourceId: string | null
  eventSourceKey?: string | null
  eventSourceName?: string | null
  eventProviderRef?: string | null
  eventWebhookEndpointId?: string | null
  eventIntegrationBindingId?: string | null
  eventIntegrationInstallationId?: string | null
  eventIntegrationProvider?: AutomationOccurrenceDbRow["event_integration_provider"]
  eventIntegrationIngressKind?: AutomationOccurrenceDbRow["event_integration_ingress_kind"]
  eventIntegrationTargetKind?: AutomationOccurrenceDbRow["event_integration_target_kind"]
  eventIntegrationTargetId?: string | null
  eventIntegrationTargetLabel?: string | null
  eventIntegrationWebhookEndpointId?: string | null
  eventExternalSubscriptionId?: string | null
  sourceLocator: string | null
  matchKey: string | null
  dedupeKey: string | null
  sourceSnapshot: unknown
  payload: unknown
  occurredAt: Date
  createdAt: Date
}

type AutomationExecutionRawRow = {
  id: string
  workspaceId: string
  ruleId: string
  executionRuleName?: string | null
  occurrenceId: string
  occurrenceOccurredAt?: Date | null
  occurrenceSourceKind?: AutomationExecutionRow["occurrence_source_kind"]
  occurrenceEventSourceName?: string | null
  occurrenceDisplayTitle?: string | null
  occurrenceDisplaySummary?: string | null
  occurrenceDisplayDescription?: string | null
  status: AutomationExecutionRow["status"]
  attemptCount: number
  errorMessage: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

type AutomationExecutionWithOccurrenceRawRow = AutomationExecutionRawRow & {
  occurrenceSourceKind?: AutomationExecutionWithOccurrenceDbRow["occurrence_source_kind"]
  eventSourceKey?: string | null
  eventProviderRef?: string | null
  sourceSnapshot?: unknown
  payload?: unknown
  sourceLocator?: string | null
  matchKey?: string | null
  dedupeKey?: string | null
  occurrenceCreatedAt?: Date | null
}

type IntegrationInstallationRawRow = Omit<
  IntegrationInstallationRow,
  "configData" | "specMetadata"
> & {
  configData: unknown
  specMetadata: unknown
}

export function normalizeIntegrationInstallationRow(
  row: IntegrationInstallationRawRow
): IntegrationInstallationRow {
  return {
    installationId: row.installationId,
    workspaceId: row.workspaceId,
    installationStatus: row.installationStatus,
    orgSlug: row.orgSlug,
    itemSlug: row.itemSlug,
    configData: parseJsonObject(row.configData),
    specMetadata: parseJsonObject(row.specMetadata),
  }
}

export function decodeAutomationEventSourceMetadata(row: {
  metadata: unknown
}): Record<string, unknown> {
  return parseJsonObject(row.metadata)
}

export function decodeAutomationTriggerMatcher(row: {
  matcher: unknown
}): Record<string, unknown> {
  return parseJsonObject(row.matcher)
}

export function normalizeAutomationRuleRow(
  row: AutomationRuleDbRow
): AutomationRuleRow {
  const normalized = {
    ...row,
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

export function normalizeAutomationTriggerRow(
  row: AutomationTriggerDbRow
): AutomationTriggerRow {
  const normalized = {
    ...row,
    matcher: parseJsonObject(row.matcher),
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

export function normalizeAutomationPolicyRow(
  row: AutomationPolicyDbRow
): AutomationPolicyRow {
  const normalized = {
    ...row,
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

export function normalizeAutomationDeliveryRow(
  row: AutomationDeliveryDbRow
): AutomationDeliveryRow {
  const normalized = {
    ...row,
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

export function normalizeAutomationEventSourceRow(
  row: AutomationEventSourceDbRow
): AutomationEventSourceRow {
  const normalized = {
    ...row,
    payload_schema: parseJsonObject(row.payload_schema),
    example_payload: parseJsonObject(row.example_payload),
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

export function normalizeAutomationOccurrenceRow(
  row: AutomationOccurrenceDbRow
): AutomationOccurrenceRow {
  const normalized = {
    ...row,
    source_snapshot: parseJsonObject(row.source_snapshot),
    payload: parseJsonObject(row.payload),
  }
  return normalized
}

export function normalizeAutomationExecutionWithOccurrenceRow(
  row: AutomationExecutionWithOccurrenceDbRow
): AutomationExecutionWithOccurrenceRow {
  const normalized = {
    ...row,
    source_snapshot: parseJsonObject(row.source_snapshot),
    payload: parseJsonObject(row.payload),
  }
  return normalized
}

export function normalizeAutomationWebhookEndpointRow(
  row: AutomationWebhookEndpointDbRow
): AutomationWebhookEndpointRow {
  const normalized = {
    ...row,
    metadata: parseJsonObject(row.metadata),
  }
  return normalized
}

/** Read one integration installation for a workspace, scoped to non-deleted workspace apps. */
export async function selectIntegrationInstallationRow(
  workspaceId: string,
  installationId: string
): Promise<IntegrationInstallationRow | undefined> {
  const row = (await db
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .innerJoin("catalogItems as item", "item.id", "installation.catalogItemId")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisherId")
    .innerJoin(
      "pluginPackageVersionSpecs as spec",
      "spec.catalogVersionId",
      "installation.catalogVersionId"
    )
    .select([
      "installation.id as installationId",
      "app.workspaceId as workspaceId",
      "app.status as installationStatus",
      "installation.configData",
      "publisher.slug as orgSlug",
      "item.slug as itemSlug",
      "spec.metadata as specMetadata",
    ])
    .where("installation.id", "=", installationId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()) as IntegrationInstallationRawRow | undefined

  return row ? normalizeIntegrationInstallationRow(row) : undefined
}

// ---------------------------------------------------------------------------
// Raw-SQL runner layer
// ---------------------------------------------------------------------------

export type SqlRunner = <T = any>(
  text: string,
  params?: unknown[]
) => Promise<{ rows: T[]; rowCount?: number | null }>

export type QueryRunner = {
  run: SqlRunner
}

/**
 * Adapt an {@link Executor} (the top-level `db` or a transaction) to the
 * `{ run(text, params) => { rows } }` runner convention used by the automation
 * service. Routes raw SQL through Kysely's `CompiledQuery.raw` so the same
 * statement runs on whichever executor (pool or trx) the caller holds.
 */
export function runnerFor(executor: Executor): QueryRunner {
  return {
    run: <T = any>(text: string, params?: unknown[]) =>
      executor.executeQuery<T>(
        CompiledQuery.raw(text, params ? [...params] : [])
      ) as Promise<{ rows: T[]; rowCount?: number | null }>,
  }
}

/** Resolve a runner for an optional executor, defaulting to the pool. */
export function resolveQueryRunner(executor?: Executor): QueryRunner {
  return runnerFor(executor ?? db)
}

/** Run raw SQL on the pool. */
export const runQuery: SqlRunner = (text, params) =>
  resolveQueryRunner().run(text, params)

function withCreatedAt(
  values: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...values,
    createdAt: sql`NOW()`,
  }
}

function toAutomationRuleDbRow(
  row: AutomationRuleComponentRawRow
): AutomationRuleDbRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    conversation_id: row.conversationId,
    category: row.category,
    status: row.status,
    name: row.name,
    description: row.description,
    created_by_participant_id: row.createdByParticipantId,
    created_by_session_id: row.createdBySessionId,
    last_triggered_at: row.lastTriggeredAt,
    last_error_at: row.lastErrorAt,
    last_error_message: row.lastErrorMessage,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toAutomationTriggerDbRow(
  row: AutomationTriggerComponentRawRow
): AutomationTriggerDbRow {
  return {
    rule_id: row.ruleId,
    trigger_kind: row.triggerKind,
    source_kind: row.sourceKind,
    event_source_id: row.eventSourceId,
    event_source_key: row.eventSourceKey,
    event_source_name: row.eventSourceName,
    event_provider_kind: row.eventProviderKind,
    event_provider_ref: row.eventProviderRef,
    event_webhook_endpoint_id: row.eventWebhookEndpointId,
    event_integration_binding_id: row.eventIntegrationBindingId,
    event_integration_installation_id: row.eventIntegrationInstallationId,
    event_integration_provider: row.eventIntegrationProvider,
    event_integration_ingress_kind: row.eventIntegrationIngressKind,
    event_integration_target_kind: row.eventIntegrationTargetKind,
    event_integration_target_id: row.eventIntegrationTargetId,
    event_integration_target_label: row.eventIntegrationTargetLabel,
    event_integration_webhook_endpoint_id:
      row.eventIntegrationWebhookEndpointId,
    event_external_subscription_id: row.eventExternalSubscriptionId,
    event_source_status: row.eventSourceStatus,
    source_locator: row.sourceLocator,
    match_key: row.matchKey,
    matcher: row.matcher,
    schedule_kind: row.scheduleKind,
    schedule_expr: row.scheduleExpr,
    schedule_timezone: row.scheduleTimezone,
    interval_seconds: row.intervalSeconds,
    starts_at: row.startsAt,
    next_fire_at: row.nextFireAt,
    last_fired_at: row.lastFiredAt,
    metadata: row.metadata,
  }
}

function toAutomationPolicyDbRow(
  row: AutomationPolicyComponentRawRow
): AutomationPolicyDbRow {
  return {
    rule_id: row.ruleId,
    active_from: row.activeFrom,
    active_until: row.activeUntil,
    max_trigger_count: row.maxTriggerCount,
    trigger_count: row.triggerCount,
    completion_status: row.completionStatus,
    completed_at: row.completedAt,
    metadata: row.metadata,
  }
}

function toAutomationDeliveryDbRow(
  row: AutomationDeliveryComponentRawRow
): AutomationDeliveryDbRow {
  return {
    rule_id: row.ruleId,
    message_text: row.messageText,
    wake_reason_text: row.wakeReasonText,
    message_blocks: row.messageBlocks,
    target_policy: row.targetPolicy,
    metadata: row.metadata,
  }
}

function automationEventSourceJoinClause(
  eventSourceAlias = "aes",
  bindingAlias = "aib"
) {
  return `LEFT JOIN automation_integration_bindings_live ${bindingAlias} ON ${bindingAlias}.id = ${eventSourceAlias}.integration_binding_id`
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

function toAutomationEventSourceDbRow(
  row: AutomationEventSourceComponentRawRow
): AutomationEventSourceDbRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    provider_kind: row.providerKind,
    provider_ref: row.providerRef,
    webhook_endpoint_id: row.webhookEndpointId,
    integration_binding_id: row.integrationBindingId,
    integration_installation_id: row.integrationInstallationId,
    integration_provider: row.integrationProvider,
    integration_ingress_kind: row.integrationIngressKind,
    integration_target_kind: row.integrationTargetKind,
    integration_target_id: row.integrationTargetId,
    integration_target_label: row.integrationTargetLabel,
    integration_webhook_endpoint_id: row.integrationWebhookEndpointId,
    integration_external_subscription_id: row.integrationExternalSubscriptionId,
    source_key: row.sourceKey,
    name: row.name,
    description: row.description,
    recommended_usage: row.recommendedUsage,
    payload_schema: row.payloadSchema,
    example_payload: row.examplePayload,
    status: row.status,
    created_by_kind: row.createdByKind,
    created_by_workspace_member_id: row.createdByWorkspaceMemberId,
    created_by_actor_id: row.createdByActorId,
    created_by_session_id: row.createdBySessionId,
    last_triggered_at: row.lastTriggeredAt,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toAutomationWebhookEndpointDbRow(
  row: AutomationWebhookEndpointRawRow
): AutomationWebhookEndpointDbRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    status: row.status,
    path_token: row.pathToken,
    secret_ciphertext: row.secretCiphertext || undefined,
    secret_hint: row.secretHint,
    metadata: row.metadata,
    created_by_workspace_member_id: row.createdByWorkspaceMemberId,
    last_received_at: row.lastReceivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toAutomationIntegrationBindingRow(
  row: AutomationIntegrationBindingRawRow
): AutomationIntegrationBindingRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    installation_id: row.installationId,
    provider: row.provider,
    ingress_kind: row.ingressKind,
    target_kind: row.targetKind,
    target_id: row.targetId,
    target_label: row.targetLabel,
    webhook_endpoint_id: row.webhookEndpointId,
    external_subscription_id: row.externalSubscriptionId,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toAutomationWebhookEventSourceRow(
  row: AutomationWebhookEventSourceRawRow
): AutomationWebhookEventSourceRow {
  return {
    ...normalizeAutomationEventSourceRow(toAutomationEventSourceDbRow(row)),
    endpoint_secret_ciphertext: row.endpointSecretCiphertext,
    endpoint_name: row.endpointName,
    endpoint_id: row.endpointId,
  }
}

function toAutomationOccurrenceDbRow(
  row: AutomationOccurrenceRawRow
): AutomationOccurrenceDbRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    source_kind: row.sourceKind,
    event_source_id: row.eventSourceId,
    event_source_key: row.eventSourceKey,
    event_source_name: row.eventSourceName,
    event_provider_ref: row.eventProviderRef,
    event_webhook_endpoint_id: row.eventWebhookEndpointId,
    event_integration_binding_id: row.eventIntegrationBindingId,
    event_integration_installation_id: row.eventIntegrationInstallationId,
    event_integration_provider: row.eventIntegrationProvider,
    event_integration_ingress_kind: row.eventIntegrationIngressKind,
    event_integration_target_kind: row.eventIntegrationTargetKind,
    event_integration_target_id: row.eventIntegrationTargetId,
    event_integration_target_label: row.eventIntegrationTargetLabel,
    event_integration_webhook_endpoint_id:
      row.eventIntegrationWebhookEndpointId,
    event_external_subscription_id: row.eventExternalSubscriptionId,
    source_locator: row.sourceLocator,
    match_key: row.matchKey,
    dedupe_key: row.dedupeKey,
    source_snapshot: row.sourceSnapshot,
    payload: row.payload,
    occurred_at: row.occurredAt,
    created_at: row.createdAt,
  }
}

function toAutomationExecutionRow(
  row: AutomationExecutionRawRow
): AutomationExecutionRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    rule_id: row.ruleId,
    execution_rule_name: row.executionRuleName,
    occurrence_id: row.occurrenceId,
    occurrence_occurred_at: row.occurrenceOccurredAt,
    occurrence_source_kind: row.occurrenceSourceKind,
    occurrence_event_source_name: row.occurrenceEventSourceName,
    occurrence_display_title: row.occurrenceDisplayTitle,
    occurrence_display_summary: row.occurrenceDisplaySummary,
    occurrence_display_description: row.occurrenceDisplayDescription,
    status: row.status,
    attempt_count: row.attemptCount,
    error_message: row.errorMessage,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function toAutomationExecutionWithOccurrenceDbRow(
  row: AutomationExecutionWithOccurrenceRawRow
): AutomationExecutionWithOccurrenceDbRow {
  return {
    ...toAutomationExecutionRow(row),
    occurrence_source_kind: row.occurrenceSourceKind,
    event_source_key: row.eventSourceKey,
    event_provider_ref: row.eventProviderRef,
    source_snapshot: row.sourceSnapshot,
    payload: row.payload,
    source_locator: row.sourceLocator,
    match_key: row.matchKey,
    dedupe_key: row.dedupeKey,
    occurrence_created_at: row.occurrenceCreatedAt,
  }
}

export async function loadAutomationRuleComponentRows(
  workspaceId: string,
  ruleIds: string[],
  executor: Executor = db
): Promise<{
  rules: AutomationRuleDbRow[]
  triggers: AutomationTriggerDbRow[]
  policies: AutomationPolicyDbRow[]
  deliveries: AutomationDeliveryDbRow[]
  targetsByRule: Map<string, string[]>
}> {
  if (ruleIds.length === 0) {
    return {
      rules: [],
      triggers: [],
      policies: [],
      deliveries: [],
      targetsByRule: new Map(),
    }
  }
  const runner = resolveQueryRunner(executor)

  const [
    rulesResult,
    triggersResult,
    policiesResult,
    deliveriesResult,
    targetsResult,
  ] = await Promise.all([
    runner.run<AutomationRuleComponentRawRow>(
      `SELECT *
       FROM automation_rules
       WHERE workspace_id = $1::uuid
         AND id = ANY($2::uuid[])
         AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [workspaceId, ruleIds]
    ),
    runner.run<AutomationTriggerComponentRawRow>(
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
       LEFT JOIN automation_event_sources_live aes ON aes.id = at.event_source_id
       LEFT JOIN automation_integration_bindings_live aib ON aib.id = aes.integration_binding_id
       WHERE at.rule_id = ANY($1::uuid[])`,
      [ruleIds]
    ),
    runner.run<AutomationPolicyComponentRawRow>(
      `SELECT *
       FROM automation_policies
       WHERE rule_id = ANY($1::uuid[])`,
      [ruleIds]
    ),
    runner.run<AutomationDeliveryComponentRawRow>(
      `SELECT *
       FROM automation_deliveries
       WHERE rule_id = ANY($1::uuid[])`,
      [ruleIds]
    ),
    runner.run<AutomationDeliveryTargetRawRow>(
      `SELECT rule_id, target_participant_id
       FROM automation_delivery_targets
       WHERE rule_id = ANY($1::uuid[])
       ORDER BY created_at ASC`,
      [ruleIds]
    ),
  ])

  const targetsByRule = new Map<string, string[]>()
  for (const row of targetsResult.rows) {
    const existing = targetsByRule.get(row.ruleId) || []
    existing.push(row.targetParticipantId)
    targetsByRule.set(row.ruleId, existing)
  }

  return {
    rules: rulesResult.rows.map(toAutomationRuleDbRow),
    triggers: triggersResult.rows.map(toAutomationTriggerDbRow),
    policies: policiesResult.rows.map(toAutomationPolicyDbRow),
    deliveries: deliveriesResult.rows.map(toAutomationDeliveryDbRow),
    targetsByRule,
  }
}

export async function pauseAutomationRuleRowsForEventSource(params: {
  eventSourceId: string
  category: AutomationRuleDbRow["category"]
  reason: string
  executor?: Executor
}): Promise<AutomationPausedRuleRow[]> {
  const runner = resolveQueryRunner(params.executor)
  const result = await runner.run<AutomationPausedRuleRow>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $2
     FROM automation_triggers at
     WHERE at.rule_id = ar.id
       AND at.event_source_id = $1::uuid
       AND ar.category = $3::automation_rules_category
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
     RETURNING ar.id, ar.workspace_id`,
    [params.eventSourceId, params.reason, params.category]
  )
  return result.rows
}

export async function listActiveEventSubscriptionRuleRowsByEventSource(params: {
  eventSourceId: string
  category: AutomationRuleDbRow["category"]
  executor?: Executor
}): Promise<AutomationRuleDbRow[]> {
  const runner = resolveQueryRunner(params.executor)
  const result = await runner.run<AutomationRuleComponentRawRow>(
    `SELECT ar.*
     FROM automation_rules_live ar
     JOIN automation_triggers at
       ON at.rule_id = ar.id
     WHERE at.event_source_id = $1::uuid
       AND ar.category = $2::automation_rules_category
       AND ar.status = 'active'`,
    [params.eventSourceId, params.category]
  )
  return result.rows.map(toAutomationRuleDbRow)
}

export async function getAutomationEventSourceRow(params: {
  workspaceId: string
  eventSourceId: string
  executor?: Executor
}): Promise<AutomationEventSourceDbRow | null> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationEventSourceComponentRawRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")}
     FROM automation_event_sources_live aes
     ${automationEventSourceJoinClause("aes", "aib")}
     WHERE aes.workspace_id = $1::uuid
       AND aes.id = $2::uuid
     LIMIT 1`,
    [params.workspaceId, params.eventSourceId]
  )
  const row = result.rows[0]
  return row ? toAutomationEventSourceDbRow(row) : null
}

export async function listAutomationEventSourceRows(params: {
  workspaceId: string
  filters?: {
    status?: AutomationEventSourceStatus
    providerKind?: AutomationEventProviderKind
    providerRef?: string
    sourceKey?: string
  }
  executor?: Executor
}): Promise<AutomationEventSourceDbRow[]> {
  const values: unknown[] = [params.workspaceId]
  let where = "aes.workspace_id = $1::uuid"

  if (params.filters?.status) {
    values.push(params.filters.status)
    where += ` AND aes.status = $${values.length}::automation_event_sources_status`
  }
  if (params.filters?.providerKind) {
    values.push(params.filters.providerKind)
    where += ` AND aes.provider_kind = $${values.length}::automation_event_sources_provider_kind`
  }
  if (params.filters?.providerRef !== undefined) {
    values.push(params.filters.providerRef)
    where += ` AND COALESCE(aes.provider_ref, '') = COALESCE($${values.length}::text, '')`
  }
  if (params.filters?.sourceKey) {
    values.push(params.filters.sourceKey)
    where += ` AND aes.source_key = $${values.length}::text`
  }

  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationEventSourceComponentRawRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")}
     FROM automation_event_sources_live aes
     ${automationEventSourceJoinClause("aes", "aib")}
     WHERE ${where}
     ORDER BY aes.created_at DESC`,
    values
  )
  return result.rows.map(toAutomationEventSourceDbRow)
}

export async function selectWebhookAutomationEventSourceByPathToken(params: {
  pathToken: string
  sourceKey: string
  executor?: Executor
}): Promise<AutomationWebhookEventSourceRow | null> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationWebhookEventSourceRawRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")},
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_event_sources_live aes
     ${automationEventSourceJoinClause("aes", "aib")}
     JOIN automation_webhook_endpoints_live awe
       ON awe.id = aes.webhook_endpoint_id
     WHERE awe.path_token = $1::text
       AND awe.status = 'active'
       AND aes.provider_kind = 'webhook'
       AND aes.source_key = $2::text
       AND aes.status IN ('active', 'deprecated')
     LIMIT 1`,
    [params.pathToken, params.sourceKey]
  )
  const row = result.rows[0]
  return row ? toAutomationWebhookEventSourceRow(row) : null
}

export async function listIntegrationAutomationEventSourceRowsByWebhookPathToken(params: {
  pathToken: string
  executor?: Executor
}): Promise<AutomationWebhookEventSourceRow[]> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationWebhookEventSourceRawRow>(
    `SELECT ${automationEventSourceSelectClause("aes", "aib")},
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_integration_bindings_live aib
     JOIN automation_webhook_endpoints_live awe
       ON awe.id = aib.webhook_endpoint_id
     JOIN automation_event_sources_live aes
       ON aes.integration_binding_id = aib.id
     WHERE awe.path_token = $1::text
       AND awe.status = 'active'
       AND aib.ingress_kind = 'webhook'
       AND aes.provider_kind = 'integration'
       AND aes.status IN ('active', 'deprecated')
     ORDER BY aes.created_at ASC`,
    [params.pathToken]
  )
  return result.rows.map(toAutomationWebhookEventSourceRow)
}

export async function listAutomationRuleIds(params: {
  workspaceId: string
  filters?: {
    status?: AutomationRuleDbRow["status"]
    category?: AutomationRuleDbRow["category"]
    conversationId?: string
  }
  executor?: Executor
}): Promise<string[]> {
  const values: unknown[] = [params.workspaceId]
  let where = "workspace_id = $1::uuid"

  if (params.filters?.status) {
    values.push(params.filters.status)
    where += ` AND status = $${values.length}::automation_rules_status`
  }
  if (params.filters?.category) {
    values.push(params.filters.category)
    where += ` AND category = $${values.length}::automation_rules_category`
  }
  if (params.filters?.conversationId) {
    values.push(params.filters.conversationId)
    where += ` AND conversation_id = $${values.length}::uuid`
  }

  const result = await resolveQueryRunner(params.executor).run<{ id: string }>(
    `SELECT id
     FROM automation_rules_live
     WHERE ${where}
     ORDER BY created_at DESC`,
    values
  )
  return result.rows.map((row) => row.id)
}

export async function listAutomationOccurrenceRows(params: {
  workspaceId: string
  filters?: {
    eventSourceId?: string
    limit?: number
  }
  executor?: Executor
}): Promise<AutomationOccurrenceDbRow[]> {
  const values: unknown[] = [params.workspaceId]
  let where = "ao.workspace_id = $1::uuid"

  if (params.filters?.eventSourceId) {
    values.push(params.filters.eventSourceId)
    where += ` AND ao.event_source_id = $${values.length}::uuid`
  }

  values.push(Math.max(1, Math.min(params.filters?.limit || 50, 200)))
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationOccurrenceRawRow>(
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
     LEFT JOIN automation_event_sources_live aes ON aes.id = ao.event_source_id
     LEFT JOIN automation_integration_bindings_live aib ON aib.id = aes.integration_binding_id
     WHERE ${where}
     ORDER BY ao.created_at DESC
     LIMIT $${values.length}`,
    values
  )
  return result.rows.map(toAutomationOccurrenceDbRow)
}

export async function selectAutomationOccurrenceRowByDedupeKey(params: {
  workspaceId: string
  sourceKind: AutomationSourceKind
  eventSourceId?: string | null
  dedupeKey: string
  executor?: Executor
}): Promise<AutomationOccurrenceDbRow | null> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationOccurrenceRawRow>(
    `SELECT *
     FROM automation_occurrences
     WHERE workspace_id = $1::uuid
       AND ${
         params.eventSourceId
           ? "event_source_id = $2::uuid"
           : "source_kind = $2::automation_occurrences_source_kind"
       }
       AND dedupe_key = $3
     LIMIT 1`,
    [
      params.workspaceId,
      params.eventSourceId || params.sourceKind,
      params.dedupeKey,
    ]
  )
  const row = result.rows[0]
  return row ? toAutomationOccurrenceDbRow(row) : null
}

export async function insertAutomationOccurrenceReturningRow(params: {
  id: string
  workspaceId: string
  sourceKind: AutomationSourceKind
  eventSourceId?: string | null
  sourceLocator?: string | null
  matchKey?: string | null
  dedupeKey?: string | null
  sourceSnapshot: Record<string, unknown>
  payload: Record<string, unknown>
  occurredAt: Timestamp
  executor?: Executor
}): Promise<AutomationOccurrenceDbRow> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationOccurrenceRawRow>(
    `INSERT INTO automation_occurrences
       (id, workspace_id, source_kind, event_source_id, source_locator, match_key, dedupe_key, source_snapshot, payload, occurred_at, created_at)
     VALUES ($1, $2, $3::automation_occurrences_source_kind, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      params.id,
      params.workspaceId,
      params.sourceKind,
      params.eventSourceId || null,
      params.sourceLocator || null,
      params.matchKey || null,
      params.dedupeKey || null,
      JSON.stringify(params.sourceSnapshot),
      JSON.stringify(params.payload),
      params.occurredAt,
    ]
  )
  return toAutomationOccurrenceDbRow(result.rows[0]!)
}

export async function claimPendingAutomationExecutionRow(
  executionId: string,
  executor?: Executor
): Promise<AutomationExecutionRow | null> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationExecutionRawRow>(
    `UPDATE automation_executions
     SET status = 'running',
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, NOW())
     WHERE id = $1::uuid
       AND status = 'pending'
     RETURNING *`,
    [executionId]
  )
  const row = result.rows[0]
  return row ? toAutomationExecutionRow(row) : null
}

export async function selectAutomationExecutionRowByRuleOccurrence(params: {
  ruleId: string
  occurrenceId: string
  executor?: Executor
}): Promise<AutomationExecutionRow | null> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationExecutionRawRow>(
    `SELECT *
     FROM automation_executions
     WHERE rule_id = $1::uuid
       AND occurrence_id = $2::uuid
     LIMIT 1`,
    [params.ruleId, params.occurrenceId]
  )
  const row = result.rows[0]
  return row ? toAutomationExecutionRow(row) : null
}

export async function insertAutomationExecutionReturningRow(params: {
  id: string
  workspaceId: string
  ruleId: string
  occurrenceId: string
  executor?: Executor
}): Promise<AutomationExecutionRow> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationExecutionRawRow>(
    `INSERT INTO automation_executions
       (id, workspace_id, rule_id, occurrence_id, status, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, NOW(), NOW())
     RETURNING *`,
    [params.id, params.workspaceId, params.ruleId, params.occurrenceId]
  )
  return toAutomationExecutionRow(result.rows[0]!)
}

export async function selectAutomationOccurrenceRow(
  occurrenceId: string,
  executor?: Executor
): Promise<AutomationOccurrenceDbRow | null> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationOccurrenceRawRow>(
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
     LEFT JOIN automation_event_sources_live aes ON aes.id = ao.event_source_id
     LEFT JOIN automation_integration_bindings_live aib ON aib.id = aes.integration_binding_id
     WHERE ao.id = $1::uuid
     LIMIT 1`,
    [occurrenceId]
  )
  const row = result.rows[0]
  return row ? toAutomationOccurrenceDbRow(row) : null
}

export async function listAutomationExecutionRows(params: {
  workspaceId: string
  ruleId: string
  limit?: number
  executor?: Executor
}): Promise<AutomationExecutionWithOccurrenceDbRow[]> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationExecutionWithOccurrenceRawRow>(
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
     LEFT JOIN automation_rules_live ar ON ar.id = ae.rule_id
     LEFT JOIN automation_occurrences ao ON ao.id = ae.occurrence_id
     LEFT JOIN automation_event_sources_live aes ON aes.id = ao.event_source_id
     WHERE ae.workspace_id = $1::uuid
       AND ae.rule_id = $2::uuid
     ORDER BY ae.created_at DESC
     LIMIT $3`,
    [
      params.workspaceId,
      params.ruleId,
      Math.max(1, Math.min(params.limit || 50, 200)),
    ]
  )
  return result.rows.map(toAutomationExecutionWithOccurrenceDbRow)
}

// ---------------------------------------------------------------------------
// Transaction wrapper (so the service never imports withDbTransaction directly)
// ---------------------------------------------------------------------------

/**
 * Open an automation write transaction. Thin re-export of the infrastructure
 * `withDbTransaction` so transaction orchestration stays in the service (it
 * wraps cross-module side-effects + audit writes) while the db client stays in
 * the repo. The service threads the supplied `trx` into the repo runners.
 */
export const withAutomationTransaction = withDbTransaction

// ---------------------------------------------------------------------------
// Audit log writer (replaces the inline db.insertInto("auditLogs") calls)
// ---------------------------------------------------------------------------

export type AutomationAuditLogRecord = {
  workspaceId: string
  userId?: string | null
  actorId?: string | null
  action: string
  resourceType: string
  resourceId: string
  details: Record<string, unknown>
}

/**
 * Append an audit-log row via Kysely (CamelCasePlugin). Runs on the supplied
 * executor (defaulting to the pool) so it can participate in a write
 * transaction. `details` is JSON-encoded here at the repo boundary.
 */
export async function appendAutomationAuditLog(
  rec: AutomationAuditLogRecord,
  run: Executor = db
) {
  await run
    .insertInto("auditLogs")
    .values({
      workspaceId: rec.workspaceId,
      userId: rec.userId ?? null,
      actorId: rec.actorId ?? null,
      action: rec.action,
      resourceType: rec.resourceType,
      resourceId: rec.resourceId,
      details: JSON.stringify(rec.details),
    })
    .execute()
}

// ---------------------------------------------------------------------------
// Event-source provider validation / key allocation probes
// ---------------------------------------------------------------------------

/** Existence probe for an active webhook endpoint owned by the workspace. */
export async function selectActiveWebhookEndpointId(
  workspaceId: string,
  endpointId: string
): Promise<string | undefined> {
  const result = await runBuilder<{ id: string }>(
    db,
    db
      .selectFrom("automationWebhookEndpoints")
      .select("id")
      .where("id", "=", endpointId)
      .where("workspaceId", "=", workspaceId)
      .where("status", "=", "active")
      .limit(1)
  )
  return result.rows[0]?.id
}

/** Existence probe: does an event source already use this source key? */
export async function existsAutomationEventSourceKey(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string | null
  sourceKey: string
}): Promise<boolean> {
  const result = await runBuilder<{ id: string }>(
    db,
    db
      .selectFrom("automationEventSources")
      .select("id")
      .where("workspaceId", "=", params.workspaceId)
      .where("providerKind", "=", params.providerKind)
      .where(
        sql`COALESCE(provider_ref, '')`,
        "=",
        sql`COALESCE(${params.providerRef || null}, '')`
      )
      .where("sourceKey", "=", params.sourceKey)
      .limit(1)
  )
  return Boolean(result.rows[0])
}

/**
 * Reuse probe for an integration event source by binding + source key. Returns
 * the id/status/metadata projection (metadata raw, decoded by the service).
 */
export async function selectIntegrationEventSourceReuseRow(params: {
  workspaceId: string
  bindingId: string
  sourceKey: string
}): Promise<IntegrationAutomationEventSourceReuseRow | undefined> {
  const result = await runBuilder<{
    id: string
    status: AutomationEventSourceStatus
    metadata: unknown
  }>(
    db,
    db
      .selectFrom("automationEventSources")
      .select(["id", "status", "metadata"])
      .where("workspaceId", "=", params.workspaceId)
      .where("providerKind", "=", "integration")
      .where("integrationBindingId", "=", params.bindingId)
      .where("sourceKey", "=", params.sourceKey)
      .limit(1)
  )
  const row = result.rows[0]
  return row
    ? {
        id: row.id,
        status: row.status,
        metadata: decodeAutomationEventSourceMetadata(row),
      }
    : undefined
}

/**
 * Reuse probe for a non-integration event source by provider + source key.
 * Returns the id/metadata projection (metadata raw).
 */
export async function selectAutomationEventSourceReuseRow(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string | null
  sourceKey: string
}): Promise<AutomationEventSourceReuseRow | undefined> {
  const result = await runBuilder<{ id: string; metadata: unknown }>(
    db,
    db
      .selectFrom("automationEventSources")
      .select(["id", "metadata"])
      .where("workspaceId", "=", params.workspaceId)
      .where("providerKind", "=", params.providerKind)
      .where(
        sql`COALESCE(provider_ref, '')`,
        "=",
        sql`COALESCE(${params.providerRef || null}, '')`
      )
      .where("sourceKey", "=", params.sourceKey)
      .limit(1)
  )
  const row = result.rows[0]
  return row
    ? { id: row.id, metadata: decodeAutomationEventSourceMetadata(row) }
    : undefined
}

/**
 * Resolve an active/deprecated, non-deleted event source id by provider + key.
 * Used by provider-event ingestion to locate the source.
 */
export async function selectActiveAutomationEventSourceId(params: {
  workspaceId: string
  providerKind: AutomationEventProviderKind
  providerRef?: string | null
  sourceKey: string
}): Promise<string | undefined> {
  const result = await runBuilder<{ id: string }>(
    db,
    db
      .selectFrom("automationEventSources")
      .select("id")
      .where("workspaceId", "=", params.workspaceId)
      .where("providerKind", "=", params.providerKind)
      .where(
        sql`COALESCE(provider_ref, '')`,
        "=",
        sql`COALESCE(${params.providerRef || null}, '')`
      )
      .where("sourceKey", "=", params.sourceKey)
      .where("status", "in", ["active", "deprecated"])
      .where("deletedAt", "is", null)
      .limit(1)
  )
  return result.rows[0]?.id
}

/**
 * Load active event-triggered rules for an event source and decode trigger
 * matcher JSON at the repo exit. The service only applies subsetMatch against
 * already-decoded matcher objects.
 */
export async function selectActiveAutomationRuleEventMatchers(params: {
  workspaceId: string
  eventSourceId: string
  occurredAt: Timestamp
}): Promise<AutomationRuleEventMatcherRecord[]> {
  const result = await runQuery<{ id: string; matcher: unknown }>(
    `SELECT ar.id, at.matcher
     FROM automation_rules_live ar
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

  return result.rows.map((row) => ({
    ruleId: row.id,
    matcher: decodeAutomationTriggerMatcher(row),
  }))
}

// ---------------------------------------------------------------------------
// Rule / policy / delivery write helpers (run on the supplied trx)
// ---------------------------------------------------------------------------

/** Insert an automation_rules row on the given executor (encoded value-bag). */
export async function insertAutomationRuleRow(
  run: Executor,
  values: Record<string, unknown>
) {
  await run
    .insertInto("automationRules")
    .values(withCreatedAt(values) as never)
    .execute()
}

/** Update an automation_rules row by id on the given executor. */
export async function updateAutomationRuleRow(
  run: Executor,
  ruleId: string,
  values: Record<string, unknown>
) {
  await run
    .updateTable("automationRules")
    .set(values as never)
    .where("id", "=", ruleId)
    .execute()
}

/** Insert an automation_policies row on the given executor. */
export async function insertAutomationPolicyRow(
  run: Executor,
  values: Record<string, unknown>
) {
  await run
    .insertInto("automationPolicies")
    .values(withCreatedAt(values) as never)
    .execute()
}

/** Update an automation_policies row by ruleId on the given executor. */
export async function updateAutomationPolicyRow(
  run: Executor,
  ruleId: string,
  values: Record<string, unknown>
) {
  await run
    .updateTable("automationPolicies")
    .set(values as never)
    .where("ruleId", "=", ruleId)
    .execute()
}

/** Insert an automation_deliveries row on the given executor. */
export async function insertAutomationDeliveryRow(
  run: Executor,
  values: Record<string, unknown>
) {
  await run
    .insertInto("automationDeliveries")
    .values(withCreatedAt(values) as never)
    .execute()
}

/** Update an automation_deliveries row by ruleId on the given executor. */
export async function updateAutomationDeliveryRow(
  run: Executor,
  ruleId: string,
  values: Record<string, unknown>
) {
  await run
    .updateTable("automationDeliveries")
    .set(values as never)
    .where("ruleId", "=", ruleId)
    .execute()
}

export async function insertAutomationTriggerRow(
  run: Executor,
  ruleId: string,
  trigger: Omit<AutomationTriggerRow, "rule_id">
) {
  await run
    .insertInto("automationTriggers")
    .values({
      ruleId,
      triggerKind: trigger.trigger_kind,
      sourceKind: trigger.source_kind,
      eventSourceId: trigger.event_source_id,
      sourceLocator: trigger.source_locator,
      matchKey: trigger.match_key,
      matcher: JSON.stringify(trigger.matcher),
      scheduleKind: trigger.schedule_kind,
      scheduleExpr: trigger.schedule_expr,
      scheduleTimezone: trigger.schedule_timezone,
      intervalSeconds: trigger.interval_seconds,
      startsAt: trigger.starts_at,
      nextFireAt: trigger.next_fire_at,
      lastFiredAt: trigger.last_fired_at,
      metadata: JSON.stringify(trigger.metadata),
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    } as never)
    .execute()
}

export async function updateAutomationTriggerRow(
  run: Executor,
  ruleId: string,
  trigger: Omit<AutomationTriggerRow, "rule_id" | "last_fired_at">
) {
  await run
    .updateTable("automationTriggers")
    .set({
      triggerKind: trigger.trigger_kind,
      sourceKind: trigger.source_kind,
      eventSourceId: trigger.event_source_id,
      sourceLocator: trigger.source_locator,
      matchKey: trigger.match_key,
      matcher: JSON.stringify(trigger.matcher),
      scheduleKind: trigger.schedule_kind,
      scheduleExpr: trigger.schedule_expr,
      scheduleTimezone: trigger.schedule_timezone,
      intervalSeconds: trigger.interval_seconds,
      startsAt: trigger.starts_at,
      nextFireAt: trigger.next_fire_at,
      metadata: JSON.stringify(trigger.metadata),
    } as never)
    .where("ruleId", "=", ruleId)
    .execute()
}

export async function persistAutomationDeliveryTargets(
  run: Executor,
  ruleId: string,
  targetParticipantIds: string[]
) {
  await run
    .deleteFrom("automationDeliveryTargets")
    .where("ruleId", "=", ruleId)
    .execute()

  if (targetParticipantIds.length === 0) {
    return
  }

  await run
    .insertInto("automationDeliveryTargets")
    .values(
      targetParticipantIds.map((targetParticipantId) => ({
        ruleId,
        targetParticipantId,
        createdAt: sql`NOW()`,
      })) as never
    )
    .execute()
}

/** Update an automation_triggers row's lastFiredAt/nextFireAt on the executor. */
export async function updateAutomationTriggerSchedule(
  run: Executor,
  ruleId: string,
  values: { lastFiredAt: Date | null; nextFireAt: Date | null }
) {
  await run
    .updateTable("automationTriggers")
    .set(values as never)
    .where("ruleId", "=", ruleId)
    .execute()
}

export async function lockDueAutomationScheduleRows(
  run: Executor,
  batchSize: number
): Promise<DueAutomationScheduleRow[]> {
  const result = await runnerFor(run).run<DueAutomationScheduleRow>(
    `SELECT at.rule_id, ar.name AS rule_name, ar.workspace_id, at.schedule_kind, at.schedule_expr, at.schedule_timezone,
            at.interval_seconds, at.starts_at, ap.active_from, ap.active_until, at.next_fire_at, at.last_fired_at
     FROM automation_triggers at
     JOIN automation_rules_live ar ON ar.id = at.rule_id
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
  return result.rows
}

export async function expireAutomationRuleRows(params: {
  referenceTime: Timestamp
  workspaceId?: string
  executor?: Executor
}): Promise<AutomationRuleLivenessMutationRow[]> {
  const executor = params.executor ?? db
  const runner = runnerFor(executor)
  const result = await runner.run<AutomationRuleLivenessMutationRow>(
    `UPDATE automation_rules ar
     SET status = 'expired'
     FROM automation_policies ap
     WHERE ap.rule_id = ar.id
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
       AND ap.active_until IS NOT NULL
       AND ap.active_until < $1
       ${params.workspaceId ? "AND ar.workspace_id = $2" : ""}
     RETURNING ar.id, ar.workspace_id AS "workspaceId"`,
    params.workspaceId
      ? [params.referenceTime, params.workspaceId]
      : [params.referenceTime]
  )

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `UPDATE automation_policies
         SET completed_at = COALESCE(completed_at, $2)
         WHERE rule_id = $1`,
        [row.id, params.referenceTime]
      )
    )
  )

  await Promise.all(
    result.rows.map((row) =>
      appendAutomationAuditLog(
        {
          workspaceId: row.workspaceId,
          action: "automation_rule.expire",
          resourceType: "automation_rule",
          resourceId: row.id,
          details: {
            referenceTime: params.referenceTime,
          },
        },
        executor
      )
    )
  )

  return result.rows
}

export async function pauseAutomationRuleRowsForInactiveCreators(params: {
  workspaceId?: string
  executor?: Executor
}): Promise<AutomationRuleLivenessMutationRow[]> {
  const executor = params.executor ?? db
  const runner = runnerFor(executor)
  const reason = "Creator participant is no longer active"
  const result = await runner.run<AutomationRuleLivenessMutationRow>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $1
     FROM conversation_participants cp
     WHERE cp.id = ar.created_by_participant_id
       AND ar.status = 'active'
       AND ar.deleted_at IS NULL
       AND cp.state <> 'active'
       ${params.workspaceId ? "AND ar.workspace_id = $2" : ""}
     RETURNING ar.id, ar.workspace_id AS "workspaceId"`,
    params.workspaceId ? [reason, params.workspaceId] : [reason]
  )

  await Promise.all(
    result.rows.map((row) =>
      appendAutomationAuditLog(
        {
          workspaceId: row.workspaceId,
          action: "automation_rule.pause",
          resourceType: "automation_rule",
          resourceId: row.id,
          details: { reason },
        },
        executor
      )
    )
  )

  return result.rows
}

/**
 * Bump the policy trigger count and, when the rule should complete, flip the
 * rule status + stamp completed_at + write the completion audit log — all on
 * the supplied executor so it joins the surrounding transaction. Returns the
 * policy snapshot used for the completion decision.
 */
export async function applyAutomationPolicyAfterTrigger(params: {
  ruleId: string
  workspaceId: string
  occurrenceId: string
  executionId: string
  completeNow?: boolean
  completionReason: "max_trigger_count" | "schedule_exhausted"
  client?: Executor
}) {
  const executor = params.client ?? db
  const policyResult = await runBuilder<{
    triggerCount: number
    maxTriggerCount: number | null
    completionStatus: string
  }>(
    executor,
    executor
      .updateTable("automationPolicies")
      .set({
        triggerCount: sql`${sql.ref("triggerCount")} + 1`,
      })
      .where("ruleId", "=", params.ruleId)
      .returningAll()
  )
  const policy = policyResult.rows[0]
  if (!policy) {
    throw new Error(`Automation policy for ${params.ruleId} not found`)
  }

  const reachedMax =
    policy.maxTriggerCount !== null &&
    policy.triggerCount >= policy.maxTriggerCount
  const shouldComplete = Boolean(params.completeNow || reachedMax)
  if (!shouldComplete) {
    return
  }

  await executor
    .updateTable("automationRules")
    .set({
      status: policy.completionStatus as never,
    })
    .where("id", "=", params.ruleId)
    .execute()
  await executor
    .updateTable("automationPolicies")
    .set({
      completedAt: sql`COALESCE(${sql.ref("completedAt")}, NOW())`,
    })
    .where("ruleId", "=", params.ruleId)
    .execute()
  await executor
    .insertInto("auditLogs")
    .values({
      workspaceId: params.workspaceId,
      action: "automation_rule.complete",
      resourceType: "automation_rule",
      resourceId: params.ruleId,
      details: JSON.stringify({
        executionId: params.executionId,
        occurrenceId: params.occurrenceId,
        triggerCount: policy.triggerCount,
        maxTriggerCount: policy.maxTriggerCount,
        completionStatus: policy.completionStatus,
        completionReason: reachedMax
          ? "max_trigger_count"
          : params.completionReason,
      }),
    })
    .execute()
}

// ---------------------------------------------------------------------------
// Rule pause / error mutations
// ---------------------------------------------------------------------------

/**
 * Pause a single active rule. Returns true if a row transitioned (the caller
 * then writes the matching audit log). Soft-delete + terminal-status guard:
 * only flips status='active' rows.
 */
export async function pauseActiveAutomationRule(
  ruleId: string,
  reason: string
): Promise<boolean> {
  const updated = await runBuilder<{ id: string }>(
    db,
    db
      .updateTable("automationRules")
      .set({
        status: "paused",
        lastErrorAt: sql`NOW()`,
        lastErrorMessage: reason,
      })
      .where("id", "=", ruleId)
      .where("status", "=", "active")
      .returning("id")
  )
  return Boolean(updated.rows[0])
}

/** Update last_error_at / last_error_message on a rule. */
export async function updateAutomationRuleError(
  ruleId: string,
  errorMessage: string | null
) {
  await db
    .updateTable("automationRules")
    .set({
      lastErrorAt: errorMessage ? new Date() : null,
      lastErrorMessage: errorMessage,
    })
    .where("id", "=", ruleId)
    .execute()
}

/**
 * Soft-delete a rule (sd_reject_delete forbids hard delete). Flips deleted_at
 * for the workspace-scoped, not-yet-deleted rule.
 */
export async function softDeleteAutomationRule(
  workspaceId: string,
  ruleId: string
) {
  await db
    .updateTable("automationRules")
    .set({ deletedAt: sql`NOW()` })
    .where("id", "=", ruleId)
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .execute()
}

// ---------------------------------------------------------------------------
// Event source mutations
// ---------------------------------------------------------------------------

/**
 * Insert an event source row. The service builds the fully-encoded `values`
 * record (JSON.stringify of payloadSchema/examplePayload/metadata, createdAt
 * sentinel, etc.) and the repo runs it on the given executor (defaulting to the
 * pool). Keeps the table client in the repo without re-typing every column.
 */
export async function insertAutomationEventSourceRow(
  values: Record<string, unknown>,
  run: Executor = db
) {
  await run
    .insertInto("automationEventSources")
    .values(withCreatedAt(values) as never)
    .execute()
}

/**
 * Update an existing event source row (used by reuse + update flows). `values`
 * is the already-encoded set-bag built by the service.
 */
export async function updateAutomationEventSourceRow(params: {
  workspaceId: string
  eventSourceId: string
  values: Record<string, unknown>
}) {
  await db
    .updateTable("automationEventSources")
    .set(params.values as never)
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.eventSourceId)
    .execute()
}

/** Set an event source status to archived for the workspace. */
export async function setAutomationEventSourceStatus(params: {
  workspaceId: string
  eventSourceId: string
  status: AutomationEventSourceStatus
}) {
  await db
    .updateTable("automationEventSources")
    .set({ status: params.status })
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.eventSourceId)
    .execute()
}

/** Touch last_triggered_at for an event source. */
export async function touchAutomationEventSourceTriggered(
  eventSourceId: string
) {
  await db
    .updateTable("automationEventSources")
    .set({ lastTriggeredAt: sql`NOW()` })
    .where("id", "=", eventSourceId)
    .execute()
}

/** Saga compensating rollback: soft-delete a just-created event source. */
export async function softDeleteAutomationEventSource(
  workspaceId: string,
  eventSourceId: string
) {
  await db
    .updateTable("automationEventSources")
    .set({ deletedAt: sql`NOW()` })
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", eventSourceId)
    .where("deletedAt", "is", null)
    .execute()
    .catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Integration binding mutations
// ---------------------------------------------------------------------------

export async function selectAutomationIntegrationBindingRow(
  bindingId: string,
  executor?: Executor
): Promise<AutomationIntegrationBindingRow | null> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationIntegrationBindingRawRow>(
    `SELECT *
     FROM automation_integration_bindings_live
     WHERE id = $1::uuid
     LIMIT 1`,
    [bindingId]
  )
  const row = result.rows[0]
  return row ? toAutomationIntegrationBindingRow(row) : null
}

export async function selectExistingAutomationIntegrationBindingRow(params: {
  workspaceId: string
  installationId: string
  provider: AutomationIntegrationProvider
  ingressKind: AutomationIntegrationIngressKind
  targetKind: AutomationIntegrationTargetKind
  targetId: string
  executor?: Executor
}): Promise<AutomationIntegrationBindingRow | null> {
  const result = await resolveQueryRunner(
    params.executor
  ).run<AutomationIntegrationBindingRawRow>(
    `SELECT *
     FROM automation_integration_bindings_live
     WHERE workspace_id = $1::uuid
       AND installation_id = $2::uuid
       AND provider = $3::automation_integration_bindings_provider
       AND ingress_kind = $4::automation_integration_bindings_ingress_kind
       AND target_kind = $5::automation_integration_bindings_target_kind
       AND target_id = $6::text
     LIMIT 1`,
    [
      params.workspaceId,
      params.installationId,
      params.provider,
      params.ingressKind,
      params.targetKind,
      params.targetId,
    ]
  )
  const row = result.rows[0]
  return row ? toAutomationIntegrationBindingRow(row) : null
}

/** List active/deprecated integration source keys for a binding. */
export async function listActiveIntegrationSourceKeysForBinding(
  bindingId: string
): Promise<string[]> {
  const result = await runBuilder<{ sourceKey: string | null }>(
    db,
    db
      .selectFrom("automationEventSources")
      .select("sourceKey")
      .where("providerKind", "=", "integration")
      .where("integrationBindingId", "=", bindingId)
      .where("status", "in", ["active", "deprecated"])
      .orderBy("sourceKey", "asc")
  )
  return Array.from(
    new Set(result.rows.map((row) => row.sourceKey).filter(Boolean))
  ) as string[]
}

/** Update an integration binding's target label. */
export async function updateIntegrationBindingTargetLabel(
  bindingId: string,
  targetLabel: string
) {
  await db
    .updateTable("automationIntegrationBindings")
    .set({ targetLabel })
    .where("id", "=", bindingId)
    .execute()
}

/**
 * Insert an integration binding row on the given executor (encoded value-bag
 * built by the service; runs inside the binding-creation transaction).
 */
export async function insertIntegrationBindingRow(
  run: Executor,
  values: Record<string, unknown>
) {
  await run
    .insertInto("automationIntegrationBindings")
    .values(withCreatedAt(values) as never)
    .execute()
}

/**
 * Insert a webhook endpoint row on the given executor (encoded value-bag built
 * by the service; runs inside the binding-creation transaction).
 */
export async function insertWebhookEndpointRow(
  run: Executor,
  values: Record<string, unknown>
) {
  await run
    .insertInto("automationWebhookEndpoints")
    .values(withCreatedAt(values) as never)
    .execute()
}

export async function insertAutomationWebhookEndpointReturningRow(
  values: {
    id: string
    workspaceId: string
    name: string
    status: AutomationWebhookEndpoint["status"]
    pathToken: string
    secretCiphertext: string
    secretHint: string
    metadata: Record<string, unknown>
    createdByWorkspaceMemberId: string
  },
  executor?: Executor
): Promise<AutomationWebhookEndpointDbRow> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationWebhookEndpointRawRow>(
    `INSERT INTO automation_webhook_endpoints
       (id, workspace_id, name, status, path_token, secret_ciphertext, secret_hint, metadata, created_by_workspace_member_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::automation_webhook_endpoints_status, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING *`,
    [
      values.id,
      values.workspaceId,
      values.name,
      values.status,
      values.pathToken,
      values.secretCiphertext,
      values.secretHint,
      JSON.stringify(values.metadata),
      values.createdByWorkspaceMemberId,
    ]
  )
  return toAutomationWebhookEndpointDbRow(result.rows[0]!)
}

/** Update an integration binding's external subscription id. */
export async function updateIntegrationBindingExternalSubscriptionId(
  bindingId: string,
  externalSubscriptionId: string | null
) {
  await db
    .updateTable("automationIntegrationBindings")
    .set({ externalSubscriptionId })
    .where("id", "=", bindingId)
    .execute()
}

// ---------------------------------------------------------------------------
// Webhook endpoint mutations
// ---------------------------------------------------------------------------

export async function selectAutomationWebhookEndpointRow(
  endpointId: string,
  executor?: Executor
): Promise<AutomationWebhookEndpointDbRow | null> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationWebhookEndpointRawRow>(
    `SELECT *
     FROM automation_webhook_endpoints_live
     WHERE id = $1::uuid
     LIMIT 1`,
    [endpointId]
  )
  const row = result.rows[0]
  return row ? toAutomationWebhookEndpointDbRow(row) : null
}

export async function listAutomationWebhookEndpointRows(
  workspaceId: string,
  executor?: Executor
): Promise<AutomationWebhookEndpointDbRow[]> {
  const result = await resolveQueryRunner(
    executor
  ).run<AutomationWebhookEndpointRawRow>(
    `SELECT *
     FROM automation_webhook_endpoints_live
     WHERE workspace_id = $1::uuid
     ORDER BY created_at DESC`,
    [workspaceId]
  )
  return result.rows.map(toAutomationWebhookEndpointDbRow)
}

/** Update a webhook endpoint's status. */
export async function updateWebhookEndpointStatus(
  endpointId: string,
  status: AutomationWebhookEndpoint["status"]
) {
  await db
    .updateTable("automationWebhookEndpoints")
    .set({ status })
    .where("id", "=", endpointId)
    .execute()
}

/** Touch last_received_at for a webhook endpoint. */
export async function touchWebhookReceived(endpointId: string) {
  await db
    .updateTable("automationWebhookEndpoints")
    .set({ lastReceivedAt: sql`NOW()` })
    .where("id", "=", endpointId)
    .execute()
}

// ---------------------------------------------------------------------------
// Execution mutations
// ---------------------------------------------------------------------------

/** Insert an automation_execution_targets row (metadata encoded here). */
export async function insertAutomationExecutionTarget(params: {
  id: string
  executionId: string
  conversationId: string | null
  targetParticipantId: string | null
  sessionId: string | null
  targetActorId: string | null
  createdItemId: string | null
  wakeupId: string | null
  status: AutomationExecutionStatus
  metadata: Record<string, unknown>
}) {
  await db
    .insertInto("automationExecutionTargets")
    .values({
      id: params.id,
      executionId: params.executionId,
      conversationId: params.conversationId,
      targetParticipantId: params.targetParticipantId,
      sessionId: params.sessionId,
      targetActorId: params.targetActorId,
      createdItemId: params.createdItemId,
      wakeupId: params.wakeupId,
      status: params.status,
      metadata: JSON.stringify(params.metadata),
      createdAt: sql`NOW()`,
    })
    .execute()
}

/** Existence probe for an automation execution by id. */
export async function existsAutomationExecution(
  executionId: string
): Promise<boolean> {
  const result = await runBuilder<{ id: string }>(
    db,
    db
      .selectFrom("automationExecutions")
      .select("id")
      .where("id", "=", executionId)
      .limit(1)
  )
  return Boolean(result.rows[0])
}

/** Mark an execution skipped with a reason. */
export async function markAutomationExecutionSkipped(
  executionId: string,
  errorMessage: string
) {
  await db
    .updateTable("automationExecutions")
    .set({
      status: "skipped",
      errorMessage,
      completedAt: sql`NOW()`,
    })
    .where("id", "=", executionId)
    .execute()
}

/** Mark an execution completed (clears error). */
export async function markAutomationExecutionCompleted(executionId: string) {
  await db
    .updateTable("automationExecutions")
    .set({
      status: "completed",
      errorMessage: null,
      completedAt: sql`NOW()`,
    })
    .where("id", "=", executionId)
    .execute()
}

/** Mark an execution failed with a message. */
export async function markAutomationExecutionFailed(
  executionId: string,
  errorMessage: string
) {
  await db
    .updateTable("automationExecutions")
    .set({
      status: "failed",
      errorMessage,
      completedAt: sql`NOW()`,
    })
    .where("id", "=", executionId)
    .execute()
}

/** Clear last_error_* on a rule (after a successful no-op / skip). */
export async function clearAutomationRuleError(ruleId: string) {
  await db
    .updateTable("automationRules")
    .set({
      lastErrorAt: null,
      lastErrorMessage: null,
    })
    .where("id", "=", ruleId)
    .execute()
}

/** Mark a rule triggered: last_triggered_at = NOW(), clear errors. */
export async function markAutomationRuleTriggered(ruleId: string) {
  await db
    .updateTable("automationRules")
    .set({
      lastTriggeredAt: sql`NOW()`,
      lastErrorAt: null,
      lastErrorMessage: null,
    })
    .where("id", "=", ruleId)
    .execute()
}

// ---------------------------------------------------------------------------
// Misc reads
// ---------------------------------------------------------------------------

/** Resolve a workspace owner id (fallback operator user). */
export async function selectWorkspaceOwnerId(
  workspaceId: string
): Promise<string | null> {
  const result = await runBuilder<{ ownerId: string | null }>(
    db,
    db
      .selectFrom("workspaces")
      .select("ownerId")
      .where("id", "=", workspaceId)
      .limit(1)
  )
  return result.rows[0]?.ownerId || null
}

// ---------------------------------------------------------------------------
// Access-binding storage (binding-storage.ts is the access-layer DB edge; the
// repo binds the pool so the automation service stays db-free)
// ---------------------------------------------------------------------------

/** Load access bindings for a set of automation event sources (pool-bound). */
export async function loadAutomationEventSourceAccessBindingRows(input: {
  resourceType: "automation_event_source"
  resourceIds: string[]
  workspaceId?: string
  includeRevoked?: boolean
}): Promise<AutomationEventSourceBindingJoinedRow[]> {
  return loadAutomationEventSourceAccessBindingRowsForSources(db, input)
}

/** Revoke an automation event-source access binding (pool-bound). */
export async function revokeAutomationEventSourceAccessBindingById(input: {
  bindingId: string
}): Promise<boolean> {
  return revokeAutomationEventSourceAccessBinding(db, input)
}

/** Update an access binding's conversation-type mask override (pool-bound). */
export async function updateAutomationEventSourceAccessBindingMaskOverride(input: {
  bindingId: string
  workspaceId?: string
  conversationTypeMaskOverride: number | null
}): Promise<void> {
  return updateAutomationEventSourceAccessGrantConversationTypeMaskOverride(
    db,
    input
  )
}
