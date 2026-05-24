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
  startSidecar,
  type SidecarHandle,
  type SidecarOptions,
} from "./sidecar.js"
export { runDeviceRuntime, embedDeviceRuntime } from "./runtime.js"
export { pair, rekeyDeviceRuntime, startPairingSession } from "./pairing.js"
export { bootstrapCloudDevice } from "./cloud-bootstrap.js"
export { TransportClient } from "./transport.js"
export { createFrpTunnelAdapter } from "./tunnel/frp.js"
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
