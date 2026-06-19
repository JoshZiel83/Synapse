// workspace-resources/repo.ts — DB-touching helpers for the workspace-resources module.
//
// The only workspace-resources file (besides the *-storage.ts siblings) permitted to
// import the db client (guard r8). Owns the inline `db` selects that previously
// lived in service.ts: the workspace-member access load, the manage-grant probe,
// the manageable-app lookup, the inventory/discover queries, the grant and
// grant-request presentation joins, the replace-grants transaction, and default-bound
// wrappers around the executor-injectable storage helpers the service threads.
//
// Functions return camelCase domain rows with Date objects kept intact (no
// serialization — presenter.ts owns Date->view transforms). JSON/permission
// columns stay raw. round-6 P1-6.

import { sql } from "kysely"
import {
  ACCESS_BINDING_STATUS,
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  WORKSPACE_RESOURCE_STATUS,
  type CapabilityAccessTarget,
  type WorkspaceResourceGrantPermission,
  type WorkspaceResourceKind,
  type WorkspaceResourceStatus,
  type WorkspaceResourceGrantRequestDirection,
} from "@synapse/shared"
import {
  db,
  type Executor,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import { isSubjectActiveConversationParticipant } from "../access/subject-resolution.js"
import { upsertAccessSubjectDefault } from "../access/guards.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import {
  cancelWorkspaceResourceGrantRequest,
  insertWorkspaceResourceGrant,
  insertWorkspaceResourceGrantRequest,
  listActiveWorkspaceResourceGrants,
  revokeWorkspaceResourceGrant,
  revokeWorkspaceResourceGrantsForApp,
  type WorkspaceResourceGrantRequestRow,
} from "./grant-storage.js"
import type {
  WorkspaceResourceRow,
  WorkspaceResourceGrantPresentationRow,
  WorkspaceResourceGrantRequestPresentationRow,
} from "./presenter.js"

/**
 * Resolve the (owner_subject_id, created_by_subject_id) pair for a
 * workspace_resources root row from the member who installed/created it.
 *
 * owner    = the installer member's workspace_member subject (or NULL when no
 *            human owner — e.g. device_capability catalog-sync).
 * creator  = the installer member's subject for member-created kinds, else the
 *            single platform-wide subject (system-generated roots, D4).
 */
export async function resolveWorkspaceResourceRootSubjects(
  run: KyselyDb | Executor,
  input: {
    ownerWorkspaceMemberId?: string | null
    createdBySubjectId?: string | null
    createdByPlatform?: boolean
  }
): Promise<{ ownerSubjectId: string | null; createdBySubjectId: string }> {
  const ownerSubjectId = input.ownerWorkspaceMemberId
    ? await upsertAccessSubjectOn(run, {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: input.ownerWorkspaceMemberId,
      })
    : null
  let createdBySubjectId = input.createdBySubjectId ?? null
  if (!createdBySubjectId) {
    createdBySubjectId =
      ownerSubjectId && !input.createdByPlatform
        ? ownerSubjectId
        : await upsertAccessSubjectOn(run, { kind: SUBJECT_KIND.PLATFORM })
  }
  return { ownerSubjectId, createdBySubjectId }
}

export async function insertWorkspaceResourceRoot(
  run: KyselyDb | Executor,
  input: {
    id: string
    workspaceId: string
    kind: WorkspaceResourceKind
    displayName: string
    ownerWorkspaceMemberId?: string | null
    ownerSubjectId?: string | null
    createdBySubjectId?: string | null
    createdByPlatform?: boolean
    status?: WorkspaceResourceStatus
    conversationTypeMaskOverride?: number | null
  }
) {
  const { ownerSubjectId, createdBySubjectId } =
    input.ownerSubjectId !== undefined && input.createdBySubjectId
      ? {
          ownerSubjectId: input.ownerSubjectId,
          createdBySubjectId: input.createdBySubjectId,
        }
      : await resolveWorkspaceResourceRootSubjects(run, input)
  await run
    .insertInto("workspaceResources")
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      displayName: input.displayName,
      ownerSubjectId,
      createdBySubjectId,
      status: input.status ?? "active",
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
    } as any)
    .execute()
}

