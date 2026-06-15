// tool-call-tasks/repo.ts — DB-touching helpers for the tool-call-tasks module.
//
// The only tool-call-tasks file (besides repo.types) permitted to import the db
// client (guard r8). Owns every toolCallTasks / toolCallTaskOutputChunks /
// accessSubjects query the service used to run inline. Each helper takes an
// injected `run: Executor` (db OR a trx) so the SERVICE keeps owning transaction
// boundaries (withDbTransaction) and atomicity — repo never opens a transaction
// and never nests one. Helpers return RAW rows with Date objects intact
// (presenter.ts does the Date→IsoInstant + JSON decode), so this file never
// serializes datetimes or parses JSON. round-6 P1-6.

import { parseJsonObject } from "@synapse/shared"
import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type Executor,
  type TableUpdate,
} from "../../infrastructure/database/kysely.js"
import type {
  ToolCallTaskInsert,
  ToolCallTaskLifecycleStatus,
  ToolCallTaskOutputChunkInsert,
  ToolCallTaskOutputChunkRawRow,
  ToolCallTaskOutputChunkRow,
  ToolCallTaskRawRow,
  ToolCallTaskRow,
} from "./repo.types.js"

/**
 * Re-exported so the service opens its transactions through the repo boundary
 * (guard r8) instead of importing the db client directly. The service keeps
 * owning the transaction body — it threads the injected `trx` Executor into the
 * `run`-taking repo helpers, so multi-statement atomicity stays in the service
 * and the repo never nests a transaction.
 */
export { withDbTransaction }

/**
 * Updateable column set for a toolCallTasks row. The service builds this value
 * object (JSON payload columns pre-cast to their Payload aliases) and hands it
 * to the repo writers, so the final `.set()` lives behind the db boundary.
 */
type ToolCallTaskUpdate = TableUpdate<"toolCallTasks">

/** The lifecycle statuses a status-changing write is allowed to mutate. */
const NON_TERMINAL_TOOL_CALL_TASK_STATUSES: ToolCallTaskLifecycleStatus[] = [
  "submitted",
  "working",
  "input_required",
  "auth_required",
]

export function normalizeToolCallTaskRow(
  row: ToolCallTaskRawRow
): ToolCallTaskRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    executorKind: row.executorKind,
    deliveryKind: row.deliveryKind,
    humanSurface: row.humanSurface,
    principalSubjectId: row.principalSubjectId,
    sessionId: row.sessionId,
    remoteAgentRunId: row.remoteAgentRunId,
    turnId: row.turnId,
    sourceToolCallId: row.sourceToolCallId,
    sourceToolName: row.sourceToolName,
    lifecycleStatus: row.lifecycleStatus,
    outcome: row.outcome,
    statusMessage: row.statusMessage,
    supportsCancel: row.supportsCancel,
    supportsOutputTail: row.supportsOutputTail,
    revision: row.revision,
    requestKey: row.requestKey,
    requesterParticipantId: row.requesterParticipantId,
    targetParticipantId: row.targetParticipantId,
    resolvedByParticipantId: row.resolvedByParticipantId,
    resolvedAt: row.resolvedAt,
    requestPayload: parseJsonObject(row.requestPayload),
    immediateResultPayload: parseJsonObject(row.immediateResultPayload),
    finalResultPayload: parseJsonObject(row.finalResultPayload),
    finalErrorPayload: parseJsonObject(row.finalErrorPayload),
    metadata: parseJsonObject(row.metadata),
    conversationItemId: row.conversationItemId,
    completionItemId: row.completionItemId,
    deadlineAt: row.deadlineAt,
    expiresAt: row.expiresAt,
    retentionTtlMs: row.retentionTtlMs,
    retainUntil: row.retainUntil,
    cancelRequestedAt: row.cancelRequestedAt,
    cancelReason: row.cancelReason,
    lastOutputSeq: row.lastOutputSeq,
    lastOutputAt: row.lastOutputAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function normalizeToolCallTaskOutputChunkRow(
  row: ToolCallTaskOutputChunkRawRow
): ToolCallTaskOutputChunkRow {
  return {
    seq: row.seq,
    stream: row.stream,
    textValue: row.textValue,
    createdAt: row.createdAt,
    metadata: parseJsonObject(row.metadata),
  }
}

