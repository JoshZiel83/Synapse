/**
 * `access_subjects` registry — the regalized polymorphic-subject table that
 * replaces the historical pattern of "kind + N nullable FK columns" duplicated
 * across 10+ tables.
 *
 * `upsertAccessSubject` is the canonical entry point for *writes*: callers
 * pass a `SubjectRef` and receive a stable `subjectId` to embed in their own
 * table. Partial-unique indexes guarantee that the same logical subject (one
 * actor, one member, etc.) reuses the same row.
 *
 * `loadAccessSubject` and `loadAccessSubjectMany` are the *read* counterparts
 * used by binding-storage and the evaluator to reconstruct a SubjectRef from
 * a stored `subject_id`.
 */

import { sql } from "kysely"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import type {
  KyselyDb,
  QueryExecutor,
  TableRow,
} from "../../infrastructure/database/kysely.js"
import { executeSqlOn } from "../../infrastructure/database/kysely.js"

export type AccessSubjectRow = TableRow<"access_subjects">

const SYSTEM_EXTERNAL_KEY = "__synapse_system__"

function subjectColumns(ref: SubjectRef): {
  kind: AccessSubjectRow["kind"]
  workspace_id: string | null
  workspace_member_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  conversation_id: string | null
  conversation_actor_context_id: string | null
  user_id: string | null
  external_identity_key: string | null
} {
  const base = {
    workspace_id: null,
    workspace_member_id: null,
    actor_id: null,
    remote_agent_id: null,
    conversation_id: null,
    conversation_actor_context_id: null,
    user_id: null,
    external_identity_key: null,
  }
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return { ...base, kind: "workspace", workspace_id: ref.workspaceId }
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      // workspace_id is auto-populated from workspace_members at insert time
      // by upsertAccessSubject's SELECT subquery; callers don't pass it.
      return {
        ...base,
        kind: "workspace_member",
        workspace_member_id: ref.memberId,
      }
    case SUBJECT_KIND.ACTOR:
      return { ...base, kind: "actor", actor_id: ref.actorId }
    case SUBJECT_KIND.REMOTE_AGENT:
      return {
        ...base,
        kind: "remote_agent",
        remote_agent_id: ref.remoteAgentId,
      }
    case SUBJECT_KIND.CONVERSATION:
      return {
        ...base,
        kind: "conversation",
        conversation_id: ref.conversationId,
      }
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      return {
        ...base,
        kind: "conversation_actor_context",
        conversation_actor_context_id: ref.contextId,
      }
    case SUBJECT_KIND.USER:
      return { ...base, kind: "user", user_id: ref.userId }
    case SUBJECT_KIND.EXTERNAL:
      return {
        ...base,
        kind: "external",
        external_identity_key: ref.externalIdentityKey,
      }
    case SUBJECT_KIND.SYSTEM:
      return { ...base, kind: "system" }
  }
}

/**
 * For workspace-scoped kinds, look up the owning workspace_id from the
 * underlying entity table. Returns null for platform-wide kinds (user,
 * external, system) and for the workspace kind itself (where workspace_id is
 * carried by the ref). Required by `chk_access_subjects_payload` which insists
 * workspace-scoped subjects know their workspace.
 */
async function resolveOwningWorkspaceId(
  db: KyselyDb,
  ref: SubjectRef
): Promise<string | null> {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return ref.workspaceId
    case SUBJECT_KIND.WORKSPACE_MEMBER: {
      const row = await db
        .selectFrom("workspace_members")
        .select("workspace_id")
        .where("id", "=", ref.memberId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: workspace_members(${ref.memberId}) not found`
        )
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.ACTOR: {
      const row = await db
        .selectFrom("actors")
        .select("workspace_id")
        .where("id", "=", ref.actorId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(`upsertAccessSubject: actors(${ref.actorId}) not found`)
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.REMOTE_AGENT: {
      const row = await db
        .selectFrom("remote_agents")
        .select("workspace_id")
        .where("id", "=", ref.remoteAgentId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: remote_agents(${ref.remoteAgentId}) not found`
        )
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.CONVERSATION: {
      // Conversations are either internal (workspace-scoped via
      // internal_workspace_id) or external (no workspace). External
      // conversations are platform-wide subjects.
      const row = await db
        .selectFrom("conversations")
        .select("internal_workspace_id")
        .where("id", "=", ref.conversationId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: conversations(${ref.conversationId}) not found`
        )
      }
      return row.internal_workspace_id
    }
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT: {
      const row = await db
        .selectFrom("conversation_actor_contexts as cac")
        .innerJoin("conversations as c", "c.id", "cac.conversation_id")
        .select("c.internal_workspace_id")
        .where("cac.id", "=", ref.contextId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: conversation_actor_contexts(${ref.contextId}) not found`
        )
      }
      return row.internal_workspace_id
    }
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.SYSTEM:
      return null
  }
}

