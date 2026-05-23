import { redis } from "../../infrastructure/redis/index.js"
import { query } from "../../infrastructure/database/index.js"
import { db, type TableInsert } from "../../infrastructure/database/kysely.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { sessionThinkingQueue } from "../../workers/queues.js"
import {
  isThreadConversationKind,
  nowISO,
  THREAD_CONVERSATION_KINDS,
  textBlock,
  type ActorRuntimeActivityState,
  type ActorRuntimePhase,
  type ActorRuntimeProcessingTarget,
  type ActorRuntimeState,
  type ActorRuntimeTurnActivityDetail,
  type ActorRuntimeTurnActivityItem,
  type ActorRuntimeTurnPreview,
  type ActorRuntimeTurnPreviewTool,
  type ActorRuntimeWakeup,
  type CanonicalContentBlock,
  type SessionTrigger,
  type SessionWakeupSourceParticipantType,
  type SessionWakeupSourceType,
  type SessionWakeupStatus,
} from "@synapse/shared"
import { sql } from "kysely"
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"
import { normalizeRelayBuiltinAuthorizationKind } from "../mcp-plugins/relay-invoke-options.js"
import { getSession, updateSessionStatus } from "./service.js"

function runtimeHashKey(conversationId: string) {
  return `runtime:conversation:${conversationId}`
}

function runtimeSequenceKey(conversationId: string) {
  return `runtime:conversation:${conversationId}:seq`
}

const runtimePublishDebounceTimers = new Map<string, NodeJS.Timeout>()

function parseMetadata(value: unknown): Record<string, unknown> {
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

function mapWakeupSourceTypeToTrigger(
  sourceType: SessionWakeupSourceType
): SessionTrigger {
  return sourceType
}

function mapWakeupRow(row: any): ActorRuntimeWakeup {
  const metadata = parseMetadata(row.metadata)
  return {
    wakeupId: row.id,
    sourceType: row.source_type,
    sourceItemId: row.source_item_id || undefined,
    sourceSessionId: row.source_session_id || undefined,
    sourceParticipantType: row.source_participant_type || undefined,
    sourceParticipantId: row.source_participant_id || undefined,
    sourceName: row.source_name || undefined,
    summary: row.summary,
    reasonText: row.reason_text || undefined,
    status: row.status,
    activationKind:
      typeof metadata.activationKind === "string"
        ? metadata.activationKind
        : undefined,
    delivery:
      typeof metadata.delivery === "string" ? metadata.delivery : undefined,
    createdAt: row.created_at,
    attachedAt: row.attached_at || undefined,
  }
}

async function loadRuntimeWakeups(
  sessionId: string,
  statuses: SessionWakeupStatus[] = ["pending", "attached"]
) {
  const rows = await db
    .selectFrom("session_wakeups")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("status", "in", statuses)
    .orderBy("created_at", "asc")
    .execute()

  return rows.map(mapWakeupRow)
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return undefined
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(parseJsonValue(value) ?? {}, null, 2)
  } catch {
    return JSON.stringify(String(value ?? ""))
  }
}

function buildTextBlocksFromLines(...parts: Array<string | null | undefined>) {
  const text = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n")

  return text ? [textBlock(text)] : []
}

function pickLatestTimestamp(...values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort(
      (left, right) => new Date(right).getTime() - new Date(left).getTime()
    )[0]
}

function getToolDisplayTitle(
  toolName: string,
  requestPayload?: Record<string, unknown>
) {
  const visibleToolName =
    typeof requestPayload?.visibleToolName === "string"
      ? requestPayload.visibleToolName.trim()
      : ""
  if (visibleToolName) {
    return visibleToolName
  }

  const segments = toolName.split("__").filter(Boolean)
  return segments[segments.length - 1] || toolName
}

function getToolDisplayDetail(params: {
  toolCallStatus: string
  taskStatus?: string
  statusMessage?: string
  errorMessage?: string
}) {
  if (params.errorMessage) return params.errorMessage
  if (params.statusMessage) return params.statusMessage
  if (params.taskStatus === "input_required") return "Waiting for input"
  if (params.taskStatus === "working" && params.toolCallStatus === "running") {
    return "Running"
  }
  if (params.toolCallStatus === "pending") return "Pending"
  return undefined
}

