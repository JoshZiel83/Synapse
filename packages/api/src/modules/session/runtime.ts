import { redis } from "../../infrastructure/redis/index.js"
import { nowIsoInstant } from "@synapse/shared/datetime"
import {
  parseInstantString,
  requireInstantDate,
} from "../../infrastructure/datetime.js"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { sessionThinkingQueue } from "../../workers/queues.js"
import { linkUpstreamTraces } from "../../workers/job-tracing.js"
import {
  ACTOR_RUNTIME_HEALTH,
  isThreadConversationKind,
  parseJsonObjectOrUndefined,
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
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"
import { getSession, updateSessionStatus } from "./service.js"
import * as repo from "./repo.js"
import { presentInstant, presentOptionalInstant } from "./presenter.js"
import {
  formatRuntimeJsonForPresentation,
  parseCachedActorRuntimeState,
} from "./runtime-cache-codec.js"
import { resolveToolPresentation } from "./tool-presentation/resolver.js"
import {
  renderToolRequest,
  renderToolResult,
  type ToolResultData,
} from "./tool-presentation/render.js"
import { redactDeep } from "./tool-presentation/redact.js"
import type {
  SessionWakeupRow,
  ToolCallTaskRow,
  ToolResultPartRow,
  ToolResultRow,
} from "./repo.types.js"

const log = createLogger("session.runtime")

function runtimeHashKey(conversationId: string) {
  return `runtime:conversation:${conversationId}`
}

function runtimeSequenceKey(conversationId: string) {
  return `runtime:conversation:${conversationId}:seq`
}

const runtimePublishDebounceTimers = new Map<string, NodeJS.Timeout>()

function mapWakeupSourceTypeToTrigger(
  sourceType: SessionWakeupSourceType
): SessionTrigger {
  return sourceType
}

function presentWakeup(row: SessionWakeupRow): ActorRuntimeWakeup {
  const metadata = row.metadata
  return {
    wakeupId: row.id,
    sourceType: row.sourceType,
    sourceItemId: row.sourceItemId || undefined,
    sourceSessionId: row.sourceSessionId || undefined,
    sourceParticipantType: row.sourceParticipantType || undefined,
    sourceParticipantId: row.sourceParticipantId || undefined,
    sourceName: row.sourceName || undefined,
    summary: row.summary,
    reasonText: row.reasonText || undefined,
    status: row.status,
    activationKind:
      typeof metadata.activationKind === "string"
        ? metadata.activationKind
        : undefined,
    delivery:
      typeof metadata.delivery === "string" ? metadata.delivery : undefined,
    createdAt: presentInstant(row.createdAt),
    attachedAt: presentOptionalInstant(row.attachedAt),
  }
}

async function loadRuntimeWakeups(
  sessionId: string,
  statuses: SessionWakeupStatus[] = ["pending", "attached"]
) {
  const rows = await repo.listSessionWakeups(sessionId, statuses)

  return rows.map(presentWakeup)
}

function buildTextBlocksFromLines(...parts: Array<string | null | undefined>) {
  const text = parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n")

  return text ? [textBlock(text)] : []
}

export {
  formatRuntimeJsonForPresentation,
  parseCachedActorRuntimeState,
} from "./runtime-cache-codec.js"

function pickLatestTimestamp(
  ...values: Array<import("@synapse/shared").Timestamp | undefined>
) {
  return values
    .filter((value): value is import("@synapse/shared").Timestamp =>
      Boolean(value)
    )
    .sort(
      (left, right) =>
        parseInstantString(right).getTime() - parseInstantString(left).getTime()
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

function mapTaskLifecycleToRuntimeTaskStatus(
  lifecycleStatus: ToolCallTaskRow["lifecycleStatus"] | undefined
): ActorRuntimeTurnActivityItem["taskStatus"] | undefined {
  if (!lifecycleStatus) return undefined
  if (lifecycleStatus === "submitted") return "working"
  if (lifecycleStatus === "auth_required") return "input_required"
  if (lifecycleStatus === "expired") return "failed"
  return lifecycleStatus
}

async function loadActiveTurnIdForSession(sessionId: string) {
  return repo.getActiveTurnId(sessionId)
}

async function loadProcessingTargetsForTurn(
  turnId: string
): Promise<ActorRuntimeProcessingTarget[]> {
  const rows = await repo.listAttachedWakeupTargets(turnId)

  return rows.map((row) => ({
    wakeupId: row.id,
    participantType:
      (row.sourceParticipantType as SessionWakeupSourceParticipantType | null) ||
      undefined,
    participantId: row.sourceParticipantId || undefined,
    name: row.sourceName || row.summary,
    summary: row.summary || undefined,
    createdAt: presentInstant(
      requireInstantDate(row.createdAt, "session_wakeups.created_at")
    ),
    attachedAt: presentOptionalInstant(row.attachedAt),
  }))
}

// API-side parts→blocks adapter: produce the raw result body blocks the
// presentation renderer keeps under bodyMode summary_then_raw/passthrough. This
// is the DB-coupled half (tool_result_parts / output chunks / task payloads)
// that stays in the API; the shared renderer never touches DB rows.
function buildResultBodyBlocks(params: {
  resultParts: any[]
  latestResult?: {
    isError?: boolean | null
    errorMessage?: string | null
    metadata?: Record<string, unknown>
  }
  task?: {
    statusMessage?: string | null
    finalResultPayload?: unknown
    finalErrorPayload?: unknown
  }
  outputChunks?: Array<{
    stream: string
    textValue: string
  }>
}): CanonicalContentBlock[] {
  if (params.resultParts.length > 0) {
    return itemPartsToCanonicalContentBlocks(params.resultParts)
  }

  if (params.outputChunks && params.outputChunks.length > 0) {
    return buildTextBlocksFromLines(
      params.outputChunks
        .map((chunk) => `[${chunk.stream}] ${chunk.textValue}`)
        .join("\n")
    )
  }

  const finalErrorPayload = params.task?.finalErrorPayload
  const finalResultPayload = params.task?.finalResultPayload
  if (
    finalErrorPayload &&
    Object.keys(parseJsonObjectOrUndefined(finalErrorPayload) ?? {}).length > 0
  ) {
    return buildTextBlocksFromLines(
      formatRuntimeJsonForPresentation(finalErrorPayload)
    )
  }
  if (
    finalResultPayload &&
    Object.keys(parseJsonObjectOrUndefined(finalResultPayload) ?? {}).length > 0
  ) {
    return buildTextBlocksFromLines(
      formatRuntimeJsonForPresentation(finalResultPayload)
    )
  }

  if (params.latestResult?.errorMessage) {
    return buildTextBlocksFromLines(params.latestResult.errorMessage)
  }

  if (params.task?.statusMessage) {
    return buildTextBlocksFromLines(params.task.statusMessage)
  }

  return []
}

// Pull the Phase-2 structured result namespace (tool_results.metadata.toolMeta)
// for the presentation renderer's ResultRef `meta.*` paths.
function readToolMeta(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const record = metadata || {}
  const toolMeta = record.toolMeta
  return toolMeta && typeof toolMeta === "object" && !Array.isArray(toolMeta)
    ? (toolMeta as Record<string, unknown>)
    : undefined
}

async function buildToolActivityDetail(turnId: string) {
  const turnRow = await repo.getTurnActivityHeader(turnId)

  if (!turnRow) {
    return null
  }

  const toolCalls = await repo.listTurnToolCalls(turnId)

  const toolCallIds = toolCalls.map((row) => row.id)
  const latestResultsByToolCall = new Map<string, ToolResultRow>()
  const resultPartsByResultId = new Map<string, ToolResultPartRow[]>()
  const latestTasksByToolCall = new Map<string, ToolCallTaskRow>()
  const outputChunksByTaskId = new Map<
    string,
    Array<{ stream: string; textValue: string }>
  >()

  if (toolCallIds.length > 0) {
    const results = await repo.listToolResultsForToolCalls(toolCallIds)

    for (const row of results) {
      if (!latestResultsByToolCall.has(row.toolCallId)) {
        latestResultsByToolCall.set(row.toolCallId, row)
      }
    }

    const resultIds = [...latestResultsByToolCall.values()].map((row) => row.id)
    if (resultIds.length > 0) {
      const resultParts = await repo.listToolResultParts(resultIds)

      for (const row of resultParts) {
        const existing = resultPartsByResultId.get(row.toolResultId) || []
        existing.push(row)
        resultPartsByResultId.set(row.toolResultId, existing)
      }
    }

    const tasks = await repo.listLatestTasksForToolCalls(toolCallIds)

    for (const row of tasks) {
      if (
        row.sourceToolCallId &&
        !latestTasksByToolCall.has(row.sourceToolCallId)
      ) {
        latestTasksByToolCall.set(row.sourceToolCallId, row)
      }
    }

    const taskIds = [...latestTasksByToolCall.values()].map((row) => row.id)
    if (taskIds.length > 0) {
      const outputRows = await repo.listTaskOutputChunks(taskIds)

      for (const row of outputRows) {
        const existing = outputChunksByTaskId.get(row.taskId) || []
        if (existing.length >= 8) continue
        existing.push({
          stream: row.stream,
          textValue: row.textValue,
        })
        outputChunksByTaskId.set(row.taskId, existing)
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
    const taskStatus = mapTaskLifecycleToRuntimeTaskStatus(
      task?.lifecycleStatus
    )
    const resultParts = latestResult
      ? resultPartsByResultId.get(latestResult.id) || []
      : []
    const outputChunks = task ? outputChunksByTaskId.get(task.id) || [] : []
    const state = mapToolActivityState({
      toolCallStatus: toolCall.status,
      taskStatus,
      latestResultIsError: latestResult?.isError === true,
    })
    const toolSource = getToolSource(
      toolCall.sourceKind,
      toolCall.sourceSnapshot
    )
    const displayDetailStatus = getToolDisplayDetail({
      toolCallStatus: toolCall.status,
      taskStatus,
      statusMessage: task?.statusMessage || undefined,
      errorMessage:
        latestResult?.errorMessage ||
        (typeof task?.finalErrorPayload === "object"
          ? formatRuntimeJsonForPresentation(task.finalErrorPayload)
          : undefined),
    })

    // Resolve the CURRENT presentation descriptor by following the source
    // (snapshot.stableKey), then render request + result. Redaction is a single
    // deep secretlint pass over the rendered output before it enters the snapshot.
    const descriptor = await resolveToolPresentation({
      sourceKind: toolCall.sourceKind,
      sourceSnapshot: toolCall.sourceSnapshot,
      pluginInstallationId: toolCall.pluginInstallationId,
    })
    const args = parseJsonObjectOrUndefined(toolCall.normalizedInput) ?? {}
    const request = renderToolRequest(descriptor, args)
    const resultData: ToolResultData = {
      meta: readToolMeta(latestResult?.metadata),
      task: task?.finalResultPayload,
      error:
        latestResult?.errorMessage ||
        (typeof task?.finalErrorPayload === "object"
          ? formatRuntimeJsonForPresentation(task.finalErrorPayload)
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
      toolKind: toolCall.sourceKind,
      toolName: toolCall.toolName,
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
      taskStatus,
      startedAt: presentInstant(
        requireInstantDate(toolCall.createdAt, "tool_calls.created_at")
      ),
      updatedAt: pickLatestTimestamp(
        presentOptionalInstant(task?.updatedAt),
        presentOptionalInstant(latestResult?.createdAt),
        presentOptionalInstant(toolCall.completedAt),
        presentInstant(
          requireInstantDate(toolCall.createdAt, "tool_calls.created_at")
        )
      )!,
      completedAt:
        presentOptionalInstant(toolCall.completedAt) ||
        presentOptionalInstant(task?.completedAt) ||
        undefined,
    })
  }

  const updatedAt = pickLatestTimestamp(
    ...processingTargets.map((target) => target.attachedAt || target.createdAt),
    ...items.map((item) => item.updatedAt),
    presentOptionalInstant(turnRow.completedAt),
    presentInstant(requireInstantDate(turnRow.updatedAt, "turns.updated_at")),
    presentOptionalInstant(turnRow.startedAt)
  )!

  return {
    conversationId: turnRow.conversationId,
    actorId: turnRow.actorId,
    actorDisplayName: turnRow.actorDisplayName || "Unknown",
    turnId: turnRow.id,
    sessionId: turnRow.sessionId,
    startedAt:
      presentOptionalInstant(turnRow.startedAt) ||
      // `turns` no longer has a created_at column; for legacy/test rows that
      // still carry NULL started_at, fall back to the always-present updated_at.
      presentInstant(requireInstantDate(turnRow.updatedAt, "turns.updated_at")),
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
      const runtimeState = parseCachedActorRuntimeState(rawValue)
      if (runtimeState) parsed[actorId] = runtimeState
    }
    runtimeMap[conversationId] = parsed
  }

  const sessionResult =
    await repo.listThreadSessionsForConversations(conversationIds)

  const missingSessions = sessionResult.filter(
    (row) => !runtimeMap[row.conversationId]?.[row.actorId]
  )
  if (missingSessions.length === 0) {
    return runtimeMap
  }

  const hydratedSnapshots = await Promise.all(
    missingSessions.map(async (row) => {
      const snapshot = await buildSessionRuntimeSnapshot(row.id)
      return snapshot
        ? { conversationId: row.conversationId as string, snapshot }
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

// Default runtime phase derived from the lane state when neither an explicit
// override nor an inherited cached phase applies. `idle` is the fallback for
// every lane state other than `running`/`blocked` (i.e. idle/queued/closed),
// matching the original ternary's final branch — do NOT throw on the default.
function defaultPhaseForLaneState(
  laneState: ActorRuntimeState["laneState"]
): ActorRuntimePhase {
  switch (laneState) {
    case "running":
      return "thinking"
    case "blocked":
      return "error"
    default:
      return "idle"
  }
}

export async function buildSessionRuntimeSnapshot(
  sessionId: string,
  overrides: SessionRuntimeSnapshotOverrides = {}
): Promise<ActorRuntimeState | null> {
  const session = await getSession(sessionId)
  if (!session || !isThreadConversationKind(session.conversationKind))
    return null

  let cachedRuntime: ActorRuntimeState | null = null
  const cachedRaw = await redis.hget(
    runtimeHashKey(session.conversationId),
    session.actorId
  )
  if (cachedRaw) cachedRuntime = parseCachedActorRuntimeState(cachedRaw)

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
        (session.errorMessage
          ? {
              message: session.errorMessage as string,
              at: presentInstant(
                requireInstantDate(session.updatedAt, "sessions.updated_at")
              ),
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
    defaultPhaseForLaneState(laneState)
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
    conversationId: session.conversationId,
    sessionId: session.id,
    actorId: session.actorId,
    actorDisplayName: session.actorDisplayName || "Unknown",
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
    updatedAt: nowIsoInstant(),
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
    timestamp: nowIsoInstant(),
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
  if (!session || !isThreadConversationKind(session.conversationKind)) return
  await redis.hdel(runtimeHashKey(session.conversationId), session.actorId)
}

export interface EnqueueSessionWakeupParams {
  sessionId: string
  actorId: string
  workspaceId: string
  sourceType: SessionWakeupSourceType
  sourceItemId?: string
  sourceSessionId?: string
  sourceParticipantType?: SessionWakeupSourceParticipantType
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
  created: SessionWakeupRow
  reusedExistingWakeup: boolean
}> {
  return repo.insertSessionWakeupRow(executor, params)
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
    health: session.status === "blocked" ? ACTOR_RUNTIME_HEALTH.OK : undefined,
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

  const { created, reusedExistingWakeup } =
    await repo.insertSessionWakeupRowDefault(params)

  if (reusedExistingWakeup) {
    return created
  }

  await nudgeSessionAfterWakeup(params, session)

  return created
}

export async function attachPendingWakeupsToTurn(
  sessionId: string,
  turnId: string,
  executor?: Executor
) {
  const rows = await repo.attachPendingWakeupsToTurnRows(
    sessionId,
    turnId,
    executor
  )

  return rows.map(presentWakeup)
}

export async function markTurnWakeupsProcessed(
  turnId: string,
  executor?: Executor
) {
  await repo.markTurnWakeupsProcessed(turnId, executor)
}

export async function markTurnWakeupsDropped(
  turnId: string,
  executor?: Executor
) {
  await repo.markTurnWakeupsDropped(turnId, executor)
}

/**
 * Reverse attachPendingWakeupsToTurn: flip this turn's `attached` wakeups back
 * to `pending` so another worker can re-claim them. Used when a turn is aborted
 * WITHOUT having processed its wakeups (e.g. the worker lost the session lock
 * mid-turn) — dropping them would silently lose user-triggered wakeups.
 */
export async function restoreTurnWakeupsToPending(
  turnId: string,
  executor?: Executor
) {
  await repo.restoreTurnWakeupsToPending(turnId, executor)
}

export async function getPendingWakeupCount(
  sessionId: string,
  executor?: Executor
) {
  return repo.getPendingWakeupCount(sessionId, executor)
}

export async function getPendingWakeups(sessionId: string) {
  const rows = await repo.listPendingSessionWakeups(sessionId)

  // Fan-in causal join. The draining turn's requeue is rooted (session-thinking
  // withRootTrace), so instead of a false single-parent we attach each drained
  // wakeup's originating trace — captured in the origin_traceparent column at
  // enqueue — as a span LINK on the active CONSUMER span. Reads the SAME rows (no
  // second query → no TOCTOU vs the drained set); no-op when OTEL is off or on
  // the idle→enqueue self-trace path. The DTO shape is unchanged (trace stays out
  // of ActorRuntimeWakeup).
  linkUpstreamTraces(
    rows
      .map((row) => row.originTraceparent)
      .filter((tp): tp is string => typeof tp === "string")
  )

  return rows.map(presentWakeup)
}
