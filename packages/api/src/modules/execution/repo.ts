// execution/repo.ts — DB-touching helpers for the execution module.
//
// The only execution file permitted to import the db client (guard r8). Owns
// the raw queries across turns / toolCalls / providerSteps / toolResults /
// toolResultParts / payloadBlobs / toolExecutionAttempts / runtimeEvents.
// service.ts holds the business logic, side effects, and cross-module
// orchestration and calls these pure DB functions; it no longer imports the db
// client. round-6 P1-6.
//
// These functions are pure DB I/O: no side effects, no cross-module calls.
// They return camelCase domain records (CamelCasePlugin already yields
// camelCase) and KEEP Date columns — serialization happens in the caller /
// presenter. JSON columns stay raw; the JSONB casts (repo.types.ts aliases)
// and the inline `${...}::jsonb` encodes live here at the DB boundary.
//
// No transactions today: recoverInterruptedExecutions runs sequential awaits,
// not a single tx — these functions preserve that (each auto-commits).

import { sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import type { ToolSourceKind } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import type {
  PayloadBlobsJsonBody,
  PayloadBlobsRetentionClass,
  ProviderStepsCapabilitiesSnapshot,
  RuntimeEventsPayload,
  ToolCallsNormalizedInput,
  ToolCallsSourceSnapshot,
  ToolResultPartsMetadata,
  ToolResultsMetadata,
  TurnsMetadata,
} from "./repo.types.js"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function asNullableUuid(value: unknown) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null
}

/** Resolve the runtime publish target (workspace + session) for a turn. */
export async function getRuntimeTargetByTurnId(turnId: string) {
  const row = await db
    .selectFrom("turns as t")
    .innerJoin("sessions as s", "s.id", "t.sessionId")
    .select(["s.workspaceId as workspaceId", "s.id as sessionId"])
    .where("t.id", "=", turnId)
    .limit(1)
    .executeTakeFirst()

  return row
    ? {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
      }
    : null
}

/** Resolve the runtime publish target (workspace + session) for a tool call. */
export async function getRuntimeTargetByToolCallId(toolCallId: string) {
  const row = await db
    .selectFrom("toolCalls as tc")
    .innerJoin("turns as t", "t.id", "tc.turnId")
    .innerJoin("sessions as s", "s.id", "t.sessionId")
    .select(["s.workspaceId as workspaceId", "s.id as sessionId"])
    .where("tc.id", "=", toolCallId)
    .limit(1)
    .executeTakeFirst()

  return row
    ? {
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
      }
    : null
}

