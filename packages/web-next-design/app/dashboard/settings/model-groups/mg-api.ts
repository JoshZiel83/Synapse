"use client"

// One scope-parameterized facade over the three byte-identical model-group API
// families (workspace / platform / workspace_member), keyed off the ownerType
// scope. Collapses the ~180 lines of duplicated per-scope helpers the old
// workbench carried; scope stays set by endpoint path (never a body field).
import type { ModelGroupOwnerType } from "@synapse/shared"
import type {
  ModelGroupCreateInput,
  ModelGroupUpdateInput,
  ModelGroupItemCreateInput,
  ModelGroupItemUpdateInput,
  ModelGroupGrantIssueInput,
} from "@synapse/shared/schemas"
import { api } from "@/lib/api"

export type Scope = ModelGroupOwnerType

export function groupApi(scope: Scope, workspaceId: string) {
  if (scope === "platform") {
    return {
      list: () => api.getPlatformModelGroups(),
      detail: (id: string) => api.getPlatformModelGroup(id),
      create: (d: ModelGroupCreateInput) => api.createPlatformModelGroup(d),
      update: (id: string, d: ModelGroupUpdateInput) =>
        api.updatePlatformModelGroup(id, d),
      remove: (id: string) => api.deletePlatformModelGroup(id),
      grants: (id: string) => api.getPlatformModelGroupGrants(id),
      issueGrant: (id: string, d: ModelGroupGrantIssueInput) =>
        api.issuePlatformModelGroupGrant(id, d),
      revokeGrant: (id: string, grantId: string) =>
        api.revokePlatformModelGroupGrant(id, grantId),
      addItem: (id: string, d: ModelGroupItemCreateInput) =>
        api.addPlatformModelItem(id, d),
      updateItem: (id: string, itemId: string, d: ModelGroupItemUpdateInput) =>
        api.updatePlatformModelItem(id, itemId, d),
      deleteItem: (id: string, itemId: string) =>
        api.deletePlatformModelItem(id, itemId),
    }
  }
  if (scope === "workspace_member") {
    return {
      list: () => api.getWorkspaceMemberModelGroups(workspaceId),
      detail: (id: string) => api.getWorkspaceMemberModelGroup(workspaceId, id),
      create: (d: ModelGroupCreateInput) =>
        api.createWorkspaceMemberModelGroup(workspaceId, d),
      update: (id: string, d: ModelGroupUpdateInput) =>
        api.updateWorkspaceMemberModelGroup(workspaceId, id, d),
      remove: (id: string) =>
        api.deleteWorkspaceMemberModelGroup(workspaceId, id),
      grants: (id: string) =>
        api.getWorkspaceMemberModelGroupGrants(workspaceId, id),
      issueGrant: (id: string, d: ModelGroupGrantIssueInput) =>
        api.issueWorkspaceMemberModelGroupGrant(workspaceId, id, d),
      revokeGrant: (id: string, grantId: string) =>
        api.revokeWorkspaceMemberModelGroupGrant(workspaceId, id, grantId),
      addItem: (id: string, d: ModelGroupItemCreateInput) =>
        api.addWorkspaceMemberModelItem(workspaceId, id, d),
      updateItem: (id: string, itemId: string, d: ModelGroupItemUpdateInput) =>
        api.updateWorkspaceMemberModelItem(workspaceId, id, itemId, d),
      deleteItem: (id: string, itemId: string) =>
        api.deleteWorkspaceMemberModelItem(workspaceId, id, itemId),
    }
  }
  return {
    list: () => api.getModelGroups(workspaceId),
    detail: (id: string) => api.getModelGroup(workspaceId, id),
    create: (d: ModelGroupCreateInput) => api.createModelGroup(workspaceId, d),
    update: (id: string, d: ModelGroupUpdateInput) =>
      api.updateModelGroup(workspaceId, id, d),
    remove: (id: string) => api.deleteModelGroup(workspaceId, id),
    grants: (id: string) => api.getModelGroupGrants(workspaceId, id),
    issueGrant: (id: string, d: ModelGroupGrantIssueInput) =>
      api.issueModelGroupGrant(workspaceId, id, d),
    revokeGrant: (id: string, grantId: string) =>
      api.revokeModelGroupGrant(workspaceId, id, grantId),
    addItem: (id: string, d: ModelGroupItemCreateInput) =>
      api.addModelItem(workspaceId, id, d),
    updateItem: (id: string, itemId: string, d: ModelGroupItemUpdateInput) =>
      api.updateModelItem(workspaceId, id, itemId, d),
    deleteItem: (id: string, itemId: string) =>
      api.deleteModelItem(workspaceId, id, itemId),
  }
}

export const SCOPE_TABS: { scope: Scope; label: string }[] = [
  { scope: "workspace", label: "工作区" },
  { scope: "workspace_member", label: "我的" },
  { scope: "platform", label: "平台" },
]
