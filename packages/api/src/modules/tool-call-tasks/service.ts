import {
  extractText,
  parseJsonObject,
  textBlocks,
  type CanonicalContentBlock,
  type TaskNoticeStatus,
} from "@synapse/shared"
import type {
  ToolCallTasksDeliveryKind,
  ToolCallTasksExecutorKind,
  ToolCallTasksHumanSurface,
  ToolCallTasksLifecycleStatus,
  ToolCallTasksOutcome,
} from "../../infrastructure/database/generated/db.js"
import {
  db,
  withDbTransaction,
  type Executor,
  type TableInsert,
  type TableRow,
} from "../../infrastructure/database/kysely.js"
import {
  createConversationEvent,
  getConversationParticipant,
} from "../chat/service.js"
import {
  enqueueSessionWakeup,
  publishSessionRuntime,
  scheduleSessionRuntimeRefresh,
} from "../session/runtime.js"

export type ToolCallTaskLifecycleStatus = ToolCallTasksLifecycleStatus
export type ToolCallTaskOutcome = ToolCallTasksOutcome
export type ToolCallTaskDeliveryKind = ToolCallTasksDeliveryKind
export type ToolCallTaskHumanSurface = ToolCallTasksHumanSurface
export type ToolCallTaskExecutorKind = ToolCallTasksExecutorKind

type ToolCallTaskRow = TableRow<"tool_call_tasks">
type ToolCallTaskOutputChunkRow = Pick<
  TableRow<"tool_call_task_output_chunks">,
  "created_at" | "metadata" | "seq" | "stream" | "text_value"
>

export interface ToolCallTaskRecord {
  id: string
  workspaceId: string
  conversationId: string
  /** Axis 1: where the result comes from. */
  executorKind: ToolCallTaskExecutorKind
  /** Axis 2: how the blocked waiter (agent) is woken. */
  deliveryKind: ToolCallTaskDeliveryKind
  /** Axis 3: does a human see/answer this? */
  humanSurface: ToolCallTaskHumanSurface
  /** THE delivery key (actor OR remote_agent subject). */
  principalSubjectId: string
  /** Present iff delivery_kind=session_wakeup. */
  sessionId?: string
  /** Optional associative col (ask/plan have it, runtime_auth doesn't). */
  remoteAgentRunId?: string
  turnId?: string
  sourceToolCallId?: string
  sourceToolName: string
  /** Pure lifecycle state machine. */
  lifecycleStatus: ToolCallTaskLifecycleStatus
  /** Business verdict, set only when lifecycleStatus='completed'. */
  outcome?: ToolCallTaskOutcome
  statusMessage?: string
  supportsCancel: boolean
  supportsOutputTail: boolean
  /** Optimistic-concurrency token for human resolution. */
  revision: number
  requestKey: string
  requesterParticipantId?: string
  targetParticipantId?: string
  resolvedByParticipantId?: string
  resolvedAt?: string
  requestPayload: Record<string, unknown>
  immediateResultPayload: Record<string, unknown>
  finalResultPayload: Record<string, unknown>
  finalErrorPayload: Record<string, unknown>
  metadata: Record<string, unknown>
  conversationItemId?: string
  completionItemId?: string
  deadlineAt?: string
  expiresAt?: string
  retentionTtlMs?: number
  retainUntil?: string
  cancelRequestedAt?: string
  cancelReason?: string
  lastOutputSeq: number
  lastOutputAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface CreateToolCallTaskParams {
  workspaceId: string
  conversationId: string
  executorKind: ToolCallTaskExecutorKind
  deliveryKind: ToolCallTaskDeliveryKind
  humanSurface: ToolCallTaskHumanSurface
  principalSubjectId: string
  sessionId?: string
  remoteAgentRunId?: string
  turnId?: string
  sourceToolCallId?: string
  sourceToolName: string
  requestKey: string
  lifecycleStatus?: ToolCallTaskLifecycleStatus
  statusMessage?: string
  supportsCancel?: boolean
  supportsOutputTail?: boolean
  requesterParticipantId?: string
  targetParticipantId?: string
  requestPayload?: Record<string, unknown>
  immediateResultPayload?: Record<string, unknown>
  metadata?: Record<string, unknown>
  deadlineAt?: string
  expiresAt?: string
  retentionTtlMs?: number
  retainUntil?: string
}

interface ToolCallTaskTerminalNoticeParams {
  summary: string
  message?: string
  messageBlocks?: CanonicalContentBlock[]
  outcome?: ToolCallTaskOutcome
  finalResultPayload?: Record<string, unknown>
  finalErrorPayload?: Record<string, unknown>
  metadata?: Record<string, unknown>
  notifyActor?: boolean
}

export interface ToolCallTaskOutputChunk {
  seq: number
  stream: "stdout" | "stderr" | "system"
  text: string
  createdAt: string
  metadata: Record<string, unknown>
}

const TERMINAL_TOOL_CALL_TASK_STATUSES = new Set<ToolCallTaskLifecycleStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
])