function mapToolActivityState(params: {
  toolCallStatus: string
  taskStatus?: string
  latestResultIsError?: boolean
}): ActorRuntimeActivityState {
  if (params.taskStatus === "input_required") return "input_required"
  if (params.taskStatus === "cancelled") return "cancelled"
  if (params.taskStatus === "failed") return "failed"
  if (params.taskStatus === "completed" && params.toolCallStatus !== "failed") {
    return "completed"
  }

  if (params.toolCallStatus === "running") return "running"
  if (params.toolCallStatus === "pending") return "pending"
  if (params.toolCallStatus === "skipped") return "skipped"
  if (params.toolCallStatus === "failed" || params.latestResultIsError)
    return "failed"
  return "completed"
}

async function loadActiveTurnIdForSession(sessionId: string) {
  const row = await db
    .selectFrom("turns")
    .select("id")
    .where("session_id", "=", sessionId)
    .where("status", "=", "running")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst()

  return row?.id
}

async function loadProcessingTargetsForTurn(
  turnId: string
): Promise<ActorRuntimeProcessingTarget[]> {
  const rows = await db
    .selectFrom("session_wakeups")
    .select([
      "id",
      "source_participant_type",
      "source_participant_id",
      "source_name",
      "summary",
      "created_at",
      "attached_at",
    ])
    .where("turn_id", "=", turnId)
    .where("status", "=", "attached")
    .orderBy("created_at", "asc")
    .execute()

  return rows.map((row) => ({
    wakeupId: row.id,
    participantType:
      (row.source_participant_type as SessionWakeupSourceParticipantType | null) ||
      undefined,
    participantId: row.source_participant_id || undefined,
    name: row.source_name || row.summary,
    summary: row.summary || undefined,
    createdAt: toIsoString(row.created_at) || nowISO(),
    attachedAt: toIsoString(row.attached_at),
  }))
}

async function loadRelayExposureSummary(exposureId: string) {
  const row = await db
    .selectFrom("relay_exposures")
    .select(["id", "device_id", "metadata"])
    .where("id", "=", exposureId)
    .limit(1)
    .executeTakeFirst()

  if (!row) return null

  return {
    deviceId: row.device_id,
    metadata: parseMetadata(row.metadata),
  }
}

function buildGenericToolRequestBlocks(toolName: string, input: unknown) {
  return buildTextBlocksFromLines(`Tool: ${toolName}`, prettyJson(input))
}

function buildGenericToolResultBlocks(params: {
  resultParts: any[]
  latestResult?: {
    is_error?: boolean | null
    error_message?: string | null
    metadata?: unknown
  }
  task?: {
    status_message?: string | null
    final_result_payload?: unknown
    final_error_payload?: unknown
  }
  outputChunks?: Array<{
    stream: string
    text_value: string
  }>
}) {
  if (params.resultParts.length > 0) {
    return itemPartsToCanonicalContentBlocks(params.resultParts)
  }

  if (params.outputChunks && params.outputChunks.length > 0) {
    return buildTextBlocksFromLines(
      params.outputChunks
        .map((chunk) => `[${chunk.stream}] ${chunk.text_value}`)
        .join("\n")
    )
  }

  const finalErrorPayload = parseJsonValue(params.task?.final_error_payload)
  const finalResultPayload = parseJsonValue(params.task?.final_result_payload)
  if (
    finalErrorPayload &&
    Object.keys(asRecord(finalErrorPayload)).length > 0
  ) {
    return buildTextBlocksFromLines(prettyJson(finalErrorPayload))
  }
  if (
    finalResultPayload &&
    Object.keys(asRecord(finalResultPayload)).length > 0
  ) {
    return buildTextBlocksFromLines(prettyJson(finalResultPayload))
  }

  if (params.latestResult?.error_message) {
    return buildTextBlocksFromLines(params.latestResult.error_message)
  }

  if (params.task?.status_message) {
    return buildTextBlocksFromLines(params.task.status_message)
  }

  return []
}

