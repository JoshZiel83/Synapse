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
    .insertInto("workspace_apps")
    .values({
      id: input.id,
      workspace_id: input.workspaceId,
      kind: input.kind,
      display_name: input.displayName,
      owner_workspace_member_id: input.ownerWorkspaceMemberId ?? null,
      status: input.status ?? "active",
      conversation_type_mask_override:
        input.conversationTypeMaskOverride ?? null,
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
    updated_at: sql`NOW()`,
  }
  if (input.displayName !== undefined) {
    patch.display_name = input.displayName
  }
  if (input.ownerWorkspaceMemberId !== undefined) {
    patch.owner_workspace_member_id = input.ownerWorkspaceMemberId
  }
  if (input.status !== undefined) {
    patch.status = input.status
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    patch.conversation_type_mask_override = input.conversationTypeMaskOverride
  }
  if (input.deletedAt !== undefined) {
    patch.deleted_at = input.deletedAt
  }

  await run
    .updateTable("workspace_apps")
    .set(patch as any)
    .where("id", "=", input.id)
    .execute()
}
