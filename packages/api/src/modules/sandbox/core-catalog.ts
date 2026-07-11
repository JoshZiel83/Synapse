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
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import type { SandboxCapabilityDescriptor } from "./model.js"

/**
 * REDUCED-FIDELITY surface (owner decision): the bare data plane is a documented
 * safety subset of the resident device builtin — NOT a byte-identical drop-in. The
 * catalog schema below is trimmed so the ADVERTISED contract matches what
 * `coreInvokeBarePlane` actually honors, rather than copying the resident schema
 * verbatim and lying about params it ignores. Known, deliberate drifts:
 *   - fs_read: no `line_range` (bare returns raw byte windows, no line slicing).
 *   - fs_stat: no `include_sha256` (bare stat returns no hash).
 *   - result field names differ (bare `total_size` vs resident `total_bytes`, no
 *     history/index families) — those are documented, NOT implemented here.
 * Each entry maps a tool name → the params stripped from its BARE input_schema
 * (each verified ignored by coreInvokeBarePlane before removal).
 */
const REDUCED_FIDELITY_STRIP: Readonly<Record<string, readonly string[]>> = {
  fs_read: ["line_range"],
  fs_stat: ["include_sha256"],
}

/** Deep-clone a catalog tool and delete the named keys from its
 *  input_schema.properties. structuredClone is MANDATORY: filesystemCoreToolDefs
 *  hands back input_schema BY REFERENCE to the shared resident TOOLS[] table, so a
 *  direct delete would corrupt the schema the device itself serves. */
function stripUnhonoredParams(
  tool: DeviceCatalogTool,
  paramsToStrip: readonly string[]
): DeviceCatalogTool {
  const clone = structuredClone(tool)
  const schema = clone.input_schema as {
    properties?: Record<string, unknown>
  }
  if (schema && typeof schema === "object" && schema.properties) {
    for (const p of paramsToStrip) {
      delete schema.properties[p]
    }
  }
  return clone
}

/** The descriptor-gated, reduced-fidelity bare filesystem tool set: derive DOWN
 *  from the resident builtin, strip params the bare plane ignores, and OMIT
 *  fs_search when the plane has no ripgrep (descriptor.core.search === false) so
 *  it is never advertised as a dead/unbacked tool (fail-closed). */
function bareFilesystemTools(
  descriptor: SandboxCapabilityDescriptor
): DeviceCatalogTool[] {
  const tools = filesystemCoreToolDefs().map((t) => {
    const strip = REDUCED_FIDELITY_STRIP[t.name]
    return strip ? stripUnhonoredParams(t, strip) : t
  })
  if (!descriptor.core.search) {
    return tools.filter((t) => t.name !== "fs_search")
  }
  return tools
}

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
      // Reduced-fidelity schema (see REDUCED_FIDELITY_STRIP): trimmed to what
      // coreInvokeBarePlane honors; fs_search omitted when the plane has no
      // ripgrep. NOT the resident schema copied verbatim.
      tools: bareFilesystemTools(descriptor),
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