async function buildRelayBuiltinToolBlocks(params: {
  toolName: string
  input: unknown
  requestPayload?: Record<string, unknown>
  resultParts: any[]
  latestResult?: {
    is_error?: boolean | null
    error_message?: string | null
    metadata?: unknown
  }
  task?: {
    status_message?: string | null
    final_result_payload?: unknown
    final_error_payload?: unknown
  }
  outputChunks?: Array<{
    stream: string
    text_value: string
  }>
}) {
  const exposureId =
    typeof params.requestPayload?.exposureId === "string"
      ? params.requestPayload.exposureId
      : ""
  const exposureSummary = exposureId
    ? await loadRelayExposureSummary(exposureId)
    : null
  const builtinKind = normalizeRelayBuiltinAuthorizationKind(
    exposureSummary?.metadata?.builtinKind
  )

  if (!builtinKind) {
    return {
      requestBlocks: buildGenericToolRequestBlocks(
        params.toolName,
        params.input
      ),
      resultBlocks: buildGenericToolResultBlocks({
        resultParts: params.resultParts,
        latestResult: params.latestResult,
        task: params.task,
        outputChunks: params.outputChunks,
      }),
    }
  }

  const visibleToolName = getToolDisplayTitle(
    params.toolName,
    params.requestPayload
  )
  const args = parseJsonValue(params.requestPayload?.args ?? params.input)
  return {
    requestBlocks: buildTextBlocksFromLines(
      `${builtinKind}: ${visibleToolName}`,
      prettyJson(args)
    ),
    resultBlocks: buildGenericToolResultBlocks({
      resultParts: params.resultParts,
      latestResult: params.latestResult,
      task: params.task,
      outputChunks: params.outputChunks,
    }),
  }
}

async function buildBuiltinToolBlocks(params: {
  toolName: string
  input: unknown
  requestPayload?: Record<string, unknown>
  resultParts: any[]
  latestResult?: {
    is_error?: boolean | null
    error_message?: string | null
    metadata?: unknown
  }
  task?: {
    status_message?: string | null
    final_result_payload?: unknown
    final_error_payload?: unknown
  }
  outputChunks?: Array<{
    stream: string
    text_value: string
  }>
}) {
  return {
    requestBlocks: buildGenericToolRequestBlocks(
      getToolDisplayTitle(params.toolName, params.requestPayload),
      params.input
    ),
    resultBlocks: buildGenericToolResultBlocks({
      resultParts: params.resultParts,
      latestResult: params.latestResult,
      task: params.task,
      outputChunks: params.outputChunks,
    }),
  }
}

