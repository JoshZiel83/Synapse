import {
  extractText,
  parseJsonObject,
  textBlocks,
  type CanonicalContentBlock,
  type Timestamp,
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
  requireInstantDate,
  serializeInstant,
  serializeNowInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { sql } from "kysely"
import {
  createConversationEvent,
  getConversationParticipant,
} from "../chat/service.js"
import {
  insertSessionWakeupRow,
  nudgeSessionAfterWakeup,
  publishSessionRuntime,
  scheduleSessionRuntimeRefresh,
  type EnqueueSessionWakeupParams,
} from "../session/runtime.js"
import { getSession } from "../session/service.js"

export type ToolCallTaskLifecycleStatus = ToolCallTasksLifecycleStatus
export type ToolCallTaskOutcome = ToolCallTasksOutcome
export type ToolCallTaskDeliveryKind = ToolCallTasksDeliveryKind
export type ToolCallTaskHumanSurface = ToolCallTasksHumanSurface
export type ToolCallTaskExecutorKind = ToolCallTasksExecutorKind

type ToolCallTaskRow = TableRow<"toolCallTasks">
type ToolCallTaskOutputChunkRow = Pick<
  TableRow<"toolCallTaskOutputChunks">,
  "createdAt" | "metadata" | "seq" | "stream" | "textValue"
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
  resolvedAt?: Timestamp
  requestPayload: Record<string, unknown>
  immediateResultPayload: Record<string, unknown>
  finalResultPayload: Record<string, unknown>
  finalErrorPayload: Record<string, unknown>
  metadata: Record<string, unknown>
  conversationItemId?: string
  completionItemId?: string
  deadlineAt?: Timestamp
  expiresAt?: Timestamp
  retentionTtlMs?: number
  retainUntil?: Timestamp
  cancelRequestedAt?: Timestamp
  cancelReason?: string
  lastOutputSeq: number
  lastOutputAt?: Timestamp
  completedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
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
  deadlineAt?: Timestamp
  expiresAt?: Timestamp
  retentionTtlMs?: number
  retainUntil?: Timestamp
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
  createdAt: Timestamp
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
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    executorKind: row.executorKind as ToolCallTaskExecutorKind,
    deliveryKind: row.deliveryKind as ToolCallTaskDeliveryKind,
    humanSurface: row.humanSurface as ToolCallTaskHumanSurface,
    principalSubjectId: row.principalSubjectId,
    sessionId: row.sessionId || undefined,
    remoteAgentRunId: row.remoteAgentRunId || undefined,
    turnId: row.turnId || undefined,
    sourceToolCallId: row.sourceToolCallId || undefined,
    sourceToolName: row.sourceToolName,
    lifecycleStatus: row.lifecycleStatus as ToolCallTaskLifecycleStatus,
    outcome: (row.outcome as ToolCallTaskOutcome | null) || undefined,
    statusMessage: row.statusMessage || undefined,
    supportsCancel: row.supportsCancel === true,
    supportsOutputTail: row.supportsOutputTail === true,
    revision:
      typeof row.revision === "number"
        ? row.revision
        : Number(row.revision || 1),
    requestKey: row.requestKey,
    requesterParticipantId: row.requesterParticipantId || undefined,
    targetParticipantId: row.targetParticipantId || undefined,
    resolvedByParticipantId: row.resolvedByParticipantId || undefined,
    resolvedAt: serializeOptionalInstant(row.resolvedAt),
    requestPayload: parseJsonObject(row.requestPayload),
    immediateResultPayload: parseJsonObject(row.immediateResultPayload),
    finalResultPayload: parseJsonObject(row.finalResultPayload),
    finalErrorPayload: parseJsonObject(row.finalErrorPayload),
    metadata: parseJsonObject(row.metadata),
    conversationItemId: row.conversationItemId || undefined,
    completionItemId: row.completionItemId || undefined,
    deadlineAt: serializeOptionalInstant(row.deadlineAt),
    expiresAt: serializeOptionalInstant(row.expiresAt),
    retentionTtlMs:
      typeof row.retentionTtlMs === "number" ? row.retentionTtlMs : undefined,
    retainUntil: serializeOptionalInstant(row.retainUntil),
    cancelRequestedAt: serializeOptionalInstant(row.cancelRequestedAt),
    cancelReason: row.cancelReason || undefined,
    lastOutputSeq:
      typeof row.lastOutputSeq === "number"
        ? row.lastOutputSeq
        : Number(row.lastOutputSeq || 0),
    lastOutputAt: serializeOptionalInstant(row.lastOutputAt),
    completedAt: serializeOptionalInstant(row.completedAt),
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `Tool-call task ${row.id} created_at`)
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updatedAt, `Tool-call task ${row.id} updated_at`)
    ),
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

  const row: TableInsert<"toolCallTasks"> = {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    executorKind: params.executorKind,
    deliveryKind: params.deliveryKind,
    humanSurface: params.humanSurface,
    principalSubjectId: params.principalSubjectId,
    sessionId: params.sessionId || null,
    remoteAgentRunId: params.remoteAgentRunId || null,
    turnId: params.turnId || null,
    sourceToolCallId: params.sourceToolCallId || null,
    sourceToolName: params.sourceToolName,
    lifecycleStatus: params.lifecycleStatus || "working",
    statusMessage: params.statusMessage || null,
    supportsCancel: params.supportsCancel === true,
    supportsOutputTail: params.supportsOutputTail === true,
    requestKey: params.requestKey,
    requesterParticipantId: params.requesterParticipantId || null,
    targetParticipantId: params.targetParticipantId || null,
    requestPayload: (params.requestPayload ||
      {}) as TableInsert<"toolCallTasks">["requestPayload"],
    immediateResultPayload: (params.immediateResultPayload ||
      {}) as TableInsert<"toolCallTasks">["immediateResultPayload"],
    metadata: (params.metadata ||
      {}) as TableInsert<"toolCallTasks">["metadata"],
    deadlineAt: toDate(params.deadlineAt),
    expiresAt: toDate(params.expiresAt),
    retentionTtlMs: params.retentionTtlMs ?? null,
    retainUntil: toDate(params.retainUntil),
  }

  const createdRow = await executor
    .insertInto("toolCallTasks")
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
    .insertInto("toolCallTasks")
    .values({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      executorKind: params.executorKind,
      deliveryKind: params.deliveryKind,
      humanSurface: params.humanSurface,
      principalSubjectId: params.principalSubjectId,
      sessionId: params.sessionId || null,
      remoteAgentRunId: params.remoteAgentRunId || null,
      turnId: params.turnId || null,
      sourceToolCallId: params.sourceToolCallId || null,
      sourceToolName: params.sourceToolName,
      lifecycleStatus: params.lifecycleStatus || "working",
      statusMessage: params.statusMessage || null,
      supportsCancel: params.supportsCancel === true,
      supportsOutputTail: params.supportsOutputTail === true,
      requestKey: params.requestKey,
      requesterParticipantId: params.requesterParticipantId || null,
      targetParticipantId: params.targetParticipantId || null,
      requestPayload: (params.requestPayload ||
        {}) as TableInsert<"toolCallTasks">["requestPayload"],
      immediateResultPayload: (params.immediateResultPayload ||
        {}) as TableInsert<"toolCallTasks">["immediateResultPayload"],
      metadata: (params.metadata ||
        {}) as TableInsert<"toolCallTasks">["metadata"],
      deadlineAt: toDate(params.deadlineAt),
      expiresAt: toDate(params.expiresAt),
      retentionTtlMs: params.retentionTtlMs ?? null,
      retainUntil: toDate(params.retainUntil),
    })
    .onConflict((oc) =>
      oc
        .columns(["workspaceId", "requestKey"])
        .where("lifecycleStatus", "in", [
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
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("requestKey", "=", requestKey)
    .where("lifecycleStatus", "in", [
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
 *
 * `onCreatedInTx` runs INSIDE the same transaction as a freshly-minted parent
 * (only when NOT deduped), so CTI detail tables (runtime_authorization /
 * device_tool / external_mcp) are written before the deferred consistency
 * trigger fires at COMMIT. Without this the parent commit would fail
 * "must have exactly one detail row".
 */
export async function createToolCallTaskDeduped(
  params: CreateToolCallTaskParams,
  onCreatedInTx?: (task: ToolCallTaskRecord, trx: Executor) => Promise<void>
): Promise<{ task: ToolCallTaskRecord; deduped: boolean }> {
  return withDbTransaction(async (trx) => {
    const created = await insertToolCallTaskDeduped(trx, params)
    if (created) {
      if (onCreatedInTx) {
        await onCreatedInTx(created, trx)
      }
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
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("id", "=", taskId)
    .limit(1)
    .executeTakeFirst()

  return mapToolCallTaskRow(row || null)
}

export async function appendToolCallTaskOutput(
  taskId: string,
  chunk: {
    /** Explicit seq for callers that own ordering; omit for atomic server-side
     *  allocation (race-safe under concurrent device.task.output frames). */
    seq?: number
    stream: "stdout" | "stderr" | "system"
    text: string
    createdAt?: Timestamp
    metadata?: Record<string, unknown>
  }
) {
  const text = chunk.text.trim()
  if (!text) {
    return getToolCallTask(taskId)
  }

  let appendedSeq: number
  if (typeof chunk.seq === "number") {
    const row: TableInsert<"toolCallTaskOutputChunks"> = {
      taskId: taskId,
      seq: chunk.seq,
      stream: chunk.stream,
      textValue: text,
      metadata: (chunk.metadata ||
        {}) as TableInsert<"toolCallTaskOutputChunks">["metadata"],
      createdAt: toDate(chunk.createdAt) ?? undefined,
    }
    await db
      .insertInto("toolCallTaskOutputChunks")
      .values(row)
      .onConflict((oc) => oc.columns(["taskId", "seq"]).doNothing())
      .execute()
    appendedSeq = Math.max(0, chunk.seq)
  } else {
    // Atomic-ish seq allocation: COALESCE(MAX(seq),0)+1 computed inside the
    // INSERT. Under READ COMMITTED two concurrent appends can still read the
    // same MAX and collide on the (task_id, seq) unique constraint — so retry on
    // unique-violation (23505) until we win a distinct seq, rather than silently
    // dropping the chunk (which onConflict-doNothing would). Bounded retries.
    let appended: number | null = null
    for (let attempt = 0; attempt < 8 && appended === null; attempt++) {
      try {
        const inserted = await sql<{ seq: number | string }>`
          INSERT INTO tool_call_task_output_chunks (task_id, seq, stream, text_value, metadata, created_at)
          SELECT
            ${taskId}::uuid,
            COALESCE(MAX(seq), 0) + 1,
            ${chunk.stream},
            ${text},
            ${JSON.stringify(chunk.metadata || {})}::jsonb,
            ${toDate(chunk.createdAt)}
          FROM tool_call_task_output_chunks
          WHERE task_id = ${taskId}::uuid
          RETURNING seq
        `.execute(db)
        const raw = inserted.rows[0]?.seq
        appended = typeof raw === "number" ? raw : Number(raw || 0)
      } catch (err) {
        // 23505 = unique_violation: a concurrent append took our seq. Retry.
        if ((err as { code?: string })?.code === "23505") continue
        throw err
      }
    }
    if (appended === null) {
      throw new Error(
        `Failed to allocate output seq for task ${taskId} after retries`
      )
    }
    appendedSeq = appended
  }

  return updateToolCallTaskRecord(taskId, {
    lastOutputSeq: appendedSeq,
    lastOutputAt: chunk.createdAt,
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
    cancelRequestedAt: serializeNowInstant(),
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
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("sessionId", "=", sessionId)
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
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("sessionId", "=", params.sessionId)

  if (params.statuses && params.statuses.length > 0) {
    statement = statement.where("lifecycleStatus", "in", params.statuses)
  }

  const result = await statement
    .orderBy("createdAt", "desc")
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
    .selectFrom("toolCallTaskOutputChunks")
    .select(["seq", "stream", "textValue", "metadata", "createdAt"])
    .where("taskId", "=", params.taskId)

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
    text: row.textValue,
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        "Tool-call task output chunk created_at"
      )
    ),
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
    resolvedAt?: Timestamp
    deadlineAt?: Timestamp
    expiresAt?: Timestamp
    retentionTtlMs?: number
    retainUntil?: Timestamp
    cancelRequestedAt?: string | null
    cancelReason?: string | null
    lastOutputSeq?: number
    lastOutputAt?: Timestamp | null
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
  // retry after the task has already reached a terminal lifecycle.
  let update = db
    .updateTable("toolCallTasks")
    .set({
      lifecycleStatus: nextStatus,
      outcome:
        params.outcome ??
        (existing.outcome as ToolCallTaskOutcome | undefined) ??
        null,
      statusMessage: params.statusMessage ?? existing.statusMessage ?? null,
      supportsCancel: params.supportsCancel ?? existing.supportsCancel,
      supportsOutputTail:
        params.supportsOutputTail ?? existing.supportsOutputTail,
      immediateResultPayload: (params.immediateResultPayload ??
        existing.immediateResultPayload ??
        {}) as TableInsert<"toolCallTasks">["immediateResultPayload"],
      finalResultPayload: (params.finalResultPayload ??
        existing.finalResultPayload ??
        {}) as TableInsert<"toolCallTasks">["finalResultPayload"],
      finalErrorPayload: (params.finalErrorPayload ??
        existing.finalErrorPayload ??
        {}) as TableInsert<"toolCallTasks">["finalErrorPayload"],
      metadata: nextMetadata as TableInsert<"toolCallTasks">["metadata"],
      conversationItemId:
        params.conversationItemId ?? existing.conversationItemId ?? null,
      completionItemId:
        params.completionItemId ?? existing.completionItemId ?? null,
      resolvedByParticipantId:
        params.resolvedByParticipantId ??
        existing.resolvedByParticipantId ??
        null,
      resolvedAt: toDate(params.resolvedAt ?? existing.resolvedAt ?? null),
      deadlineAt: toDate(params.deadlineAt ?? existing.deadlineAt ?? null),
      expiresAt: toDate(params.expiresAt ?? existing.expiresAt ?? null),
      retentionTtlMs: params.retentionTtlMs ?? existing.retentionTtlMs ?? null,
      retainUntil: toDate(params.retainUntil ?? existing.retainUntil ?? null),
      cancelRequestedAt: toDate(
        params.cancelRequestedAt ?? existing.cancelRequestedAt ?? null
      ),
      cancelReason: params.cancelReason ?? existing.cancelReason ?? null,
      lastOutputSeq: params.lastOutputSeq ?? existing.lastOutputSeq ?? 0,
      lastOutputAt: toDate(
        params.lastOutputAt ?? existing.lastOutputAt ?? null
      ),
      completedAt: nextCompletedAt,
      updatedAt: new Date(),
    })
    .where("id", "=", taskId)

  // Guard: any status-changing write must not touch an already-terminal row.
  if (params.lifecycleStatus !== undefined) {
    update = update.where(
      "lifecycleStatus",
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
    .selectFrom("accessSubjects")
    .select(["kind", "actorId", "remoteAgentId"])
    .where("id", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return {}
  return {
    actorId: row.actorId || undefined,
    remoteAgentId: row.remoteAgentId || undefined,
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

  // Atomically flip to terminal ONLY if still non-terminal — RETURNING tells us
  // whether THIS call won the transition. Concurrent terminal callers (e.g.
  // device result vs socket-close fail vs TTL sweep) thus deliver exactly once;
  // the losers see zero rows and skip delivery (no duplicate wakeup).
  const flipRow = await db
    .updateTable("toolCallTasks")
    .set({
      lifecycleStatus: lifecycleStatus,
      outcome:
        params.outcome ??
        (record.outcome as ToolCallTaskOutcome | undefined) ??
        null,
      statusMessage: params.summary ?? record.statusMessage ?? null,
      finalResultPayload: (params.finalResultPayload ??
        record.finalResultPayload ??
        {}) as TableInsert<"toolCallTasks">["finalResultPayload"],
      finalErrorPayload: (params.finalErrorPayload ??
        record.finalErrorPayload ??
        {}) as TableInsert<"toolCallTasks">["finalErrorPayload"],
      metadata: (params.metadata
        ? { ...record.metadata, ...params.metadata }
        : record.metadata) as TableInsert<"toolCallTasks">["metadata"],
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", record.id)
    .where("lifecycleStatus", "in", NON_TERMINAL_TOOL_CALL_TASK_STATUSES)
    .returningAll()
    .executeTakeFirst()

  // Zero rows = another caller already terminalized; do not re-deliver.
  if (!flipRow) {
    return (await getToolCallTask(record.id)) ?? record
  }
  const flipped = mapToolCallTaskRow(flipRow) ?? record
  if (flipped.sessionId) {
    await publishSessionRuntime(flipped.workspaceId, flipped.sessionId)
  }

  if (params.notifyActor === false || record.deliveryKind === "none") {
    return flipped
  }

  return deliverTaskNotice(flipped, status, params)
}

/**
 * Delivery-only core (no status flip): emits the agent-facing notice + wakeup
 * (session_wakeup) or the machine-WS push (remote_agent_channel). Used both by
 * emitTaskNotice (after its in-function flip) and by deliverResolvedToolCallTask
 * (where the task resolve tx already flipped the lifecycle in-tx).
 */
async function deliverTaskNotice(
  record: ToolCallTaskRecord,
  status: TaskNoticeStatus,
  params: ToolCallTaskTerminalNoticeParams
) {
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
    const sessionId = record.sessionId
    const actorMember = principal.actorId
      ? await getConversationParticipant({
          conversationId: record.conversationId,
          actorId: principal.actorId,
        })
      : null

    // Guard: a closed session can't be woken. Check before the tx so we don't
    // emit a notice + wakeup row for a session that will never drain it.
    const session = await getSession(sessionId)
    if (!session || session.status === "closed") {
      return record
    }

    // P0 durable delivery: the actor-private task_notice, the durable
    // session_wakeups row, and the task's completion_item_id marker all commit
    // in ONE transaction. The marker is what crash-recovery treats as "already
    // delivered" — so it must mean "wakeup is durably enqueued", not "notice
    // was created". Previously the marker was written before the wakeup row, so
    // a crash in between left a delivered-looking task with no wakeup and the
    // agent hung forever. completionItemId is also the wakeup's ON CONFLICT
    // dedup key, so a partial-reorder alone is unsafe (a recovery retry would
    // mint a fresh event id and double-enqueue); atomic commit is the fix.
    const wakeupParams: EnqueueSessionWakeupParams | null = principal.actorId
      ? {
          sessionId,
          actorId: principal.actorId,
          workspaceId: record.workspaceId,
          sourceType: "system_interrupt",
          // sourceItemId set inside the tx once the event id exists.
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
        }
      : null

    const { updated, reusedExistingWakeup, wakeupEnqueued } =
      await withDbTransaction(async (trx) => {
        let completionItemId: string | undefined
        if (actorMember?.id) {
          const created = await createConversationEvent({
            workspaceId: record.workspaceId,
            conversationId: record.conversationId,
            sessionId,
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
            queryable: trx,
          })
          completionItemId = created.item.id
        }

        let reused = false
        let enqueued = false
        if (wakeupParams) {
          const { reusedExistingWakeup } = await insertSessionWakeupRow(trx, {
            ...wakeupParams,
            sourceItemId: completionItemId,
          })
          reused = reusedExistingWakeup
          enqueued = true
        }

        // Persist the completion-item pointer LAST in the tx (payload-only;
        // the row is already terminal so no terminal guard). On commit, marker
        // set ⟺ wakeup row durably present.
        const updatedRecord = completionItemId
          ? (mapToolCallTaskRow(
              (await trx
                .updateTable("toolCallTasks")
                .set({
                  completionItemId: completionItemId,
                })
                .where("id", "=", record.id)
                .returningAll()
                .executeTakeFirst()) ?? null
            ) ?? record)
          : record

        return {
          updated: updatedRecord,
          reusedExistingWakeup: reused,
          wakeupEnqueued: enqueued,
        }
      })

    // Post-commit nudges (Redis publish + think-queue): non-durable, safe to
    // run after commit. The worker drains ALL pending wakeups for the session,
    // so even a lost nudge self-heals; firing it keeps latency low. Skipped on
    // reuse (an existing pending wakeup already has a live driver).
    if (wakeupParams && wakeupEnqueued && !reusedExistingWakeup) {
      await nudgeSessionAfterWakeup(wakeupParams, session)
    }
    // Refresh the runtime snapshot for the completion-marker write (mirrors the
    // publish updateToolCallTaskRecord did before this became transactional).
    if (updated.completionItemId) {
      await publishSessionRuntime(updated.workspaceId, sessionId)
    }

    return updated
  }

  // ── delivery: remote_agent_channel ────────────────────────────────────────
  // The grant (for runtime_auth) is already durable; the push is a best-effort
  // nudge to retry sooner (resume is grant-gated / re-poll, design §3.8).
  if (record.deliveryKind === "remote_agent_channel") {
    try {
      const { notifyRemoteAgentTaskResolved } =
        await import("../remote-agents/service.js")
      await notifyRemoteAgentTaskResolved(record.id)
    } catch {
      // best-effort nudge; resume is grant-gated / re-poll on the agent side.
    }
  }

  return record
}

/**
 * Deliver a task whose terminal lifecycle/outcome were ALREADY set in the
 * caller's transaction (the task resolve flow flips in-tx so its
 * broadcast/HTTP view is correct). Optionally writes a post-commit result
 * payload (e.g. runtime-auth auto-retry output) via an unguarded update, then
 * fires the notice + wakeup/push. Idempotent-safe: if the task is somehow no
 * longer terminal it still just delivers.
 */
export async function deliverResolvedToolCallTask(
  taskId: string,
  status: TaskNoticeStatus,
  params: ToolCallTaskTerminalNoticeParams
) {
  const record = await getToolCallTask(taskId)
  if (!record) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  // Idempotency / crash-recovery (P0): a session_wakeup task is "delivered" once
  // its completion_item_id (the actor-private task_notice) exists. If a retry
  // (e.g. duplicate-command resolve) reaches here and delivery already happened,
  // skip re-delivery so we don't emit a second notice + wakeup. For
  // remote_agent_channel / none there is no durable delivery marker; re-pushing
  // is harmless (best-effort nudge), so we let it through.
  if (record.deliveryKind === "session_wakeup" && record.completionItemId) {
    return record
  }
  // Persist any post-commit result payload (auto-retry output) without the
  // terminal guard (the row is already terminal from the in-tx flip).
  let current = record
  if (
    params.finalResultPayload !== undefined ||
    params.finalErrorPayload !== undefined ||
    params.metadata !== undefined ||
    params.summary
  ) {
    current =
      (await updateToolCallTaskRecord(taskId, {
        statusMessage: params.summary,
        finalResultPayload: params.finalResultPayload,
        finalErrorPayload: params.finalErrorPayload,
        metadata: params.metadata,
      })) ?? record
  }
  if (params.notifyActor === false || current.deliveryKind === "none") {
    return current
  }
  return deliverTaskNotice(current, status, params)
}

/**
 * Crash-recovery delivery (P0): re-fire delivery for a task that is terminal but
 * may never have been delivered (process died between the resolve commit and the
 * post-commit delivery). Driven entirely by persisted task state, so it works on
 * a retry where the in-memory decision is gone. Idempotent: deliverResolved-
 * ToolCallTask skips session_wakeup tasks that already have a completion item,
 * and only terminal tasks are delivered. Non-terminal or already-delivered →
 * no-op.
 */
export async function recoverUndeliveredResolvedTask(taskId: string) {
  const task = await getToolCallTask(taskId)
  if (!task) return null
  if (!TERMINAL_TOOL_CALL_TASK_STATUSES.has(task.lifecycleStatus)) return task
  // Already delivered (session_wakeup) → nothing to recover.
  if (task.deliveryKind === "session_wakeup" && task.completionItemId) {
    return task
  }
  // Map the terminal lifecycle/outcome back to a TaskNoticeStatus for the notice.
  const noticeStatus: TaskNoticeStatus =
    task.lifecycleStatus === "completed"
      ? "completed"
      : task.lifecycleStatus === "cancelled"
        ? "cancelled"
        : "failed"
  const summary =
    task.statusMessage ||
    `${task.sourceToolName.replace(/_/g, " ")} ${noticeStatus}.`
  return deliverResolvedToolCallTask(taskId, noticeStatus, {
    summary,
    // Don't overwrite the persisted result payload on recovery — deliver only.
  })
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
