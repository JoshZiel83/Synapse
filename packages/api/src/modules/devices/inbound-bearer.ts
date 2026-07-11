// Per-runtime inbound bearer for the DIRECT (network-reachable) data plane (§3.4
// layer 2 / §3.3). Derived deterministically from the server secret + runtime id:
//
//   bearer = HMAC-SHA256(config.auth.secret, "runtime-inbound:" + runtimeId)
//
// Properties this buys (invariant 43 — "registry state is reconstructible after
// API restart"):
//   - recomputable at resolve/dispatch time, so it is NEVER stored on any row and
//     never needs to survive a restart in memory;
//   - NEVER serialized into a ToolBinding / provenance / audit snapshot (it is a
//     transport credential, route-only);
//   - domain-separated ("runtime-inbound:") so it can never collide with another
//     HMAC use of the same server secret (e.g. the OAuth state MAC).
//
// ⚠️ NOT YET WIRED. This is the auth spine for a DIRECT off-box endpoint, which only
// the envd/E2B adapter (P4b) introduces — that phase is deferred (no E2B account to
// verify against), so there is currently NO producer: nothing injects this into a
// runtime's env and dispatchSyncTool sends no Authorization header (docker resident
// stays on frp/indirect, local is loopback, bare is co-located — none are direct
// off-box). When P4b lands it will (a) inject this into the direct runtime's env →
// the MCP host's requiredInboundAuth, and (b) append it as the dispatch Authorization
// header. The runtime side only ever COMPARES — it never derives (no server secret).
// Kept (with its unit test + the MCP-host fail-closed gate) as the reviewed, tested
// primitive P4b consumes; delete both if P4b is abandoned.

import { createHmac } from "node:crypto"
import { config } from "../../config/index.js"

export function deriveRuntimeInboundBearer(runtimeId: string): string {
  return createHmac("sha256", config.auth.secret)
    .update(`runtime-inbound:${runtimeId}`)
    .digest("hex")
}
