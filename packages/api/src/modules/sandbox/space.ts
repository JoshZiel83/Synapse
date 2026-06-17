export {
  SandboxSpaceError,
  MOUNT_SUBPATHS,
  ensureFileSpace,
  getFileSpace,
  insertFileMount,
  updateFileMount,
  getActiveMountsForSession,
  getFailedRecoverableMounts,
  appendSnapshot,
  ensureContentBlob,
  getSnapshotManifestSha,
} from "./repo-space.js"

export type {
  MountSubpath,
  FileSpaceRow,
  FileMountRow,
  FileSnapshotRow,
} from "./repo-space.js"
