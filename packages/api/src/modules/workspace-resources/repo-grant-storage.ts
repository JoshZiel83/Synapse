// Workspace resource grant/request repo storage.

import { sql } from "kysely"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION,
  type WorkspaceResourceGrantRequestDirection,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_STATUS,
  type SubjectRef,
  type WorkspaceResourceGrantPermission,
} from "@synapse/shared"
import type {
  Executor,
  KyselyDb,
} from "../../infrastructure/database/kysely.js"
import { db } from "../../infrastructure/database/kysely.js"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "../access/subject-registry.js"

type ScopedTarget = {
  subject: SubjectRef
  scope?: SubjectRef
}

export type WorkspaceResourceGrantRow = {
  id: string
  workspaceId: string
  workspaceResourceId: string
  subjectId: string
  scopeSubjectId: string | null
  permissions: WorkspaceResourceGrantPermission[]
  conversationTypeMaskOverride: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  createdByWorkspaceMemberId: string | null
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}

export type WorkspaceResourceGrantRequestRow = {
  id: string
  workspaceId: string
  workspaceResourceId: string
  granteeSubjectId: string
  granteeScopeSubjectId: string | null
  requestedPermissions: WorkspaceResourceGrantPermission[]
  requesterWorkspaceMemberId: string
  status: "pending" | "approved" | "rejected" | "cancelled"
  resolvedByWorkspaceMemberId: string | null
  resolvedAt: Date | null
  reason: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export type InsertWorkspaceResourceGrantInput = {
  workspaceId: string
  workspaceResourceId: string
  target: ScopedTarget
  permissions: readonly WorkspaceResourceGrantPermission[]
  conversationTypeMaskOverride?: number | null
  source?: WorkspaceResourceGrantRow["source"]
  createdByWorkspaceMemberId?: string | null
  reason?: string | null
}

export type InsertWorkspaceResourceGrantRequestInput = {
  workspaceId: string
  workspaceResourceId: string
  grantee: ScopedTarget
  requestedPermissions: readonly WorkspaceResourceGrantPermission[]
  requesterWorkspaceMemberId: string
  reason?: string | null
}

function normalizePermissions(
  permissions: readonly WorkspaceResourceGrantPermission[]
): WorkspaceResourceGrantPermission[] {
  const unique = Array.from(new Set(permissions))
  if (unique.length === 0) {
    throw new Error("workspace resource grant permissions must be non-empty")
  }
  return unique.sort()
}

function assertConversationOnlyScope(scope: SubjectRef | undefined) {
  if (!scope) return
  if (scope.kind !== SUBJECT_KIND.CONVERSATION) {
    throw new Error(
      `workspace resource grant scope must be conversation, got ${scope.kind}`
    )
  }
}

async function resolveTargetSubjects(
  run: KyselyDb | Executor,
  target: ScopedTarget
): Promise<{ subjectId: string; scopeSubjectId: string | null }> {
  if ("selectFrom" in run) {
    const subjectId = await upsertAccessSubject(run, target.subject)
    const scopeSubjectId = target.scope
      ? await upsertAccessSubject(run, target.scope)
      : null
    return { subjectId, scopeSubjectId }
  }
  const subjectId = await upsertAccessSubjectOn(run, target.subject)
  const scopeSubjectId = target.scope
    ? await upsertAccessSubjectOn(run, target.scope)
    : null
  return { subjectId, scopeSubjectId }
}

async function loadWorkspaceResourceOwner(
  run: Executor | KyselyDb,
  workspaceResourceId: string
) {
  const row = await run
    .selectFrom("workspaceResourcesLive")
    .select(["workspaceId", "kind", "ownerSubjectId"])
    .where("id", "=", workspaceResourceId)
    .executeTakeFirst()
  return row
}

export async function insertWorkspaceResourceGrant(
  run: KyselyDb,
  input: InsertWorkspaceResourceGrantInput
): Promise<WorkspaceResourceGrantRow> {
  assertConversationOnlyScope(input.target.scope)
  const { subjectId, scopeSubjectId } = await resolveTargetSubjects(
    run,
    input.target
  )
  const inserted = await run
    .insertInto("workspaceResourceGrants")
    .values({
      workspaceId: input.workspaceId,
      workspaceResourceId: input.workspaceResourceId,
      subjectId: subjectId,
      scopeSubjectId: scopeSubjectId,
      permissions: normalizePermissions(input.permissions) as any,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
      source: input.source ?? WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId ?? null,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted
}

export async function revokeWorkspaceResourceGrant(
  run: KyselyDb,
  grantId: string
): Promise<boolean> {
  const updated = await run
    .updateTable("workspaceResourceGrants")
    .set({
      status: WORKSPACE_RESOURCE_GRANT_STATUS.REVOKED,
      revokedAt: sql`NOW()`,
    } as any)
    .where("id", "=", grantId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function revokeWorkspaceResourceGrantsForResource(
  run: KyselyDb,
  workspaceResourceId: string
): Promise<number> {
  const updated = await run
    .updateTable("workspaceResourceGrants")
    .set({
      status: WORKSPACE_RESOURCE_GRANT_STATUS.REVOKED,
      revokedAt: sql`NOW()`,
    } as any)
    .where("workspaceResourceId", "=", workspaceResourceId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .returning("id")
    .execute()
  return updated.length
}

export async function listActiveWorkspaceResourceGrants(
  run: KyselyDb,
  workspaceResourceId: string
): Promise<WorkspaceResourceGrantRow[]> {
  const rows = await run
    .selectFrom("workspaceResourceGrants")
    .selectAll()
    .where("workspaceResourceId", "=", workspaceResourceId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .orderBy("createdAt", "desc")
    .execute()
  return rows
}

export async function insertWorkspaceResourceGrantRequest(
  run: KyselyDb,
  input: InsertWorkspaceResourceGrantRequestInput
): Promise<WorkspaceResourceGrantRequestRow> {
  assertConversationOnlyScope(input.grantee.scope)
  const requestedPermissions = normalizePermissions(input.requestedPermissions)
  const { subjectId, scopeSubjectId } = await resolveTargetSubjects(
    run,
    input.grantee
  )

  const resource = await loadWorkspaceResourceOwner(
    run,
    input.workspaceResourceId
  )
  if (!resource) {
    throw new Error("workspace resource not found")
  }
  const ownerImplicitContactVisible =
    resource.kind === WORKSPACE_RESOURCE_KIND.ACTOR ||
    resource.kind === WORKSPACE_RESOURCE_KIND.REMOTE_AGENT
      ? resource.ownerSubjectId != null && resource.ownerSubjectId === subjectId
      : false
  if (ownerImplicitContactVisible) {
    throw new Error(
      "workspace resource grant already satisfied by owner visibility"
    )
  }

  const existingGrant = await run
    .selectFrom("workspaceResourceGrants")
    .select("id")
    .where("workspaceResourceId", "=", input.workspaceResourceId)
    .where("subjectId", "=", subjectId)
    .where((eb) =>
      scopeSubjectId
        ? eb("scopeSubjectId", "=", scopeSubjectId)
        : eb("scopeSubjectId", "is", null)
    )
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`'contact_visible'::workspace_resource_grant_permission = ANY(permissions)`
    )
    .executeTakeFirst()
  if (existingGrant) {
    throw new Error("workspace resource grant already exists")
  }

  const existing = await run
    .selectFrom("workspaceResourceGrantRequests")
    .selectAll()
    .where("workspaceResourceId", "=", input.workspaceResourceId)
    .where("requesterWorkspaceMemberId", "=", input.requesterWorkspaceMemberId)
    .where("granteeSubjectId", "=", subjectId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING)
    .where((eb) =>
      scopeSubjectId
        ? eb("granteeScopeSubjectId", "=", scopeSubjectId)
        : eb("granteeScopeSubjectId", "is", null)
    )
    .executeTakeFirst()
  if (existing) {
    return existing
  }

  const inserted = await run
    .insertInto("workspaceResourceGrantRequests")
    .values({
      workspaceId: input.workspaceId,
      workspaceResourceId: input.workspaceResourceId,
      granteeSubjectId: subjectId,
      granteeScopeSubjectId: scopeSubjectId,
      requestedPermissions: requestedPermissions as any,
      requesterWorkspaceMemberId: input.requesterWorkspaceMemberId,
      status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted
}

export async function cancelWorkspaceResourceGrantRequest(
  run: KyselyDb,
  params: {
    workspaceId: string
    workspaceResourceId: string
    requestId: string
    requesterWorkspaceMemberId: string
  }
): Promise<boolean> {
  const updated = await run
    .updateTable("workspaceResourceGrantRequests")
    .set({
      status: WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.CANCELLED,
      updatedAt: sql`NOW()`,
    } as any)
    .where("id", "=", params.requestId)
    .where("workspaceId", "=", params.workspaceId)
    .where("workspaceResourceId", "=", params.workspaceResourceId)
    .where("requesterWorkspaceMemberId", "=", params.requesterWorkspaceMemberId)
    .where("status", "=", WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function listWorkspaceResourceGrantRequests(
  run: KyselyDb,
  params: {
    workspaceResourceId: string
    direction: WorkspaceResourceGrantRequestDirection
    requesterWorkspaceMemberId?: string
  }
): Promise<WorkspaceResourceGrantRequestRow[]> {
  let query = run
    .selectFrom("workspaceResourceGrantRequests")
    .selectAll()
    .where("workspaceResourceId", "=", params.workspaceResourceId)
    .orderBy("createdAt", "desc")
  if (
    params.direction === WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.OUTGOING &&
    params.requesterWorkspaceMemberId
  ) {
    query = query.where(
      "requesterWorkspaceMemberId",
      "=",
      params.requesterWorkspaceMemberId
    )
  }
  const rows = await query.execute()
  return rows
}

export async function resolveWorkspaceResourceGrantRequest(params: {
  workspaceId: string
  workspaceResourceId: string
  requestId: string
  approverWorkspaceMemberId: string
  decision: "approve" | "reject"
  executor?: Executor
}): Promise<WorkspaceResourceGrantRequestRow> {
  const executeResolution = async (trx: Executor) => {
    const request = await trx
      .selectFrom("workspaceResourceGrantRequests")
      .selectAll()
      .where("id", "=", params.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!request) {
      throw new Error("workspace resource grant request not found")
    }
    if (
      request.workspaceId !== params.workspaceId ||
      request.workspaceResourceId !== params.workspaceResourceId
    ) {
      throw new Error(
        "workspace resource grant request does not belong to this workspace resource"
      )
    }
    if (request.status !== WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING) {
      throw new Error("workspace resource grant request is no longer pending")
    }

    if (params.decision === "approve") {
      const resource = await loadWorkspaceResourceOwner(
        trx,
        request.workspaceResourceId
      )
      if (!resource) {
        throw new Error("workspace resource not found")
      }

      const ownerImplicitContactVisible =
        resource.kind === WORKSPACE_RESOURCE_KIND.ACTOR ||
        resource.kind === WORKSPACE_RESOURCE_KIND.REMOTE_AGENT
          ? resource.ownerSubjectId != null &&
            resource.ownerSubjectId === request.granteeSubjectId
          : false

      if (!ownerImplicitContactVisible) {
        const existingGrant = await trx
          .selectFrom("workspaceResourceGrants")
          .select(["id", "permissions"])
          .where("workspaceResourceId", "=", request.workspaceResourceId)
          .where("subjectId", "=", request.granteeSubjectId)
          .where((eb) =>
            request.granteeScopeSubjectId
              ? eb("scopeSubjectId", "=", request.granteeScopeSubjectId)
              : eb("scopeSubjectId", "is", null)
          )
          .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
          .executeTakeFirst()

        if (!existingGrant) {
          await trx
            .insertInto("workspaceResourceGrants")
            .values({
              workspaceId: request.workspaceId,
              workspaceResourceId: request.workspaceResourceId,
              subjectId: request.granteeSubjectId,
              scopeSubjectId: request.granteeScopeSubjectId,
              permissions: [
                WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
              ] as any,
              conversationTypeMaskOverride: null,
              status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_RESOURCE_GRANT_SOURCE.APPROVAL,
              createdByWorkspaceMemberId: params.approverWorkspaceMemberId,
              reason: request.reason ?? null,
            } as any)
            .execute()
        } else if (
          !existingGrant.permissions.includes(
            WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE
          )
        ) {
          await sql`
            UPDATE workspace_resource_grants
            SET permissions = array_append(
              permissions,
              ${WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE}::workspace_resource_grant_permission
            )
            WHERE id = ${existingGrant.id}
          `.execute(trx)
        }
      }
    }

    const nextStatus =
      params.decision === "approve"
        ? WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.APPROVED
        : WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.REJECTED

    const updated = await trx
      .updateTable("workspaceResourceGrantRequests")
      .set({
        status: nextStatus,
        resolvedByWorkspaceMemberId: params.approverWorkspaceMemberId,
        resolvedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      } as any)
      .where("id", "=", params.requestId)
      .returningAll()
      .executeTakeFirstOrThrow()

    return updated
  }

  if (params.executor) {
    return executeResolution(params.executor)
  }
  return db.transaction().execute(async (trx) => executeResolution(trx))
}
