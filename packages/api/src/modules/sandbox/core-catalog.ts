// api-authored static catalog for a bare (Mode-B) sandbox (§4.3 / F-D).
//
// A bare sandbox has NO device-runtime process to publish its own catalog over
// the control plane, so the API authors it. This module is the DESCRIPTOR-GATED
// subset actually backed by the bare data plane — never a dead/unbacked tool:
//   - `filesystem` ALWAYS (the plane always confines fs ops through the vfs
//     kernel). Tool DEFS are `filesystemCoreToolDefs()` — derived DOWN from the
//     resident device builtin's TOOLS[] so the schema can never drift.
//   - `commandline` ONLY when `descriptor.isolation != null` (bwrap present).
//     When bwrap is absent the exposure is omitted → no commandline grant is
//     minted → the plane's `exec` also fail-closes. Three fail-closed layers.
//   - `pty` — NEVER exposed in P4a (F-D): no device-runtime pty builtin exists,
//     so a pty exposure would be unbacked/unauthorizable. pty machinery is proven
//     only via a TEST-ONLY fixture (S8), never this production catalog.
//
// The projection surfaces any healthy/degraded exposure, so an unbacked exposure
// would be a visible, unauthorizable dead tool — the descriptor gate is exactly
// what prevents that.

import {
  filesystemCoreToolDefs,
  COMMANDLINE_CORE_TOOL_DEFS,
} from "@synapse/device-runtime"
import type { DeviceCatalogExposure } from "@synapse/device-protocol"
import type { SandboxCapabilityDescriptor } from "./model.js"

/** Stable keys the bare catalog uses (mirror the resident builtin exposures). */
export const BARE_FILESYSTEM_EXPOSURE_KEY = "builtin/filesystem"
export const BARE_COMMANDLINE_EXPOSURE_KEY = "builtin/commandline"

/**
 * Build the descriptor-gated exposure set the bare adapter hands to
 * persistCatalogSync. `filesystem` always; `commandline` iff bwrap isolation is
 * available; NEVER pty. runtimeStatus is set by persistCatalogSync ('healthy').
 */
export function buildBareCoreCatalog(
  descriptor: SandboxCapabilityDescriptor
): DeviceCatalogExposure[] {
  const exposures: DeviceCatalogExposure[] = [
    {
      stable_key: BARE_FILESYSTEM_EXPOSURE_KEY,
      display_name: "Filesystem",
      transport: "builtin",
      builtin_kind: "filesystem",
      metadata: {
        catalogSource: "api_authored",
        sandboxMode: descriptor.mode,
        confinedFs: descriptor.confinedFs,
        features: {
          read: true,
          write: descriptor.core.atomicWrite,
          delete: descriptor.core.remove,
          mkdir: descriptor.core.mkdir,
          move: descriptor.core.move,
          search: descriptor.core.search,
          // A bare sandbox carries no sqlite fs-helper — durability is the CAS
          // working-set bridge, not in-sandbox history. Declared honestly.
          history: false,
          indexedSearch: false,
        },
      },
      tools: filesystemCoreToolDefs(),
    },
  ]
  // commandline ONLY when the adapter can confine commands (F-D + fail-closed).
  if (descriptor.isolation != null) {
    exposures.push({
      stable_key: BARE_COMMANDLINE_EXPOSURE_KEY,
      display_name: "Commandline (shell + exec_file)",
      transport: "builtin",
      builtin_kind: "commandline",
      metadata: {
        catalogSource: "api_authored",
        isolation: descriptor.isolation,
        executors: ["bash", "exec_file"],
      },
      tools: [...COMMANDLINE_CORE_TOOL_DEFS],
    })
  }
  // NO pty exposure in P4a (F-D).
  return exposures
}
