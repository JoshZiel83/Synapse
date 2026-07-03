import { getFileUrlById } from "../files/service.js"
import type { WorkspaceChiefActorPreference } from "@synapse/shared"
import {
  deriveWorkspaceTrustLevel,
  presentAccessBindingRow,
  presentMemberRow,
  presentWorkspaceChiefActorPreferenceRow,
} from "./presenter.js"
import type { WorkspaceAccessKey } from "./repo.types.js"
import * as repo from "./repo.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("workspace")

// Input/output contracts kept here for importers; the DB work lives in repo.ts.
export type { CreateWorkspaceInput, AddMemberInput } from "./repo.js"
export type { WorkspaceAccessKey }

// invite/repo.ts imports this from "../service.js" and calls it with its own
// trx; the implementation now lives in repo.ts (executor-injectable). Keep the
// re-export so that importer is unaffected.
export { assignOfficialChiefActorPreference } from "./repo.js"

async function requireWorkspaceMemberRowByUserId(
  workspaceId: string,
  userId: string
) {
  const member = await repo.getWorkspaceMemberRowByUserId(workspaceId, userId)
  if (!member) {
    throw new Error("Workspace membership not found")
  }
  return member
}

export async function createWorkspace(input: repo.CreateWorkspaceInput) {
  const result = await repo.createWorkspaceTx(input)

  // Bump catalog_items.download_count outside the workspace-creation
  // transaction. This used to live inline before the return and
  // deadlocked under concurrent workspace creates: two transactions
  // both ran `UPDATE catalog_items WHERE id IN (a, b, ...)` and
  // Postgres acquired the row locks in whatever order the planner
  // chose, so two simultaneous calls could lock {a then b} vs {b then
  // a} and one would always be killed by the deadlock detector.
  //
  // The count is best-effort observability — it must not roll back a
  // workspace create. Running it post-commit, one row at a time in
  // id-sorted order, removes the cycle (each tx grabs locks in the
  // same order) and a transient failure now just leaves the counter a
  // step behind instead of failing the user-visible request.
  const sortedTemplateIds = [...result.installedTemplatePackageIds].sort()
  for (const templateId of sortedTemplateIds) {
    try {
      await repo.bumpCatalogDownloadCount(templateId)
    } catch (err) {
      log.warn(
        { err },
        `[workspace.createWorkspace] best-effort download_count bump failed for catalog_item ${templateId}`
      )
    }
  }

  return {
    workspace: result.workspace,
    secretary: result.secretary,
  }
}

export async function listUserWorkspaces(userId: string) {
  return repo.listUserWorkspaces(userId)
}

export async function getWorkspaceById(workspaceId: string) {
  return repo.getWorkspaceById(workspaceId)
}

export async function getWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  const row = await repo.getChiefActorPreferenceRow(member.id)
  if (!row) {
    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  return presentWorkspaceChiefActorPreferenceRow(row)
}

export async function updateWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
  chiefActorId?: string | null
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  if (!chiefActorId) {
    // Clearing a preference physically removes the child row; routed through the
    // SECURITY DEFINER fn since sd_reject_delete forbids a naked DELETE (§7.5).
    await repo.clearMemberPreferences(member.id)

    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  const actorRow = await repo.findActiveActorInWorkspace(
    workspaceId,
    chiefActorId
  )

  if (!actorRow) {
    throw new Error("Chief actor is not available in this workspace")
  }

  await repo.upsertChiefActorPreference(member.id, chiefActorId)

  return getWorkspaceChiefActorPreference(workspaceId, userId)
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string }
) {
  if (updates.name === undefined && updates.description === undefined) {
    return getWorkspaceById(workspaceId)
  }

  return repo.updateWorkspaceRow(workspaceId, updates)
}

/**
 * Soft-delete a workspace and its entire tenant footprint (design §5.5). Runs
 * the markWorkspaceDeleted orchestration in one transaction: soft-deletes every
 * workspace-scoped root, revokes memberships/bindings/grants, stops runtime.
 * Returns false if the workspace was already gone / not live.
 */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  const live = await repo.isWorkspaceLive(workspaceId)
  if (!live) return false
  await repo.markWorkspaceDeletedTx(workspaceId)
  return true
}

export async function checkMembership(workspaceId: string, userId: string) {
  const row = await repo.checkMembershipRow(workspaceId, userId)
  return row ? deriveWorkspaceTrustLevel(row) : null
}

export async function addMember(input: repo.AddMemberInput) {
  const result = await repo.addMemberTx(input)

  if (!result) {
    return null
  }

  return result.member
}

export async function listMembers(workspaceId: string) {
  const rows = await repo.listMembersWithAccess(workspaceId)
  return rows.map((row) => ({
    ...presentMemberRow(row),
    userName: row.userName,
    userEmail: row.userEmail,
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : null,
    accessKeys: Array.isArray(row.accessKeys) ? row.accessKeys : [],
  }))
}

export async function listWorkspaceAccessBindings(workspaceId: string) {
  const rows = await repo.listWorkspaceAccessBindingsRows(workspaceId)

  return rows.map((row) =>
    presentAccessBindingRow({
      workspaceId: row.workspaceId,
      workspaceMemberId: row.workspaceMemberId,
      userId: row.userId,
      accessKey: row.accessKey as WorkspaceAccessKey,
      assignedByWorkspaceMemberId: row.assignedByWorkspaceMemberId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      trustLevel: deriveWorkspaceTrustLevel(row),
      userName: row.userName,
      userEmail: row.userEmail,
      avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : null,
    })
  )
}

export async function grantWorkspaceAccess(input: {
  workspaceId: string
  workspaceMemberId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId: string
}) {
  const membership = await repo.getWorkspaceMemberRowById(
    input.workspaceMemberId
  )

  if (!membership || membership.workspaceId !== input.workspaceId) {
    throw new Error("Workspace member is not part of this workspace")
  }

  // Re-grant must revive a previously-revoked row (design §6.2). "Already
  // granted" is detected by checking the pre-existing active state.
  const existing = await repo.getActiveAccessBindingStatus(
    input.workspaceMemberId,
    input.accessKey
  )
  if (existing?.status === "active") {
    throw new Error("Access already granted")
  }

  const row = await repo.upsertAccessBinding({
    workspaceMemberId: input.workspaceMemberId,
    accessKey: input.accessKey,
    assignedByWorkspaceMemberId: input.assignedByWorkspaceMemberId,
  })

  if (!row) {
    throw new Error("Access already granted")
  }

  return presentAccessBindingRow({
    workspaceId: membership.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
    userId: membership.userId,
    accessKey: row.accessKey as WorkspaceAccessKey,
    assignedByWorkspaceMemberId: row.assignedByWorkspaceMemberId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
}

export async function revokeWorkspaceAccess(
  workspaceId: string,
  workspaceMemberId: string,
  accessKey: WorkspaceAccessKey
) {
  const membership = await repo.getWorkspaceMemberRowById(workspaceMemberId)
  if (!membership || membership.workspaceId !== workspaceId) {
    throw new Error("Access grant not found")
  }

  // Soft revoke (design §6.2 option A): flip status instead of hard-deleting the
  // row (which sd_reject_delete forbids). Re-granting revives the row. The
  // revoker identity is not threaded to this layer.
  const row = await repo.softRevokeAccessBinding(workspaceMemberId, accessKey)

  if (!row) {
    throw new Error("Access grant not found")
  }
}