async function buildToolActivityDetail(turnId: string) {
  const turnRow = await db
    .selectFrom("turns")
    .innerJoin("sessions as s", "s.id", "turns.session_id")
    .innerJoin("actors as a", "a.id", "turns.actor_id")
    .select([
      "turns.id",
      "turns.session_id",
      "turns.conversation_id",
      "turns.actor_id",
      "turns.started_at",
      "turns.updated_at",
      "turns.completed_at",
      "s.workspace_id",
      "a.name as actor_name",
    ])
    .where("turns.id", "=", turnId)
    .limit(1)
    .executeTakeFirst()

  if (!turnRow) {
    return null
  }

  const toolCalls = await db
    .selectFrom("tool_calls")
    .selectAll()
    .where("turn_id", "=", turnId)
    .orderBy("created_at", "asc")
    .orderBy("call_index", "asc")
    .execute()

  const toolCallIds = toolCalls.map((row) => row.id)
  const latestResultsByToolCall = new Map<string, any>()
  const resultPartsByResultId = new Map<string, any[]>()
  const latestTasksByToolCall = new Map<string, any>()
  const outputChunksByTaskId = new Map<
    string,
    Array<{ stream: string; text_value: string }>
  >()

  if (toolCallIds.length > 0) {
    const results = await db
      .selectFrom("tool_results")
      .selectAll()
      .where("tool_call_id", "in", toolCallIds)
      .orderBy("tool_call_id", "asc")
      .orderBy("result_index", "desc")
      .execute()

    for (const row of results) {
      if (!latestResultsByToolCall.has(row.tool_call_id)) {
        latestResultsByToolCall.set(row.tool_call_id, row)
      }
    }

    const resultIds = [...latestResultsByToolCall.values()].map((row) => row.id)
    if (resultIds.length > 0) {
      const resultParts = await db
        .selectFrom("tool_result_parts")
        .selectAll()
        .where("tool_result_id", "in", resultIds)
        .orderBy("tool_result_id", "asc")
        .orderBy("ordinal", "asc")
        .execute()

      for (const row of resultParts) {
        const existing = resultPartsByResultId.get(row.tool_result_id) || []
        existing.push(row)
        resultPartsByResultId.set(row.tool_result_id, existing)
      }
    }

    const tasks = await db
      .selectFrom("tool_call_tasks")
      .selectAll()
      .where("source_tool_call_id", "in", toolCallIds)
      .orderBy("created_at", "desc")
      .execute()

    for (const row of tasks) {
      if (
        row.source_tool_call_id &&
        !latestTasksByToolCall.has(row.source_tool_call_id)
      ) {
        latestTasksByToolCall.set(row.source_tool_call_id, row)
      }
    }

    const taskIds = [...latestTasksByToolCall.values()].map((row) => row.id)
    if (taskIds.length > 0) {
      const outputRows = await db
        .selectFrom("tool_call_task_output_chunks")
        .select(["task_id", "stream", "text_value", "seq"])
        .where("task_id", "in", taskIds)
        .orderBy("task_id", "asc")
        .orderBy("seq", "desc")
        .execute()

      for (const row of outputRows) {
        const existing = outputChunksByTaskId.get(row.task_id) || []
        if (existing.length >= 8) continue
        existing.push({
          stream: row.stream,
          text_value: row.text_value,
        })
        outputChunksByTaskId.set(row.task_id, existing)
      }

      for (const [taskId, chunks] of outputChunksByTaskId) {
        outputChunksByTaskId.set(taskId, [...chunks].reverse())
      }
    }
  }

  const processingTargets = await loadProcessingTargetsForTurn(turnId)

  const items: ActorRuntimeTurnActivityItem[] = []
  for (const toolCall of toolCalls) {
    const latestResult = latestResultsByToolCall.get(toolCall.id)
    const task = latestTasksByToolCall.get(toolCall.id)
    const resultParts = latestResult
      ? resultPartsByResultId.get(latestResult.id) || []
      : []
    const outputChunks = task ? outputChunksByTaskId.get(task.id) || [] : []
    const requestPayload = task
      ? parseMetadata(task.request_payload)
      : undefined
    const state = mapToolActivityState({
      toolCallStatus: toolCall.status,
      taskStatus: task?.status || undefined,
      latestResultIsError: latestResult?.is_error === true,
    })
    const displayTitle = getToolDisplayTitle(toolCall.tool_name, requestPayload)
    const displayDetail = getToolDisplayDetail({
      toolCallStatus: toolCall.status,
      taskStatus: task?.status || undefined,
      statusMessage: task?.status_message || undefined,
      errorMessage:
        latestResult?.error_message ||
        (typeof task?.final_error_payload === "object"
          ? prettyJson(task.final_error_payload)
          : undefined),
    })

    const blockParams = {
      toolName: toolCall.tool_name,
      input: parseJsonValue(toolCall.normalized_input),
      requestPayload,
      resultParts,
      latestResult,
      task,
      outputChunks,
    }

    const blocks =
      toolCall.tool_kind === "builtin"
        ? await buildBuiltinToolBlocks(blockParams)
        : toolCall.tool_kind === "mcp_relay"
          ? await buildRelayBuiltinToolBlocks(blockParams)
          : {
              requestBlocks: buildGenericToolRequestBlocks(
                displayTitle,
                parseJsonValue(toolCall.normalized_input)
              ),
              resultBlocks: buildGenericToolResultBlocks({
                resultParts,
                latestResult,
                task,
                outputChunks,
              }),
            }

    items.push({
      toolCallId: toolCall.id,
      toolKind: toolCall.tool_kind,
      toolName: toolCall.tool_name,
      state,
      displayTitle,
      displayDetail,
      requestBlocks: blocks.requestBlocks,
      resultBlocks: blocks.resultBlocks,
      taskStatus: task?.status || undefined,
      startedAt: toIsoString(toolCall.created_at) || nowISO(),
      updatedAt:
        pickLatestTimestamp(
          toIsoString(task?.updated_at),
          toIsoString(latestResult?.created_at),
          toIsoString(toolCall.completed_at),
          toIsoString(toolCall.created_at)
        ) || nowISO(),
      completedAt:
        toIsoString(toolCall.completed_at) ||
        toIsoString(task?.completed_at) ||
        undefined,
    })
  }

  const updatedAt =
    pickLatestTimestamp(
      ...processingTargets.map(
        (target) => target.attachedAt || target.createdAt
      ),
      ...items.map((item) => item.updatedAt),
      toIsoString(turnRow.completed_at),
      toIsoString(turnRow.updated_at),
      toIsoString(turnRow.started_at)
    ) || nowISO()

  return {
    conversationId: turnRow.conversation_id,
    actorId: turnRow.actor_id,
    actorName: turnRow.actor_name || "Unknown",
    turnId: turnRow.id,
    sessionId: turnRow.session_id,
    startedAt: toIsoString(turnRow.started_at) || nowISO(),
    updatedAt,
    processingTargets,
    items,
  }
}

