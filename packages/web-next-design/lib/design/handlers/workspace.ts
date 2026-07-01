import {
  WorkspaceListViewSchema,
  WorkspaceViewSchema,
  WorkspaceCreateResultViewSchema,
  WorkspaceMemberListViewSchema,
  WorkspaceNavigationViewSchema,
  WorkspaceAccessBindingListViewSchema,
  WorkspaceAccessBindingViewSchema,
  WorkspaceCapabilityConversationTypePoliciesViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Workspace shell: list / detail / members / navigation / access. These feed the
// dashboard layout and most list pages, so they are the highest-value mocks.
export const workspaceHandlers = {
  getWorkspaces: async () => mock(WorkspaceListViewSchema),
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
