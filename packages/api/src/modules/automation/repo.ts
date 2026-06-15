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
} from "./repo.types.js"

export type {
  AutomationDeliveryDbRow,
  AutomationDeliveryRow,
  AutomationEventSourceDbRow,
  AutomationEventSourceRow,
  AutomationExecutionWithOccurrenceDbRow,
  AutomationExecutionWithOccurrenceRow,
  AutomationExecutionRow,
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
} from "./repo.types.js"

/**
 * Raw integration-installation row projection. Columns are selected with
 * explicit camelCase `as` aliases (so the CamelCasePlugin is moot). No Date
 * columns are projected; configData/specMetadata are raw JSONB left as
 * `unknown` and decoded by the service.
 */
export type IntegrationInstallationRow = {
  installationId: string
  workspaceId: string
  installationStatus: "active" | "disabled" | "error" | "archived"
  configData: unknown
  orgSlug: string
  itemSlug: string
  specMetadata: unknown
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

/**
 * Read one integration installation for a workspace, scoped to non-deleted
 * workspace apps. Returns the raw camelCase row (no JSON decode / decryption).
 */
export async function selectIntegrationInstallationRow(
  workspaceId: string,
  installationId: string
): Promise<IntegrationInstallationRow | undefined> {
  return (await db
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
    .executeTakeFirst()) as IntegrationInstallationRow | undefined
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