function buildTurnPreviewFromDetail(
  detail: (ActorRuntimeTurnActivityDetail & { sessionId: string }) | null
): ActorRuntimeTurnPreview | undefined {
  if (!detail) return undefined

  const totalToolCallCount = detail.items.length
  const completedItems = detail.items.filter(
    (item) => item.state === "completed"
  )
  const failedItems = detail.items.filter(
    (item) => item.state === "failed" || item.state === "cancelled"
  )
  const activeTool = [...detail.items]
    .reverse()
    .find(
      (item) =>
        item.state === "running" ||
        item.state === "pending" ||
        item.state === "input_required"
    )
  const lastCompletedTool = [...detail.items]
    .reverse()
    .find(
      (item) =>
        item.state === "completed" ||
        item.state === "failed" ||
        item.state === "cancelled" ||
        item.state === "skipped"
    )

  return {
    turnId: detail.turnId,
    startedAt: detail.startedAt,
    updatedAt: detail.updatedAt,
    processingTargets: detail.processingTargets,
    activeTool: activeTool
      ? {
          toolCallId: activeTool.toolCallId,
          toolKind: activeTool.toolKind,
          toolName: activeTool.toolName,
          state: activeTool.state,
          displayTitle: activeTool.displayTitle,
          displayDetail: activeTool.displayDetail,
          startedAt: activeTool.startedAt,
          updatedAt: activeTool.updatedAt,
          completedAt: activeTool.completedAt,
        }
      : undefined,
    lastCompletedTool: lastCompletedTool
      ? {
          toolCallId: lastCompletedTool.toolCallId,
          toolKind: lastCompletedTool.toolKind,
          toolName: lastCompletedTool.toolName,
          state: lastCompletedTool.state,
          displayTitle: lastCompletedTool.displayTitle,
          displayDetail: lastCompletedTool.displayDetail,
          startedAt: lastCompletedTool.startedAt,
          updatedAt: lastCompletedTool.updatedAt,
          completedAt: lastCompletedTool.completedAt,
        }
      : undefined,
    totalToolCallCount,
    completedToolCallCount: completedItems.length,
    failedToolCallCount: failedItems.length,
  }
}

