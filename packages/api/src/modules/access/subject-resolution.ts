import { SUBJECT_KIND } from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import type { PermissionSubject } from "./evaluator.js"
import { upsertAccessSubject } from "./subject-registry.js"

function dedupeSubjects(subjects: PermissionSubject[]) {
  const seen = new Set<string>()
  const deduped: PermissionSubject[] = []

  for (const subject of subjects) {
    const key = `${subject.type}:${subject.id}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(subject)
  }

  return deduped
}

async function loadConversationActorContextById(
  db: KyselyDb,
  contextId: string
) {
  return db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("id", "=", contextId)
    .limit(1)
    .executeTakeFirst()
}

// P0/P6: previously delegated to session/service.ts helpers which fall back to
// the global pool when no queryable is passed. Inline the queries so subject
// resolution honors the injected `db` (test-container DB, transaction client).
async function loadConversationActorContextByPair(
  db: KyselyDb,
  conversationId: string,
  actorId: string
) {
  return db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("conversation_id", "=", conversationId)
    .where("actor_id", "=", actorId)
    .limit(1)
    .executeTakeFirst()
}

async function loadConversationActorContextBySessionId(
  db: KyselyDb,
  sessionId: string
) {
  return db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("session_id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
}

export async function isActorActiveConversationParticipant(
  db: KyselyDb,
  conversationId: string,
  actorId: string
) {
  // P1b: filter by subject_id (the polymorphic actor_id column was dropped).
  const actorSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("participant_kind", "=", "actor")
    .where("subject_id", "=", actorSubjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function buildConversationCapabilitySubjects(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId?: string | null
    actorId?: string | null
    conversationId?: string | null
    sessionId?: string | null
    conversationActorContextId?: string | null
  }
) {
  if (params.actorId && params.conversationId) {
    const isActiveParticipant = await isActorActiveConversationParticipant(
      db,
      params.conversationId,
      params.actorId
    )
    if (!isActiveParticipant) {
      return [] as PermissionSubject[]
    }
  }

  const subjects: PermissionSubject[] = [
    {
      type: "workspace",
      id: params.workspaceId,
    },
  ]

  // P2 fix: include the workspace_member subject so that workspace_member-scoped
  // bindings written by `grantApprovedAccess` actually surface in lookups /
  // visibility queries. Without this, an approved member would never see the
  // actor/skill/plugin they were granted access to.
  if (params.workspaceMemberId) {
    subjects.push({
      type: "workspace_member",
      id: params.workspaceMemberId,
    })
  }

  if (params.actorId) {
    subjects.push({
      type: "actor",
      id: params.actorId,
    })
  }

  let contextId = params.conversationActorContextId?.trim() || null
  let context:
    | {
        id: string
        actor_id: string
        conversation_id: string
        session_id: string | null
      }
    | undefined

  if (contextId) {
    context =
      (await loadConversationActorContextById(db, contextId)) || undefined
  }

  if (!context && params.actorId && params.conversationId) {
    context =
      (await loadConversationActorContextByPair(
        db,
        params.conversationId,
        params.actorId
      )) || undefined
  }

  if (!context && params.sessionId) {
    context =
      (await loadConversationActorContextBySessionId(db, params.sessionId)) ||
      undefined
  }

  if (
    context &&
    (!params.actorId || context.actor_id === params.actorId) &&
    (!params.conversationId ||
      context.conversation_id === params.conversationId) &&
    (await isActorActiveConversationParticipant(
      db,
      context.conversation_id,
      context.actor_id
    ))
  ) {
    subjects.push({
      type: "conversation_actor_context",
      id: context.id,
    })
  }

  return dedupeSubjects(subjects)
}
