import { SUBJECT_KIND, dedupeBy, type SubjectRef } from "@synapse/shared"
import { sql } from "kysely"
import type {
  Executor,
  KyselyDb,
} from "../../infrastructure/database/kysely.js"
import { runCompilable } from "../../infrastructure/database/kysely.js"
import type { PermissionSubject } from "./evaluator.js"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "./subject-registry.js"

// PermissionSubject is the evaluator's flat {type, id} input contract (kept on
// purpose — see evaluator.ts). Its stable key mirrors `subjectKey` in
// @synapse/shared (`{kind}:{id-payload}`); de-dup routes through the shared
// `dedupeBy` algorithm so there is no second hand-rolled Set<string> loop.
const permissionSubjectKey = (subject: PermissionSubject) =>
  `${subject.type}:${subject.id}`

function dedupeSubjects(subjects: PermissionSubject[]) {
  return dedupeBy(subjects, permissionSubjectKey)
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
 * — actor / remote_agent / workspace_member / external. Used by:
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
  /**
   * subject-scope-refactor: explicit principal subject_id field. Equals
   * `upsertAccessSubject(db, principal)` — i.e. the access_subjects row that
   * corresponds to the SubjectRef passed in. Always set (every principal is
   * upsertable into access_subjects). Consumers MUST read this field instead
   * of indexing `runtimeSubjectIds[0]`, which is incidental implementation
   * order and not a public contract.
   */
  principalSubjectId: string
  runtimeSubjectIds: string[]
  runtimeScopeSubjectIds: string[]
  runtimeConversationId?: string
  /**
   * subject-scope-refactor: set when the principal subject was positively
   * verified as an active participant of `params.conversationId` (via
   * `isSubjectActiveConversationParticipant`). The value is the
   * access_subjects.id of the conversation subject row (NOT the business
   * `conversation_id`). Used by `presetToOwnerScope` as an active-scope guard
   * — pure functions can decide "is this dispatch in an active conversation
   * scope?" without a DB call. NOT limited to actor/remote_agent: any
   * workspace-bound principal that passes the active-participant gate gets
   * this populated; `presetToOwnerScope` separately limits scope attachment
   * to actor/remote_agent only (per wire schema whitelist).
   */
  activeConversationSubjectId?: string
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
 * `user` / `external` / `platform` principals are platform-wide and have no
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
    case SUBJECT_KIND.PLATFORM:
      // No single-workspace identity; accept and let per-resource helpers
      // refuse if appropriate.
      return
  }
}

/**
 * PR-fix-round-2: which principal kinds are validated to belong to the
 * runtime workspace by `assertPrincipalBelongsToWorkspace`. Only these
 * earn the workspace subject_id in `runtimeSubjectIds` /
 * `runtimeScopeSubjectIds`. Platform-wide kinds (user/external/platform)
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
    case SUBJECT_KIND.PLATFORM:
      return false
  }
}

type BuildRuntimePrincipalContextParams = {
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

/**
 * 3b: the four executor-specific primitives the runtime-context builder needs.
 * Everything else — the security invariants (no creator inheritance, conversation
 * principals don't inherit workspace, platform-wide kinds skip the workspace mint),
 * the order of subject collection, the dedup — is identical between the Kysely
 * form and the pg-form (`...On`) dual, and lives ONCE in
 * `buildRuntimePrincipalContextCore`. The two public builders differ only in how
 * these four DB touches are issued (global Kysely `db` vs. a caller-supplied
 * connection/transaction using raw SQL so it sees uncommitted writes).
 */
type RuntimeContextOps = {
  assertPrincipalBelongsToWorkspace: (
    principal: SubjectRef,
    workspaceId: string
  ) => Promise<void>
  upsertSubject: (ref: SubjectRef) => Promise<string>
  isActiveParticipant: (
    conversationId: string,
    principalSubjectId: string
  ) => Promise<boolean>
  /** Returns the member's workspace_id, or null when the member does not exist. */
  lookupMemberWorkspaceId: (memberId: string) => Promise<string | null>
}

