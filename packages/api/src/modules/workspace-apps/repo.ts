// workspace-apps/repo.ts — DB-touching helpers for the workspace-apps module.
//
// The only workspace-apps file (besides the *-storage.ts siblings) permitted to
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
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  WORKSPACE_APP_GRANT_STATUS,
  WORKSPACE_APP_STATUS,
  type CapabilityAccessTarget,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppKind,
  type WorkspaceAppGrantRequestDirection,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { isSubjectActiveConversationParticipant } from "../access/subject-resolution.js"
import { upsertAccessSubjectDefault } from "../access/guards.js"
import {
  cancelWorkspaceAppGrantRequest,
  insertWorkspaceAppGrant,
  insertWorkspaceAppGrantRequest,
  listActiveWorkspaceAppGrants,
  revokeWorkspaceAppGrant,
  revokeWorkspaceAppGrantsForApp,
  type WorkspaceAppGrantRequestRow,
} from "./grant-storage.js"
import { updateWorkspaceAppRoot } from "./root-storage.js"
import type {
  WorkspaceAppRow,
  WorkspaceAppGrantPresentationRow,
  WorkspaceAppGrantRequestPresentationRow,
} from "./presenter.js"

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
  workspaceAppId: string,
  workspaceMemberId: string
): Promise<boolean> {
  const memberSubjectId = await upsertAccessSubjectDefault({
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: workspaceMemberId,
  })
  const row = await db
    .selectFrom("workspaceAppGrants")
    .select("id")
    .where("workspaceAppId", "=", workspaceAppId)
    .where("subjectId", "=", memberSubjectId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`${WORKSPACE_APP_GRANT_PERMISSION.MANAGE}::workspace_app_grant_permission = ANY(permissions)`
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/** The live (non-deleted) workspace app for (appId, workspaceId), if any. */
export async function findManageableWorkspaceApp(
  appId: string,
  workspaceId: string
): Promise<WorkspaceAppRow | undefined> {
  const app = await db
    .selectFrom("workspaceAppsLive")
    .selectAll()
    .where("id", "=", appId)
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return app
}

/**
 * The live workspace apps for a workspace (newest first), optionally filtered
 * by kind. Visibility filtering stays in the service.
 */
export async function listWorkspaceAppsLive(
  workspaceId: string,
  kind?: WorkspaceAppKind
): Promise<WorkspaceAppRow[]> {
  let query = db
    .selectFrom("workspaceAppsLive")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "desc")
  if (kind) {
    query = query.where("kind", "=", kind)
  }
  return query.execute()
}

/** Default-db upsert of an access subject (mirrors upsertAccessSubject(db,...)). */
export async function upsertWorkspaceAppSubjectIdDefault(
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
export async function listGrantedWorkspaceApps(params: {
  workspaceId: string
  claimSubjectIds: string[]
  conversationSubjectId: string | null
}): Promise<Array<WorkspaceAppRow & { id: string }>> {
  return db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .select([
      "app.id",
      "app.workspaceId",
      "app.kind",
      "app.displayName",
      "app.ownerWorkspaceMemberId",
      "app.status",
      "app.conversationTypeMaskOverride",
      "app.createdAt",
      "app.updatedAt",
    ])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where("app_grant.subjectId", "in", params.claimSubjectIds)
    .where((eb) =>
      params.conversationSubjectId
        ? eb.or([
            eb("app_grant.scopeSubjectId", "is", null),
            eb("app_grant.scopeSubjectId", "=", params.conversationSubjectId),
          ])
        : eb("app_grant.scopeSubjectId", "is", null)
    )
    .where(
      sql<boolean>`(
        ${WORKSPACE_APP_GRANT_PERMISSION.USE}::workspace_app_grant_permission = ANY(app_grant.permissions)
        OR ${WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE}::workspace_app_grant_permission = ANY(app_grant.permissions)
      )`
    )
    .distinct()
    .execute()
}

/** Implicit-owner discover query: active apps the member owns of the given kinds. */
export async function listImplicitOwnerWorkspaceApps(params: {
  workspaceId: string
  ownerWorkspaceMemberId: string
  kinds: readonly WorkspaceAppKind[]
}): Promise<WorkspaceAppRow[]> {
  return db
    .selectFrom("workspaceAppsLive as app")
    .selectAll()
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", WORKSPACE_APP_STATUS.ACTIVE)
    .where("app.ownerWorkspaceMemberId", "=", params.ownerWorkspaceMemberId)
    .where("app.kind", "in", params.kinds as WorkspaceAppKind[])
    .execute()
}

/** Active grants for an app joined to subject/scope for presentation. */
export async function listWorkspaceAppGrantPresentationRows(
  appId: string
): Promise<WorkspaceAppGrantPresentationRow[]> {
  return db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select([
      "app_grant.id",
      "app_grant.workspaceId",
      "app_grant.workspaceAppId",
      "app_grant.permissions",
      "app_grant.status",
      "app_grant.source",
      "app_grant.createdByWorkspaceMemberId",
      "app_grant.reason",
      "app_grant.conversationTypeMaskOverride",
      "app_grant.createdAt",
      "app_grant.revokedAt",
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
    .where("app_grant.workspaceAppId", "=", appId)
    .where("app_grant.status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .orderBy("app_grant.createdAt", "desc")
    .execute()
}

/**
 * Atomically replace all active grants for an app: revoke every existing active
 * grant, then insert the supplied set, in a single transaction. The
 * revoke-then-reinsert loop runs on one trx executor so the swap is atomic.
 */
export async function replaceWorkspaceAppGrantsTx(params: {
  workspaceId: string
  appId: string
  grants: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  createdByWorkspaceMemberId: string
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const existing = await listActiveWorkspaceAppGrants(trx, params.appId)
    for (const grant of existing) {
      await revokeWorkspaceAppGrant(trx, grant.id)
    }
    for (const grant of params.grants) {
      await insertWorkspaceAppGrant(trx, {
        workspaceId: params.workspaceId,
        workspaceAppId: params.appId,
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
export async function listWorkspaceAppGrantRequestPresentationRows(params: {
  appId: string
  direction: WorkspaceAppGrantRequestDirection
  requesterWorkspaceMemberId: string
}): Promise<WorkspaceAppGrantRequestPresentationRow[]> {
  return db
    .selectFrom("workspaceAppGrantRequests as app_request")
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
      "app_request.workspaceAppId",
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
    .where("app_request.workspaceAppId", "=", params.appId)
    .where((eb) =>
      params.direction === WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING
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

/** Default-db insert of a grant request (mirrors insertWorkspaceAppGrantRequest(db,...)). */
export async function insertWorkspaceAppGrantRequestDefault(
  input: Parameters<typeof insertWorkspaceAppGrantRequest>[1]
): Promise<WorkspaceAppGrantRequestRow> {
  return insertWorkspaceAppGrantRequest(db, input)
}

/** The cancel-by-requester probe row (status + ownership fields). */
export async function findGrantRequestById(requestId: string): Promise<
  | {
      id: string
      workspaceId: string
      workspaceAppId: string
      requesterWorkspaceMemberId: string
      status: string
    }
  | undefined
> {
  return db
    .selectFrom("workspaceAppGrantRequests")
    .select([
      "id",
      "workspaceId",
      "workspaceAppId",
      "requesterWorkspaceMemberId",
      "status",
    ])
    .where("id", "=", requestId)
    .executeTakeFirst()
}

/** Default-db cancel of a grant request (mirrors cancelWorkspaceAppGrantRequest(db,...)). */
export async function cancelWorkspaceAppGrantRequestDefault(params: {
  workspaceId: string
  workspaceAppId: string
  requestId: string
  requesterWorkspaceMemberId: string
}): Promise<boolean> {
  return cancelWorkspaceAppGrantRequest(db, params)
}

/** Default-db update of the workspace_apps root row (mirrors updateWorkspaceAppRoot(db,...)). */
export async function updateWorkspaceAppRootDefault(
  input: Parameters<typeof updateWorkspaceAppRoot>[1]
): Promise<void> {
  await updateWorkspaceAppRoot(db, input)
}

/** Default-db revoke of all active grants for an app (mirrors revokeWorkspaceAppGrantsForApp(db,...)). */
export async function revokeWorkspaceAppGrantsForAppDefault(
  workspaceAppId: string
): Promise<number> {
  return revokeWorkspaceAppGrantsForApp(db, workspaceAppId)
}
