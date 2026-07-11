// @synapse/device-runtime — public surface.

export * from "./types.js"
export { createFileBackedBroker } from "./broker.js"
export { createInMemoryMcpHost, toolErrorResult } from "./mcp-host.js"
export {
  createFilesystemBuiltin,
  filesystemCoreToolDefs,
  FILESYSTEM_CORE_TOOL_NAMES,
} from "./builtins/filesystem.js"
export {
  createCommandlineBuiltin,
  COMMANDLINE_CORE_TOOL_DEFS,
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
  canonicalVfsPath,
  pathUnderPrefix,
  collapsePrefixes,
  WHOLE_SCOPE,
  GrantPrefixDeniedError,
  CanonicalPathError,
  CrossMountError,
  StaleWriteError,
  type WholeScope,
  type ExtendedLocalBackend,
  type SafeStatInfo,
  type VfsBackend,
  type VfsEntry,
  type VfsExposure,
  type VfsReadResult,
  type VfsSessionState,
  type VfsWriteResult,
} from "./vfs.js"

// ── Mode-B (bare sandbox) reference-adapter surface (S4) ──────────────────────
// Exposed so the API sandbox adapters (sandbox/adapter-registry.ts,
// makeLocalBareAdapter) reuse the SAME confined exec + vfs + search kernel the
// resident device-runtime does — one implementation, no drift. NOTE: the
// bare-sandbox adapter deliberately does NOT USE embedDeviceRuntime /
// createInMemoryEnvelopeVerifier / createFileBackedBroker (Mode-A markers — a
// bare sandbox never pairs, never runs a resident runtime), even though the
// package still exports them for the resident Mode-A runtime.
export {
  bwrapAvailable,
  resolveBwrapPath,
  buildBwrapArgs,
  wrapDescriptorWithBwrap,
  DEFAULT_SANDBOX_CWD,
  type SandboxConfinement,
} from "./terminal/sandbox-confinement.js"
export {
  spawnTerminalProcess,
  previewSpawnEnv,
  type SpawnTerminalProcessOptions,
  type SpawnedTerminalResult,
} from "./terminal/executor.js"
export {
  buildUtf8Env,
  InvalidAllowedEnvError,
  sanitizePathEnv,
  type BuildUtf8EnvOptions,
} from "./terminal/utf8.js"
export {
  PosixBashProvider,
  PowerShellProvider,
  buildExecFileDescriptor,
  ShellNotAvailableError,
} from "./terminal/shell-provider.js"
export type {
  SpawnDescriptor,
  TerminalExecResult,
  TerminalPlatform,
} from "./terminal/types.js"
export {
  dispatchRipgrep,
  detectRipgrep,
  type RipgrepDeps,
  type RipgrepDispatchInput,
  type RipgrepDispatchOutput,
  type RipgrepHit,
} from "./builtins/ripgrep-runner.js"

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
  DirApplyHeadInput,
  DirSyncResult,
  ConflictSidecar,
  ManifestCleanupInput,
  SidecarRestoreInput,
} from "./builtins/fs-helper-types.js"

// Unified sidecar-binary resolver + the wire proto version TS clients pin.
// Exposed so the API sandbox manager resolves the fs-helper the same way the
// device-runtime does (consistent release-first vs newest-wins policy).
export {
  resolveSidecarPath,
  resolveSidecarPathOrThrow,
  FS_HELPER_PROTO_VERSION,
  FS_HELPER_BIN_NAME,
  FS_HELPER_ENV_VAR,
  FS_HELPER_PROFILES,
  fsHelperCandidatePaths,
  fsHelperBuildOutput,
  resolveFsHelperForProfile,
  FsHelperProtoMismatchError,
  assertFsHelperProto,
  type ResolveMode,
  type ResolveSidecarOptions,
  type FsHelperProfile,
} from "./builtins/fs-helper-resolve.js"
