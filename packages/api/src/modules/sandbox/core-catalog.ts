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
  RuntimeCatalogExposure,
  RuntimeCatalogTool,
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
 *   - fs_search: no `indexed` (bare does a live non-indexed scan; there is no
 *     in-sandbox SQLite FTS5 index, so `indexed` could never be honored).
 *   - result field names differ (bare `total_size` vs resident `total_bytes`,
 *     camelCase fs_stat, no history/index families). Those divergences are stated
 *     TRUTHFULLY in the per-tool bare descriptions (BARE_TOOL_DESCRIPTION_OVERRIDES),
 *     NOT papered over by copying the resident description.
 * Each entry maps a tool name → the params stripped from its BARE input_schema
 * (each verified ignored by coreInvokeBarePlane before removal).
 */
const REDUCED_FIDELITY_STRIP: Readonly<Record<string, readonly string[]>> = {
  fs_read: ["line_range"],
  fs_stat: ["include_sha256"],
  fs_search: ["indexed"],
}

/**
 * Per-tool BARE description overrides (owner decision: a FULL SEPARATE truthful
 * contract, not the resident's descriptions copied over a divergent implementation).
 * The resident TOOLS[] descriptions describe the resident semantics/result fields;
 * where the bare data plane (coreInvokeBarePlane) diverges, we publish a bare-specific
 * description that states EXACTLY what bare does and returns. A tool NOT in this map
 * keeps the resident description verbatim (its bare semantics match).
 *
 * These strings must stay in sync with coreInvokeBarePlane's actual emitted fields.
 * Field-convergence decision: bare's actual result field names are DOCUMENTED here
 * (not renamed to match resident) — e.g. fs_read still emits `total_size`, fs_stat
 * still emits camelCase `mtimeMs`/`isSymlink`. The contract is honest either way; we
 * chose "document" over "converge" per the owner's separate-contract decision.
 */
export const BARE_TOOL_DESCRIPTION_OVERRIDES: Readonly<
  Record<string, string>
> = {
  fs_read:
    "Read a file from the bare sandbox. Defaults to utf-8 and automatically falls " +
    "back to base64 for non-UTF-8/binary content — the returned `encoding` field " +
    "reflects the encoding actually used (never lossy U+FFFD over binary). Byte " +
    "windows via start_byte/end_byte/max_bytes. Result fields: path, content, " +
    "encoding, total_size (total file size in bytes), truncated. No line-range " +
    "slicing and no sha256/mtime in the result (reduced-fidelity vs the resident " +
    "device builtin).",
  fs_stat:
    "Stat a path in the bare sandbox. Returns: path, exists, and when the path " +
    "exists kind, size, mtimeMs, isSymlink. No sha256 hashing and no mode_octal " +
    "(reduced-fidelity vs the resident device builtin).",
  fs_search:
    "Search the bare sandbox filesystem with a live, NON-indexed scan (ripgrep-" +
    "style) over the granted prefixes. mode=content matches file contents; " +
    "mode=path matches file paths; regex/glob supported. There is NO in-sandbox " +
    "index — this is not SQLite FTS5 / bm25 indexed search. Result fields: mode, " +
    "query, hits, truncated.",
  bash:
    "Run a bash command inside the confined bare sandbox (bwrap/container jail, no " +
    "network). Output is captured and returned synchronously as a JSON object with " +
    "fields: exit_code, stdout, stderr, truncated, killed (reduced-fidelity vs the " +
    "resident device builtin's markdown-formatted output). A non-zero exit or a " +
    "killed command is flagged with isError. Subject to a commandline grant.",
  exec_file:
    "Spawn an executable directly with structured argv (no shell) inside the " +
    "confined bare sandbox. Program must be a bare command name (no path " +
    "separators, parent traversal, or absolute paths). Returns a JSON object with " +
    "fields: exit_code, stdout, stderr, truncated, killed (reduced-fidelity vs the " +
    "resident device builtin's markdown-formatted output). A non-zero exit or a " +
    "killed command is flagged with isError. Subject to a commandline grant with " +
    "executor='exec_file'.",
}

/** Apply the BARE description override for a tool, if any. Returns a NEW object
 *  (spread) so the shared resident TOOLS[] descriptor is never mutated — only the
 *  top-level `description` is replaced; input_schema is carried by reference (safe,
 *  it is only ever read). A tool absent from the map is returned unchanged. */
function applyBareDescription(tool: RuntimeCatalogTool): RuntimeCatalogTool {
  const override = BARE_TOOL_DESCRIPTION_OVERRIDES[tool.name]
  return override ? { ...tool, description: override } : tool
}

/** Deep-clone a catalog tool and delete the named keys from its
 *  input_schema.properties. structuredClone is MANDATORY: filesystemCoreToolDefs
 *  hands back input_schema BY REFERENCE to the shared resident TOOLS[] table, so a
 *  direct delete would corrupt the schema the device itself serves. */
function stripUnhonoredParams(
  tool: RuntimeCatalogTool,
  paramsToStrip: readonly string[]
): RuntimeCatalogTool {
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
): RuntimeCatalogTool[] {
  const tools = filesystemCoreToolDefs().map((t) => {
    const strip = REDUCED_FIDELITY_STRIP[t.name]
    const stripped = strip ? stripUnhonoredParams(t, strip) : t
    return applyBareDescription(stripped)
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
): RuntimeCatalogExposure[] {
  const exposures: RuntimeCatalogExposure[] = [
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
      tools: COMMANDLINE_CORE_TOOL_DEFS.map(applyBareDescription),
    })
  }
  // NO pty exposure in P4a (F-D).
  return exposures
}