export function rowToSubjectRef(row: AccessSubjectRow): SubjectRef {
  switch (row.kind) {
    case "workspace":
      return { kind: SUBJECT_KIND.WORKSPACE, workspaceId: row.workspace_id! }
    case "workspace_member":
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: row.workspace_member_id!,
      }
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: row.actor_id! }
    case "remote_agent":
      return {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: row.remote_agent_id!,
      }
    case "conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: row.conversation_id!,
      }
    case "conversation_actor_context":
      return {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: row.conversation_actor_context_id!,
      }
    case "user":
      return { kind: SUBJECT_KIND.USER, userId: row.user_id! }
    case "external":
      return {
        kind: SUBJECT_KIND.EXTERNAL,
        externalIdentityKey: row.external_identity_key!,
      }
    case "system":
      return { kind: SUBJECT_KIND.SYSTEM }
  }
}

/**
 * Atomically returns the id of the access_subjects row representing `ref`,
 * inserting a new row only if no matching one exists. Safe to call inside
 * transactions and tolerant of concurrent racing inserts on the same logical
 * subject — the partial-unique indexes on access_subjects guarantee uniqueness.
 */
export async function upsertAccessSubject(
  db: KyselyDb,
  ref: SubjectRef
): Promise<string> {
  const columns = subjectColumns(ref)

  // Try fast-path: select the matching row first.
  let lookup = db
    .selectFrom("access_subjects")
    .select("id")
    .where("kind", "=", columns.kind)
    .limit(1)

  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      lookup = lookup.where("workspace_id", "=", ref.workspaceId)
      break
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      lookup = lookup.where("workspace_member_id", "=", ref.memberId)
      break
    case SUBJECT_KIND.ACTOR:
      lookup = lookup.where("actor_id", "=", ref.actorId)
      break
    case SUBJECT_KIND.REMOTE_AGENT:
      lookup = lookup.where("remote_agent_id", "=", ref.remoteAgentId)
      break
    case SUBJECT_KIND.CONVERSATION:
      lookup = lookup.where("conversation_id", "=", ref.conversationId)
      break
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      lookup = lookup.where("conversation_actor_context_id", "=", ref.contextId)
      break
    case SUBJECT_KIND.USER:
      lookup = lookup.where("user_id", "=", ref.userId)
      break
    case SUBJECT_KIND.EXTERNAL:
      lookup = lookup.where(
        "external_identity_key",
        "=",
        ref.externalIdentityKey
      )
      break
    case SUBJECT_KIND.SYSTEM:
      // System subject is a singleton — the partial-unique index on
      // (kind='system') guarantees at most one row.
      break
  }

  const existing = await lookup.executeTakeFirst()
  if (existing) {
    return existing.id
  }

  // Insert with ON CONFLICT DO NOTHING to handle the race where two callers
  // try to upsert the same subject simultaneously. Workspace-scoped kinds
  // populate workspace_id from the underlying entity table so the
  // `chk_access_subjects_payload` constraint is satisfied.
  const ownerWorkspaceId = await resolveOwningWorkspaceId(db, ref)
  const valuesWithWorkspace = {
    ...columns,
    workspace_id: columns.workspace_id ?? ownerWorkspaceId,
  }
  const inserted = await db
    .insertInto("access_subjects")
    .values(valuesWithWorkspace)
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst()
  if (inserted) {
    return inserted.id
  }

  // Lost the race — re-read.
  const after = await lookup.executeTakeFirstOrThrow()
  return after.id
}

export async function loadAccessSubject(
  db: KyselyDb,
  subjectId: string
): Promise<SubjectRef | null> {
  const row = await db
    .selectFrom("access_subjects")
    .selectAll()
    .where("id", "=", subjectId)
    .executeTakeFirst()
  return row ? rowToSubjectRef(row) : null
}

