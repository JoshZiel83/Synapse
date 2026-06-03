// Sandbox manager — public surface.
//
// Provisions a per-session, content-addressed file sandbox (three mount spaces
// materialized into a same-host device-runtime), refreshes/commits the working
// tree across the session lifecycle, and tears it down.

export {
  provisionSandbox,
  refreshSpaces,
  commitSpaces,
  teardownSandbox,
  recoverFailedSandboxMounts,
  reconcileSandboxes,
  peekPendingCommitConflicts,
  clearPendingCommitConflicts,
  peekPendingRefreshConflicts,
  clearPendingRefreshConflicts,
  isSidecarPayloadIrrecoverable,
  mergePendingRefreshConflicts,
  SandboxServiceError,
  type ProvisionSandboxOptions,
  type CommitResult,
  type PendingCommitConflict,
  type PendingRefreshConflicts,
  type ConflictSidecarRef,
  type TeardownSandboxOptions,
  type RecoverFailedMountsResult,
} from "./service.js"
export {
  CONFLICT_SIDECAR_PREFIX,
  type SandboxProvisionResult,
  type SidecarRestoreFailure,
  type SidecarRestoreFailureReason,
} from "./model.js"
export {
  ensureFileSpace,
  getFileSpace,
  getActiveMountsForSession,
  SandboxSpaceError,
  MOUNT_SUBPATHS,
  type MountSubpath,
  type FileSpaceRow,
  type FileMountRow,
  type FileSnapshotRow,
} from "./space.js"
export {
  createLocalHostProvider,
  type HostProvider,
  type RunHandle,
  type PairResult,
  type SpawnSandboxRuntimeParams,
} from "./host-provider.js"
export { runContentGc, type GcResult } from "./gc.js"
export {
  partitionSidecars,
  formatRestoredPair,
  formatUnrestoredPair,
  transientUnrestoredSentence,
  permanentUnrestoredSentence,
  type PartitionedSidecars,
} from "./conflict-notice.js"
