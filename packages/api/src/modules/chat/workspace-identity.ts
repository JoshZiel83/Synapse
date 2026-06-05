import { db } from "../../infrastructure/database/kysely.js"

export interface WorkspaceMemberIdentity {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  userName: string
  avatarFileId?: string | null
  trustLevel: string
}

export async function getWorkspaceMemberIdentity(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .select([
      "wm.id as workspace_member_id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "u.name as user_name",
      "u.avatar_file_id",
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .where("wm.user_id", "=", userId)
    // Soft delete (§8.4): only an active member + live user resolves to an identity.
    .where("wm.status", "=", "active")
    .where("u.deleted_at", "is", null)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspace_member_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    userName: row.user_name,
    avatarFileId: row.avatar_file_id,
    trustLevel: row.trust_level,
  }
}

export async function requireWorkspaceMemberIdentity(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberIdentity> {
  const identity = await getWorkspaceMemberIdentity(workspaceId, userId)
  if (!identity) {
    throw new Error("Workspace membership not found")
  }
  return identity
}

export async function getWorkspaceMemberIdentityById(
  workspaceMemberId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .select([
      "wm.id as workspace_member_id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "u.name as user_name",
      "u.avatar_file_id",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspace_member_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    userName: row.user_name,
    avatarFileId: row.avatar_file_id,
    trustLevel: row.trust_level,
  }
}
