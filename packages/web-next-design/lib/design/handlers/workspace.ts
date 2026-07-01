import {
  WorkspaceViewSchema,
  WorkspaceCreateResultViewSchema,
  WorkspaceMemberListViewSchema,
  WorkspaceNavigationViewSchema,
  WorkspaceAccessBindingListViewSchema,
  WorkspaceAccessBindingViewSchema,
  WorkspaceCapabilityConversationTypePoliciesViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import { designWorkspaces } from "../fixtures/identity"
import type { DesignHandlers } from "./_types"

// Workspace shell: list / detail / members / navigation / access. These feed the
// dashboard layout and most list pages, so they are the highest-value mocks.
export const workspaceHandlers = {
  // Fixed workspace so `useWorkspace().currentWorkspaceMemberId` === the chat
  // viewer (wm-viewer) — that's how the chat UI knows which messages are yours.
  getWorkspaces: async () => designWorkspaces,
  getWorkspace: async () => mock(WorkspaceViewSchema),
  createWorkspace: async () => mock(WorkspaceCreateResultViewSchema),
  getWorkspaceMembers: async () => mock(WorkspaceMemberListViewSchema),
  getWorkspaceNavigation: async () => mock(WorkspaceNavigationViewSchema),
  getWorkspaceAccess: async () => mock(WorkspaceAccessBindingListViewSchema),
  grantWorkspaceAccess: async () => mock(WorkspaceAccessBindingViewSchema),
  revokeWorkspaceAccess: async () => mock(WorkspaceAccessBindingViewSchema),
  getWorkspaceCapabilityConversationTypePolicies: async () =>
    mock(WorkspaceCapabilityConversationTypePoliciesViewSchema),
  updateWorkspaceCapabilityConversationTypePolicies: async () =>
    mock(WorkspaceCapabilityConversationTypePoliciesViewSchema),
} satisfies DesignHandlers
