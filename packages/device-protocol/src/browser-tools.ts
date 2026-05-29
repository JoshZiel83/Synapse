// Tool → Operation → Target mapping for the chrome-devtools-mcp provider.
// SINGLE SOURCE OF TRUTH: imported by api/capability-projection (preflight +
// requested action building) AND by device-runtime/chrome-devtools-mcp (runtime
// authz + sidecar forwarding). Keep these in lockstep. See plan §Phase 1 and
// docs/device-runtime-v3.md §Browser capability v3.1.

import type { BrowserOperation } from "./enums.js"
// Re-export so consumers importing from the `./browser-tools` subpath get
// both the operation enum and the descriptor types in one place.
export {
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  type BrowserOperation,
} from "./enums.js"

// ────────────────────────────── target shapes ───────────────────────────────

export type BrowserToolTarget =
  | { kind: "argument_url"; argKey: string }
  | { kind: "current_page" }
  | { kind: "page_id"; argKey: string }
  | { kind: "all_pages" }

export type EffectiveTarget =
  | { kind: "argument_url"; url: string }
  | { kind: "current_page" }
  | { kind: "page_id"; pageId: number }
  | { kind: "all_pages" }

// ────────────────────────────── descriptor ──────────────────────────────────

export interface BrowserToolDescriptor {
  /** Which exposure this tool belongs to. Determines metadata.enabled. */
  exposure: BrowserExposureKey
  /** Operation gate this tool needs at runtime. */
  operation: BrowserOperation
  /** Read or write — also fed to the matcher for write-covers-read semantics. */
  action: "read" | "write"
  /** How the runtime/server determines the URL being acted on. */
  target: BrowserToolTarget
  /**
   * If false, the tool is advertised in catalog but exposure.metadata.enabled
   * starts at false; user must flip the matching --browser-allow-<flag> to
   * enable. Allow-flag MVP set: script | network | performance only.
   * extensions/webmcp/upload deferred (no allow flag, no tools in map).
   */
  enabledByDefault: boolean
  allowFlag?: "script" | "network" | "performance"
  /** sha256 of canonical inputSchema dumped from the pinned sidecar. Used by
   *  the runtime to detect drift at startup; set by refresh-browser-tool-schemas.ts. */
  expectedInputSchemaHash?: string
}

// ────────────────────────────── exposure keys ───────────────────────────────

export const BROWSER_EXPOSURE_STABLE_KEYS = {
  navigation: "builtin/browser/navigation",
  read: "builtin/browser/read",
  input: "builtin/browser/input",
  network: "builtin/browser/network",
  performance: "builtin/browser/performance",
  script: "builtin/browser/script",
  extensions: "builtin/browser/extensions",
  webmcp: "builtin/browser/webmcp",
} as const

export type BrowserExposureKey = keyof typeof BROWSER_EXPOSURE_STABLE_KEYS

// ────────────────────────────── tool map ────────────────────────────────────

/**
 * Every advertised browser tool — both for the chrome-devtools-mcp provider
 * (rows with `exposure` ∈ navigation/read/input/network/performance/script)
 * AND for the legacy lite provider (browser_navigate / browser_read_text).
 *
 * extensions/webmcp are intentionally absent: extensions need browser-scope
 * grants (not yet modeled), webmcp needs Chrome 149+ feature flags. Their
 * exposures still advertise (metadata.enabled=false, tools=[]) for UI Coming
 * Soon, but the tool map carries no entries so any invokeTool returns
 * invalid_request "unknown tool".
 *
 * upload_file is not advertised in v1 (sanitize would always reject filePath
 * anyway; needs filesystem-grant interlock).
 */
