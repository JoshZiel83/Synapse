import { AsyncLocalStorage } from "node:async_hooks"
import {
  isValidTraceparent,
  sanitizeTracestateHeader,
  type TraceCarrier,
} from "@synapse/shared"
import { createDeviceLogger } from "./logger.js"

/**
 * Per-dispatch W3C `{traceparent, tracestate?}` carrier (trace plan §3c/§4.G).
 *
 * The api injects the carrier into each device `tools/call` `_meta`
 * (dispatch.ts). The MCP host (mcp-host.ts) validates + extracts it and runs
 * the dispatch inside this AsyncLocalStorage; the sidecar transport
 * (sidecar.ts) then spreads the active carrier onto every outbound JSON-RPC
 * frame so cua/fs-helper can continue the SAME trace per request, and the
 * logger (logger.ts) stamps the active traceparent per record. A lightweight
 * string-only carrier — no OpenTelemetry SDK on this published bin.
 *
 * Validation is the canonical `@synapse/shared` artifact (strict version-00
 * regex, all-zero rejected; tracestate through the full Level-2 gate
 * `sanitizeTracestateHeader` — key/value ABNF, no duplicate keys, ≤32 members,
 * ≤512 chars — and accepted only alongside a valid traceparent). Receiver rule:
 * a malformed value degrades to ABSENT — never rejected, never forwarded, never
 * logged raw. No extract happens here: the carrier is re-stamped onto JSON-RPC
 * frames, where cua/fs-helper apply their own whole-or-nothing tracestate parse.
 */
const store = new AsyncLocalStorage<TraceCarrier>()

/** Run `fn` with `carrier` as the active device trace context. */
export function runWithTraceContext<T>(
  carrier: TraceCarrier | undefined,
  fn: () => T
): T {
  return carrier ? store.run(carrier, fn) : fn()
}

/** The active dispatch's {traceparent, tracestate?} carrier, if any. */
export function getTraceContext(): TraceCarrier | undefined {
  return store.getStore()
}

/** Convenience: the active dispatch's W3C traceparent, if any. */
export function getTraceparent(): string | undefined {
  return store.getStore()?.traceparent
}

// §3c receiver rule: warn ONCE per process on the first malformed value,
// logging only the value's length (a raw invalid value must never reach any
// sink — it could be a batch-poisoning payload).
let warnedInvalidMeta = false
function warnInvalidOnce(field: string, length: number): void {
  if (warnedInvalidMeta) return
  warnedInvalidMeta = true
  createDeviceLogger("trace-context").warn(
    "invalid trace context in tools/call _meta dropped (degrade-not-reject; warn-once)",
    { field, valueLength: length }
  )
}

/**
 * Extract + validate a `{traceparent, tracestate?}` carrier from a tools/call
 * `_meta` object. An invalid traceparent degrades the whole carrier to
 * undefined (the frame is never rejected for a trace field); tracestate is
 * accepted only alongside a valid traceparent and only when it passes the full
 * gate (`sanitizeTracestateHeader`: Level-2 ABNF, no duplicate keys, ≤32
 * members, ≤512 chars) — otherwise the tracestate drops and the traceparent
 * still rides.
 */
export function traceContextFromMeta(meta: unknown): TraceCarrier | undefined {
  if (!meta || typeof meta !== "object") return undefined
  const record = meta as Record<string, unknown>
  const tp = record["traceparent"]
  if (tp === undefined) return undefined
  if (!isValidTraceparent(tp)) {
    warnInvalidOnce("traceparent", typeof tp === "string" ? tp.length : -1)
    return undefined
  }
  const ts = record["tracestate"]
  if (typeof ts !== "string") return { traceparent: tp }
  const gated = sanitizeTracestateHeader(ts)
  if (gated === undefined) {
    if (ts.length > 0) warnInvalidOnce("tracestate", ts.length)
    return { traceparent: tp }
  }
  return { traceparent: tp, tracestate: gated }
}
