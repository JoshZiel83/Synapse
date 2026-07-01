import {
  ModelGroupListViewSchema,
  ModelGroupViewSchema,
  ModelGroupDetailViewSchema,
  ModelGroupGrantListViewSchema,
  ModelGroupGrantViewSchema,
  ModelGroupItemViewSchema,
  ModelGroupItemVersionListViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Model-group CRUD for both the workspace surface (/workspaces/:id/model-groups)
// and the platform surface (/platform/model-groups). Both surfaces return the
// same view shapes, so the workspace and platform handlers reuse identical
// schemas. Delete/revoke routes return the bare fetch envelope (void to the UI)
// and are left to the Proxy catch-all.
export const modelGroupsWsPlatformHandlers = {
  getModelGroups: async () => mock(ModelGroupListViewSchema),
  createModelGroup: async () => mock(ModelGroupViewSchema),
  getModelGroup: async () => mock(ModelGroupDetailViewSchema),
  updateModelGroup: async () => mock(ModelGroupDetailViewSchema),
  getModelGroupGrants: async () => mock(ModelGroupGrantListViewSchema),
  issueModelGroupGrant: async () => mock(ModelGroupGrantViewSchema),
  addModelItem: async () => mock(ModelGroupItemViewSchema),
  updateModelItem: async () => mock(ModelGroupItemViewSchema),
  getItemVersions: async () => mock(ModelGroupItemVersionListViewSchema),
  getPlatformModelGroups: async () => mock(ModelGroupListViewSchema),
  createPlatformModelGroup: async () => mock(ModelGroupViewSchema),
  getPlatformModelGroup: async () => mock(ModelGroupDetailViewSchema),
  updatePlatformModelGroup: async () => mock(ModelGroupDetailViewSchema),
  getPlatformModelGroupGrants: async () => mock(ModelGroupGrantListViewSchema),
  issuePlatformModelGroupGrant: async () => mock(ModelGroupGrantViewSchema),
  addPlatformModelItem: async () => mock(ModelGroupItemViewSchema),
  updatePlatformModelItem: async () => mock(ModelGroupItemViewSchema),
  getPlatformItemVersions: async () =>
    mock(ModelGroupItemVersionListViewSchema),
} satisfies DesignHandlers
