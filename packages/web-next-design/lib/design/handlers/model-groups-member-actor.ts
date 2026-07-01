import {
  ModelGroupListViewSchema,
  ModelGroupViewSchema,
  ModelGroupDetailViewSchema,
  ModelGroupGrantListViewSchema,
  ModelGroupGrantViewSchema,
  ModelGroupItemViewSchema,
  ModelGroupItemVersionListViewSchema,
  ActorModelGroupAssignmentListViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Model-groups settings surface for the workspace-member ("me") routes plus the
// actor failover-chain assignment endpoints. Groups carry their items and grants
// in the detail view; the actor endpoints return assignment / list views. The
// void DELETE / revoke mutations are left to the Proxy catch-all.
export const modelGroupsMemberActorHandlers = {
  getWorkspaceMemberModelGroups: async () => mock(ModelGroupListViewSchema),
  createWorkspaceMemberModelGroup: async () => mock(ModelGroupViewSchema),
  getWorkspaceMemberModelGroup: async () => mock(ModelGroupDetailViewSchema),
  updateWorkspaceMemberModelGroup: async () => mock(ModelGroupDetailViewSchema),
  getWorkspaceMemberModelGroupGrants: async () =>
    mock(ModelGroupGrantListViewSchema),
  issueWorkspaceMemberModelGroupGrant: async () =>
    mock(ModelGroupGrantViewSchema),
  addWorkspaceMemberModelItem: async () => mock(ModelGroupItemViewSchema),
  updateWorkspaceMemberModelItem: async () => mock(ModelGroupItemViewSchema),
  getWorkspaceMemberItemVersions: async () =>
    mock(ModelGroupItemVersionListViewSchema),
  getActorModelGroups: async () =>
    mock(ActorModelGroupAssignmentListViewSchema),
  getVisibleActorModelGroups: async () => mock(ModelGroupListViewSchema),
  setActorModelGroups: async () =>
    mock(ActorModelGroupAssignmentListViewSchema),
} satisfies DesignHandlers