export async function loadAccessSubjectMany(
  db: KyselyDb,
  subjectIds: readonly string[]
): Promise<Map<string, SubjectRef>> {
  if (subjectIds.length === 0) return new Map()
  const rows = await db
    .selectFrom("access_subjects")
    .selectAll()
    .where("id", "in", [...subjectIds])
    .execute()
  const result = new Map<string, SubjectRef>()
  for (const row of rows) {
    result.set(row.id, rowToSubjectRef(row))
  }
  return result
}

/**
 * Lookup the subject id for `ref` without inserting. Returns null if no
 * matching row exists yet — used by queries that want to filter by an
 * existing subject without committing a write.
 */
export async function findAccessSubjectId(
  db: KyselyDb,
  ref: SubjectRef
): Promise<string | null> {
  // Avoid SELECT cost by using the partial-unique index lookups.
  // This duplicates the WHERE clause logic from upsertAccessSubject; consider
  // collapsing them if a third reader appears.
  let lookup = db
    .selectFrom("access_subjects")
    .select("id")
    .where("kind", "=", subjectColumns(ref).kind)
    .limit(1)
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      lookup = lookup.where("workspace_id", "=", ref.workspaceId)
      break
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      lookup = lookup.where("workspace_member_id", "=", ref.memberId)
      break
    case SUBJECT_KIND.ACTOR:
      lookup = lookup.where("actor_id", "=", ref.actorId)
      break
    case SUBJECT_KIND.REMOTE_AGENT:
      lookup = lookup.where("remote_agent_id", "=", ref.remoteAgentId)
      break
    case SUBJECT_KIND.CONVERSATION:
      lookup = lookup.where("conversation_id", "=", ref.conversationId)
      break
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      lookup = lookup.where("conversation_actor_context_id", "=", ref.contextId)
      break
    case SUBJECT_KIND.USER:
      lookup = lookup.where("user_id", "=", ref.userId)
      break
    case SUBJECT_KIND.EXTERNAL:
      lookup = lookup.where(
        "external_identity_key",
        "=",
        ref.externalIdentityKey
      )
      break
    case SUBJECT_KIND.SYSTEM:
      break
  }
  const row = await lookup.executeTakeFirst()
  return row?.id ?? null
}

/**
 * Queryable-based variant of `findAccessSubjectId`. Use inside
 * `transaction(async client => ...)` blocks so the lookup runs on the same
 * connection as the surrounding writes — `findAccessSubjectId` requires a
 * `KyselyDb` and crashes at runtime when called with a raw `PoolClient`.
 */
export async function findAccessSubjectIdOn(
  client: QueryExecutor,
  ref: SubjectRef
): Promise<string | null> {
  const columns = subjectColumnsRaw(ref)
  const where = whereClauseFor(ref)
  const result = await executeSqlOn<{ id: string }>(
    client,
    `SELECT id FROM access_subjects WHERE kind = $1 AND ${where.condition} LIMIT 1`,
    [columns.kind, ...where.values]
  )
  return result.rows[0]?.id ?? null
}

/**
 * Queryable-based upsert (`pg.PoolClient` compatible). Use this from inside
 * `transaction(async client => ...)` blocks so the subject upsert commits or
 * rolls back atomically with the binding insert that consumes the returned id.
 */
