// @synapse/device-runtime — public surface.

export * from "./types.js"
export { createFileBackedBroker } from "./broker.js"
export { createInMemoryMcpHost, toolErrorResult } from "./mcp-host.js"
export { createFilesystemBuiltin } from "./builtins/filesystem.js"
export { runDeviceRuntime, embedDeviceRuntime } from "./runtime.js"
export { pair, rekeyDeviceRuntime, startPairingSession } from "./pairing.js"
export { TransportClient } from "./transport.js"