const NON_TERMINAL_TOOL_CALL_TASK_STATUSES: ToolCallTaskLifecycleStatus[] = [
  "submitted",
  "working",
  "input_required",
  "auth_required",
]

/** Map a TaskNoticeStatus (terminal) to its lifecycle_status. */
function noticeStatusToLifecycle(
  status: TaskNoticeStatus
): ToolCallTaskLifecycleStatus {
  return status
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

function toDate(value: string | null | undefined) {
  if (!value) return null
  return new Date(value)
}

function mapToolCallTaskRow(
  row: ToolCallTaskRow | null
): ToolCallTaskRecord | null {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    executorKind: row.executor_kind as ToolCallTaskExecutorKind,
    deliveryKind: row.delivery_kind as ToolCallTaskDeliveryKind,
    humanSurface: row.human_surface as ToolCallTaskHumanSurface,
    principalSubjectId: row.principal_subject_id,
    sessionId: row.session_id || undefined,
    remoteAgentRunId: row.remote_agent_run_id || undefined,
    turnId: row.turn_id || undefined,
    sourceToolCallId: row.source_tool_call_id || undefined,
    sourceToolName: row.source_tool_name,
    lifecycleStatus: row.lifecycle_status as ToolCallTaskLifecycleStatus,
    outcome: (row.outcome as ToolCallTaskOutcome | null) || undefined,
    statusMessage: row.status_message || undefined,
    supportsCancel: row.supports_cancel === true,
    supportsOutputTail: row.supports_output_tail === true,
    revision:
      typeof row.revision === "number"
        ? row.revision
        : Number(row.revision || 1),
    requestKey: row.request_key,
    requesterParticipantId: row.requester_participant_id || undefined,
    targetParticipantId: row.target_participant_id || undefined,
    resolvedByParticipantId: row.resolved_by_participant_id || undefined,
    resolvedAt: toIsoString(row.resolved_at),
    requestPayload: parseJsonObject(row.request_payload),
    immediateResultPayload: parseJsonObject(row.immediate_result_payload),
    finalResultPayload: parseJsonObject(row.final_result_payload),
    finalErrorPayload: parseJsonObject(row.final_error_payload),
    metadata: parseJsonObject(row.metadata),
    conversationItemId: row.conversation_item_id || undefined,
    completionItemId: row.completion_item_id || undefined,
    deadlineAt: toIsoString(row.deadline_at),
    expiresAt: toIsoString(row.expires_at),
    retentionTtlMs:
      typeof row.retention_ttl_ms === "number"
        ? row.retention_ttl_ms
        : undefined,
    retainUntil: toIsoString(row.retain_until),
    cancelRequestedAt: toIsoString(row.cancel_requested_at),
    cancelReason: row.cancel_reason || undefined,
    lastOutputSeq:
      typeof row.last_output_seq === "number"
        ? row.last_output_seq
        : Number(row.last_output_seq || 0),
    lastOutputAt: toIsoString(row.last_output_at),
    completedAt: toIsoString(row.completed_at),
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
  } satisfies ToolCallTaskRecord
}

