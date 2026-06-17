import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-dispatch W3C `traceparent` carrier (logging refactor P7).
 *
 * The api injects a `traceparent` into each device `tools/call` `_meta`
 * (dispatch.ts). The MCP host (mcp-host.ts) reads it and runs the dispatch
 * inside this AsyncLocalStorage; the sidecar transport (sidecar.ts) then stamps
 * the active traceparent onto every outbound JSON-RPC frame so cua/fs-helper can
 * continue the SAME trace per request. A lightweight string-only carrier — no
 * OpenTelemetry SDK on this published bin.
 */
const store = new AsyncLocalStorage<string>()

/** Run `fn` with `traceparent` as the active device trace context. */
export function runWithTraceparent<T>(
  traceparent: string | undefined,
  fn: () => T
): T {
  return traceparent ? store.run(traceparent, fn) : fn()
}

/** The active dispatch's W3C traceparent, if any. */
export function getTraceparent(): string | undefined {
  return store.getStore()
}

/** Extract a W3C traceparent string from a tools/call `_meta` object. */
export function traceparentFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined
  const tp = (meta as Record<string, unknown>)["traceparent"]
  return typeof tp === "string" && tp.length > 0 ? tp : undefined
}
