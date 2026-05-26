// Tool → Operation → Target mapping for the chrome-devtools-mcp provider.
// SINGLE SOURCE OF TRUTH: imported by api/capability-projection (preflight +
// requested action building) AND by device-runtime/chrome-devtools-mcp (runtime
// authz + sidecar forwarding). Keep these in lockstep. See plan §Phase 1 and
// docs/device-runtime-v3.md §Browser capability v3.1.

import type { BrowserOperation } from "./enums.js"

// ────────────────────────────── target shapes ───────────────────────────────

export type BrowserToolTarget =
  | { kind: "argument_url"; argKey: string }
  | { kind: "current_page" }
  | { kind: "page_id"; argKey: string }
  | { kind: "all_pages" }
  // navigate_page: args.url present → argument_url; otherwise current_page.
  | { kind: "navigation_url_or_current_page"; argKey: string }

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
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "navigation_url_or_current_page", argKey: "url" },
    enabledByDefault: true,
  },
  select_page: {
    exposure: "navigation",
    operation: "page.read",
    action: "read",
    target: { kind: "page_id", argKey: "pageId" },
    enabledByDefault: true,
  },
  close_page: {
    exposure: "navigation",
    operation: "page.navigate",
    action: "write",
    target: { kind: "page_id", argKey: "pageId" },
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
  get_console_message: {
    exposure: "read",
    operation: "console.read",
    action: "read",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },

  // ── input ──────────────────────────────────────────────────────────────
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
  press_key: {
    exposure: "input",
    operation: "page.input",
    action: "write",
    target: { kind: "current_page" },
    enabledByDefault: true,
  },
  type_text: {
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
    exposure: "network",
    operation: "network.body.read",
    action: "read",
    target: { kind: "current_page" },
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
    "select_page",
    "close_page",
    "wait_for",
  ],
  read: [
    "take_snapshot",
    "take_screenshot",
    "list_console_messages",
    "get_console_message",
  ],
  input: [
    "click",
    "fill",
    "fill_form",
    "hover",
    "press_key",
    "type_text",
    "handle_dialog",
  ],
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
      code: "missing_arg" | "navigate_page_type_mismatch"
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
    case "navigation_url_or_current_page": {
      const url = args[t.argKey]
      const type = args["type"]
      if (typeof url === "string" && url.length > 0) {
        if (type !== undefined && type !== "url") {
          return {
            ok: false,
            code: "navigate_page_type_mismatch",
            detail: `navigate_page: url provided but type is '${String(type)}'`,
          }
        }
        return { ok: true, target: { kind: "argument_url", url } }
      }
      return { ok: true, target: { kind: "current_page" } }
    }
  }
}
