export {
  insertWorkspaceResourceGrant,
  revokeWorkspaceResourceGrant,
  revokeWorkspaceResourceGrantsForResource,
  listActiveWorkspaceResourceGrants,
  insertWorkspaceResourceGrantRequest,
  cancelWorkspaceResourceGrantRequest,
  listWorkspaceResourceGrantRequests,
  resolveWorkspaceResourceGrantRequest,
} from "./repo-grant-storage.js"

export type {
  WorkspaceResourceGrantRow,
  WorkspaceResourceGrantRequestRow,
  InsertWorkspaceResourceGrantInput,
  InsertWorkspaceResourceGrantRequestInput,
} from "./repo-grant-storage.js"
