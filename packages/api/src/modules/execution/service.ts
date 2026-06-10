import { createHash } from "crypto"
import { sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { db } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
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
import { updateSessionStatus } from "../session/service.js"
import {
  markTurnWakeupsDropped,
  publishSessionRuntime,
} from "../session/runtime.js"

const log = createLogger("execution")

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(
    value,
    Object.keys(value as Record<string, unknown>).sort()
  )
}

function asNullableUuid(value: unknown) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null
}

async function getRuntimeTargetByTurnId(turnId: string) {
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

async function getRuntimeTargetByToolCallId(toolCallId: string) {
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

async function publishRuntimeForTurn(turnId: string) {
  const runtimeTarget = await getRuntimeTargetByTurnId(turnId)
  if (!runtimeTarget) return
  await publishSessionRuntime(
    runtimeTarget.workspaceId,
    runtimeTarget.sessionId
  )
}

async function publishRuntimeForToolCall(toolCallId: string) {
  const runtimeTarget = await getRuntimeTargetByToolCallId(toolCallId)
  if (!runtimeTarget) return
  await publishSessionRuntime(
    runtimeTarget.workspaceId,
    runtimeTarget.sessionId
  )
}

async function storePayloadBlobInternal(
  contentType: "json" | "text",
  payload: unknown,
  retentionClass: PayloadBlobsRetentionClass = "audit"
) {
  const body =
    contentType === "json"
      ? JSON.stringify(payload ?? {})
      : String(payload ?? "")
  const sha256 = createHash("sha256").update(body).digest("hex")

  const existing = await db
    .selectFrom("payloadBlobs")
    .select("id")
    .where("sha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()
  if (existing) {
    return existing.id
  }

  const inserted = await db
    .insertInto("payloadBlobs")
    .values({
      id: uuidv4(),
      sha256,
      contentType: contentType,
      jsonBody: (contentType === "json"
        ? (payload ?? {})
        : null) as PayloadBlobsJsonBody,
      textBody: contentType === "text" ? String(payload ?? "") : null,
      byteSize: Buffer.byteLength(body, "utf8"),
      retentionClass: retentionClass,
      createdAt: sql`NOW()`,
    })
    .returning("id")
    .executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to store payload blob")
  }

  return inserted.id
}

export async function storePayloadBlob(
  payload: unknown,
  retentionClass: PayloadBlobsRetentionClass = "audit"
) {
  return storePayloadBlobInternal("json", payload, retentionClass)
}

export async function storeTextPayloadBlob(
  payload: string,
  retentionClass: PayloadBlobsRetentionClass = "audit"
) {
  return storePayloadBlobInternal("text", payload, retentionClass)
}

export async function createTurn(params: {
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

export async function updateTurnStatus(
  turnId: string,
  status: "completed" | "failed" | "cancelled",
  extra?: {
    metadata?: Record<string, unknown>
  }
) {
  const update = db
    .updateTable("turns")
    .set({
      status,
      completedAt: sql`NOW()`,
      ...(extra?.metadata
        ? {
            metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(extra.metadata)}::jsonb`,
          }
        : {}),
    })
    .where("id", "=", turnId)
  await update.execute()
}

export async function logProviderStep(params: {
  turnId: string
  stepIndex: number
  providerType: string
  requestType: "actor_think" | "ai_complete"
  modelGroupId?: string
  modelBindingId?: string
  modelBindingVersionId?: string
  modelName: string
  capabilitiesSnapshot?: Record<string, unknown>
  requestPayload?: unknown
  responsePayload?: unknown
  stopReason?: string
  inputTokens: number
  outputTokens: number
  costMicros?: number
  latencyMs: number
  status: "success" | "error" | "timeout"
  errorMessage?: string
}) {
  const requestPayloadBlobId =
    params.requestPayload !== undefined
      ? await storePayloadBlob(
          params.requestPayload,
          params.status === "error" ? "debug" : "audit"
        )
      : null
  const responsePayloadBlobId =
    params.responsePayload !== undefined
      ? await storePayloadBlob(
          params.responsePayload,
          params.status === "error" ? "debug" : "audit"
        )
      : null

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
      requestPayloadBlobId: requestPayloadBlobId,
      responsePayloadBlobId: responsePayloadBlobId,
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
        requestPayloadBlobId: requestPayloadBlobId,
        responsePayloadBlobId: responsePayloadBlobId,
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

export async function createToolCall(params: {
  id?: string
  turnId: string
  providerStepId?: string
  conversationId: string
  sessionId?: string
  callIndex: number
  providerCallId?: string
  bundleId: string
  toolName: string
  // Tool provenance & routing: the immutable public source snapshot + its
  // discriminator, plus optional soft pointers to the live source entity.
  sourceKind: "system" | "plugin" | "device"
  sourceSnapshot: Record<string, unknown>
  pluginInstallationId?: string | null
  deviceToolId?: string | null
  normalizedInput: Record<string, unknown>
}) {
  const row = await db
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

  if (row) {
    await publishRuntimeForTurn(params.turnId)
  }

  return row
}

export async function updateToolCallStatus(
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

  await publishRuntimeForToolCall(toolCallId)
}

export async function createToolExecutionAttempt(params: {
  toolCallId: string
  attemptNo: number
  transport?: string
  requestPayload?: unknown
}) {
  const requestPayloadBlobId =
    params.requestPayload !== undefined
      ? await storePayloadBlob(params.requestPayload)
      : null

  return db
    .insertInto("toolExecutionAttempts")
    .values({
      id: uuidv4(),
      toolCallId: params.toolCallId,
      attemptNo: params.attemptNo,
      transport: params.transport || null,
      requestPayloadBlobId: requestPayloadBlobId,
      status: "success",
      isError: false,
      createdAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()
}

export async function finalizeToolExecutionAttempt(params: {
  attemptId: string
  status: "success" | "error" | "timeout"
  isError?: boolean
  errorMessage?: string
  durationMs?: number
  responsePayload?: unknown
}) {
  const responsePayloadBlobId =
    params.responsePayload !== undefined
      ? await storePayloadBlob(
          params.responsePayload,
          params.status === "error" ? "debug" : "audit"
        )
      : null

  await db
    .updateTable("toolExecutionAttempts")
    .set({
      status: params.status,
      isError: params.isError || false,
      errorMessage: params.errorMessage || null,
      durationMs: params.durationMs || null,
      ...(responsePayloadBlobId
        ? { responsePayloadBlobId: responsePayloadBlobId }
        : {}),
    })
    .where("id", "=", params.attemptId)
    .execute()
}

export async function createToolResult(params: {
  toolCallId: string
  attemptId?: string
  resultIndex?: number
  isError?: boolean
  errorMessage?: string
  metadata?: Record<string, unknown>
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
}) {
  const result = await db
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

  if (!result) {
    throw new Error("Failed to create tool result")
  }

  if (params.parts.length > 0) {
    await db
      .insertInto("toolResultParts")
      .values(
        params.parts.map((part, ordinal) => ({
          id: uuidv4(),
          toolResultId: result.id,
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

  await publishRuntimeForToolCall(params.toolCallId)

  return result
}

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

export async function logRuntimeEvent(params: {
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
    .catch((err) => {
      log.error({ err }, "[runtime_events] failed")
    })
}

export async function recoverInterruptedExecutions(params?: {
  errorMessage?: string
}) {
  const errorMessage =
    params?.errorMessage || "Interrupted while the turn was still running."

  const interruptedToolCalls = (await db
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

  let recoveredToolCalls = 0
  for (const row of interruptedToolCalls) {
    if (row.latestAttemptId) {
      await db
        .updateTable("toolExecutionAttempts")
        .set({
          status: "error",
          isError: true,
          errorMessage: sql`COALESCE(error_message, ${errorMessage})`,
        })
        .where("id", "=", row.latestAttemptId)
        .execute()
    }

    const existingResult = await db
      .selectFrom("toolResults")
      .select("id")
      .where("toolCallId", "=", row.toolCallId)
      .limit(1)
      .executeTakeFirst()

    if (!existingResult) {
      await createToolResult({
        toolCallId: row.toolCallId,
        attemptId: row.latestAttemptId || undefined,
        isError: true,
        errorMessage,
        parts: [{ type: "text", text: `Error: ${errorMessage}` }],
      })
    }

    await updateToolCallStatus(row.toolCallId, "failed")
    recoveredToolCalls += 1
  }

  const interruptedTurns = (await db
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

  const sessionsById = new Map<
    string,
    { workspaceId: string | null; turnId: string }
  >()
  for (const row of interruptedTurns) {
    await markTurnWakeupsDropped(row.id).catch(() => {})
    await updateTurnStatus(row.id, "failed", {
      metadata: { errorMessage, interruptedByRecovery: true },
    })
    if (row.sessionId) {
      sessionsById.set(row.sessionId, {
        workspaceId: row.workspaceId,
        turnId: row.id,
      })
    }
  }

  let recoveredSessions = 0
  for (const [sessionId, sessionInfo] of sessionsById.entries()) {
    await updateSessionStatus(sessionId, "blocked", { errorMessage })
    if (sessionInfo.workspaceId) {
      await publishSessionRuntime(sessionInfo.workspaceId, sessionId, {
        laneState: "blocked",
        health: "error",
        phase: "error",
        statusText: errorMessage,
        activeTurnId: sessionInfo.turnId,
        lastError: {
          message: errorMessage,
          at: nowIsoInstant(),
        },
      }).catch(() => {})
    }
    recoveredSessions += 1
  }

  return {
    recoveredToolCalls,
    recoveredTurns: interruptedTurns.length,
    recoveredSessions,
  }
}
