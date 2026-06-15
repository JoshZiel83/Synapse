// session/repo.ts — DB-touching helpers for the session module.
//
// This is the only session file permitted to import the db client and `sql`
// (guard-layering r8/r1/r2/r4 exempt repo*.ts). It owns query OWNERSHIP for the
// session module; service.ts carries business orchestration and calls in here.
// Repo functions return camelCase DOMAIN rows with Date columns intact — time
// serialization (serializeInstant) belongs to presenter.ts (guard r3).

import {
  db,
  runBuilder,
  takeFirstOn,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import {
  parseJsonObject,
  SUBJECT_KIND,
  THREAD_CONVERSATION_KINDS,
} from "@synapse/shared"
import type {
  UUID,
  SessionStatus,
  SessionTrigger,
  SessionInterruptType,
  SessionWakeupStatus,
} from "@synapse/shared"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import type {
  ConversationItemPartRow,
  SessionDbRow,
  ToolCallDbRow,
  ToolCallRow,
  ToolCallTaskDbRow,
  ToolResultDbRow,
  SessionWakeupDbRow,
  SessionMessageItemDbRow,
  SessionMessageItemRow,
  SessionRow,
  SessionWakeupMetadataInsert,
  SessionWakeupRow,
  ToolCallTaskRow,
  ToolResultPartRow,
  ToolResultRow,
} from "./repo.types.js"
import type { EnqueueSessionWakeupParams } from "./runtime.js"
import { parseSessionCollaborationState } from "./collaboration-state.js"

function parseCollaborationStateJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("collaboration_state must be a JSON object")
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `collaboration_state must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("collaboration_state must be an object")
  }
  return value as Record<string, unknown>
}

export function decodeSessionCollaborationState(value: unknown) {
  return parseSessionCollaborationState(parseCollaborationStateJson(value))
}

export function normalizeSessionRow(row: SessionDbRow): SessionRow {
  const normalized = {
    ...row,
    collaborationState: decodeSessionCollaborationState(row.collaborationState),
  }
  return normalized
}

export function normalizeSessionMessageItemRow(
  row: SessionMessageItemDbRow
): SessionMessageItemRow {
  const normalized = {
    ...row,
    metadata: { ...parseJsonObject(row.metadata) },
  }
  return normalized
}

export function normalizeSessionWakeupRow(
  row: SessionWakeupDbRow
): SessionWakeupRow {
  const normalized = {
    ...row,
    metadata: { ...parseJsonObject(row.metadata) },
  }
  return normalized
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  return value
}

export function normalizeRuntimeToolCallRow(row: ToolCallDbRow): ToolCallRow {
  const normalized = {
    ...row,
    normalizedInput: { ...parseJsonObject(row.normalizedInput) },
    sourceSnapshot: { ...parseJsonObject(row.sourceSnapshot) },
  }
  return normalized
}

export function normalizeRuntimeToolResultRow(
  row: ToolResultDbRow
): ToolResultRow {
  const normalized = {
    ...row,
    metadata: { ...parseJsonObject(row.metadata) },
  }
  return normalized
}

export function normalizeRuntimeToolCallTaskRow(
  row: ToolCallTaskDbRow
): ToolCallTaskRow {
  const normalized = {
    ...row,
    finalErrorPayload: parseJsonValue(row.finalErrorPayload),
    finalResultPayload: parseJsonValue(row.finalResultPayload),
  }
  return normalized
}

export async function getActorJoinVersionId(actorId: UUID) {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("actorVersions as current_version", (join) =>
      join
        .onRef("current_version.actorId", "=", "a.id")
        .onRef("current_version.version", "=", "a.currentVersion")
    )
    .select("current_version.id as actorVersionId")
    .where("a.id", "=", actorId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return row?.actorVersionId || undefined
}

export async function loadSessionRow(
  sessionId: UUID
): Promise<SessionRow | null> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("actors as a", "a.id", "s.actorId")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("conversations as c", "c.id", "s.conversationId")
    .selectAll("s")
    .select((eb) => [
      "app.displayName as actorDisplayName",
      "c.kind as conversationKind",
      eb
        .exists(
          eb
            .selectFrom("conversationTransportBindings as b")
            .select("b.id")
            .whereRef("b.conversationId", "=", "c.id")
        )
        .as("conversationIsIm"),
      "c.title as conversationTitle",
    ])
    .where("s.id", "=", sessionId)
    .executeTakeFirst()
  return row ? normalizeSessionRow(row as SessionDbRow) : null
}

export async function getConversationActorSessionRow(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  return takeFirstOn(
    queryable,
    db
      .selectFrom("sessions")
      .selectAll()
      .where("conversationId", "=", conversationId)
      .where("actorId", "=", actorId)
      .limit(1)
  )
}

export async function requireActiveActorConversationParticipant(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  // P1b: upsert the actor's subject_id (on the same queryable for trx safety),
  // then filter conversation_participants by subject_id.
  const actorSubjectId = await upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const participant = await takeFirstOn(
    queryable,
    db
      .selectFrom("conversationParticipants")
      .select("id")
      .where("conversationId", "=", conversationId)
      .where("subjectId", "=", actorSubjectId)
      .where("state", "=", "active")
      .limit(1)
  )

  if (!participant) {
    throw new Error(
      `Actor ${actorId} is not an active participant of conversation ${conversationId}`
    )
  }
}

export async function insertSessionIfAbsent(
  params: {
    id: string
    workspaceId: UUID
    actorId: UUID
    conversationId: UUID
    trigger?: SessionTrigger
  },
  queryable: Executor = db
): Promise<{ id: string } | null> {
  return takeFirstOn<{ id: string }>(
    queryable,
    db
      .insertInto("sessions")
      .values({
        id: params.id,
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        conversationId: params.conversationId,
        trigger: params.trigger || "user_message",
        status: "idle",
      })
      .onConflict((oc) => oc.columns(["conversationId", "actorId"]).doNothing())
      .returning("id")
  )
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: SessionStatus,
  extra?: { errorMessage?: string | null }
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      status,
      completedAt: status === "closed" ? sql`NOW()` : null,
      ...(extra?.errorMessage !== undefined
        ? { errorMessage: extra.errorMessage }
        : {}),
    })
    .where("id", "=", sessionId)
    .execute()
}

export async function setSessionCollaborationValues(
  sessionId: UUID,
  values: Record<string, unknown>,
  queryable: Executor = db
): Promise<void> {
  await runBuilder(
    queryable,
    db.updateTable("sessions").set(values).where("id", "=", sessionId)
  )
}

export async function getActorDisplayName(
  actorId: UUID
): Promise<string | undefined> {
  return (
    await db
      .selectFrom("actors as actor")
      .innerJoin("workspaceApps as app", "app.id", "actor.id")
      .select("app.displayName as displayName")
      .where("actor.id", "=", actorId)
      .where("app.deletedAt", "is", null)
      .executeTakeFirst()
  )?.displayName
}

export async function getSessionMessageItemRows(
  sessionId: UUID
): Promise<SessionMessageItemRow[]> {
  const items = await db
    .selectFrom("conversationItems as ci")
    .innerJoin("sessions as s", "s.id", "ci.sessionId")
    .leftJoin(
      "conversationParticipants as cp",
      "cp.id",
      "ci.authorParticipantId"
    )
    .leftJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .leftJoin("actors as a", "a.id", "cpsubj.actorId")
    .leftJoin("workspaceApps as actor_app", "actor_app.id", "a.id")
    .leftJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .leftJoin("users as u", "u.id", "wm.userId")
    .select([
      "ci.id",
      "ci.sessionId",
      "ci.conversationId",
      "ci.sequence",
      "ci.role",
      "ci.subtype",
      "ci.metadata",
      "ci.eventPayload",
      "ci.authorParticipantId",
      "ci.createdAt",
      "s.workspaceId",
      "cpsubj.actorId as fromActorId",
      "cpsubj.workspaceMemberId as fromWorkspaceMemberId",
      sql<
        string | null
      >`COALESCE(actor_app.display_name, u.name, cp.display_name)`.as(
        "authorName"
      ),
    ])
    .where("ci.sessionId", "=", sessionId)
    .orderBy("ci.createdAt", "asc")
    .orderBy("ci.sequence", "asc")
    .execute()
  return (items as unknown as SessionMessageItemDbRow[]).map(
    normalizeSessionMessageItemRow
  )
}

export async function getSessionMessagePartRows(
  itemIds: string[]
): Promise<ConversationItemPartRow[]> {
  return db
    .selectFrom("conversationItemParts as cip")
    .select([
      "cip.id",
      "cip.itemId",
      "cip.ordinal",
      "cip.partType",
      "cip.mimeType",
      "cip.textValue",
      "cip.jsonValue",
      "cip.refPath",
      "cip.refSha256",
      "cip.name",
      "cip.metadata",
    ])
    .where("cip.itemId", "in", itemIds)
    .orderBy("cip.itemId", "asc")
    .orderBy("cip.ordinal", "asc")
    .execute()
}

export async function consumeSessionInterrupts(
  sessionId: UUID
): Promise<any[]> {
  return db
    .updateTable("sessionInterrupts")
    .set({
      isConsumed: true,
    })
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)
    .returningAll()
    .execute()
}

export async function hasPendingSessionInterrupt(
  sessionId: UUID,
  type?: SessionInterruptType
): Promise<boolean> {
  let query = db
    .selectFrom("sessionInterrupts")
    .select("id")
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)

  if (type) {
    query = query.where("type", "=", type)
  }

  const row = await query.limit(1).executeTakeFirst()
  return Boolean(row?.id)
}

// ---------------------------------------------------------------------------
// Runtime engine (session/runtime.ts) query ownership.
//
// These back the runtime snapshot/turn-activity reads and the session-wakeup
// write edge. Reads return camelCase DOMAIN rows with Date columns intact —
// runtime.ts does the Date→IsoInstant serialization (presentWakeup /
// buildToolActivityDetail). The repo decodes session_wakeups.metadata before
// runtime presentation consumes it. The write
// helpers take an injected `executor: Executor` so they can participate in a
// caller's transaction (e.g. tool-call-tasks delivery commits a wakeup row +
// task-completion marker atomically); the `= db` default lives here in the repo
// (the only session file allowed the db client, guard r8).
// ---------------------------------------------------------------------------

/** Wakeups for a session in the given statuses, oldest first. */
export async function listSessionWakeups(
  sessionId: string,
  statuses: SessionWakeupStatus[]
): Promise<SessionWakeupRow[]> {
  const rows = await db
    .selectFrom("sessionWakeups")
    .selectAll()
    .where("sessionId", "=", sessionId)
    .where("status", "in", statuses)
    .orderBy("createdAt", "asc")
    .execute()

  return rows.map((row) => normalizeSessionWakeupRow(row as SessionWakeupDbRow))
}

/** Pending wakeups for a session, oldest first. */
export async function listPendingSessionWakeups(
  sessionId: string
): Promise<SessionWakeupRow[]> {
  const rows = await db
    .selectFrom("sessionWakeups")
    .selectAll()
    .where("sessionId", "=", sessionId)
    .where("status", "=", "pending")
    .orderBy("createdAt", "asc")
    .execute()

  return rows.map((row) => normalizeSessionWakeupRow(row as SessionWakeupDbRow))
}

/** Id of the session's most-recently-started running turn, if any. */
export async function getActiveTurnId(
  sessionId: string
): Promise<string | undefined> {
  const row = await db
    .selectFrom("turns")
    .select("id")
    .where("sessionId", "=", sessionId)
    .where("status", "=", "running")
    .orderBy("startedAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return row?.id
}

export type AttachedWakeupTargetRow = {
  id: string
  sourceParticipantType: string | null
  sourceParticipantId: string | null
  sourceName: string | null
  summary: string
  createdAt: Date
  attachedAt: Date | null
}

/** Attached wakeups for a turn (the turn's processing targets), oldest first. */
export async function listAttachedWakeupTargets(
  turnId: string
): Promise<AttachedWakeupTargetRow[]> {
  return db
    .selectFrom("sessionWakeups")
    .select([
      "id",
      "sourceParticipantType",
      "sourceParticipantId",
      "sourceName",
      "summary",
      "createdAt",
      "attachedAt",
    ])
    .where("turnId", "=", turnId)
    .where("status", "=", "attached")
    .orderBy("createdAt", "asc")
    .execute()
}

export type TurnActivityHeaderRow = {
  id: string
  sessionId: string
  conversationId: string
  actorId: string
  startedAt: Date | null
  updatedAt: Date
  completedAt: Date | null
  workspaceId: string
  actorDisplayName: string | null
}

/** The turn header (turns ⨝ sessions ⨝ actors ⨝ workspaceApps) for activity detail. */
export async function getTurnActivityHeader(
  turnId: string
): Promise<TurnActivityHeaderRow | undefined> {
  const row = await db
    .selectFrom("turns")
    .innerJoin("sessions as s", "s.id", "turns.sessionId")
    .innerJoin("actors as a", "a.id", "turns.actorId")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .select([
      "turns.id",
      "turns.sessionId",
      "turns.conversationId",
      "turns.actorId",
      "turns.startedAt",
      "turns.updatedAt",
      "turns.completedAt",
      "s.workspaceId",
      "app.displayName as actorDisplayName",
    ])
    .where("turns.id", "=", turnId)
    .limit(1)
    .executeTakeFirst()
  return row as TurnActivityHeaderRow | undefined
}

/** Tool calls for a turn, ordered by creation then call index. */
export async function listTurnToolCalls(
  turnId: string
): Promise<ToolCallRow[]> {
  const rows = await db
    .selectFrom("toolCalls")
    .selectAll()
    .where("turnId", "=", turnId)
    .orderBy("createdAt", "asc")
    .orderBy("callIndex", "asc")
    .execute()

  return rows.map((row) => normalizeRuntimeToolCallRow(row as ToolCallDbRow))
}

/** Tool results for the given tool-call ids (newest result per call first). */
export async function listToolResultsForToolCalls(
  toolCallIds: string[]
): Promise<ToolResultRow[]> {
  const rows = await db
    .selectFrom("toolResults")
    .selectAll()
    .where("toolCallId", "in", toolCallIds)
    .orderBy("toolCallId", "asc")
    .orderBy("resultIndex", "desc")
    .execute()

  return rows.map((row) =>
    normalizeRuntimeToolResultRow(row as ToolResultDbRow)
  )
}

/** Result parts for the given result ids, ordered for assembly. */
export async function listToolResultParts(
  resultIds: string[]
): Promise<ToolResultPartRow[]> {
  return db
    .selectFrom("toolResultParts")
    .selectAll()
    .where("toolResultId", "in", resultIds)
    .orderBy("toolResultId", "asc")
    .orderBy("ordinal", "asc")
    .execute()
}

/** Latest tasks sourced from the given tool-call ids (newest first). */
export async function listLatestTasksForToolCalls(
  toolCallIds: string[]
): Promise<ToolCallTaskRow[]> {
  const rows = await db
    .selectFrom("toolCallTasks")
    .selectAll()
    .where("sourceToolCallId", "in", toolCallIds)
    .orderBy("createdAt", "desc")
    .execute()

  return rows.map((row) =>
    normalizeRuntimeToolCallTaskRow(row as ToolCallTaskDbRow)
  )
}

/** Output chunks for the given task ids (newest seq first). */
export async function listTaskOutputChunks(taskIds: string[]) {
  return db
    .selectFrom("toolCallTaskOutputChunks")
    .select(["taskId", "stream", "textValue", "seq"])
    .where("taskId", "in", taskIds)
    .orderBy("taskId", "asc")
    .orderBy("seq", "desc")
    .execute()
}

export type ThreadSessionRow = {
  id: string
  actorId: string
  conversationId: string
}

/**
 * Thread-conversation sessions for the given conversation ids. Filters by
 * THREAD_CONVERSATION_KINDS (the domain filter stays in the repo query) so the
 * runtime map only hydrates thread sessions.
 */
export async function listThreadSessionsForConversations(
  conversationIds: string[]
): Promise<ThreadSessionRow[]> {
  return db
    .selectFrom("sessions as s")
    .innerJoin("conversations as c", "c.id", "s.conversationId")
    .select(["s.id", "s.actorId", "s.conversationId"])
    .where("s.conversationId", "in", conversationIds)
    .where("c.kind", "in", [...THREAD_CONVERSATION_KINDS])
    .execute()
}

/**
 * Durable half of enqueueSessionWakeup: insert (or idempotently reuse) the
 * `session_wakeups` row on the given executor. No Redis/queue side effects, so
 * it can run INSIDE a caller's transaction. The raw `sql` INSERT keeps its
 * snake_case identifiers, `::jsonb` cast, and the partial-unique-index
 * ON CONFLICT verbatim — it already runs on the injected executor.
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
  let created: SessionWakeupRow | undefined
  let reusedExistingWakeup = false

  if (params.sourceItemId) {
    const insertResult = await sql<SessionWakeupDbRow>`
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
    const inserted = insertResult.rows[0]
    created = inserted
      ? normalizeSessionWakeupRow(inserted as SessionWakeupDbRow)
      : undefined

    if (!created) {
      const existing = await executor
        .selectFrom("sessionWakeups")
        .selectAll()
        .where("sessionId", "=", params.sessionId)
        .where("sourceType", "=", params.sourceType)
        .where("sourceItemId", "=", params.sourceItemId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .execute()
      created = existing[0]
        ? normalizeSessionWakeupRow(existing[0] as SessionWakeupDbRow)
        : undefined
      reusedExistingWakeup = Boolean(created)
    }
  } else {
    const inserted = await executor
      .insertInto("sessionWakeups")
      .values({
        id: crypto.randomUUID(),
        sessionId: params.sessionId,
        sourceType: params.sourceType,
        sourceItemId: null,
        sourceSessionId: params.sourceSessionId || null,
        sourceParticipantType: params.sourceParticipantType || null,
        sourceParticipantId: params.sourceParticipantId || null,
        sourceName: params.sourceName || null,
        summary: params.summary,
        reasonText: params.reasonText || null,
        automationExecutionId: params.automationExecutionId || null,
        automationOccurrenceId: params.automationOccurrenceId || null,
        status: "pending",
        metadata: (params.metadata || {}) as SessionWakeupMetadataInsert,
      })
      .returningAll()
      .executeTakeFirst()
    created = inserted
      ? normalizeSessionWakeupRow(inserted as SessionWakeupDbRow)
      : undefined
  }
  if (!created) {
    throw new Error("Failed to enqueue session wakeup")
  }
  return { created, reusedExistingWakeup }
}