export const BROWSER_TOOL_MAP: Record<string, BrowserToolDescriptor> = {
  // ── navigation ─────────────────────────────────────────────────────────
  list_pages: {
    exposure: "navigation",
    operation: "page.read",
    action: "read",
    target: { kind: "all_pages" },
    enabledByDefault: true,
  },
  new_page: {
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "argument_url", argKey: "url" },
    enabledByDefault: true,
  },
  navigate_page: {
    // chrome-devtools-mcp 0.7.0: schema is {url} — no `type` discriminator.
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "argument_url", argKey: "url" },
    enabledByDefault: true,
  },
  navigate_page_history: {
    // back/forward on the currently selected page.
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  select_page: {
    exposure: "navigation",
    operation: "page.read",
    action: "read",
    target: { kind: "page_id", argKey: "pageIdx" },
    enabledByDefault: true,
  },
  close_page: {
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "page_id", argKey: "pageIdx" },
    enabledByDefault: true,
  },
  wait_for: {
    exposure: "navigation",
    operation: "page.read",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },

  // ── read ───────────────────────────────────────────────────────────────
  take_snapshot: {
    exposure: "read",
    operation: "page.read",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  take_screenshot: {
    exposure: "read",
    operation: "screenshot.capture",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  list_console_messages: {
    exposure: "read",
    operation: "console.read",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },

  // ── input ──────────────────────────────────────────────────────────────
  // 0.7.0 input tools: click, hover, fill, drag, fill_form, upload_file +
  // handle_dialog (lives in pages.js but classified as INPUT_AUTOMATION).
  // `press_key` / `type_text` do not exist upstream.
  click: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  fill: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  fill_form: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  hover: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  handle_dialog: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },

  // ── network (allow-flag gated) ─────────────────────────────────────────
  list_network_requests: {
    exposure: "network",
    operation: "network.list",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: false,
    allowFlag: "network",
  },
  get_network_request: {
    // 0.7.0: schema is {url}. The URL identifies the request AND is the
    // authz target — no need for a separate current-page lookup.
    exposure: "network",
    operation: "network.body.read",
    action: "read",
    target: { kind: "argument_url", argKey: "url" },
    enabledByDefault: false,
    allowFlag: "network",
  },

  // ── performance (allow-flag gated) ─────────────────────────────────────
  performance_start_trace: {
    exposure: "performance",
    operation: "performance.trace",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: false,
    allowFlag: "performance",
  },
  performance_stop_trace: {
    exposure: "performance",
    operation: "performance.trace",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: false,
    allowFlag: "performance",
  },
  performance_analyze_insight: {
    exposure: "performance",
    operation: "performance.trace",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: false,
    allowFlag: "performance",
  },

  // ── script (allow-flag gated) ──────────────────────────────────────────
  evaluate_script: {
    exposure: "script",
    operation: "script.evaluate",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: false,
    allowFlag: "script",
  },

  // ── lite provider legacy tools (kept here so api/buildRequestedAction can
  //    project them without a special case; lite exposure self-declares them) ─
  browser_navigate: {
    // exposure value is irrelevant for lite; api preflight only checks the
    // descriptor itself. Pick navigation for visual consistency.
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "argument_url", argKey: "url" },
    enabledByDefault: true,
  },
  browser_read_text: {
    exposure: "read",
    operation: "page.read",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
}

// ────────────────────────────── exposure → tools ────────────────────────────

/**
 * Which tool names belong to which chrome-devtools-mcp exposure. Used by
 * provider.describeExposures(). extensions/webmcp keep empty arrays —
 * exposure is advertised for UI "Coming Soon" but has no callable surface.
 */
export const BROWSER_EXPOSURE_TOOLS: Record<BrowserExposureKey, string[]> = {
  navigation: [
    "list_pages",
    "new_page",
    "navigate_page",
    "navigate_page_history",
    "select_page",
    "close_page",
    "wait_for",
  ],
  read: ["take_snapshot", "take_screenshot", "list_console_messages"],
  input: ["click", "fill", "fill_form", "hover", "handle_dialog"],
  network: ["list_network_requests", "get_network_request"],
  performance: [
    "performance_start_trace",
    "performance_stop_trace",
    "performance_analyze_insight",
  ],
  script: ["evaluate_script"],
  extensions: [],
  webmcp: [],
}

// ────────────────────────────── operation→action lookup ─────────────────────

/**
 * Minimum action level required to invoke each browser operation.
 *
 * Exhaustive over `RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS` — every enum
 * member MUST appear so `browserActionCoversOperations` never silently
 * falls into a fail-open path on a deferred-but-defined operation
 * (file.upload / extension.manage / webmcp.execute are not in
 * BROWSER_TOOL_MAP today but the enum still lets a caller request them).
 *
 * The TypeScript compiler enforces exhaustiveness at this site:
 * `Record<BrowserOperation, ...>` will fail to typecheck if a new
 * operation lands without an entry here.
 *
 * Runtime extra safety: the per-op table is also cross-checked against
 * BROWSER_TOOL_MAP — if a tool there demands action="write" for an
 * operation we listed here as "read" the constructor escalates.
 */
