import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
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
    .where("participant_type", "=", "actor")
    .where("subject_id", "=", actorSubjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function isRemoteAgentActiveConversationParticipant(
  db: KyselyDb,
  conversationId: string,
  remoteAgentId: string
) {
  const remoteAgentSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.REMOTE_AGENT,
    remoteAgentId,
  })
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("participant_type", "=", "remote_agent")
    .where("subject_id", "=", remoteAgentSubjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * PR2: generic active-participant check, replacing the kind-specific
 * `isActorActiveConversationParticipant` / `isRemoteAgentActiveConversationParticipant`
 * helpers. Works for any participant kind backed by `conversation_participants.subject_id`
 * — actor / remote_agent / workspace_member / external / system. Used by:
 *   - `buildRuntimePrincipalContext` (PR2) to decide whether to add the
 *     conversation subject_id to `runtimeScopeSubjectIds`.
 *   - `hasConversationPermission` (PR3) to evaluate `subject=conversation`
 *     grants without re-implementing the membership check per principal kind.
 */
export async function isSubjectActiveConversationParticipant(
  db: KyselyDb,
  conversationId: string,
  subjectId: string
): Promise<boolean> {
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("subject_id", "=", subjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * PR2: structured runtime principal context expressed in subject_id terms.
 *
 * `runtimeSubjectIds` is the set of access_subjects.id values that, treated
 * as a grant subject, the principal can claim under right now. It always
 * contains the principal's own subject_id, the current workspace subject_id,
 * the conversation subject_id (if the principal is an active participant),
 * and — *only* if the caller explicitly passes `delegatedWorkspaceMemberId`
 * AND the row belongs to the current workspace — the workspace_member
 * subject_id.
 *
 * Critical security property: `runtimeSubjectIds` MUST NOT auto-include the
 * `actors.created_by_workspace_member_id` / `remote_agents.created_by_workspace_member_id`
 * — that would let an actor inherit its creator's `subject=workspace_member`
 * grants (including user_private memory). Delegation is an explicit-act-on-behalf
 * contract, surfaced via `delegatedWorkspaceMemberId`.
 *
 * `runtimeScopeSubjectIds` is the subset used as the right-hand side of a
 * `scope_subject_id` match: the current workspace subject_id, plus the
 * conversation subject_id when the principal is an active participant.
 */
export type RuntimePrincipalContext = {
  principal: SubjectRef
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  runtimeConversationId?: string
}

export async function buildRuntimePrincipalContext(
  db: KyselyDb,
  params: {
    principal: SubjectRef
    workspaceId: string
    conversationId?: string | null
    /**
     * Explicit delegation: "this request acts on behalf of the named
     * workspace_member". Builder validates that the member exists AND belongs
     * to `workspaceId`; throws otherwise. Callers MUST set this only when
     * they are confident the delegation matches the authenticated user.
     */
    delegatedWorkspaceMemberId?: string | null
  }
): Promise<RuntimePrincipalContext> {
  const runtimeSubjectIds: string[] = []
  const runtimeScopeSubjectIds: string[] = []

  const principalSubjectId = await upsertAccessSubject(db, params.principal)
  runtimeSubjectIds.push(principalSubjectId)

  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  runtimeSubjectIds.push(workspaceSubjectId)
  runtimeScopeSubjectIds.push(workspaceSubjectId)

  if (params.conversationId) {
    const isActive = await isSubjectActiveConversationParticipant(
      db,
      params.conversationId,
      principalSubjectId
    )
    if (isActive) {
      const convSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
      runtimeSubjectIds.push(convSubjectId)
      runtimeScopeSubjectIds.push(convSubjectId)
    }
  }

  if (params.delegatedWorkspaceMemberId) {
    const member = await db
      .selectFrom("workspace_members")
      .select(["id", "workspace_id"])
      .where("id", "=", params.delegatedWorkspaceMemberId)
      .limit(1)
      .executeTakeFirst()
    if (!member) {
      throw new Error(
        `delegatedWorkspaceMemberId ${params.delegatedWorkspaceMemberId} not found`
      )
    }
    if (member.workspace_id !== params.workspaceId) {
      throw new Error(
        `delegatedWorkspaceMemberId ${params.delegatedWorkspaceMemberId} belongs to workspace ${member.workspace_id}, not ${params.workspaceId}`
      )
    }
    const memberSubjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.delegatedWorkspaceMemberId,
    })
    runtimeSubjectIds.push(memberSubjectId)
  }

  return {
    principal: params.principal,
    runtimeSubjectIds: Array.from(new Set(runtimeSubjectIds)),
    runtimeScopeSubjectIds: Array.from(new Set(runtimeScopeSubjectIds)),
    runtimeConversationId: params.conversationId ?? undefined,
  }
}

export async function buildConversationCapabilitySubjects(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId?: string | null
    actorId?: string | null
    remoteAgentId?: string | null
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

  // Remote agents have no actor identity; the only "actor-like" check we can
  // do is conversation participation as a remote_agent. If the caller passed
  // a remote_agent + conversation pair, refuse to grant access unless that
  // remote_agent is actively participating — same fail-closed behavior as the
  // actor path above.
  if (params.remoteAgentId && params.conversationId && !params.actorId) {
    const isActiveParticipant =
      await isRemoteAgentActiveConversationParticipant(
        db,
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

  // The session→context fallback only makes sense for the actor path:
  // conversation_actor_context.session_id is a UUID column and the row only
  // exists for human actors. Remote agents have no actor identity and no
  // matching context row, so calling this lookup with the synthetic cache key
  // we use for reverse-MCP sessions ("remote_agent_mcp:…") would crash the
  // SQL driver and silently mask plugin/relay tool resolution. Gating on
  // actorId keeps the actor flow unchanged while making the remote-agent
  // flow correct-by-construction.
  if (!context && params.actorId && params.sessionId) {
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