export async function getConversationRuntimeMap(conversationIds: string[]) {
  if (conversationIds.length === 0) {
    return {} as Record<string, Record<string, ActorRuntimeState>>
  }

  const pipeline = redis.pipeline()
  for (const conversationId of conversationIds) {
    pipeline.hgetall(runtimeHashKey(conversationId))
  }

  const responses = await pipeline.exec()
  const runtimeMap: Record<string, Record<string, ActorRuntimeState>> = {}

  for (let index = 0; index < conversationIds.length; index++) {
    const conversationId = conversationIds[index]!
    const [, rawMap] = responses?.[index] || []
    const parsed: Record<string, ActorRuntimeState> = {}
    for (const [actorId, rawValue] of Object.entries(
      (rawMap || {}) as Record<string, string>
    )) {
      try {
        parsed[actorId] = JSON.parse(rawValue)
      } catch {
        // ignore malformed cache entry
      }
    }
    runtimeMap[conversationId] = parsed
  }

  const sessionResult = await db
    .selectFrom("sessions as s")
    .innerJoin("conversations as c", "c.id", "s.conversation_id")
    .select(["s.id", "s.actor_id", "s.conversation_id"])
    .where("s.conversation_id", "in", conversationIds)
    .where("c.kind", "in", [...THREAD_CONVERSATION_KINDS])
    .execute()

  const missingSessions = sessionResult.filter(
    (row) => !runtimeMap[row.conversation_id]?.[row.actor_id]
  )
  if (missingSessions.length === 0) {
    return runtimeMap
  }

  const hydratedSnapshots = await Promise.all(
    missingSessions.map(async (row) => {
      const snapshot = await buildSessionRuntimeSnapshot(row.id)
      return snapshot
        ? { conversationId: row.conversation_id as string, snapshot }
        : null
    })
  )

  const hydratePipeline = redis.pipeline()
  for (const entry of hydratedSnapshots) {
    if (!entry) continue
    runtimeMap[entry.conversationId] = runtimeMap[entry.conversationId] || {}
    runtimeMap[entry.conversationId]![entry.snapshot.actorId] = entry.snapshot
    hydratePipeline.hset(
      runtimeHashKey(entry.conversationId),
      entry.snapshot.actorId,
      JSON.stringify(entry.snapshot)
    )
  }
  await hydratePipeline.exec()

  return runtimeMap
}

interface SessionRuntimeSnapshotOverrides {
  laneState?: ActorRuntimeState["laneState"]
  health?: ActorRuntimeState["health"]
  phase?: ActorRuntimeState["phase"]
  statusText?: ActorRuntimeState["statusText"]
  activeTurnId?: string
  /**
   * Pass `null` to explicitly clear any inherited lastError from the cached
   * runtime snapshot (e.g. when re-enqueuing a previously-blocked session
   * — the old failure is no longer current and must not leak through into
   * the next "queued" / "running" snapshot).
   */
  lastError?: ActorRuntimeState["lastError"] | null
}

export async function buildSessionRuntimeSnapshot(
  sessionId: string,
  overrides: SessionRuntimeSnapshotOverrides = {}
): Promise<ActorRuntimeState | null> {
  const session = await getSession(sessionId)
  if (!session || !isThreadConversationKind(session.conversation_kind))
    return null

  let cachedRuntime: ActorRuntimeState | null = null
  const cachedRaw = await redis.hget(
    runtimeHashKey(session.conversation_id),
    session.actor_id
  )
  if (cachedRaw) {
    try {
      cachedRuntime = JSON.parse(cachedRaw) as ActorRuntimeState
    } catch {
      cachedRuntime = null
    }
  }

  const rawWakeups = await loadRuntimeWakeups(sessionId, [
    "pending",
    "attached",
  ])
  const pendingWakeupCount = rawWakeups.filter(
    (wakeup) => wakeup.status === "pending"
  ).length
  const latestWakeupAt =
    rawWakeups.length > 0
      ? rawWakeups[rawWakeups.length - 1]!.createdAt
      : undefined
  const lastError =
    overrides.lastError === null
      ? undefined
      : overrides.lastError ||
        cachedRuntime?.lastError ||
        (session.error_message
          ? {
              message: session.error_message as string,
              at: session.updated_at || nowISO(),
            }
          : undefined)

  const laneState = overrides.laneState || session.status
  const phase =
    overrides.phase ||
    (laneState === "running" ||
    laneState === "queued" ||
    laneState === "blocked"
      ? cachedRuntime?.phase
      : undefined) ||
    (laneState === "running"
      ? "thinking"
      : laneState === "blocked"
        ? "error"
        : "idle")
  const health = overrides.health || (lastError ? "error" : "ok")
  const activeTurnId =
    overrides.activeTurnId ||
    (laneState === "running" || laneState === "blocked"
      ? await loadActiveTurnIdForSession(sessionId)
      : undefined)
  const currentTurnDetail = activeTurnId
    ? await buildToolActivityDetail(activeTurnId)
    : null
  const currentTurnPreview = buildTurnPreviewFromDetail(currentTurnDetail)

  return {
    conversationId: session.conversation_id,
    sessionId: session.id,
    actorId: session.actor_id,
    actorName: session.actor_name || "Unknown",
    laneState,
    health,
    phase,
    statusText:
      overrides.statusText ??
      (laneState === "running" ||
      laneState === "queued" ||
      laneState === "blocked"
        ? cachedRuntime?.statusText
        : undefined),
    pendingWakeupCount,
    currentTurnPreview,
    latestWakeupAt,
    lastError,
    updatedAt: nowISO(),
  }
}