async function assertSessionAllowsToolCallTasks(
  executor: Executor,
  sessionId: string
) {
  const row = await executor
    .selectFrom("sessions")
    .select(["id", "status"])
    .where("id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new Error(`Session ${sessionId} not found`)
  }
  if (row.status === "closed") {
    throw new Error(`Session ${sessionId} is closed`)
  }
}

export async function insertToolCallTask(
  executor: Executor,
  params: CreateToolCallTaskParams
) {
  if (params.deliveryKind === "session_wakeup") {
    if (!params.sessionId) {
      throw new Error("session_wakeup delivery requires a sessionId")
    }
    await assertSessionAllowsToolCallTasks(executor, params.sessionId)
  }

  const row: TableInsert<"tool_call_tasks"> = {
    workspace_id: params.workspaceId,
    conversation_id: params.conversationId,
    executor_kind: params.executorKind,
    delivery_kind: params.deliveryKind,
    human_surface: params.humanSurface,
    principal_subject_id: params.principalSubjectId,
    session_id: params.sessionId || null,
    remote_agent_run_id: params.remoteAgentRunId || null,
    turn_id: params.turnId || null,
    source_tool_call_id: params.sourceToolCallId || null,
    source_tool_name: params.sourceToolName,
    lifecycle_status: params.lifecycleStatus || "working",
    status_message: params.statusMessage || null,
    supports_cancel: params.supportsCancel === true,
    supports_output_tail: params.supportsOutputTail === true,
    request_key: params.requestKey,
    requester_participant_id: params.requesterParticipantId || null,
    target_participant_id: params.targetParticipantId || null,
    request_payload: (params.requestPayload ||
      {}) as TableInsert<"tool_call_tasks">["request_payload"],
    immediate_result_payload: (params.immediateResultPayload ||
      {}) as TableInsert<"tool_call_tasks">["immediate_result_payload"],
    metadata: (params.metadata ||
      {}) as TableInsert<"tool_call_tasks">["metadata"],
    deadline_at: toDate(params.deadlineAt),
    expires_at: toDate(params.expiresAt),
    retention_ttl_ms: params.retentionTtlMs ?? null,
    retain_until: toDate(params.retainUntil),
  }

  const createdRow = await executor
    .insertInto("tool_call_tasks")
    .values(row)
    .returningAll()
    .executeTakeFirst()

  const record = mapToolCallTaskRow(createdRow ?? null)
  if (!record) {
    throw new Error("Failed to create tool-call task")
  }
  return record
}

/**
 * Dedupe-aware task mint (design §3.4): INSERT ... ON CONFLICT on the
 * partial-unique (workspace_id, request_key) WHERE non-terminal DO NOTHING.
 * Returns the new record, or null when a live task with the same request_key
 * already exists (the caller looks up the winner — the loser never
 * materializes, so there is no orphan to clean up).
 */
