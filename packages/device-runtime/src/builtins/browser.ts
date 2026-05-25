// Browser builtin (§4.5 / spec §10). v3.0 replaces relay/internal/builtinmcp/
// chrome. v1 ships a minimal CDP-based navigate + read-text surface; full
// chrome-devtools-bundle parity lands incrementally.
//
// The implementation deliberately avoids puppeteer to keep the dependency
// surface light — we connect to an already-running Chrome instance via
// chrome-remote-interface-style WebSocket. Operator must launch Chrome with
// --remote-debugging-port=NNNN.

import WebSocket from "ws"
import type {
  CatalogProvider,
  CatalogToolInvocationResult,
} from "../types.js"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import { toolErrorResult } from "../mcp-host.js"

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
    async invokeTool(input): Promise<CatalogToolInvocationResult> {
      if (!opts.cdpEndpoint) {
        return toolErrorResult({
          code: "runtime_constraint",
          message:
            "browser builtin has no cdpEndpoint; start Chrome with --remote-debugging-port=NNNN and pass --browser-cdp http://127.0.0.1:NNNN",
        })
      }
      if (input.toolName !== "browser_navigate" && input.toolName !== "browser_read_text") {
        return toolErrorResult({
          code: "invalid_request",
          message: `browser builtin does not handle ${input.toolName}`,
        })
      }
      let targets: CdpTarget[]
      try {
        targets = await listCdpTargets(opts.cdpEndpoint)
      } catch (err) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `cdp targets fetch failed: ${(err as Error).message}`,
        })
      }
      const target = targets[0]
      if (!target) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: "no active CDP page target",
        })
      }
      try {
        if (input.toolName === "browser_navigate") {
          const url = input.args["url"]
          if (typeof url !== "string" || url.length === 0) {
            return toolErrorResult({
              code: "invalid_request",
              message: "browser_navigate: 'url' (string) is required",
            })
          }
          const waitFor =
            typeof input.args["wait_for"] === "string"
              ? (input.args["wait_for"] as string)
              : "load"
          const result = await invokeCdpCommand<{ frameId: string }>(
            target.webSocketDebuggerUrl,
            "Page.navigate",
            { url }
          )
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    url,
                    wait_for: waitFor,
                    frameId: result.frameId,
                  },
                  null,
                  2
                ),
              },
            ],
            _meta: { target_id: target.id },
          }
        }
        // browser_read_text
        const maxChars =
          typeof input.args["max_chars"] === "number"
            ? Math.max(1, Math.min(input.args["max_chars"], 200_000))
            : 8192
        const evalResult = await invokeCdpCommand<{
          result?: { value?: unknown }
          exceptionDetails?: { text?: string }
        }>(target.webSocketDebuggerUrl, "Runtime.evaluate", {
          expression: `document.body && document.body.innerText ? document.body.innerText : ''`,
          returnByValue: true,
        })
        if (evalResult.exceptionDetails) {
          return toolErrorResult({
            code: "runtime_constraint",
            message: `evaluate failed: ${evalResult.exceptionDetails.text ?? "unknown"}`,
          })
        }
        const text = String(evalResult.result?.value ?? "").slice(0, maxChars)
        return {
          content: [{ type: "text", text }],
          _meta: { target_id: target.id, char_count: text.length },
        }
      } catch (err) {
        return toolErrorResult({
          code: "runtime_constraint",
          message: `cdp call failed: ${(err as Error).message}`,
        })
      }
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

/**
 * Open a one-shot WebSocket against the target's debugger URL, send a single
 * CDP command, await the matching response, then close. Each tool call uses
 * its own connection — simpler than long-lived state and adequate for the
 * v3 navigate / read-text surface.
 */
function invokeCdpCommand<T>(
  webSocketDebuggerUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl)
    const id = Date.now() + Math.floor(Math.random() * 1000)
    let settled = false
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`CDP ${method} timeout`)))
    }, 30_000)
    ws.on("open", () => {
      ws.send(JSON.stringify({ id, method, params }))
    })
    ws.on("message", (raw) => {
      let frame: {
        id?: number
        result?: T
        error?: { code: number; message: string }
      }
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame.id !== id) return
      clearTimeout(timer)
      if (frame.error) {
        settle(() =>
          reject(new Error(`CDP ${method} error: ${frame.error?.message}`))
        )
        return
      }
      settle(() => resolve(frame.result as T))
    })
    ws.on("error", (err) => {
      clearTimeout(timer)
      settle(() => reject(err))
    })
    ws.on("close", () => {
      clearTimeout(timer)
      settle(() => reject(new Error(`CDP ${method} closed without response`)))
    })
  })
}
