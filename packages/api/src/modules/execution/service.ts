import { createHash } from "crypto"
import { ACTOR_RUNTIME_HEALTH } from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { createLogger } from "../../infrastructure/logger/index.js"
import type { PayloadBlobsRetentionClass } from "./repo.types.js"
import { updateSessionStatus } from "../session/service.js"
import {
  markTurnWakeupsDropped,
  publishSessionRuntime,
} from "../session/runtime.js"
import {
  findExistingToolResult,
  findPayloadBlobBySha256,
  getRuntimeTargetByToolCallId,
  getRuntimeTargetByTurnId,
  getToolHistoryForSession as getToolHistoryForSessionRow,
  insertPayloadBlob,
  insertRuntimeEvent,
  insertToolCall,
  insertToolExecutionAttempt,
  insertToolResult,
  insertToolResultParts,
  insertTurn,
  finalizeToolExecutionAttemptRow,
  listInterruptedToolCalls,
  listRunningTurns,
  markAttemptInterrupted,
  updateToolCallStatusRow,
  updateTurnStatusRow,
  upsertProviderStep,
} from "./repo.js"

const log = createLogger("execution")

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

  const existing = await findPayloadBlobBySha256(sha256)
  if (existing) {
    return existing.id
  }

  const inserted = await insertPayloadBlob({
    sha256,
    contentType,
    jsonBody: contentType === "json" ? (payload ?? {}) : null,
    textBody: contentType === "text" ? String(payload ?? "") : null,
    byteSize: Buffer.byteLength(body, "utf8"),
    retentionClass,
  })
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
  return insertTurn(params)
}

export async function updateTurnStatus(
  turnId: string,
  status: "completed" | "failed" | "cancelled",
  extra?: {
    metadata?: Record<string, unknown>
  }
) {
  await updateTurnStatusRow(turnId, status, extra?.metadata)
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

  return upsertProviderStep({
    turnId: params.turnId,
    stepIndex: params.stepIndex,
    providerType: params.providerType,
    requestType: params.requestType,
    modelGroupId: params.modelGroupId,
    modelBindingId: params.modelBindingId,
    modelBindingVersionId: params.modelBindingVersionId,
    modelName: params.modelName,
    capabilitiesSnapshot: params.capabilitiesSnapshot,
    requestPayloadBlobId,
    responsePayloadBlobId,
    stopReason: params.stopReason,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    costMicros: params.costMicros,
    latencyMs: params.latencyMs,
    status: params.status,
    errorMessage: params.errorMessage,
  })
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
  const row = await insertToolCall(params)

  if (row) {
    await publishRuntimeForTurn(params.turnId)
  }

  return row
}

export async function updateToolCallStatus(
  toolCallId: string,
  status: "running" | "completed" | "failed" | "skipped"
) {
  await updateToolCallStatusRow(toolCallId, status)

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

  return insertToolExecutionAttempt({
    toolCallId: params.toolCallId,
    attemptNo: params.attemptNo,
    transport: params.transport,
    requestPayloadBlobId,
  })
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

  await finalizeToolExecutionAttemptRow({
    attemptId: params.attemptId,
    status: params.status,
    isError: params.isError,
    errorMessage: params.errorMessage,
    durationMs: params.durationMs,
    responsePayloadBlobId,
  })
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
  const result = await insertToolResult({
    toolCallId: params.toolCallId,
    attemptId: params.attemptId,
    resultIndex: params.resultIndex,
    isError: params.isError,
    errorMessage: params.errorMessage,
    metadata: params.metadata,
  })

  if (!result) {
    throw new Error("Failed to create tool result")
  }

  if (params.parts.length > 0) {
    await insertToolResultParts(result.id, params.parts)
  }

  await publishRuntimeForToolCall(params.toolCallId)

  return result
}

export async function getToolHistoryForSession(sessionId: string) {
  return getToolHistoryForSessionRow(sessionId)
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
  await insertRuntimeEvent(params).catch((err) => {
    log.error({ err }, "[runtime_events] failed")
  })
}

export async function recoverInterruptedExecutions(params?: {
  errorMessage?: string
}) {
  const errorMessage =
    params?.errorMessage || "Interrupted while the turn was still running."

  const interruptedToolCalls = await listInterruptedToolCalls()

  let recoveredToolCalls = 0
  for (const row of interruptedToolCalls) {
    if (row.latestAttemptId) {
      await markAttemptInterrupted(row.latestAttemptId, errorMessage)
    }

    const existingResult = await findExistingToolResult(row.toolCallId)

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

  const interruptedTurns = await listRunningTurns()

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
        health: ACTOR_RUNTIME_HEALTH.ERROR,
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
