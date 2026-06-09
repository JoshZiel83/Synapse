/**
 * Contact visibility for actor / remote_agent workspace apps is expressed by
 * `workspace_app_grants` rows:
 * - a workspace-scoped `contact_visible` grant with `source=system`
 *   means no approval is required
 * - otherwise members must be explicitly granted `contact_visible`
 *
 * The historical actor/remote-agent access-policy columns are gone. This
 * module is the single point where the derived `requiresContactApproval`
 * intent is read and written.
 */

import {
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_SOURCE,
  WORKSPACE_APP_GRANT_STATUS,
  workspaceMemberRef,
} from "@synapse/shared"
import { sql } from "kysely"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { insertWorkspaceAppGrant } from "../workspace-apps/grant-storage.js"

const DEFAULT_CONTACT_VISIBILITY_GRANT_REASON =
  "workspace contact-visible grant written by access lifecycle"

async function hasWorkspaceDefaultContactVisibilityGrant(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  const row = await db
    .selectFrom("workspace_app_grants as app_grant")
    .innerJoin("access_subjects as subj", "subj.id", "app_grant.subject_id")
    .innerJoin("workspace_apps as app", "app.id", "app_grant.workspace_app_id")
    .select("app_grant.id")
    .where("app.kind", "=", resourceType)
    .where("app_grant.workspace_app_id", "=", resourceId)
    .where("subj.kind", "=", "workspace")
    .where("subj.workspace_id", "=", workspaceId)
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function deriveRequiresContactApproval(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  return !(await hasWorkspaceDefaultContactVisibilityGrant(
    db,
    resourceType,
    resourceId,
    workspaceId
  ))
}

export async function deriveRequiresContactApprovalMany(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  workspaceId: string,
  resourceIds: readonly string[]
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (resourceIds.length === 0) return out
  for (const id of resourceIds) {
    out.set(id, true)
  }
  const rows = await db
    .selectFrom("workspace_app_grants as app_grant")
    .innerJoin("access_subjects as subj", "subj.id", "app_grant.subject_id")
    .innerJoin("workspace_apps as app", "app.id", "app_grant.workspace_app_id")
    .select(["app_grant.workspace_app_id as resource_id"])
    .where("app.kind", "=", resourceType)
    .where("app_grant.workspace_app_id", "in", [...resourceIds])
    .where("subj.kind", "=", "workspace")
    .where("subj.workspace_id", "=", workspaceId)
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .execute()
  for (const row of rows as Array<{ resource_id: string | null }>) {
    if (row.resource_id) {
      out.set(row.resource_id, false)
    }
  }
  return out
}

/**
 * Idempotently align the workspace-wide contact-visible grant to the
 * desired approval requirement. Call this on actor/remote_agent creation and
 * on approval-setting updates.
 */
export async function setRequiresContactApproval(
  db: KyselyDb,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    requiresContactApproval: boolean
    createdByWorkspaceMemberId?: string | null
  }
): Promise<void> {
  if (!params.requiresContactApproval) {
    const existing = await hasWorkspaceDefaultContactVisibilityGrant(
      db,
      params.resourceType,
      params.resourceId,
      params.workspaceId
    )
    if (existing) return
    await insertWorkspaceAppGrant(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.resourceId,
      target: {
        subject: { kind: "workspace", workspaceId: params.workspaceId },
      },
      permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      source: WORKSPACE_APP_GRANT_SOURCE.SYSTEM,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: DEFAULT_CONTACT_VISIBILITY_GRANT_REASON,
    })
    return
  }

  await db
    .updateTable("workspace_app_grants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revoked_at: new Date(),
    } as any)
    .where("workspace_app_id", "=", params.resourceId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
    )
    .where("reason", "=", DEFAULT_CONTACT_VISIBILITY_GRANT_REASON)
    .execute()
}

export async function grantApprovedContactVisibility(
  db: KyselyDb,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    grantedToMemberId: string
    grantedByWorkspaceMemberId?: string | null
    reason?: string | null
  }
) {
  const subjectId = await db
    .selectFrom("access_subjects")
    .select("id")
    .where("workspace_member_id", "=", params.grantedToMemberId)
    .where("kind", "=", "workspace_member")
    .executeTakeFirst()
  if (subjectId) {
    const existing = await db
      .selectFrom("workspace_app_grants")
      .select("id")
      .where("workspace_id", "=", params.workspaceId)
      .where("workspace_app_id", "=", params.resourceId)
      .where("subject_id", "=", subjectId.id)
      .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
      .where("scope_subject_id", "is", null)
      .where(
        sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
      )
      .executeTakeFirst()
    if (existing?.id) {
      return existing.id
    }
  }

  const inserted = await insertWorkspaceAppGrant(db, {
    workspaceId: params.workspaceId,
    workspaceAppId: params.resourceId,
    target: { subject: workspaceMemberRef(params.grantedToMemberId) },
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
    source: WORKSPACE_APP_GRANT_SOURCE.APPROVAL,
    createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
    reason: params.reason ?? "approved contact visibility grant",
  })
  return inserted.id
}
