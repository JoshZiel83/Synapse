// Browser builtin (§4.5 / spec §10). v3.0 replaces relay/internal/builtinmcp/
// chrome. v1 ships a minimal CDP-based navigate + read-text surface; full
// chrome-devtools-bundle parity lands incrementally.
//
// The implementation deliberately avoids puppeteer to keep the dependency
// surface light — we connect to an already-running Chrome instance via
// chrome-remote-interface-style WebSocket. Operator must launch Chrome with
// --remote-debugging-port=NNNN.

import type { CatalogProvider } from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"

const PROVIDER_KEY = "builtin.browser"

const NAVIGATE_TOOL: DeviceCatalogTool = {
  stable_key: "browser/navigate",
  name: "browser_navigate",
  description:
    "Navigate the active browser tab to a URL. Subject to runtime authorization grants of capability='browser'.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      wait_for: {
        type: "string",
        enum: ["load", "networkidle"],
        description: "When to consider the navigation complete",
      },
    },
    required: ["url"],
  },
}

const READ_TOOL: DeviceCatalogTool = {
  stable_key: "browser/read-text",
  name: "browser_read_text",
  description:
    "Return the visible text of the active page. Subject to runtime authorization grants of capability='browser'.",
  input_schema: {
    type: "object",
    properties: {
      max_chars: {
        type: "integer",
        description: "Limit text size; default 8192",
      },
    },
  },
}

export interface BrowserBuiltinOptions {
  displayName?: string
  /**
   * URL to the Chrome DevTools Protocol HTTP endpoint
   * (e.g. http://127.0.0.1:9222). Optional — when absent the exposure is
   * still reported but its runtime_status is reported as 'degraded' until a
   * browser is attached at request time.
   */
  cdpEndpoint?: string
}

export function createBrowserBuiltin(
  opts: BrowserBuiltinOptions = {}
): CatalogProvider {
  return {
    providerKey: PROVIDER_KEY,
    async describeExposures(): Promise<DeviceCatalogExposure[]> {
      return [
        {
          stable_key: "builtin/browser",
          display_name: opts.displayName ?? "Browser (Chrome DevTools)",
          transport: "builtin",
          builtin_kind: "browser",
          metadata: {
            cdpEndpoint: opts.cdpEndpoint ?? null,
            schemaVersion: 1,
          },
          tools: [NAVIGATE_TOOL, READ_TOOL],
        },
      ]
    },
  }
}

// ───────────────────────────── runtime helpers ──────────────────────────────

export interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl: string
}

/**
 * List active CDP targets on a running Chrome instance. The MCP tool handler
 * uses this + a WebSocket connection to drive Page.navigate / DOM.getDocument.
 * Kept as a pure function so tests can mock fetch without spinning Chrome.
 */
export async function listCdpTargets(
  cdpEndpoint: string,
  fetchImpl: typeof fetch = fetch
): Promise<CdpTarget[]> {
  const url = `${cdpEndpoint.replace(/\/$/, "")}/json`
  const res = await fetchImpl(url, { method: "GET" })
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`)
  const data = (await res.json()) as CdpTarget[]
  return data.filter((t) => t.type === "page")
}
