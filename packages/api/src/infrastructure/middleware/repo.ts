import { db } from "../database/kysely.js"

export type MiddlewareWorkspaceMember = {
  id: string
  workspaceId: string
  userId: string
  trustLevel: string
}

export async function findActiveWorkspaceMemberForMiddleware(input: {
  workspaceId: string
  userId: string
}): Promise<MiddlewareWorkspaceMember | undefined> {
  return (
    db
      .selectFrom("workspaceMembers")
      .select(["id", "workspaceId", "userId", "trustLevel"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.userId)
      // Soft delete (design §8.4): a left/removed member must lose workspace access.
      .where("status", "=", "active")
      .executeTakeFirst()
  )
}
