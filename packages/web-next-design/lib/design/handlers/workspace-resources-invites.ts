import {
  WorkspaceResourceGrantListViewSchema,
  WorkspaceInvitePublicViewSchema,
  WorkspaceInviteRedeemResultSchema,
  WorkspaceInviteViewSchema,
  WorkspaceInviteListViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Workspace-resource grants (per-resource access list) plus the invite
// lifecycle: public info → redeem, and the management CRUD (create / list /
// revoke). These back the resource-access editors and the invite/join screens.
export const workspaceResourcesInvitesHandlers = {
  getWorkspaceResourceGrants: async () =>
    mock(WorkspaceResourceGrantListViewSchema),
  replaceWorkspaceResourceGrants: async () =>
    mock(WorkspaceResourceGrantListViewSchema),
  getInviteInfo: async () => mock(WorkspaceInvitePublicViewSchema),
  redeemInvite: async () => mock(WorkspaceInviteRedeemResultSchema),
  createInvite: async () => mock(WorkspaceInviteViewSchema),
  listInvites: async () => mock(WorkspaceInviteListViewSchema),
  revokeInvite: async () => mock(WorkspaceInviteViewSchema),
} satisfies DesignHandlers
