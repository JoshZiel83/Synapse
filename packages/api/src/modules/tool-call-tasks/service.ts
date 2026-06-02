import {
  extractText,
  parseJsonObject,
  textBlocks,
  type CanonicalContentBlock,
  type TaskNoticeStatus,
} from "@synapse/shared"
import type {
  ToolCallTasksDeliveryPolicy,
  ToolCallTasksDispatchStatus,
  ToolCallTasksExecutorKind,
  ToolCallTasksStatus,
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

export type ToolCallTaskStatus = ToolCallTasksStatus
export type ToolCallTaskDispatchStatus = ToolCallTasksDispatchStatus
export type ToolCallTaskDeliveryPolicy = ToolCallTasksDeliveryPolicy
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
  sessionId: string
  actorId: string
  turnId?: string
  sourceToolCallId?: string
  sourceToolName: string
  executorKind: ToolCallTaskExecutorKind
  deliveryPolicy: ToolCallTaskDeliveryPolicy
  status: ToolCallTaskStatus
  statusMessage?: string
  dispatchStatus: ToolCallTaskDispatchStatus
  supportsCancel: boolean
  supportsOutputTail: boolean
  requestPayload: Record<string, unknown>
  immediateResultPayload: Record<string, unknown>
  finalResultPayload: Record<string, unknown>
  finalErrorPayload: Record<string, unknown>
  metadata: Record<string, unknown>
  completionItemId?: string
  deadlineAt?: string
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
  sessionId: string
  actorId: string
  turnId?: string
  sourceToolCallId?: string
  sourceToolName: string
  executorKind: ToolCallTaskExecutorKind
  deliveryPolicy: ToolCallTaskDeliveryPolicy
  status?: ToolCallTaskStatus
  statusMessage?: string
  dispatchStatus?: ToolCallTaskDispatchStatus
  supportsCancel?: boolean
  supportsOutputTail?: boolean
  requestPayload?: Record<string, unknown>
  immediateResultPayload?: Record<string, unknown>
  metadata?: Record<string, unknown>
  deadlineAt?: string
  retentionTtlMs?: number
  retainUntil?: string
}

interface ToolCallTaskTerminalNoticeParams {
  summary: string
  message?: string
  messageBlocks?: CanonicalContentBlock[]
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

const TERMINAL_TOOL_CALL_TASK_STATUSES = new Set<ToolCallTaskStatus>([
  "completed",
  "failed",
  "cancelled",
])

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
    sessionId: row.session_id,
    actorId: row.actor_id,
    turnId: row.turn_id || undefined,
    sourceToolCallId: row.source_tool_call_id || undefined,
    sourceToolName: row.source_tool_name,
    executorKind: row.executor_kind as ToolCallTaskExecutorKind,
    deliveryPolicy: row.delivery_policy as ToolCallTaskDeliveryPolicy,
    status: row.status as ToolCallTaskStatus,
    statusMessage: row.status_message || undefined,
    dispatchStatus: row.dispatch_status as ToolCallTaskDispatchStatus,
    supportsCancel: row.supports_cancel === true,
    supportsOutputTail: row.supports_output_tail === true,
    requestPayload: parseJsonObject(row.request_payload),
    immediateResultPayload: parseJsonObject(row.immediate_result_payload),
    finalResultPayload: parseJsonObject(row.final_result_payload),
    finalErrorPayload: parseJsonObject(row.final_error_payload),
    metadata: parseJsonObject(row.metadata),
    completionItemId: row.completion_item_id || undefined,
    deadlineAt: toIsoString(row.deadline_at),
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
  await assertSessionAllowsToolCallTasks(executor, params.sessionId)