export async function updateWorkspaceResourceRoot(
  run: KyselyDb | Executor,
  input: {
    id: string
    displayName?: string
    ownerWorkspaceMemberId?: string | null
    status?: WorkspaceResourceStatus
    conversationTypeMaskOverride?: number | null
    deletedAt?: Date | null
  }
) {
  const patch: Record<string, unknown> = {
    updatedAt: sql`NOW()`,
  }
  if (input.displayName !== undefined) {
    patch.displayName = input.displayName
  }
  if (input.ownerWorkspaceMemberId !== undefined) {
    patch.ownerSubjectId = input.ownerWorkspaceMemberId
      ? await upsertAccessSubjectOn(run, {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: input.ownerWorkspaceMemberId,
        })
      : null
  }
  if (input.status !== undefined) {
    patch.status = input.status
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    patch.conversationTypeMaskOverride = input.conversationTypeMaskOverride
  }
  if (input.deletedAt !== undefined) {
    patch.deletedAt = input.deletedAt
  }

  await run
    .updateTable("workspaceResources")
    .set(patch as any)
    .where("id", "=", input.id)
    .execute()
}

export type WorkspaceMemberAccessRecord = {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  ownerId: string
  trustLevel: string
  accessKeys: string[]
}

/**
 * The workspace-member access record for a (workspace, user): the wm/workspaces
 * join plus the member's active accessKeys. Returns null when the member is not
 * active or the workspace is soft-deleted.
 */