async function buildRuntimePrincipalContextCore(
  ops: RuntimeContextOps,
  params: BuildRuntimePrincipalContextParams
): Promise<RuntimePrincipalContext> {
  // Verify the principal actually belongs to the named workspace before minting
  // workspace subject_ids in their name. Without this check a caller could ask
  // for context against any workspace and get back a runtime set that
  // legitimately matches `subject=workspace W` grants in W — an
  // authorization-expansion bug. assertPrincipalBelongsToWorkspace accepts
  // user/external/platform/conversation (no single-workspace identity); the
  // `isPrincipalWorkspaceBound` gate below is what stops THOSE platform-wide
  // principals from auto-collecting the workspace subject.
  await ops.assertPrincipalBelongsToWorkspace(
    params.principal,
    params.workspaceId
  )

  const principalSubjectId = await ops.upsertSubject(params.principal)
  const runtimeSubjectIds: string[] = [principalSubjectId]
  const runtimeScopeSubjectIds: string[] = []

  if (isPrincipalWorkspaceBound(params.principal)) {
    const workspaceSubjectId = await ops.upsertSubject({
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: params.workspaceId,
    })
    runtimeSubjectIds.push(workspaceSubjectId)
    runtimeScopeSubjectIds.push(workspaceSubjectId)
  }

  let activeConversationSubjectId: string | undefined
  if (params.conversationId) {
    const isActive = await ops.isActiveParticipant(
      params.conversationId,
      principalSubjectId
    )
    if (isActive) {
      const convSubjectId = await ops.upsertSubject({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
      runtimeSubjectIds.push(convSubjectId)
      runtimeScopeSubjectIds.push(convSubjectId)
      activeConversationSubjectId = convSubjectId
    }
  }

  if (params.delegatedWorkspaceMemberId) {
    const memberWorkspaceId = await ops.lookupMemberWorkspaceId(
      params.delegatedWorkspaceMemberId
    )
    if (memberWorkspaceId === null) {
      throw new Error(
        `delegatedWorkspaceMemberId ${params.delegatedWorkspaceMemberId} not found`
      )
    }
    if (memberWorkspaceId !== params.workspaceId) {
      throw new Error(
        `delegatedWorkspaceMemberId ${params.delegatedWorkspaceMemberId} belongs to workspace ${memberWorkspaceId}, not ${params.workspaceId}`
      )
    }
    const memberSubjectId = await ops.upsertSubject({
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: params.delegatedWorkspaceMemberId,
    })
    runtimeSubjectIds.push(memberSubjectId)
  }

  return {
    principal: params.principal,
    principalSubjectId,
    runtimeSubjectIds: Array.from(new Set(runtimeSubjectIds)),
    runtimeScopeSubjectIds: Array.from(new Set(runtimeScopeSubjectIds)),
    runtimeConversationId: params.conversationId ?? undefined,
    activeConversationSubjectId,
  }
}

export async function buildRuntimePrincipalContext(
  db: KyselyDb,
  params: BuildRuntimePrincipalContextParams
): Promise<RuntimePrincipalContext> {
  return buildRuntimePrincipalContextCore(
    {
      assertPrincipalBelongsToWorkspace: (principal, workspaceId) =>
        assertPrincipalBelongsToWorkspace(db, principal, workspaceId),
      upsertSubject: (ref) => upsertAccessSubject(db, ref),
      isActiveParticipant: (conversationId, principalSubjectId) =>
        isSubjectActiveConversationParticipant(
          db,
          conversationId,
          principalSubjectId
        ),
      lookupMemberWorkspaceId: async (memberId) => {
        const member = await db
          .selectFrom("workspace_members")
          .select(["id", "workspace_id"])
          .where("id", "=", memberId)
          .limit(1)
          .executeTakeFirst()
        return member?.workspace_id ?? null
      },
    },
    params
  )
}

/**
 * subject-scope-refactor: pg-form dual of `buildRuntimePrincipalContext`.
 *
 * Shares ALL orchestration + security invariants with the Kysely form via
 * `buildRuntimePrincipalContextCore`; the only differences are wire-level:
 *
 *  - takes a pg `Executor` (the same connection / transaction the caller
 *    has open) rather than the global Kysely `db`, so the workspace-bound
 *    + active-participant guards see uncommitted writes from the surrounding
 *    transaction (critical for approval flows that just upserted the
 *    interaction row in the same client).
 *  - calls `upsertAccessSubjectOn(executor, ...)` (pg-form upsert) so the
 *    subject rows it mints are visible to the same transaction.
 *  - uses raw SQL for the membership / participant lookups so we don't
 *    open a parallel Kysely connection.
 */
export async function buildRuntimePrincipalContextOn(
  executor: Executor,
  params: BuildRuntimePrincipalContextParams
): Promise<RuntimePrincipalContext> {
  return buildRuntimePrincipalContextCore(
    {
      assertPrincipalBelongsToWorkspace: (principal, workspaceId) =>
        assertPrincipalBelongsToWorkspaceOn(executor, principal, workspaceId),
      upsertSubject: (ref) => upsertAccessSubjectOn(executor, ref),
      isActiveParticipant: async (conversationId, principalSubjectId) => {
        const activeRow = await runCompilable(
          executor,
          sql<{ id: string }>`
            SELECT id FROM conversation_participants
            WHERE conversation_id = ${conversationId} AND subject_id = ${principalSubjectId} AND state = 'active'
            LIMIT 1`
        )
        return activeRow.rows.length > 0
      },
      lookupMemberWorkspaceId: async (memberId) => {
        const memberRow = await runCompilable(
          executor,
          sql<{ workspace_id: string }>`
            SELECT workspace_id FROM workspace_members WHERE id = ${memberId} LIMIT 1`
        )
        return memberRow.rows[0]?.workspace_id ?? null
      },
    },
    params
  )
}

async function assertPrincipalBelongsToWorkspaceOn(
  executor: Executor,
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
      const row = await runCompilable(
        executor,
        sql<{ workspace_id: string }>`
          SELECT workspace_id FROM workspace_members WHERE id = ${principal.memberId} LIMIT 1`
      )
      if (row.rows.length === 0 || row.rows[0].workspace_id !== workspaceId) {
        throw new Error(
          `workspace_member ${principal.memberId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.ACTOR: {
      const row = await runCompilable(
        executor,
        sql<{ workspace_id: string }>`
          SELECT workspace_id FROM actors WHERE id = ${principal.actorId} LIMIT 1`
      )
      if (row.rows.length === 0 || row.rows[0].workspace_id !== workspaceId) {
        throw new Error(
          `actor ${principal.actorId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.REMOTE_AGENT: {
      const row = await runCompilable(
        executor,
        sql<{ workspace_id: string }>`
          SELECT workspace_id FROM remote_agents WHERE id = ${principal.remoteAgentId} LIMIT 1`
      )
      if (row.rows.length === 0 || row.rows[0].workspace_id !== workspaceId) {
        throw new Error(
          `remote_agent ${principal.remoteAgentId} does not belong to workspace ${workspaceId}`
        )
      }
      return
    }
    case SUBJECT_KIND.CONVERSATION:
    case SUBJECT_KIND.USER:
    case SUBJECT_KIND.EXTERNAL:
    case SUBJECT_KIND.PLATFORM:
      return
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
/**
 * Post-D4 P2 fix: shared workspace-membership validator for the visibility
 * helpers below. Mirrors the `assertPrincipalBelongsToWorkspace` checks used
 * by `buildRuntimePrincipalContext` — without this guard the visibility
 * helpers would mint the workspace subject from `params.workspaceId`
 * unconditionally, so a caller passing an actor/member/remote_agent in
 * workspace W1 plus `workspaceId = W2` would silently get back a runtime
 * set that matches `subject=workspace W2` grants. The helpers refuse
 * inconsistent inputs by throwing.
 */
async function assertVisibilityPrincipalsBelongToWorkspace(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId?: string | null
    actorId?: string | null
    remoteAgentId?: string | null
  }
): Promise<void> {
  if (params.workspaceMemberId) {
    const row = await db
      .selectFrom("workspace_members")
      .select(["id", "workspace_id"])
      .where("id", "=", params.workspaceMemberId)
      .limit(1)
      .executeTakeFirst()
    if (!row || row.workspace_id !== params.workspaceId) {
      throw new Error(
        `workspace_member ${params.workspaceMemberId} does not belong to workspace ${params.workspaceId}`
      )
    }
  }
  if (params.actorId) {
    const row = await db
      .selectFrom("actors")
      .select(["id", "workspace_id"])
      .where("id", "=", params.actorId)
      .limit(1)
      .executeTakeFirst()
    if (!row || row.workspace_id !== params.workspaceId) {
      throw new Error(
        `actor ${params.actorId} does not belong to workspace ${params.workspaceId}`
      )
    }
  }
  if (params.remoteAgentId) {
    const row = await db
      .selectFrom("remote_agents")
      .select(["id", "workspace_id"])
      .where("id", "=", params.remoteAgentId)
      .limit(1)
      .executeTakeFirst()
    if (!row || row.workspace_id !== params.workspaceId) {
      throw new Error(
        `remote_agent ${params.remoteAgentId} does not belong to workspace ${params.workspaceId}`
      )
    }
  }
}

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
  await assertVisibilityPrincipalsBelongToWorkspace(db, params)
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

/**
 * P1 fix (post-D4): subject_ids the principal can *claim* under right now —
 * principal own subject + workspace + any group subjects (conversation when
 * active participant). Passed as `runtimeSubjectIds` to the RAB visibility
 * layer so `subject=conversation C` bindings surface for active participants
 * (otherwise they'd be writable but never match).
 *
 * Mirrors `buildRuntimePrincipalContext.runtimeSubjectIds` but takes the
 * legacy (workspaceMemberId / actorId / remoteAgentId / conversationId)
 * fields directly so the visibility callers don't have to assemble a
 * principal SubjectRef first.
 */
export async function computeRuntimeSubjectIdsForVisibility(
  db: KyselyDb,
  params: {
    workspaceId: string
    workspaceMemberId?: string | null
    actorId?: string | null
    remoteAgentId?: string | null
    conversationId?: string | null
  }
): Promise<string[]> {
  await assertVisibilityPrincipalsBelongToWorkspace(db, params)
  const ids: string[] = []
  const workspaceSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  ids.push(workspaceSubjectId)

  if (params.workspaceMemberId) {
    ids.push(
      await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: params.workspaceMemberId,
      })
    )
  }
  if (params.actorId) {
    ids.push(
      await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: params.actorId,
      })
    )
  }
  if (params.remoteAgentId) {
    ids.push(
      await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: params.remoteAgentId,
      })
    )
  }

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
      ids.push(convSubjectId)
    }
  }

  return Array.from(new Set(ids))
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