export async function getSessionRuntimeTurnActivityDetail(params: {
  conversationId: string
  actorId: string
  turnId: string
}): Promise<ActorRuntimeTurnActivityDetail | null> {
  const detail = await buildToolActivityDetail(params.turnId)
  if (!detail) return null
  if (
    detail.conversationId !== params.conversationId ||
    detail.actorId !== params.actorId
  ) {
    return null
  }

  const { sessionId: _sessionId, ...activityDetail } = detail
  return activityDetail
}

export function scheduleSessionRuntimeRefresh(
  workspaceId: string,
  sessionId: string,
  debounceMs = 350
) {
  const existing = runtimePublishDebounceTimers.get(sessionId)
  if (existing) {
    clearTimeout(existing)
  }

  const timer = setTimeout(
    () => {
      runtimePublishDebounceTimers.delete(sessionId)
      void publishSessionRuntime(workspaceId, sessionId).catch((error) => {
        console.error(
          `[runtime] failed to publish debounced runtime for session ${sessionId}:`,
          error
        )
      })
    },
    Math.max(0, debounceMs)
  )
  timer.unref?.()
  runtimePublishDebounceTimers.set(sessionId, timer)
}

export async function publishSessionRuntime(
  workspaceId: string,
  sessionId: string,
  overrides: SessionRuntimeSnapshotOverrides = {}
) {
  const snapshot = await buildSessionRuntimeSnapshot(sessionId, overrides)
  if (!snapshot) return null

  await redis.hset(
    runtimeHashKey(snapshot.conversationId),
    snapshot.actorId,
    JSON.stringify(snapshot)
  )
  const runtimeSeq = await redis.incr(
    runtimeSequenceKey(snapshot.conversationId)
  )
  await emitEvent({
    type: "runtime.updated",
    workspaceId,
    payload: {
      conversationId: snapshot.conversationId,
      runtimeSeq,
      snapshot,
    },
    timestamp: nowISO(),
  })

  return snapshot
}

export async function removeSessionRuntime(sessionId: string) {
  const timer = runtimePublishDebounceTimers.get(sessionId)
  if (timer) {
    clearTimeout(timer)
    runtimePublishDebounceTimers.delete(sessionId)
  }
  const session = await getSession(sessionId)
  if (!session || !isThreadConversationKind(session.conversation_kind)) return
  await redis.hdel(runtimeHashKey(session.conversation_id), session.actor_id)
}

