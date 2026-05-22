import { db } from "../../infrastructure/database/kysely.js"
import type { PermissionSubject } from "./core.js"
import {
  getConversationActorContextByPair,
  getConversationActorContextBySessionId,
} from "../session/service.js"

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

async function loadConversationActorContextById(contextId: string) {
  return db
    .selectFrom("conversation_actor_contexts")
    .select(["id", "actor_id", "conversation_id", "session_id"])
    .where("id", "=", contextId)
    .limit(1)
    .executeTakeFirst()
}

export async function isActorActiveConversationParticipant(
  conversationId: string,
  actorId: string
) {
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("participant_kind", "=", "actor")
    .where("actor_id", "=", actorId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function isRemoteAgentActiveConversationParticipant(
  conversationId: string,
  remoteAgentId: string
) {
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("participant_kind", "=", "remote_agent")
    .where("remote_agent_id", "=", remoteAgentId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function buildConversationCapabilitySubjects(params: {
  workspaceId: string
  actorId?: string | null
  remoteAgentId?: string | null
  conversationId?: string | null
  sessionId?: string | null
  conversationActorContextId?: string | null
}) {
  if (params.actorId && params.conversationId) {
    const isActiveParticipant = await isActorActiveConversationParticipant(
      params.conversationId,
      params.actorId
    )
    if (!isActiveParticipant) {
      return [] as PermissionSubject[]
    }
  }

  // Remote agents have no actor identity; the only "actor-like" check we can
  // do is conversation participation as a remote_agent. If the caller passed
  // a remote_agent + conversation pair, refuse to grant access unless that
  // remote_agent is actively participating — same fail-closed behavior as the
  // actor path above.
  if (params.remoteAgentId && params.conversationId && !params.actorId) {
    const isActiveParticipant =
      await isRemoteAgentActiveConversationParticipant(
        params.conversationId,
        params.remoteAgentId
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
    context = (await loadConversationActorContextById(contextId)) || undefined
  }

  if (!context && params.actorId && params.conversationId) {
    context =
      (await getConversationActorContextByPair(
        params.conversationId,
        params.actorId
      )) || undefined
  }

  if (!context && params.sessionId) {
    context =
      (await getConversationActorContextBySessionId(params.sessionId)) ||
      undefined
  }

  if (
    context &&
    (!params.actorId || context.actor_id === params.actorId) &&
    (!params.conversationId ||
      context.conversation_id === params.conversationId) &&
    (await isActorActiveConversationParticipant(
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
