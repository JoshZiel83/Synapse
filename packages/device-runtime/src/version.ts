// Single source of truth for the device-runtime's self-reported version.
//
// This is DELIBERATELY decoupled from the npm package version in package.json
// (the workspace bumps that in lockstep for registry publishing — currently
// 0.28.0). The value below is the device-runtime *protocol* iteration, reported
// on the wire to peers that key behavior off it:
//   • DEVICE_RUNTIME_CLIENT_VERSION → pairing/bootstrap `client_version`
//     (the api reads it; the `-device-runtime-v3` suffix marks the v3 protocol).
//   • DEVICE_RUNTIME_VERSION → MCP `serverInfo`/client `version` (host + stdio
//     sidecar) — MCP peers compare it, so it must not drift with the npm bump.
//
// Do NOT reroute these to `package.json` version: doing so would silently change
// wire-visible strings on every release. Bump the constant HERE, intentionally,
// when the protocol iteration changes.
export const DEVICE_RUNTIME_VERSION = "0.1.0"

export const DEVICE_RUNTIME_CLIENT_VERSION = `${DEVICE_RUNTIME_VERSION}-device-runtime-v3`