/** Minimal session row used by the session_wakeup precondition check. */
export async function selectSessionStatusRow(
  run: Executor,
  sessionId: string
): Promise<{ id: string; status: string } | null> {
  const row = await run
    .selectFrom("sessions")
    .select(["id", "status"])
    .where("id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/** Plain INSERT ... RETURNING * for a tool-call task. */
export async function insertToolCallTaskRow(
  run: Executor,
  row: ToolCallTaskInsert
): Promise<ToolCallTaskRow | null> {
  const created = await run
    .insertInto("toolCallTasks")
    .values(row)
    .returningAll()
    .executeTakeFirst()
  return created ? normalizeToolCallTaskRow(created) : null
}

/**
 * Dedupe-aware mint (design §3.4): INSERT ... ON CONFLICT on the partial-unique
 * (workspace_id, request_key) WHERE non-terminal DO NOTHING. Returns the new
 * row, or null when a live task with the same request_key already exists.
 */
export async function insertToolCallTaskRowDeduped(
  run: Executor,
  row: ToolCallTaskInsert
): Promise<ToolCallTaskRow | null> {
  const created = await run
    .insertInto("toolCallTasks")
    .values(row)
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
  return created ? normalizeToolCallTaskRow(created) : null
}

/**
 * Look up the live (non-terminal) task that won a dedupe race on request_key.
 */
export async function selectLiveToolCallTaskByRequestKey(
  run: Executor,
  workspaceId: string,
  requestKey: string
): Promise<ToolCallTaskRow | null> {
  const row = await run
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
  return row ? normalizeToolCallTaskRow(row) : null
}

/** Fetch a single tool-call task by id. */
export async function selectToolCallTaskById(
  run: Executor,
  taskId: string
): Promise<ToolCallTaskRow | null> {
  const row = await run
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("id", "=", taskId)
    .limit(1)
    .executeTakeFirst()
  return row ? normalizeToolCallTaskRow(row) : null
}

/** Fetch a single tool-call task scoped to a session. */
export async function selectToolCallTaskForSession(
  run: Executor,
  sessionId: string,
  taskId: string
): Promise<ToolCallTaskRow | null> {
  const row = await run
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("sessionId", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  return row ? normalizeToolCallTaskRow(row) : null
}

/** List a session's tool-call tasks (optionally filtered by status), newest first. */
export async function selectToolCallTasksForSession(
  run: Executor,
  params: {
    sessionId: string
    statuses?: ToolCallTaskLifecycleStatus[]
    limit: number
  }
): Promise<ToolCallTaskRow[]> {
  let statement = run
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("sessionId", "=", params.sessionId)

  if (params.statuses && params.statuses.length > 0) {
    statement = statement.where("lifecycleStatus", "in", params.statuses)
  }

  const rows = await statement
    .orderBy("createdAt", "desc")
    .limit(params.limit)
    .execute()
  return rows.map(normalizeToolCallTaskRow)
}

/**
 * Read a window of a task's output chunks. `afterSeq>0` pages forward (seq>after,
 * ascending); otherwise it tails the most-recent chunks (descending). The caller
 * reverses the tail-mode rows for chronological order.
 */
export async function selectToolCallTaskOutputChunks(
  run: Executor,
  params: {
    taskId: string
    afterSeq: number
    stream: "stdout" | "stderr" | "system" | null
    limit: number
  }
): Promise<ToolCallTaskOutputChunkRow[]> {
  let statement = run
    .selectFrom("toolCallTaskOutputChunks")
    .select(["seq", "stream", "textValue", "metadata", "createdAt"])
    .where("taskId", "=", params.taskId)

  if (params.afterSeq > 0) {
    statement = statement.where("seq", ">", String(params.afterSeq))
  }
  if (params.stream) {
    statement = statement.where("stream", "=", params.stream)
  }

  const rows = await statement
    .orderBy("seq", params.afterSeq > 0 ? "asc" : "desc")
    .limit(params.limit)
    .execute()
  return rows.map(normalizeToolCallTaskOutputChunkRow)
}

/** Insert an output chunk with a caller-supplied seq (idempotent on conflict). */
export async function insertToolCallTaskOutputChunkExplicit(
  run: Executor,
  row: ToolCallTaskOutputChunkInsert
): Promise<void> {
  await run
    .insertInto("toolCallTaskOutputChunks")
    .values(row)
    .onConflict((oc) => oc.columns(["taskId", "seq"]).doNothing())
    .execute()
}

/**
 * Atomic-ish seq allocation: COALESCE(MAX(seq),0)+1 computed inside the INSERT.
 * Under READ COMMITTED two concurrent appends can still read the same MAX and
 * collide on the (task_id, seq) unique constraint — so retry on unique-violation
 * (23505) until we win a distinct seq, rather than silently dropping the chunk
 * (which onConflict-doNothing would). Bounded retries. Returns the allocated seq.
 */
export async function appendToolCallTaskOutputChunkAtomic(
  run: Executor,
  params: {
    taskId: string
    stream: "stdout" | "stderr" | "system"
    text: string
    metadata: Record<string, unknown>
    createdAt: Date | null
  }
): Promise<number> {
  let appended: number | null = null
  for (let attempt = 0; attempt < 8 && appended === null; attempt++) {
    try {
      const inserted = await sql<{ seq: number | string }>`
          INSERT INTO tool_call_task_output_chunks (task_id, seq, stream, text_value, metadata, created_at)
          SELECT
            ${params.taskId}::uuid,
            COALESCE(MAX(seq), 0) + 1,
            ${params.stream},
            ${params.text},
            ${JSON.stringify(params.metadata || {})}::jsonb,
            ${params.createdAt}
          FROM tool_call_task_output_chunks
          WHERE task_id = ${params.taskId}::uuid
          RETURNING seq
        `.execute(run)
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
      `Failed to allocate output seq for task ${params.taskId} after retries`
    )
  }
  return appended
}

/**
 * Write the computed column set onto a task, RETURNING the new row (or null when
 * zero rows matched). When `requireNonTerminal` is true the update carries the
 * terminal guard `lifecycleStatus IN (non-terminal...)` so a status-changing
 * write can never mutate an already-terminal row (zero rows = idempotent no-op).
 * Callers that intentionally write an already-terminal row (completion marker,
 * post-commit result payload) pass `requireNonTerminal: false`.
 */
export async function updateToolCallTaskRow(
  run: Executor,
  taskId: string,
  values: ToolCallTaskUpdate,
  options: { requireNonTerminal: boolean }
): Promise<ToolCallTaskRow | null> {
  let update = run
    .updateTable("toolCallTasks")
    .set(values)
    .where("id", "=", taskId)

  if (options.requireNonTerminal) {
    update = update.where(
      "lifecycleStatus",
      "in",
      NON_TERMINAL_TOOL_CALL_TASK_STATUSES
    )
  }

  const row = await update.returningAll().executeTakeFirst()
  return row ? normalizeToolCallTaskRow(row) : null
}

/**
 * Atomic terminal flip: set the terminal column values ONLY if the row is still
 * non-terminal, RETURNING the row so the caller learns whether THIS call won the
 * transition (zero rows = a concurrent caller already terminalized).
 */
export async function flipToolCallTaskTerminal(
  run: Executor,
  taskId: string,
  values: ToolCallTaskUpdate
): Promise<ToolCallTaskRow | null> {
  const row = await run
    .updateTable("toolCallTasks")
    .set(values)
    .where("id", "=", taskId)
    .where("lifecycleStatus", "in", NON_TERMINAL_TOOL_CALL_TASK_STATUSES)
    .returningAll()
    .executeTakeFirst()
  return row ? normalizeToolCallTaskRow(row) : null
}

/**
 * Persist the completion-item pointer (payload-only; the row is already terminal
 * so no terminal guard). Used inside the durable session_wakeup delivery tx.
 */
export async function setToolCallTaskCompletionItem(
  run: Executor,
  taskId: string,
  completionItemId: string
): Promise<ToolCallTaskRow | null> {
  const row = await run
    .updateTable("toolCallTasks")
    .set({ completionItemId: completionItemId })
    .where("id", "=", taskId)
    .returningAll()
    .executeTakeFirst()
  return row ? normalizeToolCallTaskRow(row) : null
}

/**
 * Resolve the actor/remote_agent that a task's principal subject points at, so
 * the delivery layer can find the right conversation participant.
 */
export async function selectPrincipalSubjectForDelivery(
  run: Executor,
  subjectId: string
): Promise<{ actorId: string | null; remoteAgentId: string | null } | null> {
  const row = await run
    .selectFrom("accessSubjects")
    .select(["kind", "actorId", "remoteAgentId"])
    .where("id", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return { actorId: row.actorId, remoteAgentId: row.remoteAgentId }
}

// ── Default-db convenience wrappers (non-tx callers) ────────────────────────
// Service entrypoints that run a single statement outside any transaction call
// these so the service never needs a `db` value-import. Tx-bearing callers pass
// their trx into the `run`-taking helpers above instead.

/** {@link selectToolCallTaskById} on the default db. */
export function selectToolCallTaskByIdDefault(
  taskId: string
): Promise<ToolCallTaskRow | null> {
  return selectToolCallTaskById(db, taskId)
}

/** {@link selectToolCallTaskForSession} on the default db. */
export function selectToolCallTaskForSessionDefault(
  sessionId: string,
  taskId: string
): Promise<ToolCallTaskRow | null> {
  return selectToolCallTaskForSession(db, sessionId, taskId)
}

/** {@link selectToolCallTasksForSession} on the default db. */
export function selectToolCallTasksForSessionDefault(params: {
  sessionId: string
  statuses?: ToolCallTaskLifecycleStatus[]
  limit: number
}): Promise<ToolCallTaskRow[]> {
  return selectToolCallTasksForSession(db, params)
}

/** {@link selectToolCallTaskOutputChunks} on the default db. */
export function selectToolCallTaskOutputChunksDefault(params: {
  taskId: string
  afterSeq: number
  stream: "stdout" | "stderr" | "system" | null
  limit: number
}): Promise<ToolCallTaskOutputChunkRow[]> {
  return selectToolCallTaskOutputChunks(db, params)
}

/** {@link insertToolCallTaskOutputChunkExplicit} on the default db. */
export function insertToolCallTaskOutputChunkExplicitDefault(
  row: ToolCallTaskOutputChunkInsert
): Promise<void> {
  return insertToolCallTaskOutputChunkExplicit(db, row)
}

/** {@link appendToolCallTaskOutputChunkAtomic} on the default db. */
export function appendToolCallTaskOutputChunkAtomicDefault(params: {
  taskId: string
  stream: "stdout" | "stderr" | "system"
  text: string
  metadata: Record<string, unknown>
  createdAt: Date | null
}): Promise<number> {
  return appendToolCallTaskOutputChunkAtomic(db, params)
}

/** {@link updateToolCallTaskRow} on the default db. */
export function updateToolCallTaskRowDefault(
  taskId: string,
  values: ToolCallTaskUpdate,
  options: { requireNonTerminal: boolean }
): Promise<ToolCallTaskRow | null> {
  return updateToolCallTaskRow(db, taskId, values, options)
}

/** {@link flipToolCallTaskTerminal} on the default db. */
export function flipToolCallTaskTerminalDefault(
  taskId: string,
  values: ToolCallTaskUpdate
): Promise<ToolCallTaskRow | null> {
  return flipToolCallTaskTerminal(db, taskId, values)
}

/** {@link selectPrincipalSubjectForDelivery} on the default db. */
export function selectPrincipalSubjectForDeliveryDefault(
  subjectId: string
): Promise<{ actorId: string | null; remoteAgentId: string | null } | null> {
  return selectPrincipalSubjectForDelivery(db, subjectId)
}