const BROWSER_OPERATION_REQUIRED_ACTION_BASE: Record<
  BrowserOperation,
  "read" | "write"
> = {
  "page.read": "read",
  "page.navigate": "write",
  "page.input": "write",
  "screenshot.capture": "read",
  "console.read": "read",
  "network.list": "read",
  "network.body.read": "read",
  "script.evaluate": "write",
  "performance.trace": "read",
  // Deferred operations: not in BROWSER_TOOL_MAP today, but listed in the
  // enum so a grant policy can name them. Each one is write-sensitive
  // (uploads files, manages extensions, executes WebMCP tools), so
  // explicit "write" prevents an action=read grant from covering them
  // if/when the deferred exposure ships.
  "file.upload": "write",
  "extension.manage": "write",
  "webmcp.execute": "write",
}

export const BROWSER_OPERATION_REQUIRED_ACTION: Readonly<
  Record<BrowserOperation, "read" | "write">
> = (() => {
  const out: Record<BrowserOperation, "read" | "write"> = {
    ...BROWSER_OPERATION_REQUIRED_ACTION_BASE,
  }
  // Cross-check / escalate from BROWSER_TOOL_MAP. If a tool surfaces an
  // operation as write, force it even if the table above marked it read.
  for (const desc of Object.values(BROWSER_TOOL_MAP)) {
    if (desc.action === "write") {
      out[desc.operation] = "write"
    }
  }
  return out
})()

/**
 * True iff the supplied (action, operations[]) combination is internally
 * consistent — i.e. `action` covers the minimum required action for every
 * operation. Used by the manual-grant endpoint and the Settings UI to
 * reject "action:read + operations:[page.input]" type misconfigurations
 * that would silently produce a dead grant.
 *
 * Fail-closed on unknown operations: if a caller smuggles in a string
 * that isn't in `RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS` (e.g. via an
 * older deployment talking to a newer one), it counts as offending so
 * action=read can never cover it. Zod usually catches this upstream but
 * direct callers of `browserActionCoversOperations` need the defence.
 */
export function browserActionCoversOperations(
  action: "read" | "write",
  operations: readonly BrowserOperation[]
): { ok: true } | { ok: false; offending: BrowserOperation[] } {
  if (action === "write") return { ok: true }
  const offending = operations.filter((op) => {
    const required = BROWSER_OPERATION_REQUIRED_ACTION[op]
    if (required === undefined) return true // unknown op → deny
    return required === "write"
  })
  return offending.length === 0 ? { ok: true } : { ok: false, offending }
}

// ────────────────────────────── effective target resolver ───────────────────

/**
 * Resolve a descriptor + invocation args into an EffectiveTarget. Returns
 * `null` when a required arg is missing (caller should surface invalid_request).
 * Returns a string error code for arg-shape mismatch (e.g. navigate_page with
 * `url` present but `type` saying otherwise — see plan §#14).
 *
 * navigate_page rule: **args.url present → argument_url**. If args.url is
 * present AND args.type is explicitly non-"url", we refuse — server would
 * pre-authorize by current_page but sidecar would actually navigate to a new
 * URL.
 */
export type EffectiveTargetResolution =
  | { ok: true; target: EffectiveTarget }
  | {
      ok: false
      code: "missing_arg"
      detail: string
    }

export function resolveEffectiveTarget(
  descriptor: BrowserToolDescriptor,
  args: Record<string, unknown>
): EffectiveTargetResolution {
  const t = descriptor.target
  switch (t.kind) {
    case "argument_url": {
      const url = args[t.argKey]
      if (typeof url !== "string" || url.length === 0) {
        return {
          ok: false,
          code: "missing_arg",
          detail: `missing required argument: ${t.argKey}`,
        }
      }
      return { ok: true, target: { kind: "argument_url", url } }
    }
    case "current_page":
      return { ok: true, target: { kind: "current_page" } }
    case "page_id": {
      const pageId = args[t.argKey]
      if (typeof pageId !== "number" || !Number.isFinite(pageId)) {
        return {
          ok: false,
          code: "missing_arg",
          detail: `missing or invalid required argument: ${t.argKey} (expected number)`,
        }
      }
      return { ok: true, target: { kind: "page_id", pageId } }
    }
    case "all_pages":
      return { ok: true, target: { kind: "all_pages" } }
  }
}