export async function insertToolCallTaskDeduped(
  executor: Executor,
  params: CreateToolCallTaskParams
): Promise<ToolCallTaskRecord | null> {
  if (params.deliveryKind === "session_wakeup") {
    if (!params.sessionId) {
      throw new Error("session_wakeup delivery requires a sessionId")
    }
    await assertSessionAllowsToolCallTasks(executor, params.sessionId)
  }

  const createdRow = await executor
    .insertInto("tool_call_tasks")
    .values({
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      executor_kind: params.executorKind,
      delivery_kind: params.deliveryKind,
      human_surface: params.humanSurface,
      principal_subject_id: params.principalSubjectId,
      session_id: params.sessionId || null,
      remote_agent_run_id: params.remoteAgentRunId || null,
      turn_id: params.turnId || null,
      source_tool_call_id: params.sourceToolCallId || null,
      source_tool_name: params.sourceToolName,
      lifecycle_status: params.lifecycleStatus || "working",
      status_message: params.statusMessage || null,
      supports_cancel: params.supportsCancel === true,
      supports_output_tail: params.supportsOutputTail === true,
      request_key: params.requestKey,
      requester_participant_id: params.requesterParticipantId || null,
      target_participant_id: params.targetParticipantId || null,
      request_payload: (params.requestPayload ||
        {}) as TableInsert<"tool_call_tasks">["request_payload"],
      immediate_result_payload: (params.immediateResultPayload ||
        {}) as TableInsert<"tool_call_tasks">["immediate_result_payload"],
      metadata: (params.metadata ||
        {}) as TableInsert<"tool_call_tasks">["metadata"],
      deadline_at: toDate(params.deadlineAt),
      expires_at: toDate(params.expiresAt),
      retention_ttl_ms: params.retentionTtlMs ?? null,
      retain_until: toDate(params.retainUntil),
    })
    .onConflict((oc) =>
      oc
        .columns(["workspace_id", "request_key"])
        .where("lifecycle_status", "in", [
          "submitted",
          "working",
          "input_required",
          "auth_required",
        ])
        .doNothing()
    )
    .returningAll()
    .executeTakeFirst()

  return mapToolCallTaskRow(createdRow ?? null)
}

/**
 * Look up the live (non-terminal) task that won a dedupe race on request_key.
 */
export async function findLiveToolCallTaskByRequestKey(
  executor: Executor,
  workspaceId: string,
  requestKey: string
): Promise<ToolCallTaskRecord | null> {
  const row = await executor
    .selectFrom("tool_call_tasks")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("request_key", "=", requestKey)
    .where("lifecycle_status", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .limit(1)
    .executeTakeFirst()
  return mapToolCallTaskRow(row || null)
}

export async function createToolCallTask(params: CreateToolCallTaskParams) {
  const record = await withDbTransaction((trx) =>
    insertToolCallTask(trx, params)
  )
  if (record.sessionId) {
    await publishSessionRuntime(record.workspaceId, record.sessionId)
  }
  return record
}

/**
 * Dedupe-aware create: mints a task, or returns the existing live task that won
 * the request_key race (design §3.4 — the loser never materializes, so there is
 * no orphan to clean up). `deduped` is true when an existing task was returned.
 */
export async function createToolCallTaskDeduped(
  params: CreateToolCallTaskParams
): Promise<{ task: ToolCallTaskRecord; deduped: boolean }> {
  return withDbTransaction(async (trx) => {
    const created = await insertToolCallTaskDeduped(trx, params)
    if (created) {
      if (created.sessionId) {
        await publishSessionRuntime(created.workspaceId, created.sessionId)
      }
      return { task: created, deduped: false }
    }
    const winner = await findLiveToolCallTaskByRequestKey(
      trx,
      params.workspaceId,
      params.requestKey
    )
    if (!winner) {
      throw new Error(
        "Task dedupe hit but no live winner found — request_key may have been concurrently resolved"
      )
    }
    return { task: winner, deduped: true }
  })
}

export async function getToolCallTask(taskId: string) {
  const row = await db
    .selectFrom("tool_call_tasks")
    .selectAll()
    .where("id", "=", taskId)
    .limit(1)
    .executeTakeFirst()

  return mapToolCallTaskRow(row || null)
}

export async function appendToolCallTaskOutput(
  taskId: string,
  chunk: {
    seq: number
    stream: "stdout" | "stderr" | "system"
    text: string
    createdAt?: string
    metadata?: Record<string, unknown>
  }
) {
  const text = chunk.text.trim()
  if (!text) {
    return getToolCallTask(taskId)
  }

  const row: TableInsert<"tool_call_task_output_chunks"> = {
    task_id: taskId,
    seq: chunk.seq,
    stream: chunk.stream,
    text_value: text,
    metadata: (chunk.metadata ||
      {}) as TableInsert<"tool_call_task_output_chunks">["metadata"],
    created_at: toDate(chunk.createdAt),
  }

  await db
    .insertInto("tool_call_task_output_chunks")
    .values(row)
    .onConflict((oc) => oc.columns(["task_id", "seq"]).doNothing())
    .execute()

  return updateToolCallTaskRecord(taskId, {
    lastOutputSeq: Math.max(0, chunk.seq),
    lastOutputAt: chunk.createdAt || new Date().toISOString(),
  })
}

export async function requestToolCallTaskCancel(
  taskId: string,
  reason?: string
) {
  const existing = await getToolCallTask(taskId)
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.lifecycleStatus)) {
    return existing
  }
  return updateToolCallTaskRecord(taskId, {
    cancelRequestedAt: new Date().toISOString(),
    cancelReason: reason?.trim() || existing.cancelReason || null,
    statusMessage:
      reason?.trim() || existing.statusMessage || "Cancellation requested.",
  })
}

