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

/**
 * PR5 fix: principal-belongs-to-workspace guard for buildRuntimePrincipalContext.
 *
 * For workspace-bound principals (actor / remote_agent / workspace_member),
 * the named principal MUST be in the named workspace before we mint runtime
 * subject_ids in its name — otherwise a caller could ask for runtime
 * context against any workspace and get back a set that legitimately
 * matches `subject=workspace W` grants in W.
 *
 * `workspace` principals are accepted iff the principal IS the workspace.
 * `user` / `external` / `system` principals are platform-wide and have no
 * single workspace to validate against — we accept them here and rely on
 * the per-resource permission helpers to refuse them as appropriate.
 */
async function assertPrincipalBelongsToWorkspace(
  db: KyselyDb,
  principal: SubjectRef,
  workspaceId: string
): Promise<void> {
  switch (principal.kind) {
    case SUBJECT_KIND.WORKSPACE:
      if (principal.workspaceId !== workspaceId) {
        throw new Error(
          `principal workspace ${principal.workspaceId} does not match runtime workspace ${workspaceId}`
        )
      }
      return
    case SUBJECT_KIND.WORKSPACE_MEMBER: {
      const row = await db
        .selectFrom("workspace_members")
        .select(["id", "workspace_id"])
        .where("id", "=", principal.memberId)
        .limit(1)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        throw new Error(
          `workspace_member ${principal.memberId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.ACTOR: {
      const row = await db
        .selectFrom("actors")
        .select(["id", "workspace_id"])
        .where("id", "=", principal.actorId)
        .limit(1)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        throw new Error(
          `actor ${principal.actorId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.REMOTE_AGENT: {
      const row = await db
        .selectFrom("remote_agents")
        .select(["id", "workspace_id"])
        .where("id", "=", principal.remoteAgentId)
        .limit(1)
        .executeTakeFirst()
      if (!row || row.workspace_id !== workspaceId) {
        throw new Error(
          `remote_agent ${principal.remoteAgentId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.CONVERSATION:
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.SYSTEM:
      // No single-workspace identity; accept and let per-resource helpers
      // refuse if appropriate.
      return
  }
}

/**
 * PR-fix-round-2: which principal kinds are validated to belong to the
 * runtime workspace by `assertPrincipalBelongsToWorkspace`. Only these
 * earn the workspace subject_id in `runtimeSubjectIds` /
 * `runtimeScopeSubjectIds`. Platform-wide kinds (user/external/system)
 * and conversation principals are accepted as the principal itself but
 * MUST NOT auto-collect workspace subject — otherwise a user principal
 * could mint runtime context against any workspace and silently match
 * `subject=workspace W` grants.
 */
function isPrincipalWorkspaceBound(principal: SubjectRef): boolean {
  switch (principal.kind) {
    case SUBJECT_KIND.WORKSPACE:
    case SUBJECT_KIND.WORKSPACE_MEMBER:
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
      return true
    case SUBJECT_KIND.CONVERSATION:
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.SYSTEM:
      return false
  }
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

  // PR5 fix: verify the principal actually belongs to the named workspace
  // before minting workspace subject_ids in their name. Without this check,
  // a caller could ask the builder for context against any workspace and
  // get back a runtime set that legitimately matches `subject=workspace W`
  // grants in W — an authorization-expansion bug if the builder is ever
  // wired to request-path code.
  //
  // PR-fix-round-2: assertPrincipalBelongsToWorkspace verifies the
  // principal is in the workspace for workspace-bound kinds, but it
  // intentionally accepts user/external/system/conversation (no single
  // workspace identity). To prevent THOSE platform-wide principals from
  // automatically picking up `subject=workspace W` grants, we only mint
  // the workspace subject for principals that were positively verified
  // as belonging to the workspace.
  await assertPrincipalBelongsToWorkspace(
    db,
    params.principal,
    params.workspaceId
  )

  const principalSubjectId = await upsertAccessSubject(db, params.principal)
  runtimeSubjectIds.push(principalSubjectId)

  const principalIsWorkspaceBound = isPrincipalWorkspaceBound(params.principal)
  if (principalIsWorkspaceBound) {
    const workspaceSubjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: params.workspaceId,
    })
    runtimeSubjectIds.push(workspaceSubjectId)
    runtimeScopeSubjectIds.push(workspaceSubjectId)
  }

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

/**
 * PR-fix-round-4: companion to `buildConversationCapabilitySubjects`.
 * Returns the access_subjects.id set used as the right-hand side of a
 * scope_subject_id match — i.e. which subjects represent the runtime
 * group context the principal is currently inside. Used by skill /
 * plugin / relay visibility listings to pass `runtimeScopeSubjectIds`
 * to `lookupResources` and `listGrantedResourceIds` so a scoped grant
 * (subject=actor + scope=conversation) is actually visible in tool /
 * skill / plugin enumeration.
 *
 * The function mirrors the gating in `buildConversationCapabilitySubjects`:
 * the conversation subject is included only when the principal
 * (actor / remote_agent / workspace_member) is an active participant of
 * the named conversation. The workspace subject is always included
 * when a workspaceId is supplied.
 */
export async function computeRuntimeScopeSubjectIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId?: string | null
    actorId?: string | null
    remoteAgentId?: string | null
    conversationId?: string | null
  }
): Promise<string[]> {
  const scopeIds: string[] = []
  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  scopeIds.push(workspaceSubjectId)

  if (params.conversationId) {
    let anyActive = false
    if (params.actorId) {
      const actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: params.actorId,
      })
      anyActive =
        anyActive ||
        (await isSubjectActiveConversationParticipant(
          db,
          params.conversationId,
          actorSubjectId
        ))
    }
    if (!anyActive && params.remoteAgentId) {
      const remoteAgentSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: params.remoteAgentId,
      })
      anyActive =
        anyActive ||
        (await isSubjectActiveConversationParticipant(
          db,
          params.conversationId,
          remoteAgentSubjectId
        ))
    }
    if (!anyActive && params.workspaceMemberId) {
      const memberSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: params.workspaceMemberId,
      })
      anyActive =
        anyActive ||
        (await isSubjectActiveConversationParticipant(
          db,
          params.conversationId,
          memberSubjectId
        ))
    }
    if (anyActive) {
      const convSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
      scopeIds.push(convSubjectId)
    }
  }

  return Array.from(new Set(scopeIds))
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

  // PR4 fix: previously omitted, so `remote_agent + scope=conversation`
  // (and even plain `remote_agent`) bindings never showed up in the
  // expander. listResourceGrantRows in evaluator.ts now has a matching
  // remote_agent branch.
  if (params.remoteAgentId) {
    subjects.push({
      type: "remote_agent",
      id: params.remoteAgentId,
    })
  }

  return dedupeSubjects(subjects)
}
