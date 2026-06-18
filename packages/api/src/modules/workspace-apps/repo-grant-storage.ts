// Workspace app grant/request repo storage.

import { sql } from "kysely"
import {
  SUBJECT_KIND,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTION,
  type WorkspaceAppGrantRequestDirection,
  WORKSPACE_APP_GRANT_REQUEST_STATUS,
  WORKSPACE_APP_GRANT_SOURCE,
  WORKSPACE_APP_GRANT_STATUS,
  type SubjectRef,
  type WorkspaceAppGrantPermission,
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

export type WorkspaceAppGrantRow = {
  id: string
  workspaceId: string
  workspaceAppId: string
  subjectId: string
  scopeSubjectId: string | null
  permissions: WorkspaceAppGrantPermission[]
  conversationTypeMaskOverride: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  createdByWorkspaceMemberId: string | null
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}

export type WorkspaceAppGrantRequestRow = {
  id: string
  workspaceId: string
  workspaceAppId: string
  granteeSubjectId: string
  granteeScopeSubjectId: string | null
  requestedPermissions: WorkspaceAppGrantPermission[]
  requesterWorkspaceMemberId: string
  status: "pending" | "approved" | "rejected" | "cancelled"
  resolvedByWorkspaceMemberId: string | null
  resolvedAt: Date | null
  reason: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export type InsertWorkspaceAppGrantInput = {
  workspaceId: string
  workspaceAppId: string
  target: ScopedTarget
  permissions: readonly WorkspaceAppGrantPermission[]
  conversationTypeMaskOverride?: number | null
  source?: WorkspaceAppGrantRow["source"]
  createdByWorkspaceMemberId?: string | null
  reason?: string | null
}

export type InsertWorkspaceAppGrantRequestInput = {
  workspaceId: string
  workspaceAppId: string
  grantee: ScopedTarget
  requestedPermissions: readonly WorkspaceAppGrantPermission[]
  requesterWorkspaceMemberId: string
  reason?: string | null
}

function normalizePermissions(
  permissions: readonly WorkspaceAppGrantPermission[]
): WorkspaceAppGrantPermission[] {
  const unique = Array.from(new Set(permissions))
  if (unique.length === 0) {
    throw new Error("workspace app grant permissions must be non-empty")
  }
  return unique.sort()
}

function assertConversationOnlyScope(scope: SubjectRef | undefined) {
  if (!scope) return
  if (scope.kind !== SUBJECT_KIND.CONVERSATION) {
    throw new Error(
      `workspace app grant scope must be conversation, got ${scope.kind}`
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

async function loadWorkspaceAppOwner(
  run: Executor | KyselyDb,
  workspaceAppId: string
) {
  const row = await run
    .selectFrom("workspaceAppsLive")
    .select(["workspaceId", "kind", "ownerWorkspaceMemberId"])
    .where("id", "=", workspaceAppId)
    .executeTakeFirst()
  return row
}

export async function insertWorkspaceAppGrant(
  run: KyselyDb,
  input: InsertWorkspaceAppGrantInput
): Promise<WorkspaceAppGrantRow> {
  assertConversationOnlyScope(input.target.scope)
  const { subjectId, scopeSubjectId } = await resolveTargetSubjects(
    run,
    input.target
  )
  const inserted = await run
    .insertInto("workspaceAppGrants")
    .values({
      workspaceId: input.workspaceId,
      workspaceAppId: input.workspaceAppId,
      subjectId: subjectId,
      scopeSubjectId: scopeSubjectId,
      permissions: normalizePermissions(input.permissions) as any,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
      source: input.source ?? WORKSPACE_APP_GRANT_SOURCE.MANUAL,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId ?? null,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted
}

export async function revokeWorkspaceAppGrant(
  run: KyselyDb,
  grantId: string
): Promise<boolean> {
  const updated = await run
    .updateTable("workspaceAppGrants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revokedAt: sql`NOW()`,
    } as any)
    .where("id", "=", grantId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function revokeWorkspaceAppGrantsForApp(
  run: KyselyDb,
  workspaceAppId: string
): Promise<number> {
  const updated = await run
    .updateTable("workspaceAppGrants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revokedAt: sql`NOW()`,
    } as any)
    .where("workspaceAppId", "=", workspaceAppId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .returning("id")
    .execute()
  return updated.length
}

export async function listActiveWorkspaceAppGrants(
  run: KyselyDb,
  workspaceAppId: string
): Promise<WorkspaceAppGrantRow[]> {
  const rows = await run
    .selectFrom("workspaceAppGrants")
    .selectAll()
    .where("workspaceAppId", "=", workspaceAppId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .orderBy("createdAt", "desc")
    .execute()
  return rows
}

export async function insertWorkspaceAppGrantRequest(
  run: KyselyDb,
  input: InsertWorkspaceAppGrantRequestInput
): Promise<WorkspaceAppGrantRequestRow> {
  assertConversationOnlyScope(input.grantee.scope)
  const requestedPermissions = normalizePermissions(input.requestedPermissions)
  const { subjectId, scopeSubjectId } = await resolveTargetSubjects(
    run,
    input.grantee
  )

  const app = await loadWorkspaceAppOwner(run, input.workspaceAppId)
  if (!app) {
    throw new Error("workspace app not found")
  }
  const ownerImplicitContactVisible =
    app.kind === WORKSPACE_APP_KIND.ACTOR ||
    app.kind === WORKSPACE_APP_KIND.REMOTE_AGENT
      ? await (async () => {
          if (!app.ownerWorkspaceMemberId) return false
          const ownerSubjectId = await upsertAccessSubject(run, {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: app.ownerWorkspaceMemberId,
          })
          return ownerSubjectId === subjectId
        })()
      : false
  if (ownerImplicitContactVisible) {
    throw new Error("workspace app grant already satisfied by owner visibility")
  }

  const existingGrant = await run
    .selectFrom("workspaceAppGrants")
    .select("id")
    .where("workspaceAppId", "=", input.workspaceAppId)
    .where("subjectId", "=", subjectId)
    .where((eb) =>
      scopeSubjectId
        ? eb("scopeSubjectId", "=", scopeSubjectId)
        : eb("scopeSubjectId", "is", null)
    )
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
    )
    .executeTakeFirst()
  if (existingGrant) {
    throw new Error("workspace app grant already exists")
  }

  const existing = await run
    .selectFrom("workspaceAppGrantRequests")
    .selectAll()
    .where("workspaceAppId", "=", input.workspaceAppId)
    .where("requesterWorkspaceMemberId", "=", input.requesterWorkspaceMemberId)
    .where("granteeSubjectId", "=", subjectId)
    .where("status", "=", WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING)
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
    .insertInto("workspaceAppGrantRequests")
    .values({
      workspaceId: input.workspaceId,
      workspaceAppId: input.workspaceAppId,
      granteeSubjectId: subjectId,
      granteeScopeSubjectId: scopeSubjectId,
      requestedPermissions: requestedPermissions as any,
      requesterWorkspaceMemberId: input.requesterWorkspaceMemberId,
      status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted
}

export async function cancelWorkspaceAppGrantRequest(
  run: KyselyDb,
  params: {
    workspaceId: string
    workspaceAppId: string
    requestId: string
    requesterWorkspaceMemberId: string
  }
): Promise<boolean> {
  const updated = await run
    .updateTable("workspaceAppGrantRequests")
    .set({
      status: WORKSPACE_APP_GRANT_REQUEST_STATUS.CANCELLED,
      updatedAt: sql`NOW()`,
    } as any)
    .where("id", "=", params.requestId)
    .where("workspaceId", "=", params.workspaceId)
    .where("workspaceAppId", "=", params.workspaceAppId)
    .where("requesterWorkspaceMemberId", "=", params.requesterWorkspaceMemberId)
    .where("status", "=", WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function listWorkspaceAppGrantRequests(
  run: KyselyDb,
  params: {
    workspaceAppId: string
    direction: WorkspaceAppGrantRequestDirection
    requesterWorkspaceMemberId?: string
  }
): Promise<WorkspaceAppGrantRequestRow[]> {
  let query = run
    .selectFrom("workspaceAppGrantRequests")
    .selectAll()
    .where("workspaceAppId", "=", params.workspaceAppId)
    .orderBy("createdAt", "desc")
  if (
    params.direction === WORKSPACE_APP_GRANT_REQUEST_DIRECTION.OUTGOING &&
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

export async function resolveWorkspaceAppGrantRequest(params: {
  workspaceId: string
  workspaceAppId: string
  requestId: string
  approverWorkspaceMemberId: string
  decision: "approve" | "reject"
  executor?: Executor
}): Promise<WorkspaceAppGrantRequestRow> {
  const executeResolution = async (trx: Executor) => {
    const request = await trx
      .selectFrom("workspaceAppGrantRequests")
      .selectAll()
      .where("id", "=", params.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!request) {
      throw new Error("workspace app grant request not found")
    }
    if (
      request.workspaceId !== params.workspaceId ||
      request.workspaceAppId !== params.workspaceAppId
    ) {
      throw new Error("workspace app grant request does not belong to this app")
    }
    if (request.status !== WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING) {
      throw new Error("workspace app grant request is no longer pending")
    }

    if (params.decision === "approve") {
      const app = await loadWorkspaceAppOwner(trx, request.workspaceAppId)
      if (!app) {
        throw new Error("workspace app not found")
      }

      const ownerImplicitContactVisible =
        app.kind === WORKSPACE_APP_KIND.ACTOR ||
        app.kind === WORKSPACE_APP_KIND.REMOTE_AGENT
          ? await (async () => {
              if (!app.ownerWorkspaceMemberId) return false
              const ownerSubjectId = await upsertAccessSubjectOn(trx, {
                kind: SUBJECT_KIND.WORKSPACE_MEMBER,
                memberId: app.ownerWorkspaceMemberId,
              })
              return ownerSubjectId === request.granteeSubjectId
            })()
          : false

      if (!ownerImplicitContactVisible) {
        const existingGrant = await trx
          .selectFrom("workspaceAppGrants")
          .select(["id", "permissions"])
          .where("workspaceAppId", "=", request.workspaceAppId)
          .where("subjectId", "=", request.granteeSubjectId)
          .where((eb) =>
            request.granteeScopeSubjectId
              ? eb("scopeSubjectId", "=", request.granteeScopeSubjectId)
              : eb("scopeSubjectId", "is", null)
          )
          .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
          .executeTakeFirst()

        if (!existingGrant) {
          await trx
            .insertInto("workspaceAppGrants")
            .values({
              workspaceId: request.workspaceId,
              workspaceAppId: request.workspaceAppId,
              subjectId: request.granteeSubjectId,
              scopeSubjectId: request.granteeScopeSubjectId,
              permissions: [
                WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
              ] as any,
              conversationTypeMaskOverride: null,
              status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_APP_GRANT_SOURCE.APPROVAL,
              createdByWorkspaceMemberId: params.approverWorkspaceMemberId,
              reason: request.reason ?? null,
            } as any)
            .execute()
        } else if (
          !existingGrant.permissions.includes(
            WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE
          )
        ) {
          await sql`
            UPDATE workspace_app_grants
            SET permissions = array_append(
              permissions,
              ${WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE}::workspace_app_grant_permission
            )
            WHERE id = ${existingGrant.id}
          `.execute(trx)
        }
      }
    }

    const nextStatus =
      params.decision === "approve"
        ? WORKSPACE_APP_GRANT_REQUEST_STATUS.APPROVED
        : WORKSPACE_APP_GRANT_REQUEST_STATUS.REJECTED

    const updated = await trx
      .updateTable("workspaceAppGrantRequests")
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