/** Default-db binding of {@link insertSessionWakeupRow} for the post-commit edge. */
export function insertSessionWakeupRowDefault(
  params: EnqueueSessionWakeupParams
): Promise<{
  created: SessionWakeupRow
  reusedExistingWakeup: boolean
}> {
  return insertSessionWakeupRow(db, params)
}

/** Flip a session's `pending` wakeups to `attached` on this turn (returns rows). */
export async function attachPendingWakeupsToTurnRows(
  sessionId: string,
  turnId: string,
  executor: Executor = db
): Promise<SessionWakeupRow[]> {
  const rows = await executor
    .updateTable("sessionWakeups")
    .set({
      status: "attached",
      turnId: turnId,
      attachedAt: sql`NOW()`,
    })
    .where("sessionId", "=", sessionId)
    .where("status", "=", "pending")
    .returningAll()
    .execute()

  return rows.map((row) => normalizeSessionWakeupRow(row as SessionWakeupDbRow))
}

/** Mark a turn's `attached` wakeups as `processed`. */
export async function markTurnWakeupsProcessed(
  turnId: string,
  executor: Executor = db
): Promise<void> {
  await executor
    .updateTable("sessionWakeups")
    .set({
      status: "processed",
      processedAt: sql`NOW()`,
    })
    .where("turnId", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

/** Mark a turn's `attached` wakeups as `dropped`. */
export async function markTurnWakeupsDropped(
  turnId: string,
  executor: Executor = db
): Promise<void> {
  await executor
    .updateTable("sessionWakeups")
    .set({
      status: "dropped",
      processedAt: sql`NOW()`,
    })
    .where("turnId", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

/** Reverse attach: flip a turn's `attached` wakeups back to `pending`. */
export async function restoreTurnWakeupsToPending(
  turnId: string,
  executor: Executor = db
): Promise<void> {
  await executor
    .updateTable("sessionWakeups")
    .set({
      status: "pending",
      turnId: null,
      attachedAt: null,
    })
    .where("turnId", "=", turnId)
    .where("status", "=", "attached")
    .execute()
}

/** Count of `pending` wakeups for a session. */
export async function getPendingWakeupCount(
  sessionId: string,
  executor: Executor = db
): Promise<number> {
  const row = await executor
    .selectFrom("sessionWakeups")
    .select(({ fn }) => fn.count<number>("id").as("count"))
    .where("sessionId", "=", sessionId)
    .where("status", "=", "pending")
    .executeTakeFirst()

  return Number(row?.count || 0)
}