export async function getToolCallTaskForSession(
  sessionId: string,
  taskId: string
) {
  const row = await db
    .selectFrom("tool_call_tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("session_id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()

  return mapToolCallTaskRow(row || null)
}

export async function listToolCallTasksForSession(params: {
  sessionId: string
  statuses?: ToolCallTaskLifecycleStatus[]
  limit?: number
}) {
  let statement = db
    .selectFrom("tool_call_tasks")
    .selectAll()
    .where("session_id", "=", params.sessionId)

  if (params.statuses && params.statuses.length > 0) {
    statement = statement.where("lifecycle_status", "in", params.statuses)
  }

  const result = await statement
    .orderBy("created_at", "desc")
    .limit(Math.min(Math.max(params.limit || 20, 1), 100))
    .execute()

  return result
    .map((row) => mapToolCallTaskRow(row))
    .filter((row): row is ToolCallTaskRecord => row !== null)
}

export async function getToolCallTaskOutput(params: {
  taskId: string
  afterSeq?: number
  limit?: number
  stream?: "stdout" | "stderr" | "system" | "combined"
}) {
  const normalizedLimit = Math.min(Math.max(params.limit || 20, 1), 200)
  const afterSeq = Math.max(0, params.afterSeq || 0)
  const stream =
    params.stream && params.stream !== "combined" ? params.stream : null

  let statement = db
    .selectFrom("tool_call_task_output_chunks")
    .select(["seq", "stream", "text_value", "metadata", "created_at"])
    .where("task_id", "=", params.taskId)

  if (afterSeq > 0) {
    statement = statement.where("seq", ">", String(afterSeq))
  }
  if (stream) {
    statement = statement.where("stream", "=", stream)
  }

  const rows = await statement
    .orderBy("seq", afterSeq > 0 ? "asc" : "desc")
    .limit(normalizedLimit)
    .execute()

  const orderedRows =
    afterSeq > 0 ? rows : ([...rows].reverse() as ToolCallTaskOutputChunkRow[])

  return orderedRows.map((row) => ({
    seq: typeof row.seq === "number" ? row.seq : Number(row.seq || 0),
    stream: row.stream as ToolCallTaskOutputChunk["stream"],
    text: row.text_value,
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    metadata: parseJsonObject(row.metadata),
  })) satisfies ToolCallTaskOutputChunk[]
}

async function updateToolCallTaskRecord(
  taskId: string,
  params: {
    lifecycleStatus?: ToolCallTaskLifecycleStatus
    outcome?: ToolCallTaskOutcome
    statusMessage?: string
    supportsCancel?: boolean
    supportsOutputTail?: boolean
    immediateResultPayload?: Record<string, unknown>
    finalResultPayload?: Record<string, unknown>
    finalErrorPayload?: Record<string, unknown>
    metadata?: Record<string, unknown>
    conversationItemId?: string
    completionItemId?: string
    resolvedByParticipantId?: string
    resolvedAt?: string
    deadlineAt?: string
    expiresAt?: string
    retentionTtlMs?: number
    retainUntil?: string
    cancelRequestedAt?: string | null
    cancelReason?: string | null
    lastOutputSeq?: number
    lastOutputAt?: string | null
  }
) {
  const existing = await getToolCallTask(taskId)
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }

  const nextStatus = params.lifecycleStatus || existing.lifecycleStatus
  const transitioningToTerminal =
    params.lifecycleStatus !== undefined &&
    TERMINAL_TOOL_CALL_TASK_STATUSES.has(params.lifecycleStatus)

  const nextMetadata =
    params.metadata !== undefined
      ? {
          ...existing.metadata,
          ...params.metadata,
        }
      : existing.metadata

  const nextCompletedAt = TERMINAL_TOOL_CALL_TASK_STATUSES.has(nextStatus)
    ? toDate(existing.completedAt) || new Date()
    : toDate(existing.completedAt)

  // Terminal guard as a SQL predicate: only mutate a task that is NOT already
  // terminal. Zero rows back = idempotent no-op (concurrent resolve / cancel /
  // TTL sweep already finished it). This is what makes terminalization safe to
  // retry now that the interaction and the task are the same row.
  let update = db
    .updateTable("tool_call_tasks")
    .set({
      lifecycle_status: nextStatus,
      outcome:
        params.outcome ??
        (existing.outcome as ToolCallTaskOutcome | undefined) ??
        null,
      status_message: params.statusMessage ?? existing.statusMessage ?? null,
      supports_cancel: params.supportsCancel ?? existing.supportsCancel,
      supports_output_tail:
        params.supportsOutputTail ?? existing.supportsOutputTail,
      immediate_result_payload: (params.immediateResultPayload ??
        existing.immediateResultPayload ??
        {}) as TableInsert<"tool_call_tasks">["immediate_result_payload"],
      final_result_payload: (params.finalResultPayload ??
        existing.finalResultPayload ??
        {}) as TableInsert<"tool_call_tasks">["final_result_payload"],
      final_error_payload: (params.finalErrorPayload ??
        existing.finalErrorPayload ??
        {}) as TableInsert<"tool_call_tasks">["final_error_payload"],
      metadata: nextMetadata as TableInsert<"tool_call_tasks">["metadata"],
      conversation_item_id:
        params.conversationItemId ?? existing.conversationItemId ?? null,
      completion_item_id:
        params.completionItemId ?? existing.completionItemId ?? null,
      resolved_by_participant_id:
        params.resolvedByParticipantId ??
        existing.resolvedByParticipantId ??
        null,
      resolved_at: toDate(params.resolvedAt ?? existing.resolvedAt ?? null),
      deadline_at: toDate(params.deadlineAt ?? existing.deadlineAt ?? null),
      expires_at: toDate(params.expiresAt ?? existing.expiresAt ?? null),
      retention_ttl_ms:
        params.retentionTtlMs ?? existing.retentionTtlMs ?? null,
      retain_until: toDate(params.retainUntil ?? existing.retainUntil ?? null),
      cancel_requested_at: toDate(
        params.cancelRequestedAt ?? existing.cancelRequestedAt ?? null
      ),
      cancel_reason: params.cancelReason ?? existing.cancelReason ?? null,
      last_output_seq: params.lastOutputSeq ?? existing.lastOutputSeq ?? 0,
      last_output_at: toDate(
        params.lastOutputAt ?? existing.lastOutputAt ?? null
      ),
      completed_at: nextCompletedAt,
      updated_at: new Date(),
    })
    .where("id", "=", taskId)

  // Guard: any status-changing write must not touch an already-terminal row.
  if (params.lifecycleStatus !== undefined) {
    update = update.where(
      "lifecycle_status",
      "in",
      NON_TERMINAL_TOOL_CALL_TASK_STATUSES
    )
  }

  const row = await update.returningAll().executeTakeFirst()

  // Zero rows = the guard rejected a terminal-row mutation; return current state.
  const updated = mapToolCallTaskRow(row || null) ?? existing
  if (!row) {
    return updated
  }

  const onlyOutputTailUpdate =
    params.lastOutputSeq !== undefined &&
    params.lastOutputAt !== undefined &&
    params.lifecycleStatus === undefined &&
    params.outcome === undefined &&
    params.statusMessage === undefined &&
    params.supportsCancel === undefined &&
    params.supportsOutputTail === undefined &&
    params.immediateResultPayload === undefined &&
    params.finalResultPayload === undefined &&
    params.finalErrorPayload === undefined &&
    params.metadata === undefined &&
    params.conversationItemId === undefined &&
    params.completionItemId === undefined &&
    params.resolvedByParticipantId === undefined &&
    params.resolvedAt === undefined &&
    params.deadlineAt === undefined &&
    params.expiresAt === undefined &&
    params.retentionTtlMs === undefined &&
    params.retainUntil === undefined &&
    params.cancelRequestedAt === undefined &&
    params.cancelReason === undefined

  if (updated.sessionId) {
    if (onlyOutputTailUpdate) {
      scheduleSessionRuntimeRefresh(updated.workspaceId, updated.sessionId)
    } else {
      await publishSessionRuntime(updated.workspaceId, updated.sessionId)
    }
  }

  return updated
}

