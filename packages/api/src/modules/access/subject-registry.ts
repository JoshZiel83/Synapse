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

import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import type {
  Executor,
  KyselyDb,
  TableRow,
} from "../../infrastructure/database/kysely.js"

export type AccessSubjectRow = TableRow<"access_subjects">

/**
 * Maps an access_subjects.kind to the conversation participant_type semantic.
 * Only the four participant-eligible kinds are valid; anything else is a
 * programming/data error (the DB trigger tg_conversation_participant_validate
 * enforces the same invariant). Used by the chat DB→API mapper now that the
 * `conversation_participants.participant_type` column is derived from the joined
 * subject kind rather than stored.
 */
export function subjectKindToParticipantType(
  kind: AccessSubjectRow["kind"]
): "workspace_member" | "actor" | "remote_agent" | "external" {
  switch (kind) {
    case "workspace_member":
    case "actor":
    case "remote_agent":
    case "external":
      return kind
    default:
      throw new Error(
        `subjectKindToParticipantType: kind '${kind}' cannot be a conversation participant`
      )
  }
}

function subjectColumns(ref: SubjectRef): {
  kind: AccessSubjectRow["kind"]
  workspace_id: string | null
  workspace_member_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  conversation_id: string | null
  user_id: string | null
  transport_address_id: string | null
} {
  const base = {
    workspace_id: null,
    workspace_member_id: null,
    actor_id: null,
    remote_agent_id: null,
    conversation_id: null,
    user_id: null,
    transport_address_id: null,
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
    case SUBJECT_KIND.USER:
      return { ...base, kind: "user", user_id: ref.userId }
    case SUBJECT_KIND.EXTERNAL:
      // external is workspace-rooted and identified by its transport_address.
      // workspace_id is carried on the ref (validated against the address by the
      // composite FK), so unlike other workspace-bound kinds it is set here.
      return {
        ...base,
        kind: "external",
        workspace_id: ref.workspaceId,
        transport_address_id: ref.transportAddressId,
      }
    case SUBJECT_KIND.PLATFORM:
      return { ...base, kind: "platform" }
  }
}

/**
 * For workspace-scoped kinds, look up the owning workspace_id from the
 * underlying entity table. external carries workspace_id on the ref; user /
 * platform are platform-wide and return null; workspace carries its own id.
 * Required by `chk_access_subjects_payload` which insists workspace-scoped
 * subjects know their workspace.
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
        .selectFrom("actors as actor")
        .innerJoin("workspace_apps as app", "app.id", "actor.id")
        .select("app.workspace_id")
        .where("actor.id", "=", ref.actorId)
        .where("app.deleted_at", "is", null)
        .executeTakeFirst()
      if (!row) {
        throw new Error(`upsertAccessSubject: actors(${ref.actorId}) not found`)
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.REMOTE_AGENT: {
      const row = await db
        .selectFrom("remote_agents as agent")
        .innerJoin("workspace_apps as app", "app.id", "agent.id")
        .select("app.workspace_id")
        .where("agent.id", "=", ref.remoteAgentId)
        .where("app.deleted_at", "is", null)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: remote_agents(${ref.remoteAgentId}) not found`
        )
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.CONVERSATION: {
      // Every conversation is workspace-scoped (conversations.workspace_id is
      // NOT NULL); IM-ness is derived from a transport binding, not a boundary
      // axis. Read the workspace directly — no creator-member fallback.
      const row = await db
        .selectFrom("conversations as c")
        .select("c.workspace_id as workspace_id")
        .where("c.id", "=", ref.conversationId)
        .executeTakeFirst()
      if (!row) {
        throw new Error(
          `upsertAccessSubject: conversations(${ref.conversationId}) not found`
        )
      }
      return row.workspace_id
    }
    case SUBJECT_KIND.EXTERNAL:
      // external carries its workspace_id on the ref; the composite FK ensures
      // it matches the transport_address's workspace.
      return ref.workspaceId
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.PLATFORM:
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
    case "user":
      return { kind: SUBJECT_KIND.USER, userId: row.user_id! }
    case "external":
      return {
        kind: SUBJECT_KIND.EXTERNAL,
        workspaceId: row.workspace_id!,
        transportAddressId: row.transport_address_id!,
      }
    case "platform":
      return { kind: SUBJECT_KIND.PLATFORM }
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
    case SUBJECT_KIND.USER:
      lookup = lookup.where("user_id", "=", ref.userId)
      break
    case SUBJECT_KIND.EXTERNAL:
      // P2#4: match on transport_address_id AND workspace_id so a ref carrying
      // the wrong workspace can never resolve to another workspace's subject.
      lookup = lookup
        .where("transport_address_id", "=", ref.transportAddressId)
        .where("workspace_id", "=", ref.workspaceId)
      break
    case SUBJECT_KIND.PLATFORM:
      // Platform subject is a singleton — the partial-unique index on
      // (kind='platform') guarantees at most one row.
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

/**
 * subject-scope-refactor: pg-form variant of loadAccessSubject. Reads the
 * access_subjects row over the supplied transactional client so the result
 * reflects writes made earlier in the same transaction (and approval-time
 * reads stay on a single connection, matching the "all approval consistency
 * checks happen on the same pg client" plan).
 */
export async function loadAccessSubjectOn(
  executor: Executor,
  subjectId: string
): Promise<SubjectRef | null> {
  return loadAccessSubject(executor, subjectId)
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
    case SUBJECT_KIND.USER:
      lookup = lookup.where("user_id", "=", ref.userId)
      break
    case SUBJECT_KIND.EXTERNAL:
      lookup = lookup
        .where("transport_address_id", "=", ref.transportAddressId)
        .where("workspace_id", "=", ref.workspaceId)
      break
    case SUBJECT_KIND.PLATFORM:
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
  executor: Executor,
  ref: SubjectRef
): Promise<string | null> {
  return findAccessSubjectId(executor, ref)
}

/**
 * Executor-based upsert. Use inside `withDbTransaction(async (trx) => ...)` so
 * the subject upsert commits/rolls back atomically with the binding insert that
 * consumes the returned id. Delegates to {@link upsertAccessSubject}
 * (Transaction<Database> is a Kysely<Database>).
 */
export async function upsertAccessSubjectOn(
  executor: Executor,
  ref: SubjectRef
): Promise<string> {
  return upsertAccessSubject(executor, ref)
}

/**
 * subject-scope-refactor: Kysely-transaction variant of upsertAccessSubject.
 * Accepts DatabaseTransaction so callers in atomic claim / approval paths
 * commit the subject upsert + grant insert in the same transaction. Since
 * `Transaction<Database>` is assignable to `Kysely<Database>` structurally,
 * this just delegates — kept as a named export to make intent explicit at
 * call sites and to mirror the `upsertAccessSubjectOn(executor: Executor)`
 * pg-form helper.
 */
export async function upsertAccessSubjectOnTrx(
  trx: import("../../infrastructure/database/kysely.js").DatabaseTransaction,
  ref: SubjectRef
): Promise<string> {
  return upsertAccessSubject(trx as unknown as KyselyDb, ref)
}