  const row: TableInsert<"tool_call_tasks"> = {
    workspace_id: params.workspaceId,
    conversation_id: params.conversationId,
    session_id: params.sessionId,
    actor_id: params.actorId,
    turn_id: params.turnId || null,
    source_tool_call_id: params.sourceToolCallId || null,
    source_tool_name: params.sourceToolName,
    executor_kind: params.executorKind,
    delivery_policy: params.deliveryPolicy,
    status: params.status || "working",
    status_message: params.statusMessage || null,
    dispatch_status: params.dispatchStatus || "accepted",
    supports_cancel: params.supportsCancel === true,
    supports_output_tail: params.supportsOutputTail === true,
    request_payload: (params.requestPayload ||
      {}) as TableInsert<"tool_call_tasks">["request_payload"],
    immediate_result_payload: (params.immediateResultPayload ||
      {}) as TableInsert<"tool_call_tasks">["immediate_result_payload"],
    metadata: (params.metadata ||
      {}) as TableInsert<"tool_call_tasks">["metadata"],
    deadline_at: toDate(params.deadlineAt),
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

export async function createToolCallTask(params: CreateToolCallTaskParams) {
  const record = await withDbTransaction((trx) =>
    insertToolCallTask(trx, params)
  )
  await publishSessionRuntime(record.workspaceId, record.sessionId)
  return record
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
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing
  }
  return updateToolCallTaskRecord(taskId, {
    dispatchStatus: "cancel_requested",
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
  statuses?: ToolCallTaskStatus[]
  limit?: number
}) {
  let statement = db
    .selectFrom("tool_call_tasks")
    .selectAll()
    .where("session_id", "=", params.sessionId)

  if (params.statuses && params.statuses.length > 0) {
    statement = statement.where("status", "in", params.statuses)
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
    status?: ToolCallTaskStatus
    statusMessage?: string
    dispatchStatus?: ToolCallTaskDispatchStatus
    supportsCancel?: boolean
    supportsOutputTail?: boolean
    immediateResultPayload?: Record<string, unknown>
    finalResultPayload?: Record<string, unknown>
    finalErrorPayload?: Record<string, unknown>
    metadata?: Record<string, unknown>
    completionItemId?: string
    deadlineAt?: string
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

  const nextStatus = params.status || existing.status
  if (
    TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status) &&
    existing.status !== nextStatus
  ) {
    return existing
  }

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

  const row = await db
    .updateTable("tool_call_tasks")
    .set({
      status: nextStatus,
      status_message: params.statusMessage ?? existing.statusMessage ?? null,
      dispatch_status: params.dispatchStatus || existing.dispatchStatus,
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
      completion_item_id:
        params.completionItemId ?? existing.completionItemId ?? null,
      deadline_at: toDate(params.deadlineAt ?? existing.deadlineAt ?? null),
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
    })
    .where("id", "=", taskId)
    .returningAll()
    .executeTakeFirst()

  const updated = mapToolCallTaskRow(row || null)
  if (!updated) {
    return updated
  }

  const onlyOutputTailUpdate =
    params.lastOutputSeq !== undefined &&
    params.lastOutputAt !== undefined &&
    params.status === undefined &&
    params.statusMessage === undefined &&
    params.dispatchStatus === undefined &&
    params.supportsCancel === undefined &&
    params.supportsOutputTail === undefined &&
    params.immediateResultPayload === undefined &&
    params.finalResultPayload === undefined &&
    params.finalErrorPayload === undefined &&
    params.metadata === undefined &&
    params.completionItemId === undefined &&
    params.deadlineAt === undefined &&
    params.retentionTtlMs === undefined &&
    params.retainUntil === undefined &&
    params.cancelRequestedAt === undefined &&
    params.cancelReason === undefined

  if (onlyOutputTailUpdate) {
    scheduleSessionRuntimeRefresh(updated.workspaceId, updated.sessionId)
  } else {
    await publishSessionRuntime(updated.workspaceId, updated.sessionId)
  }

  return updated
}

async function emitTaskNotice(
  record: ToolCallTaskRecord,
  status: TaskNoticeStatus,
  params: ToolCallTaskTerminalNoticeParams
) {
  if (params.notifyActor === false) {
    return updateToolCallTaskRecord(record.id, {
      status,
      statusMessage: params.summary,
      finalResultPayload: params.finalResultPayload,
      finalErrorPayload: params.finalErrorPayload,
      metadata: params.metadata,
    })
  }

  const actorMember = await getConversationParticipant({
    conversationId: record.conversationId,
    actorId: record.actorId,
  })

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
    status,
    statusMessage: params.summary,
    finalResultPayload: params.finalResultPayload,
    finalErrorPayload: params.finalErrorPayload,
    metadata: params.metadata,
    completionItemId,
  })

  await enqueueSessionWakeup({
    sessionId: record.sessionId,
    actorId: record.actorId,
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

  return updated
}

export async function markToolCallTaskInputRequired(
  taskId: string,
  statusMessage: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "input_required",
    statusMessage,
    dispatchStatus: "input_requested",
    metadata,
  })
}

export async function markToolCallTaskQueued(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "queued",
    metadata,
  })
}

export async function markToolCallTaskDispatched(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "dispatched",
    metadata,
  })
}

export async function markToolCallTaskReceived(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "received",
    metadata,
  })
}

export async function markToolCallTaskStarted(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "started",
    metadata,
  })
}

export async function markToolCallTaskCancelRequested(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "cancel_requested",
    metadata,
    cancelRequestedAt: new Date().toISOString(),
  })
}

export async function markToolCallTaskWorking(
  taskId: string,
  statusMessage?: string,
  params?: {
    dispatchStatus?: ToolCallTaskDispatchStatus
    metadata?: Record<string, unknown>
  }
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: params?.dispatchStatus,
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
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
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
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
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
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing
  }
  return emitTaskNotice(existing, "cancelled", params)
}