/**
 * Resolve the actor/remote_agent that a task's principal subject points at, so
 * the delivery layer can find the right conversation participant.
 */
async function resolvePrincipalForDelivery(subjectId: string): Promise<{
  actorId?: string
  remoteAgentId?: string
}> {
  const row = await db
    .selectFrom("access_subjects")
    .select(["kind", "actor_id", "remote_agent_id"])
    .where("id", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return {}
  return {
    actorId: row.actor_id || undefined,
    remoteAgentId: row.remote_agent_id || undefined,
  }
}

/**
 * Terminal-resolution fan-out. Sets the terminal lifecycle_status (+ outcome),
 * then routes the wakeup via the DELIVERY REGISTRY keyed on delivery_kind:
 *   session_wakeup       → conversation task_notice + session_wakeups spine
 *   remote_agent_channel → server-push over the machine WS (best-effort nudge;
 *                          runtime-auth resume is grant-gated, see design §3.8)
 *   none                 → terminal write only, no delivery
 */
async function emitTaskNotice(
  record: ToolCallTaskRecord,
  status: TaskNoticeStatus,
  params: ToolCallTaskTerminalNoticeParams
) {
  const lifecycleStatus = noticeStatusToLifecycle(status)

  if (params.notifyActor === false || record.deliveryKind === "none") {
    return updateToolCallTaskRecord(record.id, {
      lifecycleStatus,
      outcome: params.outcome,
      statusMessage: params.summary,
      finalResultPayload: params.finalResultPayload,
      finalErrorPayload: params.finalErrorPayload,
      metadata: params.metadata,
    })
  }

  const messageBlocks =
    params.messageBlocks && params.messageBlocks.length > 0
      ? params.messageBlocks
      : params.message?.trim()
        ? textBlocks(params.message.trim())
        : textBlocks(params.summary)
  const message =
    params.message?.trim() ||
    extractText(messageBlocks).trim() ||
    params.summary

  const principal = await resolvePrincipalForDelivery(record.principalSubjectId)

  // ── delivery: session_wakeup ──────────────────────────────────────────────
  if (record.deliveryKind === "session_wakeup" && record.sessionId) {
    const actorMember = principal.actorId
      ? await getConversationParticipant({
          conversationId: record.conversationId,
          actorId: principal.actorId,
        })
      : null

    let completionItemId: string | undefined
    if (actorMember?.id) {
      const created = await createConversationEvent({
        workspaceId: record.workspaceId,
        conversationId: record.conversationId,
        sessionId: record.sessionId,
        turnId: record.turnId,
        eventType: "task_notice",
        eventPayload: {
          taskId: record.id,
          toolName: record.sourceToolName,
          status,
          summary: params.summary,
          message,
          messageBlocks,
        },
        timelinePolicy: "none",
        contextPolicy: "actor_private",
        contextTargetParticipantIds: [actorMember.id],
        metadata: {
          taskId: record.id,
          sourceToolName: record.sourceToolName,
        },
      })
      completionItemId = created.item.id
    }

    const updated = await updateToolCallTaskRecord(record.id, {
      lifecycleStatus,
      outcome: params.outcome,
      statusMessage: params.summary,
      finalResultPayload: params.finalResultPayload,
      finalErrorPayload: params.finalErrorPayload,
      metadata: params.metadata,
      completionItemId,
    })

    if (principal.actorId) {
      await enqueueSessionWakeup({
        sessionId: record.sessionId,
        actorId: principal.actorId,
        workspaceId: record.workspaceId,
        sourceType: "system_interrupt",
        sourceItemId: completionItemId,
        sourceParticipantType: "system",
        sourceName: record.sourceToolName,
        summary: params.summary,
        reasonText: message || params.summary,
        metadata: {
          taskId: record.id,
          taskStatus: status,
          executorKind: record.executorKind,
          sourceToolName: record.sourceToolName,
          activationKind: "tool_call_task",
          delivery: record.id,
          ...(params.metadata || {}),
        },
        trigger: "system_interrupt",
      })
    }

    return updated
  }

  // ── delivery: remote_agent_channel ────────────────────────────────────────
  // Write the terminal state first (the grant — for runtime_auth — is already
  // durable; the push is a best-effort nudge to retry sooner). Then push.
  const updated = await updateToolCallTaskRecord(record.id, {
    lifecycleStatus,
    outcome: params.outcome,
    statusMessage: params.summary,
    finalResultPayload: params.finalResultPayload,
    finalErrorPayload: params.finalErrorPayload,
    metadata: params.metadata,
  })

  if (record.deliveryKind === "remote_agent_channel") {
    try {
      const { notifyRemoteAgentTaskResolved } =
        await import("../remote-agents/service.js")
      await notifyRemoteAgentTaskResolved(record.id)
    } catch {
      // best-effort nudge; resume is grant-gated / re-poll on the agent side.
    }
  }

  return updated
}

export async function markToolCallTaskInputRequired(
  taskId: string,
  statusMessage: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    lifecycleStatus: "input_required",
    statusMessage,
    metadata,
  })
}

export async function markToolCallTaskAuthRequired(
  taskId: string,
  statusMessage: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    lifecycleStatus: "auth_required",
    statusMessage,
    metadata,
  })
}

export async function markToolCallTaskWorking(
  taskId: string,
  statusMessage?: string,
  params?: {
    metadata?: Record<string, unknown>
  }
) {
  return updateToolCallTaskRecord(taskId, {
    lifecycleStatus: "working",
    statusMessage,
    metadata: params?.metadata,
  })
}

export async function completeToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams
) {
  const existing = await getToolCallTask(taskId)
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.lifecycleStatus)) {
    return existing
  }
  return emitTaskNotice(existing, "completed", params)
}

export async function failToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams
) {
  const existing = await getToolCallTask(taskId)
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.lifecycleStatus)) {
    return existing
  }
  return emitTaskNotice(existing, "failed", params)
}

export async function cancelToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams
) {
  const existing = await getToolCallTask(taskId)
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.lifecycleStatus)) {
    return existing
  }
  return emitTaskNotice(existing, "cancelled", params)
}