export async function loadWorkspaceMemberAccessRecord(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberAccessRecord | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .select([
      "wm.id",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "w.ownerId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    .where("wm.status", "=", "active")
    .where("w.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  const accessRows = await db
    .selectFrom("workspaceAccessBindings")
    .select("accessKey")
    .where("workspaceMemberId", "=", row.id)
    .where("status", "=", ACCESS_BINDING_STATUS.ACTIVE)
    .execute()

  return {
    workspaceMemberId: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    ownerId: row.ownerId,
    trustLevel: row.trustLevel,
    accessKeys: accessRows.map((entry) => entry.accessKey),
  }
}

/**
 * Whether the given workspace-member has an active MANAGE grant on the app.
 * Upserts the member subject (so the probe is consistent with the registry)
 * on the same default db the probe runs against.
 */
export async function hasManageGrantForSubject(
  workspaceResourceId: string,
  workspaceMemberId: string
): Promise<boolean> {
  const memberSubjectId = await upsertAccessSubjectDefault({
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
  const row = await db
    .selectFrom("workspaceResourceGrants")
    .select("id")
    .where("workspaceResourceId", "=", workspaceResourceId)
    .where("subjectId", "=", memberSubjectId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`${WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE}::workspace_resource_grant_permission = ANY(permissions)`
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

// Projection that surfaces the owner member id (when the owner subject is a
// workspace_member) so callers keep the legacy `ownerWorkspaceMemberId`
// semantics post owner→subject migration. Other owner kinds (actor/remote_agent)
// project null here; their owner-implicit access is computed subject-side.
function selectWorkspaceResourceLiveRow(builder: any) {
  return builder
    .leftJoin(
      "accessSubjects as owner_subject",
      "owner_subject.id",
      "resource.ownerSubjectId"
    )
    .select([
      "resource.id",
      "resource.workspaceId",
      "resource.kind",
      "resource.displayName",
      "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
      "resource.ownerSubjectId",
      "resource.status",
      "resource.conversationTypeMaskOverride",
      "resource.createdAt",
      "resource.updatedAt",
      "resource.deletedAt",
    ])
}

/** The live (non-deleted) workspace app for (resourceId, workspaceId), if any. */
export async function findManageableWorkspaceResource(
  resourceId: string,
  workspaceId: string
): Promise<WorkspaceResourceRow | undefined> {
  const resource = await selectWorkspaceResourceLiveRow(
    db.selectFrom("workspaceResourcesLive as resource")
  )
    .where("resource.id", "=", resourceId)
    .where("resource.workspaceId", "=", workspaceId)
    .where("resource.deletedAt", "is", null)
    .executeTakeFirst()
  return resource
}

/**
 * The live workspace apps for a workspace (newest first), optionally filtered
 * by kind. Visibility filtering stays in the service.
 */
export async function listWorkspaceResourcesLive(
  workspaceId: string,
  kind?: WorkspaceResourceKind
): Promise<WorkspaceResourceRow[]> {
  let query = selectWorkspaceResourceLiveRow(
    db.selectFrom("workspaceResourcesLive as resource")
  )
    .where("resource.workspaceId", "=", workspaceId)
    .where("resource.deletedAt", "is", null)
    .orderBy("resource.createdAt", "desc")
  if (kind) {
    query = query.where("resource.kind", "=", kind)
  }
  return query.execute()
}

/** Default-db upsert of an access subject (mirrors upsertAccessSubject(db,...)). */
export async function upsertWorkspaceResourceSubjectIdDefault(
  ref: Parameters<typeof upsertAccessSubjectDefault>[0]
): Promise<string> {
  return upsertAccessSubjectDefault(ref)
}

/** Default-db active-participant probe (mirrors the (db,...) call in discover). */
export async function isSubjectActiveConversationParticipantDefault(
  conversationId: string,
  subjectId: string
): Promise<boolean> {
  return isSubjectActiveConversationParticipant(db, conversationId, subjectId)
}

/**
 * The granted-app discover query: workspace apps with an active USE or
 * CONTACT_VISIBLE grant claimable by the given subject ids, optionally scoped
 * to a conversation subject. Preserves the raw permission ANY(...) probe and the
 * scope OR-null predicate verbatim.
 */
export async function listGrantedWorkspaceResources(
  params: {
    workspaceId: string
    claimSubjectIds: string[]
    conversationSubjectId: string | null
  },
  // Optional executor so the §6.5 no-leak filter is testable inside a
  // rolled-back test transaction; defaults to the pool-bound client.
  run: KyselyDb | Executor = db
): Promise<Array<WorkspaceResourceRow & { id: string }>> {
  return (
    run
      .selectFrom("workspaceResourceGrants as resource_grant")
      .innerJoin(
        "workspaceResources as resource",
        "resource.id",
        "resource_grant.workspaceResourceId"
      )
      .leftJoin(
        "accessSubjects as owner_subject",
        "owner_subject.id",
        "resource.ownerSubjectId"
      )
      .select([
        "resource.id",
        "resource.workspaceId",
        "resource.kind",
        "resource.displayName",
        "owner_subject.workspaceMemberId as ownerWorkspaceMemberId",
        "resource.ownerSubjectId",
        "resource.status",
        "resource.conversationTypeMaskOverride",
        "resource.createdAt",
        "resource.updatedAt",
      ])
      .where("resource.workspaceId", "=", params.workspaceId)
      .where("resource.deletedAt", "is", null)
      // §6.5: automation event sources are folded into workspace_resources but their
      // "open to all" workspace-subject use grant must not leak into discover.
      .where(
        "resource.kind",
        "<>",
        WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE
      )
      .where("resource.status", "=", WORKSPACE_RESOURCE_STATUS.ACTIVE)
      .where(
        "resource_grant.status",
        "=",
        WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE
      )
      .where("resource_grant.subjectId", "in", params.claimSubjectIds)
      .where((eb) =>
        params.conversationSubjectId
          ? eb.or([
              eb("resource_grant.scopeSubjectId", "is", null),
              eb(
                "resource_grant.scopeSubjectId",
                "=",
                params.conversationSubjectId
              ),
            ])
          : eb("resource_grant.scopeSubjectId", "is", null)
      )
      .where(
        sql<boolean>`(
        ${WORKSPACE_RESOURCE_GRANT_PERMISSION.USE}::workspace_resource_grant_permission = ANY(resource_grant.permissions)
        OR ${WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE}::workspace_resource_grant_permission = ANY(resource_grant.permissions)
      )`
      )
      .distinct()
      .execute()
  )
}

/** Implicit-owner discover query: active apps the member owns of the given kinds. */
export async function listImplicitOwnerWorkspaceResources(params: {
  workspaceId: string
  ownerWorkspaceMemberId: string
  kinds: readonly WorkspaceResourceKind[]
}): Promise<WorkspaceResourceRow[]> {
  const ownerSubjectId = await upsertAccessSubjectOn(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: params.ownerWorkspaceMemberId,
  })
  return selectWorkspaceResourceLiveRow(
    db.selectFrom("workspaceResourcesLive as resource")
  )
    .where("resource.workspaceId", "=", params.workspaceId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", WORKSPACE_RESOURCE_STATUS.ACTIVE)
    .where("resource.ownerSubjectId", "=", ownerSubjectId)
    .where("resource.kind", "in", params.kinds as WorkspaceResourceKind[])
    .execute()
}

/** Active grants for an app joined to subject/scope for presentation. */
export async function listWorkspaceResourceGrantPresentationRows(
  resourceId: string
): Promise<WorkspaceResourceGrantPresentationRow[]> {
  return db
    .selectFrom("workspaceResourceGrants as resource_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "resource_grant.subjectId")
    .leftJoin(
      "accessSubjects as scope",
      "scope.id",
      "resource_grant.scopeSubjectId"
    )
    .select([
      "resource_grant.id",
      "resource_grant.workspaceId",
      "resource_grant.workspaceResourceId",
      "resource_grant.permissions",
      "resource_grant.status",
      "resource_grant.source",
      "resource_grant.createdByWorkspaceMemberId",
      "resource_grant.reason",
      "resource_grant.conversationTypeMaskOverride",
      "resource_grant.createdAt",
      "resource_grant.revokedAt",
      "subj.kind",
      "subj.workspaceId",
      "subj.workspaceMemberId",
      "subj.actorId",
      "subj.remoteAgentId",
      "subj.conversationId",
      "scope.kind as scopeKind",
      "scope.workspaceId as scopeWorkspaceIdViaJoin",
      "scope.conversationId as scopeConversationIdViaJoin",
    ])
    .where("resource_grant.workspaceResourceId", "=", resourceId)
    .where("resource_grant.status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .orderBy("resource_grant.createdAt", "desc")
    .execute()
}

/**
 * Atomically replace all active grants for an app: revoke every existing active
 * grant, then insert the supplied set, in a single transaction. The
 * revoke-then-reinsert loop runs on one trx executor so the swap is atomic.
 */
export async function replaceWorkspaceResourceGrantsTx(params: {
  workspaceId: string
  resourceId: string
  grants: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  createdByWorkspaceMemberId: string
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await listActiveWorkspaceResourceGrants(
      trx,
      params.resourceId
    )
    for (const grant of existing) {
      await revokeWorkspaceResourceGrant(trx, grant.id)
    }
    for (const grant of params.grants) {
      await insertWorkspaceResourceGrant(trx, {
        workspaceId: params.workspaceId,
        workspaceResourceId: params.resourceId,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
        reason: grant.reason ?? null,
      })
    }
  })
}

/** Grant requests for an app joined to grantee/scope for presentation. */
export async function listWorkspaceResourceGrantRequestPresentationRows(params: {
  resourceId: string
  direction: WorkspaceResourceGrantRequestDirection
  requesterWorkspaceMemberId: string
}): Promise<WorkspaceResourceGrantRequestPresentationRow[]> {
  return db
    .selectFrom("workspaceResourceGrantRequests as app_request")
    .innerJoin(
      "accessSubjects as grantee",
      "grantee.id",
      "app_request.granteeSubjectId"
    )
    .leftJoin(
      "accessSubjects as scope",
      "scope.id",
      "app_request.granteeScopeSubjectId"
    )
    .select([
      "app_request.id",
      "app_request.workspaceId",
      "app_request.workspaceResourceId",
      "app_request.requestedPermissions",
      "app_request.requesterWorkspaceMemberId",
      "app_request.status",
      "app_request.resolvedByWorkspaceMemberId",
      "app_request.resolvedAt",
      "app_request.reason",
      "app_request.createdAt",
      "app_request.updatedAt",
      "grantee.kind as granteeKind",
      "grantee.workspaceId as granteeWorkspaceIdViaJoin",
      "grantee.workspaceMemberId as granteeWorkspaceMemberIdViaJoin",
      "grantee.actorId as granteeActorIdViaJoin",
      "grantee.remoteAgentId as granteeRemoteAgentIdViaJoin",
      "grantee.conversationId as granteeConversationIdViaJoin",
      "scope.kind as granteeScopeKind",
      "scope.workspaceId as granteeScopeWorkspaceIdViaJoin",
      "scope.conversationId as granteeScopeConversationIdViaJoin",
    ])
    .where("app_request.workspaceResourceId", "=", params.resourceId)
    .where((eb) =>
      params.direction === WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.OUTGOING
        ? eb(
            "app_request.requesterWorkspaceMemberId",
            "=",
            params.requesterWorkspaceMemberId
          )
        : eb.val(true)
    )
    .orderBy("app_request.createdAt", "desc")
    .execute()
}

/** Default-db insert of a grant request (mirrors insertWorkspaceResourceGrantRequest(db,...)). */
export async function insertWorkspaceResourceGrantRequestDefault(
  input: Parameters<typeof insertWorkspaceResourceGrantRequest>[1]
): Promise<WorkspaceResourceGrantRequestRow> {
  return insertWorkspaceResourceGrantRequest(db, input)
}

/** The cancel-by-requester probe row (status + ownership fields). */
export async function findGrantRequestById(requestId: string): Promise<
  | {
      id: string
      workspaceId: string
      workspaceResourceId: string
      requesterWorkspaceMemberId: string
      status: string
    }
  | undefined
> {
  return db
    .selectFrom("workspaceResourceGrantRequests")
    .select([
      "id",
      "workspaceId",
      "workspaceResourceId",
      "requesterWorkspaceMemberId",
      "status",
    ])
    .where("id", "=", requestId)
    .executeTakeFirst()
}

/** Default-db cancel of a grant request (mirrors cancelWorkspaceResourceGrantRequest(db,...)). */
export async function cancelWorkspaceResourceGrantRequestDefault(params: {
  workspaceId: string
  workspaceResourceId: string
  requestId: string
  requesterWorkspaceMemberId: string
}): Promise<boolean> {
  return cancelWorkspaceResourceGrantRequest(db, params)
}

/** Default-db update of the workspace_resources root row (mirrors updateWorkspaceResourceRoot(db,...)). */
export async function updateWorkspaceResourceRootDefault(
  input: Parameters<typeof updateWorkspaceResourceRoot>[1]
): Promise<void> {
  await updateWorkspaceResourceRoot(db, input)
}

/** Default-db revoke of all active grants for an app (mirrors revokeWorkspaceResourceGrantsForApp(db,...)). */
export async function revokeWorkspaceResourceGrantsForAppDefault(
  workspaceResourceId: string
): Promise<number> {
  return revokeWorkspaceResourceGrantsForApp(db, workspaceResourceId)
}
