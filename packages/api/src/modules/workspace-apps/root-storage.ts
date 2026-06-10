import { sql } from "kysely"
import type {
  Executor,
  KyselyDb,
} from "../../infrastructure/database/kysely.js"
import type { WorkspaceAppKind, WorkspaceAppStatus } from "@synapse/shared"

export async function insertWorkspaceAppRoot(
  run: KyselyDb | Executor,
  input: {
    id: string
    workspaceId: string
    kind: WorkspaceAppKind
    displayName: string
    ownerWorkspaceMemberId?: string | null
    status?: WorkspaceAppStatus
    conversationTypeMaskOverride?: number | null
  }
) {
  await run
    .insertInto("workspaceApps")
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      displayName: input.displayName,
      ownerWorkspaceMemberId: input.ownerWorkspaceMemberId ?? null,
      status: input.status ?? "active",
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
    } as any)
    .execute()
}

export async function updateWorkspaceAppRoot(
  run: KyselyDb | Executor,
  input: {
    id: string
    displayName?: string
    ownerWorkspaceMemberId?: string | null
    status?: WorkspaceAppStatus
    conversationTypeMaskOverride?: number | null
    deletedAt?: Date | null
  }
) {
  const patch: Record<string, unknown> = {
    updatedAt: sql`NOW()`,
  }
  if (input.displayName !== undefined) {
    patch.displayName = input.displayName
  }
  if (input.ownerWorkspaceMemberId !== undefined) {
    patch.ownerWorkspaceMemberId = input.ownerWorkspaceMemberId
  }
  if (input.status !== undefined) {
    patch.status = input.status
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    patch.conversationTypeMaskOverride = input.conversationTypeMaskOverride
  }
  if (input.deletedAt !== undefined) {
    patch.deletedAt = input.deletedAt
  }

  await run
    .updateTable("workspaceApps")
    .set(patch as any)
    .where("id", "=", input.id)
    .execute()
}
