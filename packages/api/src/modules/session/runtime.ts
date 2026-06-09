import { redis } from "../../infrastructure/redis/index.js"
import {
  db,
  type Executor,
  type TableInsert,
  type TableRow,
} from "../../infrastructure/database/kysely.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
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
  type ActorRuntimeToolSource,
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
import { getSession, updateSessionStatus } from "./service.js"
import { resolveToolPresentation } from "./tool-presentation/resolver.js"
import {
  renderToolRequest,
  renderToolResult,
  type ToolResultData,
} from "./tool-presentation/render.js"
import { redactDeep } from "./tool-presentation/redact.js"

const log = createLogger("session.runtime")

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

// Build the structured UI source from the persisted source_kind + source_snapshot
// (tool provenance & routing). Lets the UI render a source badge / secondary text
// so two same-leaf tools from different sources are distinguishable, instead of
// inferring from the wire name. Tolerant of older rows with a thin snapshot.
function getToolSource(
  sourceKind: unknown,
  sourceSnapshot: unknown
): ActorRuntimeToolSource | undefined {
  if (
    sourceKind !== "system" &&
    sourceKind !== "plugin" &&
    sourceKind !== "device"
  ) {
    return undefined
  }
  const snap =
    sourceSnapshot && typeof sourceSnapshot === "object"
      ? (sourceSnapshot as Record<string, unknown>)
      : {}
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined
  if (sourceKind === "plugin") {
    const publisher = str(snap.publisherSlug)
    const item = str(snap.itemSlug)
    const displayName =
      publisher && item ? `${publisher}/${item}` : (item ?? publisher)
    return {
      kind: "plugin",
      ...(displayName ? { displayName } : {}),
      ...(str(snap.upstreamToolName)
        ? { upstreamToolName: str(snap.upstreamToolName) }
        : {}),
    }
  }
  if (sourceKind === "device") {
    return {
      kind: "device",
      ...(str(snap.deviceName) ? { displayName: str(snap.deviceName) } : {}),
      ...(str(snap.visibleToolName)
        ? { upstreamToolName: str(snap.visibleToolName) }
        : {}),
    }
  }
  return { kind: "system" }
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

// API-side parts→blocks adapter: produce the raw result body blocks the
// presentation renderer keeps under bodyMode summary_then_raw/passthrough. This
// is the DB-coupled half (tool_result_parts / output chunks / task payloads)
// that stays in the API; the shared renderer never touches DB rows.
function buildResultBodyBlocks(params: {
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
}): CanonicalContentBlock[] {
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

// Pull the Phase-2 structured result namespace (tool_results.metadata.toolMeta)
// for the presentation renderer's ResultRef `meta.*` paths.
function readToolMeta(metadata: unknown): Record<string, unknown> | undefined {
  const record = asRecord(parseJsonValue(metadata))
  const toolMeta = record.toolMeta
  return toolMeta && typeof toolMeta === "object" && !Array.isArray(toolMeta)
    ? (toolMeta as Record<string, unknown>)
    : undefined
}

async function buildToolActivityDetail(turnId: string) {
  const turnRow = await db
    .selectFrom("turns")
    .innerJoin("sessions as s", "s.id", "turns.session_id")
    .innerJoin("actors as a", "a.id", "turns.actor_id")
    .innerJoin("workspace_apps as app", "app.id", "a.id")
    .select([
      "turns.id",
      "turns.session_id",
      "turns.conversation_id",
      "turns.actor_id",
      "turns.started_at",
      "turns.updated_at",
      "turns.completed_at",
      "s.workspace_id",
      "app.display_name as actor_display_name",
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
    const state = mapToolActivityState({
      toolCallStatus: toolCall.status,
      taskStatus: task?.status || undefined,
      latestResultIsError: latestResult?.is_error === true,
    })
    const toolSource = getToolSource(
      toolCall.source_kind,
      toolCall.source_snapshot
    )
    const displayDetailStatus = getToolDisplayDetail({
      toolCallStatus: toolCall.status,
      taskStatus: task?.status || undefined,
      statusMessage: task?.status_message || undefined,
      errorMessage:
        latestResult?.error_message ||
        (typeof task?.final_error_payload === "object"
          ? prettyJson(task.final_error_payload)
          : undefined),
    })

    // Resolve the CURRENT presentation descriptor by following the source
    // (snapshot.stableKey), then render request + result. Redaction is a single
    // deep secretlint pass over the rendered output before it enters the snapshot.
    const descriptor = await resolveToolPresentation({
      sourceKind: toolCall.source_kind,
      sourceSnapshot: toolCall.source_snapshot,
      pluginInstallationId: toolCall.plugin_installation_id,
    })
    const args = asRecord(parseJsonValue(toolCall.normalized_input))
    const request = renderToolRequest(descriptor, args)
    const resultData: ToolResultData = {
      meta: readToolMeta(latestResult?.metadata),
      task: parseJsonValue(task?.final_result_payload),
      error:
        latestResult?.error_message ||
        (typeof task?.final_error_payload === "object"
          ? prettyJson(task.final_error_payload)
          : undefined) ||
        undefined,
      bodyBlocks: buildResultBodyBlocks({
        resultParts,
        latestResult,
        task,
        outputChunks,
      }),
    }
    const result = renderToolResult(descriptor, resultData)

    const rendered = await redactDeep({
      icon: request.icon,
      titlePresentation: request.title,
      detailPresentation: request.detail,
      requestBlocks: request.requestBlocks,
      resultSummary: result.resultSummary,
      resultBlocks: result.resultBlocks,
    })

    items.push({
      toolCallId: toolCall.id,
      toolKind: toolCall.source_kind,
      toolName: toolCall.tool_name,
      ...(toolSource ? { source: toolSource } : {}),
      icon: rendered.icon,
      state,
      // displayTitle/displayDetail remain the fallback strings old clients read.
      displayTitle: rendered.titlePresentation.fallback,
      displayDetail:
        displayDetailStatus ?? rendered.detailPresentation?.fallback,
      titlePresentation: rendered.titlePresentation,
      ...(rendered.detailPresentation
        ? { detailPresentation: rendered.detailPresentation }
        : {}),
      ...(rendered.resultSummary
        ? { resultSummary: rendered.resultSummary }
        : {}),
      requestBlocks: rendered.requestBlocks,
      resultBlocks: rendered.resultBlocks,
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
    actorDisplayName: turnRow.actor_display_name || "Unknown",
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
    activeTool: activeTool ? toPreviewTool(activeTool) : undefined,
    lastCompletedTool: lastCompletedTool
      ? toPreviewTool(lastCompletedTool)
      : undefined,
    totalToolCallCount,
    completedToolCallCount: completedItems.length,
    failedToolCallCount: failedItems.length,
  }
}

// Project a full activity item into the light preview tool (no result blocks /
// raw bodies — preview stays cheap). Carries icon + presentation strings so the
// collapsed bubble shows the friendly title without fetching the detail.
function toPreviewTool(
  item: ActorRuntimeTurnActivityItem
): ActorRuntimeTurnPreviewTool {
  return {
    toolCallId: item.toolCallId,
    toolKind: item.toolKind,
    toolName: item.toolName,
    ...(item.source ? { source: item.source } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    state: item.state,
    displayTitle: item.displayTitle,
    displayDetail: item.displayDetail,
    ...(item.titlePresentation
      ? { titlePresentation: item.titlePresentation }
      : {}),
    ...(item.detailPresentation
      ? { detailPresentation: item.detailPresentation }
      : {}),
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt,
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
  /**
   * Pass `null` to explicitly clear any inherited statusText from the
   * cached runtime snapshot. See lastError doc for the same pattern.
   */
  statusText?: ActorRuntimeState["statusText"] | null
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
    actorDisplayName: session.actor_display_name || "Unknown",
    laneState,
    health,
    phase,
    statusText:
      overrides.statusText === null
        ? undefined
        : (overrides.statusText ??
          (laneState === "running" ||
          laneState === "queued" ||
          laneState === "blocked"
            ? cachedRuntime?.statusText
            : undefined)),
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
        log.error(
          { err: error },
          `[runtime] failed to publish debounced runtime for session ${sessionId}`
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

export interface EnqueueSessionWakeupParams {
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
}

/**
 * Durable half of {@link enqueueSessionWakeup}: insert (or idempotently reuse)
 * the `session_wakeups` row on the given executor. No Redis/queue side effects —
 * pure DB write, so it can run INSIDE a caller's transaction (e.g. resolved
 * task delivery, which commits the wakeup row + the task's completion marker
 * atomically so a crash can't leave a "delivered" marker without a wakeup).
 *
 * Returns the row plus `reusedExistingWakeup` (true when ON CONFLICT hit an
 * existing pending wakeup for the same source item — the nudge is then a no-op).
 */
export async function insertSessionWakeupRow(
  executor: Executor,
  params: EnqueueSessionWakeupParams
): Promise<{
  created: TableRow<"session_wakeups">
  reusedExistingWakeup: boolean
}> {
  let created: TableRow<"session_wakeups"> | undefined
  let reusedExistingWakeup = false

  if (params.sourceItemId) {
    const insertResult = await sql<TableRow<"session_wakeups">>`
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
          ${crypto.randomUUID()},
          ${params.sessionId},
          ${params.sourceType},
          ${params.sourceItemId},
          ${params.sourceSessionId || null},
          ${params.sourceParticipantType || null},
          ${params.sourceParticipantId || null},
          ${params.sourceName || null},
          ${params.summary},
          ${params.reasonText || null},
          ${params.automationExecutionId || null},
          ${params.automationOccurrenceId || null},
          'pending',
          ${JSON.stringify(params.metadata || {})}::jsonb
        )
        ON CONFLICT (session_id, source_type, source_item_id)
        WHERE source_item_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `.execute(executor)
    created = insertResult.rows[0]

    if (!created) {
      const existing = await executor
        .selectFrom("session_wakeups")
        .selectAll()
        .where("session_id", "=", params.sessionId)
        .where("source_type", "=", params.sourceType)
        .where("source_item_id", "=", params.sourceItemId)
        .orderBy("created_at", "desc")
        .limit(1)
        .execute()
      created = existing[0]
      reusedExistingWakeup = Boolean(created)
    }
  } else {
    created = await executor
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
  return { created, reusedExistingWakeup }
}

/**
 * Non-durable half of {@link enqueueSessionWakeup}: flip the session out of
 * idle/blocked, publish the runtime snapshot, and enqueue the think job that
 * drives the session. Safe to call POST-COMMIT (after the durable wakeup row is
 * persisted): the worker drains ALL pending wakeups for the session, so even a
 * lost nudge is recovered by the worker's pending-wakeup self-heal — but firing
 * it keeps latency low. A no-op when the wakeup was a reuse.
 */
export async function nudgeSessionAfterWakeup(
  params: EnqueueSessionWakeupParams,
  session: { status: string }
): Promise<void> {
  if (session.status === "idle" || session.status === "blocked") {
    await updateSessionStatus(params.sessionId, "queued", {
      errorMessage: null,
    })
  }

  // When transitioning out of "blocked", the cached runtime snapshot still
  // carries phase="error", a stale lastError, and a statusText that holds
  // the previous failure's message. Override them explicitly so consumers
  // (IM hooks, dashboard) see a clean queued/running state instead of
  // inheriting the prior error through buildSessionRuntimeSnapshot's
  // inherit-from-cache fallback. statusText specifically is what the
  // dashboard chat runtime UI prints to the user (web-next runtime-ui.ts
  // surfaces runtime.statusText first), so leaving the failure message
  // there would visibly lie about the session's current state.
  const requeueOverrides:
    | { phase: ActorRuntimePhase; lastError: null; statusText: null }
    | Record<string, never> =
    session.status === "blocked"
      ? { phase: "idle", lastError: null, statusText: null }
      : {}

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
}

export async function enqueueSessionWakeup(params: EnqueueSessionWakeupParams) {
  const session = await getSession(params.sessionId)
  if (!session) {
    throw new Error(`Session ${params.sessionId} not found`)
  }
  if (session.status === "closed") {
    throw new Error(`Session ${params.sessionId} is closed`)
  }

  const { created, reusedExistingWakeup } = await insertSessionWakeupRow(
    db,
    params
  )

  if (reusedExistingWakeup) {
    return created
  }

  await nudgeSessionAfterWakeup(params, session)

  return created
}

export async function attachPendingWakeupsToTurn(
  sessionId: string,
  turnId: string,
  executor: Executor = db
) {
  const rows = await executor
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

export async function markTurnWakeupsDropped(
  turnId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("session_wakeups")
    .set({
      status: "dropped",
      processed_at: sql`NOW()`,
    })
    .where("turn_id", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

/**
 * Reverse attachPendingWakeupsToTurn: flip this turn's `attached` wakeups back
 * to `pending` so another worker can re-claim them. Used when a turn is aborted
 * WITHOUT having processed its wakeups (e.g. the worker lost the session lock
 * mid-turn) — dropping them would silently lose user-triggered wakeups.
 */
export async function restoreTurnWakeupsToPending(
  turnId: string,
  executor: Executor = db
) {
  await executor
    .updateTable("session_wakeups")
    .set({
      status: "pending",
      turn_id: null,
      attached_at: null,
    })
    .where("turn_id", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

export async function getPendingWakeupCount(
  sessionId: string,
  executor: Executor = db
) {
  const row = await executor
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
