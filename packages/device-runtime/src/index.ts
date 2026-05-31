// @synapse/device-runtime — public surface.

export * from "./types.js"
export { createFileBackedBroker } from "./broker.js"
export { createInMemoryMcpHost, toolErrorResult } from "./mcp-host.js"
export { createFilesystemBuiltin } from "./builtins/filesystem.js"
export {
  createCommandlineBuiltin,
  executeBash,
} from "./builtins/commandline.js"
export { createBrowserBuiltin, listCdpTargets } from "./builtins/browser.js"
export {
  createChromeDevtoolsMcpBuiltin,
  PINNED_VERSION as CHROME_DEVTOOLS_MCP_PINNED_VERSION,
  PROVIDER_KEY as CHROME_DEVTOOLS_MCP_PROVIDER_KEY,
} from "./builtins/chrome-devtools-mcp.js"
export {
  startMcpStdioSidecar,
  type McpClient,
  type McpCallToolResult,
  type McpStdioSidecarHandle,
  type McpStdioSidecarOptions,
} from "./mcp-stdio-sidecar.js"
export { createCuaBuiltin } from "./builtins/cua.js"
export {
  startSidecar,
  type SidecarHandle,
  type SidecarOptions,
} from "./sidecar.js"
export { runDeviceRuntime, embedDeviceRuntime } from "./runtime.js"
export { pair, rekeyDeviceRuntime, startPairingSession } from "./pairing.js"
export { bootstrapCloudDevice } from "./cloud-bootstrap.js"
export { TransportClient } from "./transport.js"
export { createFrpTunnelAdapter } from "./tunnel/frp.js"
export { createNoopTunnelAdapter } from "./tunnel/noop.js"
export {
  createInMemoryEnvelopeVerifier,
  canonicalize,
  hashArguments,
} from "./envelope.js"
export {
  createLocalFsBackend,
  createVfsService,
  VfsService,
  type VfsBackend,
  type VfsEntry,
  type VfsExposure,
  type VfsReadResult,
  type VfsSessionState,
  type VfsWriteResult,
} from "./vfs.js"

// Supervisor-side one-shot fs-helper driver + CAS/manifest RPC types. Exposed
// so the API sandbox manager can materialize / commit / sync file spaces
// against the shared CAS without embedding a long-lived device-runtime.
export {
  OneShotFsHelper,
  OneShotFsHelperError,
  withOneShotFsHelper,
  type OneShotFsHelperOptions,
} from "./builtins/one-shot-fs-helper.js"
export type {
  CasPutInput,
  CasPutResult,
  CasHasInput,
  CasHasResult,
  CasGcInput,
  CasGcResult,
  ManifestMaterializeInput,
  ManifestScanCommitInput,
  ManifestScanCommitResult,
  ManifestEntryWire,
  ManifestEntryKind,
  DirSyncInput,
  DirSyncResult,
  ConflictSidecar,
  ManifestCleanupInput,
} from "./builtins/fs-helper-types.js"
