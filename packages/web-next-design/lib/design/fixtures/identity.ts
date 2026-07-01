// Single source of truth for "who am I" across the design sandbox.
//
// The chat UI decides which messages are yours by comparing a message author's
// workspaceMemberId against `useWorkspace().currentWorkspaceMemberId` — which
// comes from getWorkspaces(), NOT from the chat bootstrap. With random mocks the
// two never matched, so your own sent messages rendered as someone else's. These
// fixed ids tie the workspace, the auth session, and the chat viewer together.
import type { WorkspaceListView } from "@synapse/shared/schemas"
import { dateToIsoInstant } from "@synapse/shared/datetime"

export const designWorkspaceId = "ws-design"
export const designWorkspaceMemberId = "wm-viewer"
export const designUserId = "user-viewer"
export const designUserName = "林墨"

export const designWorkspaces: WorkspaceListView = [
  {
    id: designWorkspaceId,
    name: "设计工作区",
    slug: "design",
    description: "web-next-design 演示工作区",
    ownerId: designUserId,
    isTrusted: true,
    createdAt: dateToIsoInstant(new Date("2026-06-01T09:00:00Z")),
    updatedAt: dateToIsoInstant(new Date("2026-06-30T12:00:00Z")),
    currentWorkspaceMemberId: designWorkspaceMemberId,
    trustLevel: null,
  },
]
