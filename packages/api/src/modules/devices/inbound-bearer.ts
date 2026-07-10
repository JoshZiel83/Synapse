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
// The API uses it in two places: it injects the value into a direct runtime's env
// at create() (→ the MCP host's requiredInboundAuth), and it appends it as the
// dispatch Authorization header for a direct network endpoint. The runtime side
// only ever COMPARES — it never derives (it has no server secret).

import { createHmac } from "node:crypto"
import { config } from "../../config/index.js"

export function deriveRuntimeInboundBearer(runtimeId: string): string {
  return createHmac("sha256", config.auth.secret)
    .update(`runtime-inbound:${runtimeId}`)
    .digest("hex")
}
