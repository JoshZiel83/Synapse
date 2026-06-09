import { sql } from "kysely"
import {
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
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
  workspace_id: string
  workspace_app_id: string
  subject_id: string
  scope_subject_id: string | null
  permissions: WorkspaceAppGrantPermission[]
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: Date
  revoked_at: Date | null
}

export type WorkspaceAppGrantRequestRow = {
  id: string
  workspace_id: string
  workspace_app_id: string
  grantee_subject_id: string
  grantee_scope_subject_id: string | null
  requested_permissions: WorkspaceAppGrantPermission[]
  requester_workspace_member_id: string
  status: "pending" | "approved" | "rejected" | "cancelled"
  resolved_by_workspace_member_id: string | null
  resolved_at: Date | null
  reason: string | null
  created_at: Date
  updated_at: Date
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
    .selectFrom("workspace_apps")
    .select(["workspace_id", "kind", "owner_workspace_member_id"])
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
    .insertInto("workspace_app_grants")
    .values({
      workspace_id: input.workspaceId,
      workspace_app_id: input.workspaceAppId,
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId,
      permissions: normalizePermissions(input.permissions) as any,
      conversation_type_mask_override:
        input.conversationTypeMaskOverride ?? null,
      status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
      source: input.source ?? WORKSPACE_APP_GRANT_SOURCE.MANUAL,
      created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted as unknown as WorkspaceAppGrantRow
}

export async function revokeWorkspaceAppGrant(
  run: KyselyDb,
  grantId: string
): Promise<boolean> {
  const updated = await run
    .updateTable("workspace_app_grants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revoked_at: sql`NOW()`,
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
    .updateTable("workspace_app_grants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revoked_at: sql`NOW()`,
    } as any)
    .where("workspace_app_id", "=", workspaceAppId)
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
    .selectFrom("workspace_app_grants")
    .selectAll()
    .where("workspace_app_id", "=", workspaceAppId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .orderBy("created_at", "desc")
    .execute()
  return rows as unknown as WorkspaceAppGrantRow[]
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
    app.kind === "actor" || app.kind === "remote_agent"
      ? await (async () => {
          if (!app.owner_workspace_member_id) return false
          const ownerSubjectId = await upsertAccessSubject(run, {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: app.owner_workspace_member_id,
          })
          return ownerSubjectId === subjectId
        })()
      : false
  if (ownerImplicitContactVisible) {
    throw new Error("workspace app grant already satisfied by owner visibility")
  }

  const existingGrant = await run
    .selectFrom("workspace_app_grants")
    .select("id")
    .where("workspace_app_id", "=", input.workspaceAppId)
    .where("subject_id", "=", subjectId)
    .where((eb) =>
      scopeSubjectId
        ? eb("scope_subject_id", "=", scopeSubjectId)
        : eb("scope_subject_id", "is", null)
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
    .selectFrom("workspace_app_grant_requests")
    .selectAll()
    .where("workspace_app_id", "=", input.workspaceAppId)
    .where(
      "requester_workspace_member_id",
      "=",
      input.requesterWorkspaceMemberId
    )
    .where("grantee_subject_id", "=", subjectId)
    .where("status", "=", WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING)
    .where((eb) =>
      scopeSubjectId
        ? eb("grantee_scope_subject_id", "=", scopeSubjectId)
        : eb("grantee_scope_subject_id", "is", null)
    )
    .executeTakeFirst()
  if (existing) {
    return existing as unknown as WorkspaceAppGrantRequestRow
  }

  const inserted = await run
    .insertInto("workspace_app_grant_requests")
    .values({
      workspace_id: input.workspaceId,
      workspace_app_id: input.workspaceAppId,
      grantee_subject_id: subjectId,
      grantee_scope_subject_id: scopeSubjectId,
      requested_permissions: requestedPermissions as any,
      requester_workspace_member_id: input.requesterWorkspaceMemberId,
      status: WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
      reason: input.reason ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return inserted as unknown as WorkspaceAppGrantRequestRow
}

export async function cancelWorkspaceAppGrantRequest(
  run: KyselyDb,
  requestId: string,
  requesterWorkspaceMemberId: string
): Promise<boolean> {
  const updated = await run
    .updateTable("workspace_app_grant_requests")
    .set({
      status: WORKSPACE_APP_GRANT_REQUEST_STATUS.CANCELLED,
      updated_at: sql`NOW()`,
    } as any)
    .where("id", "=", requestId)
    .where("requester_workspace_member_id", "=", requesterWorkspaceMemberId)
    .where("status", "=", WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function listWorkspaceAppGrantRequests(
  run: KyselyDb,
  params: {
    workspaceAppId: string
    direction: "incoming" | "outgoing"
    requesterWorkspaceMemberId?: string
  }
): Promise<WorkspaceAppGrantRequestRow[]> {
  let query = run
    .selectFrom("workspace_app_grant_requests")
    .selectAll()
    .where("workspace_app_id", "=", params.workspaceAppId)
    .orderBy("created_at", "desc")
  if (params.direction === "outgoing" && params.requesterWorkspaceMemberId) {
    query = query.where(
      "requester_workspace_member_id",
      "=",
      params.requesterWorkspaceMemberId
    )
  }
  const rows = await query.execute()
  return rows as unknown as WorkspaceAppGrantRequestRow[]
}

export async function resolveWorkspaceAppGrantRequest(params: {
  requestId: string
  approverWorkspaceMemberId: string
  decision: "approve" | "reject"
}): Promise<WorkspaceAppGrantRequestRow> {
  return db.transaction().execute(async (trx) => {
    const request = await trx
      .selectFrom("workspace_app_grant_requests")
      .selectAll()
      .where("id", "=", params.requestId)
      .forUpdate()
      .executeTakeFirst()

    if (!request) {
      throw new Error("workspace app grant request not found")
    }
    if (request.status !== WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING) {
      throw new Error("workspace app grant request is no longer pending")
    }

    if (params.decision === "approve") {
      const app = await loadWorkspaceAppOwner(trx, request.workspace_app_id)
      if (!app) {
        throw new Error("workspace app not found")
      }

      const ownerImplicitContactVisible =
        app.kind === "actor" || app.kind === "remote_agent"
          ? await (async () => {
              if (!app.owner_workspace_member_id) return false
              const ownerSubjectId = await upsertAccessSubjectOn(trx, {
                kind: SUBJECT_KIND.WORKSPACE_MEMBER,
                memberId: app.owner_workspace_member_id,
              })
              return ownerSubjectId === request.grantee_subject_id
            })()
          : false

      if (!ownerImplicitContactVisible) {
        const existingGrant = await trx
          .selectFrom("workspace_app_grants")
          .select("id")
          .where("workspace_app_id", "=", request.workspace_app_id)
          .where("subject_id", "=", request.grantee_subject_id)
          .where((eb) =>
            request.grantee_scope_subject_id
              ? eb("scope_subject_id", "=", request.grantee_scope_subject_id)
              : eb("scope_subject_id", "is", null)
          )
          .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
          .executeTakeFirst()

        if (!existingGrant) {
          await trx
            .insertInto("workspace_app_grants")
            .values({
              workspace_id: request.workspace_id,
              workspace_app_id: request.workspace_app_id,
              subject_id: request.grantee_subject_id,
              scope_subject_id: request.grantee_scope_subject_id,
              permissions: [
                WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
              ] as any,
              conversation_type_mask_override: null,
              status: WORKSPACE_APP_GRANT_STATUS.ACTIVE,
              source: WORKSPACE_APP_GRANT_SOURCE.APPROVAL,
              created_by_workspace_member_id: params.approverWorkspaceMemberId,
              reason: request.reason ?? null,
            } as any)
            .execute()
        }
      }
    }

    const nextStatus =
      params.decision === "approve"
        ? WORKSPACE_APP_GRANT_REQUEST_STATUS.APPROVED
        : WORKSPACE_APP_GRANT_REQUEST_STATUS.REJECTED

    const updated = await trx
      .updateTable("workspace_app_grant_requests")
      .set({
        status: nextStatus,
        resolved_by_workspace_member_id: params.approverWorkspaceMemberId,
        resolved_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      } as any)
      .where("id", "=", params.requestId)
      .returningAll()
      .executeTakeFirstOrThrow()

    return updated as unknown as WorkspaceAppGrantRequestRow
  })
}