export async function upsertAccessSubjectOn(
  client: QueryExecutor,
  ref: SubjectRef
): Promise<string> {
  const columns = subjectColumnsRaw(ref)
  const where = whereClauseFor(ref)
  const lookupResult = await executeSqlOn<{ id: string }>(
    client,
    `SELECT id FROM access_subjects WHERE kind = $1 AND ${where.condition} LIMIT 1`,
    [columns.kind, ...where.values]
  )
  if (lookupResult.rows[0]) return lookupResult.rows[0].id

  // Resolve workspace_id from the underlying entity table for workspace-scoped
  // kinds — required by chk_access_subjects_payload.
  const ownerWorkspaceId = await resolveOwningWorkspaceIdOn(client, ref)
  const workspaceId = columns.workspace_id ?? ownerWorkspaceId

  const insertResult = await executeSqlOn<{ id: string }>(
    client,
    `INSERT INTO access_subjects (
       kind, workspace_id, workspace_member_id, actor_id,
       remote_agent_id, conversation_id, conversation_actor_context_id,
       user_id, external_identity_key
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      columns.kind,
      workspaceId,
      columns.workspace_member_id,
      columns.actor_id,
      columns.remote_agent_id,
      columns.conversation_id,
      columns.conversation_actor_context_id,
      columns.user_id,
      columns.external_identity_key,
    ]
  )
  if (insertResult.rows[0]) return insertResult.rows[0].id

  const recheck = await executeSqlOn<{ id: string }>(
    client,
    `SELECT id FROM access_subjects WHERE kind = $1 AND ${where.condition} LIMIT 1`,
    [columns.kind, ...where.values]
  )
  if (!recheck.rows[0]) {
    throw new Error("access_subjects upsert race could not be resolved")
  }
  return recheck.rows[0].id
}

async function resolveOwningWorkspaceIdOn(
  client: QueryExecutor,
  ref: SubjectRef
): Promise<string | null> {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return ref.workspaceId
    case SUBJECT_KIND.WORKSPACE_MEMBER: {
      const r = await executeSqlOn<{ workspace_id: string }>(
        client,
        `SELECT workspace_id FROM workspace_members WHERE id = $1`,
        [ref.memberId]
      )
      if (!r.rows[0]) {
        throw new Error(
          `upsertAccessSubjectOn: workspace_members(${ref.memberId}) not found`
        )
      }
      return r.rows[0].workspace_id
    }
    case SUBJECT_KIND.ACTOR: {
      const r = await executeSqlOn<{ workspace_id: string }>(
        client,
        `SELECT workspace_id FROM actors WHERE id = $1`,
        [ref.actorId]
      )
      if (!r.rows[0]) {
        throw new Error(
          `upsertAccessSubjectOn: actors(${ref.actorId}) not found`
        )
      }
      return r.rows[0].workspace_id
    }
    case SUBJECT_KIND.REMOTE_AGENT: {
      const r = await executeSqlOn<{ workspace_id: string }>(
        client,
        `SELECT workspace_id FROM remote_agents WHERE id = $1`,
        [ref.remoteAgentId]
      )
      if (!r.rows[0]) {
        throw new Error(
          `upsertAccessSubjectOn: remote_agents(${ref.remoteAgentId}) not found`
        )
      }
      return r.rows[0].workspace_id
    }
    case SUBJECT_KIND.CONVERSATION: {
      const r = await executeSqlOn<{ internal_workspace_id: string | null }>(
        client,
        `SELECT internal_workspace_id FROM conversations WHERE id = $1`,
        [ref.conversationId]
      )
      if (!r.rows[0]) {
        throw new Error(
          `upsertAccessSubjectOn: conversations(${ref.conversationId}) not found`
        )
      }
      return r.rows[0].internal_workspace_id
    }
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT: {
      const r = await executeSqlOn<{ internal_workspace_id: string | null }>(
        client,
        `SELECT c.internal_workspace_id
         FROM conversation_actor_contexts cac
         JOIN conversations c ON c.id = cac.conversation_id
         WHERE cac.id = $1`,
        [ref.contextId]
      )
      if (!r.rows[0]) {
        throw new Error(
          `upsertAccessSubjectOn: conversation_actor_contexts(${ref.contextId}) not found`
        )
      }
      return r.rows[0].internal_workspace_id
    }
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.SYSTEM:
      return null
  }
}

function subjectColumnsRaw(ref: SubjectRef) {
  return subjectColumns(ref)
}

function whereClauseFor(ref: SubjectRef): {
  condition: string
  values: unknown[]
} {
  switch (ref.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return { condition: "workspace_id = $2", values: [ref.workspaceId] }
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return {
        condition: "workspace_member_id = $2",
        values: [ref.memberId],
      }
    case SUBJECT_KIND.ACTOR:
      return { condition: "actor_id = $2", values: [ref.actorId] }
    case SUBJECT_KIND.REMOTE_AGENT:
      return {
        condition: "remote_agent_id = $2",
        values: [ref.remoteAgentId],
      }
    case SUBJECT_KIND.CONVERSATION:
      return {
        condition: "conversation_id = $2",
        values: [ref.conversationId],
      }
    case SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT:
      return {
        condition: "conversation_actor_context_id = $2",
        values: [ref.contextId],
      }
    case SUBJECT_KIND.USER:
      return { condition: "user_id = $2", values: [ref.userId] }
    case SUBJECT_KIND.EXTERNAL:
      return {
        condition: "external_identity_key = $2",
        values: [ref.externalIdentityKey],
      }
    case SUBJECT_KIND.SYSTEM:
      return { condition: "TRUE", values: [] }
  }
}
