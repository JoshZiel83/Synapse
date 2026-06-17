import { db, type TableInsert } from "../database/kysely.js"

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

export async function insertMiddlewareAuditLog(input: {
  workspaceId: string | null
  userId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  details: Record<string, unknown>
  ipAddress: string
}): Promise<void> {
  await db
    .insertInto("auditLogs")
    .values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: input.details as TableInsert<"auditLogs">["details"],
      ipAddress: input.ipAddress,
    })
    .execute()
}
