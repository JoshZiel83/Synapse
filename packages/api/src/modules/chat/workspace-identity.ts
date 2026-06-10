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
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    // Soft delete (§8.4): only an active member + live user resolves to an identity.
    .where("wm.status", "=", "active")
    .where("u.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
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
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
  }
}
