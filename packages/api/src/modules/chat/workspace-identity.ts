// chat workspace-member identity — public surface. The DB reads + the
// WorkspaceMemberIdentity record live in ./repo.ts (the only chat file allowed
// to touch the db client, guard r8); this module re-exports them and adds the
// pure require* wrapper, so the cross-module importers stay unchanged. r6 P1-6.

import {
  getWorkspaceMemberIdentity,
  type WorkspaceMemberIdentity,
} from "./repo.js"

export { getWorkspaceMemberIdentity, type WorkspaceMemberIdentity }

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