export async function enqueueSessionWakeup(params: {
  sessionId: string
  actorId: string
  workspaceId: string
  sourceType: SessionWakeupSourceType
  sourceItemId?: string
  sourceSessionId?: string
  sourceParticipantType?:
    | "workspace_member"
    | "actor"
    | "remote_agent"
    | "external"
    | "system"
  sourceParticipantId?: string
  sourceName?: string
  summary: string
  reasonText?: string
  automationExecutionId?: string
  automationOccurrenceId?: string
  metadata?: Record<string, unknown>
  trigger?: SessionTrigger
}) {
  const session = await getSession(params.sessionId)
  if (!session) {
    throw new Error(`Session ${params.sessionId} not found`)
  }
  if (session.status === "closed") {
    throw new Error(`Session ${params.sessionId} is closed`)
  }

  let created: any
  let reusedExistingWakeup = false

  if (params.sourceItemId) {
    const insertResult = await query(
      `
        INSERT INTO session_wakeups (
          id,
          session_id,
          source_type,
          source_item_id,
          source_session_id,
          source_participant_type,
          source_participant_id,
          source_name,
          summary,
          reason_text,
          automation_execution_id,
          automation_occurrence_id,
          status,
          metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13::jsonb
        )
        ON CONFLICT (session_id, source_type, source_item_id)
        WHERE source_item_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `,
      [
        crypto.randomUUID(),
        params.sessionId,
        params.sourceType,
        params.sourceItemId,
        params.sourceSessionId || null,
        params.sourceParticipantType || null,
        params.sourceParticipantId || null,
        params.sourceName || null,
        params.summary,
        params.reasonText || null,
        params.automationExecutionId || null,
        params.automationOccurrenceId || null,
        JSON.stringify(params.metadata || {}),
      ]
    )
    created = insertResult.rows[0]

    if (!created) {
      const existing = await query(
        `
          SELECT *
          FROM session_wakeups
          WHERE session_id = $1
            AND source_type = $2
            AND source_item_id = $3
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [params.sessionId, params.sourceType, params.sourceItemId]
      )
      created = existing.rows[0]
      reusedExistingWakeup = Boolean(created)
    }
  } else {
    created = await db
      .insertInto("session_wakeups")
      .values({
        id: crypto.randomUUID(),
        session_id: params.sessionId,
        source_type: params.sourceType,
        source_item_id: null,
        source_session_id: params.sourceSessionId || null,
        source_participant_type: params.sourceParticipantType || null,
        source_participant_id: params.sourceParticipantId || null,
        source_name: params.sourceName || null,
        summary: params.summary,
        reason_text: params.reasonText || null,
        automation_execution_id: params.automationExecutionId || null,
        automation_occurrence_id: params.automationOccurrenceId || null,
        status: "pending",
        metadata: (params.metadata ||
          {}) as TableInsert<"session_wakeups">["metadata"],
      })
      .returningAll()
      .executeTakeFirst()
  }
  if (!created) {
    throw new Error("Failed to enqueue session wakeup")
  }

  if (reusedExistingWakeup) {
    return created
  }

  if (session.status === "idle" || session.status === "blocked") {
    await updateSessionStatus(params.sessionId, "queued", {
      errorMessage: null,
    })
  }

  // When transitioning out of "blocked", the cached runtime snapshot still
  // carries phase="error" and a stale lastError from the previous failure.
  // Override them explicitly so consumers (IM hooks, dashboard) see a clean
  // queued/running state instead of inheriting the prior error through
  // buildSessionRuntimeSnapshot's inherit-from-cache fallback (see runtime
  // snapshot builder for the inheritance rules).
  const requeueOverrides:
    | { phase: ActorRuntimePhase; lastError: null }
    | Record<string, never> =
    session.status === "blocked" ? { phase: "idle", lastError: null } : {}

  await publishSessionRuntime(params.workspaceId, params.sessionId, {
    laneState: session.status === "running" ? "running" : "queued",
    health: session.status === "blocked" ? "ok" : undefined,
    ...requeueOverrides,
  })

  if (session.status !== "running") {
    await sessionThinkingQueue.add("think", {
      sessionId: params.sessionId,
      actorId: params.actorId,
      workspaceId: params.workspaceId,
      trigger:
        params.trigger || mapWakeupSourceTypeToTrigger(params.sourceType),
    })
  }

  return created
}

export async function attachPendingWakeupsToTurn(
  sessionId: string,
  turnId: string
) {
  const rows = await db
    .updateTable("session_wakeups")
    .set({
      status: "attached",
      turn_id: turnId,
      attached_at: sql`NOW()`,
    })
    .where("session_id", "=", sessionId)
    .where("status", "=", "pending")
    .returningAll()
    .execute()

  return rows.map(mapWakeupRow)
}

export async function markTurnWakeupsProcessed(turnId: string) {
  await db
    .updateTable("session_wakeups")
    .set({
      status: "processed",
      processed_at: sql`NOW()`,
    })
    .where("turn_id", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

export async function markTurnWakeupsDropped(turnId: string) {
  await db
    .updateTable("session_wakeups")
    .set({
      status: "dropped",
      processed_at: sql`NOW()`,
    })
    .where("turn_id", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

export async function getPendingWakeupCount(sessionId: string) {
  const row = await db
    .selectFrom("session_wakeups")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("session_id", "=", sessionId)
    .where("status", "=", "pending")
    .executeTakeFirst()

  return Number(row?.count || 0)
}

export async function getPendingWakeups(sessionId: string) {
  const rows = await db
    .selectFrom("session_wakeups")
    .selectAll()
    .where("session_id", "=", sessionId)
    .where("status", "=", "pending")
    .orderBy("created_at", "asc")
    .execute()

  return rows.map(mapWakeupRow)
}
