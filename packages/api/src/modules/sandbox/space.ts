export {
  SandboxSpaceError,
  MOUNT_SUBPATHS,
  ensureFileSpace,
  getFileSpace,
  insertFileMount,
  updateFileMount,
  getActiveMountsForSession,
  claimFailedRecoverableMounts,
  releaseRecoveryClaims,
  sessionHasFailedRecoverableMounts,
  sandboxHasFailedRecoverableMounts,
  closeSessionFailedMounts,
  appendSnapshot,
  getSnapshotManifestSha,
} from "./repo-space.js"

// The single content_blobs row-writer now lives in infrastructure/storage/repo.ts
// (the raw-SQL ensureContentBlob here was deleted). Re-export so sandbox callers
// keep importing it from ./space.js.
export { ensureContentBlob } from "../../infrastructure/storage/repo.js"

export type {
  MountSubpath,
  FileSpaceRow,
  FileMountRow,
  FileSnapshotRow,
} from "./repo-space.js"