/** Find an existing payload blob by content hash (SHA256 dedup). */
export async function findPayloadBlobBySha256(sha256: string) {
  return db
    .selectFrom("payloadBlobs")
    .select("id")
    .where("sha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
}

/** Insert a payload blob; owns the createdAt NOW() and the JSONB body cast. */
export async function insertPayloadBlob(params: {
  sha256: string
  contentType: "json" | "text"
  jsonBody: unknown
  textBody: string | null
  byteSize: number
  retentionClass: PayloadBlobsRetentionClass
}) {
  return db
    .insertInto("payloadBlobs")
    .values({
      id: uuidv4(),
      sha256: params.sha256,
      contentType: params.contentType,
      jsonBody: params.jsonBody as PayloadBlobsJsonBody,
      textBody: params.textBody,
      byteSize: params.byteSize,
      retentionClass: params.retentionClass,
      createdAt: sql`NOW()`,
    })
    .returning("id")
    .executeTakeFirst()
}

/** Insert a turn row (status running, startedAt NOW()); returns the row. */
export async function insertTurn(params: {
  id?: string
  sessionId: string
  conversationId: string
  actorId: string
  triggerType: string
  triggerItemId?: string
  metadata?: Record<string, unknown>
}) {
  return db
    .insertInto("turns")
    .values({
      id: params.id || uuidv4(),
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      actorId: params.actorId,
      triggerItemId: params.triggerItemId || null,
      triggerType: params.triggerType,
      status: "running",
      metadata: (params.metadata || {}) as TurnsMetadata,
      startedAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()
}

/**
 * Set a turn's terminal status (completedAt NOW()), optionally merging a
 * metadata patch via COALESCE(metadata, '{}')||$::jsonb.
 */
export async function updateTurnStatusRow(
  turnId: string,
  status: "completed" | "failed" | "cancelled",
  metadataPatch?: Record<string, unknown>
) {
  await db
    .updateTable("turns")
    .set({
      status,
      completedAt: sql`NOW()`,
      ...(metadataPatch
        ? {
            metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(metadataPatch)}::jsonb`,
          }
        : {}),
    })
    .where("id", "=", turnId)
    .execute()
}

/** Upsert a provider step on (turnId, stepIndex); returns the row. */
export async function upsertProviderStep(params: {
  turnId: string
  stepIndex: number
  providerType: string
  requestType: "actor_think" | "ai_complete"
  modelGroupId?: string
  modelBindingId?: string
  modelBindingVersionId?: string
  modelName: string
  capabilitiesSnapshot?: Record<string, unknown>
  requestPayloadBlobId: string | null
  responsePayloadBlobId: string | null
  stopReason?: string
  inputTokens: number
  outputTokens: number
  costMicros?: number
  latencyMs: number
  status: "success" | "error" | "timeout"
  errorMessage?: string
}) {
  return db
    .insertInto("providerSteps")
    .values({
      id: uuidv4(),
      turnId: params.turnId,
      stepIndex: params.stepIndex,
      providerType: params.providerType,
      requestType: params.requestType,
      modelGroupId: asNullableUuid(params.modelGroupId),
      modelBindingId: asNullableUuid(params.modelBindingId),
      modelBindingVersionId: asNullableUuid(params.modelBindingVersionId),
      modelName: params.modelName,
      capabilitiesSnapshot: (params.capabilitiesSnapshot ||
        {}) as ProviderStepsCapabilitiesSnapshot,
      requestPayloadBlobId: params.requestPayloadBlobId,
      responsePayloadBlobId: params.responsePayloadBlobId,
      stopReason: params.stopReason || null,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costMicros: params.costMicros || 0,
      latencyMs: params.latencyMs,
      status: params.status,
      errorMessage: params.errorMessage || null,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["turnId", "stepIndex"]).doUpdateSet({
        providerType: params.providerType,
        requestType: params.requestType,
        modelGroupId: asNullableUuid(params.modelGroupId),
        modelBindingId: asNullableUuid(params.modelBindingId),
        modelBindingVersionId: asNullableUuid(params.modelBindingVersionId),
        modelName: params.modelName,
        capabilitiesSnapshot: (params.capabilitiesSnapshot ||
          {}) as ProviderStepsCapabilitiesSnapshot,
        requestPayloadBlobId: params.requestPayloadBlobId,
        responsePayloadBlobId: params.responsePayloadBlobId,
        stopReason: params.stopReason || null,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        costMicros: params.costMicros || 0,
        latencyMs: params.latencyMs,
        status: params.status,
        errorMessage: params.errorMessage || null,
      })
    )
    .returningAll()
    .executeTakeFirst()
}

/** Insert a tool call (status pending, createdAt NOW()); returns the row. */
export async function insertToolCall(params: {
  id?: string
  turnId: string
  providerStepId?: string
  conversationId: string
  sessionId?: string
  callIndex: number
  providerCallId?: string
  bundleId: string
  toolName: string
  sourceKind: ToolSourceKind
  sourceSnapshot: Record<string, unknown>
  pluginInstallationId?: string | null
  deviceToolId?: string | null
  normalizedInput: Record<string, unknown>
}) {
  return db
    .insertInto("toolCalls")
    .values({
      id: params.id || uuidv4(),
      turnId: params.turnId,
      providerStepId: params.providerStepId || null,
      conversationId: params.conversationId,
      sessionId: params.sessionId || null,
      callIndex: params.callIndex,
      providerCallId: params.providerCallId || null,
      bundleId: params.bundleId,
      toolName: params.toolName,
      sourceKind: params.sourceKind,
      sourceSnapshot: params.sourceSnapshot as ToolCallsSourceSnapshot,
      pluginInstallationId: params.pluginInstallationId || null,
      deviceToolId: params.deviceToolId || null,
      normalizedInput: params.normalizedInput as ToolCallsNormalizedInput,
      status: "pending",
      createdAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()
}

/**
 * Set a tool call's status; on terminal statuses stamp completedAt NOW(),
 * otherwise keep the existing completed_at column value.
 */
export async function updateToolCallStatusRow(
  toolCallId: string,
  status: "running" | "completed" | "failed" | "skipped"
) {
  await db
    .updateTable("toolCalls")
    .set({
      status,
      completedAt:
        status === "completed" || status === "failed" || status === "skipped"
          ? sql`NOW()`
          : sql`completed_at`,
    })
    .where("id", "=", toolCallId)
    .execute()
}

/** Insert a tool execution attempt (status success, createdAt NOW()). */
export async function insertToolExecutionAttempt(params: {
  toolCallId: string
  attemptNo: number
  transport?: string
  requestPayloadBlobId: string | null
}) {
  return db
    .insertInto("toolExecutionAttempts")
    .values({
      id: uuidv4(),
      toolCallId: params.toolCallId,
      attemptNo: params.attemptNo,
      transport: params.transport || null,
      requestPayloadBlobId: params.requestPayloadBlobId,
      status: "success",
      isError: false,
      createdAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()
}

/** Finalize a tool execution attempt with status / error / duration / blob. */
export async function finalizeToolExecutionAttemptRow(params: {
  attemptId: string
  status: "success" | "error" | "timeout"
  isError?: boolean
  errorMessage?: string
  durationMs?: number
  responsePayloadBlobId: string | null
}) {
  await db
    .updateTable("toolExecutionAttempts")
    .set({
      status: params.status,
      isError: params.isError || false,
      errorMessage: params.errorMessage || null,
      durationMs: params.durationMs || null,
      ...(params.responsePayloadBlobId
        ? { responsePayloadBlobId: params.responsePayloadBlobId }
        : {}),
    })
    .where("id", "=", params.attemptId)
    .execute()
}

/** Insert a tool result row (createdAt NOW()); returns the row (or undefined). */
export async function insertToolResult(params: {
  toolCallId: string
  attemptId?: string
  resultIndex?: number
  isError?: boolean
  errorMessage?: string
  metadata?: Record<string, unknown>
}) {
  return db
    .insertInto("toolResults")
    .values({
      id: uuidv4(),
      toolCallId: params.toolCallId,
      attemptId: params.attemptId || null,
      resultIndex: params.resultIndex || 0,
      isError: params.isError || false,
      errorMessage: params.errorMessage || null,
      metadata: (params.metadata || {}) as ToolResultsMetadata,
      createdAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()
}

/** Insert tool result parts; owns the jsonValue `${...}::jsonb` encode. */
export async function insertToolResultParts(
  toolResultId: string,
  parts: Array<{
    type: "text" | "file_ref" | "json"
    text?: string
    refPath?: string | null
    refSha256?: string | null
    json?: unknown
    mimeType?: string
    name?: string
    metadata?: Record<string, unknown>
  }>
) {
  await db
    .insertInto("toolResultParts")
    .values(
      parts.map((part, ordinal) => ({
        id: uuidv4(),
        toolResultId,
        ordinal,
        partType: part.type,
        textValue: part.type === "text" ? part.text || "" : null,
        refPath: part.type === "file_ref" ? (part.refPath ?? null) : null,
        refSha256: part.type === "file_ref" ? (part.refSha256 ?? null) : null,
        jsonValue:
          part.type === "json"
            ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
            : null,
        mimeType: part.mimeType || null,
        name: part.name || null,
        metadata: (part.metadata || {}) as ToolResultPartsMetadata,
      }))
    )
    .execute()
}

/**
 * Flat denormalized tool-history join for a session (multiple rows per tool
 * call). Row→shape reassembly stays in the caller; this returns joined rows
 * with Date columns preserved. Owns the snake_case `ps.step_index` order key.
 */
export async function getToolHistoryForSession(sessionId: string) {
  return db
    .selectFrom("toolCalls as tc")
    .leftJoin("providerSteps as ps", "ps.id", "tc.providerStepId")
    .leftJoin("toolResults as tr", "tr.toolCallId", "tc.id")
    .leftJoin("toolResultParts as trp", "trp.toolResultId", "tr.id")
    .select([
      "tc.id",
      "tc.turnId",
      "tc.providerStepId",
      "tc.conversationId",
      "tc.sessionId",
      "tc.callIndex",
      "tc.providerCallId",
      "tc.bundleId",
      "tc.toolName",
      "tc.sourceKind",
      "tc.sourceSnapshot",
      "tc.pluginInstallationId",
      "tc.deviceToolId",
      "tc.normalizedInput",
      "tc.status",
      "tc.createdAt",
      "tc.completedAt",
      "tr.id as toolResultId",
      "tr.isError",
      "tr.errorMessage",
      "ps.stepIndex",
      "trp.ordinal as resultPartOrdinal",
      "trp.partType as resultPartType",
      "trp.textValue as resultTextValue",
      "trp.refPath as resultRefPath",
      "trp.refSha256 as resultRefSha256",
      "trp.jsonValue as resultJsonValue",
      "trp.mimeType as resultMimeType",
      "trp.name as resultName",
      "trp.metadata as resultPartMetadata",
    ])
    .where("tc.sessionId", "=", sessionId)
    .orderBy("tc.createdAt", "asc")
    .orderBy(sql`ps.step_index asc nulls last`)
    .orderBy("tc.callIndex", "asc")
    .orderBy("tr.resultIndex", "asc")
    .orderBy("trp.ordinal", "asc")
    .execute()
}

/** Insert a runtime event row (createdAt NOW()); owns the payload JSONB cast. */
export async function insertRuntimeEvent(params: {
  workspaceId?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  providerStepId?: string
  toolCallId?: string
  toolAttemptId?: string
  actorId?: string
  userId?: string
  source: "conversation" | "provider" | "tool" | "device" | "system"
  level?: "debug" | "info" | "warn" | "error"
  eventType: string
  payload?: Record<string, unknown>
}) {
  await db
    .insertInto("runtimeEvents")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId || null,
      conversationId: params.conversationId || null,
      sessionId: params.sessionId || null,
      turnId: params.turnId || null,
      providerStepId: params.providerStepId || null,
      toolCallId: params.toolCallId || null,
      toolAttemptId: params.toolAttemptId || null,
      actorId: params.actorId || null,
      userId: params.userId || null,
      source: params.source,
      level: params.level || "info",
      eventType: params.eventType,
      payload: (params.payload || {}) as RuntimeEventsPayload,
      createdAt: sql`NOW()`,
    })
    .execute()
}

/**
 * Tool calls whose turn is still running and that are not terminal, with the
 * latest attempt id via the correlated tool_execution_attempts subquery.
 */
export async function listInterruptedToolCalls() {
  return (await db
    .selectFrom("toolCalls as tc")
    .innerJoin("turns as t", "t.id", "tc.turnId")
    .select([
      "tc.id as toolCallId",
      "tc.sessionId",
      sql<string | null>`(
         SELECT tea.id
         FROM tool_execution_attempts tea
         WHERE tea.tool_call_id = tc.id
         ORDER BY tea.attempt_no DESC
         LIMIT 1
       )`.as("latestAttemptId"),
    ])
    .where("t.status", "=", "running")
    .where("tc.status", "in", ["pending", "running"])
    .execute()) as Array<{
    toolCallId: string
    latestAttemptId: string | null
    sessionId: string | null
  }>
}

/**
 * Mark a tool execution attempt interrupted (error), keeping any prior
 * error_message via COALESCE(error_message, $).
 */
export async function markAttemptInterrupted(
  attemptId: string,
  errorMessage: string
) {
  await db
    .updateTable("toolExecutionAttempts")
    .set({
      status: "error",
      isError: true,
      errorMessage: sql`COALESCE(error_message, ${errorMessage})`,
    })
    .where("id", "=", attemptId)
    .execute()
}

/** Find an existing tool result for a tool call (null if none). */
export async function findExistingToolResult(toolCallId: string) {
  return db
    .selectFrom("toolResults")
    .select("id")
    .where("toolCallId", "=", toolCallId)
    .limit(1)
    .executeTakeFirst()
}

/** Turns still in the running state, with their session + workspace. */
export async function listRunningTurns() {
  return (await db
    .selectFrom("turns as t")
    .leftJoin("sessions as s", "s.id", "t.sessionId")
    .leftJoin("conversations as c", "c.id", "s.conversationId")
    .select(["t.id", "t.sessionId", "s.workspaceId"])
    .where("t.status", "=", "running")
    .execute()) as Array<{
    id: string
    sessionId: string | null
    workspaceId: string | null
  }>
}
