// Shared WS-envelope receiver helper (docs/trace-correctness-remediation-plan-
// 2026-07-12.md §4.D change 5). Every WS surface — chat `/ws`, `/ws/asr`, the
// device control-plane, and (from Phase 3, workstream C) the remote-agents
// machine-message handlers — turns a message envelope's optional
// `{traceparent, tracestate}` fields into a per-message Context HERE, then
// opens its logical-operation span inside it.
//
// The invariant: **extract-or-ROOT, never `context.active()`** — WS message
// handlers run under the (deliberately span-free, `config:{otel:false}`)
// upgrade request, and falling back to the ambient context would re-parent
// message spans onto connection-lifetime state. A frame without (or with an
// invalid) carrier gets a fresh root, full stop.
//
// RING-0 BY CONSTRUCTION (round-2 trust boundary, §3a A3): a WS envelope carrier
// is client-supplied — the frame is untrusted, which is exactly why the raw
// {traceparent, tracestate} fields are re-validated here. So EVERY per-message
// span is a public-ingress entry span and this helper marks its context
// public-ingress on ALL exits (the extracted context AND every ROOT_CONTEXT
// early return), UNCONDITIONALLY. Marking here rather than threading a flag from
// the upgrade request is deliberate and fail-closed: a new WS surface that calls
// this helper inherits the marking for free and cannot forget to opt in. This
// closes the per-message trace-id adoption path an HTTP-only ingress fix would
// miss (an HTTP marker never touches these carriers). The marker only feeds the
// span attribute + policy (never sampling math, R3); it never rides any wire.

import { ROOT_CONTEXT, type Context } from "@opentelemetry/api"
import type { TraceCarrier } from "@synapse/shared"
import { createLogger } from "../logger/index.js"
import { markPublicIngress } from "./ingress-trust.js"
import {
  extractTraceCarrierContext,
  isValidTraceparent,
  sanitizeTracestateHeader,
} from "./traceparent.js"

const log = createLogger("server.ws")

// Receiver rule (§3c, degrade-not-reject): never forward or log a raw invalid
// value (a valid traceparent is exactly 55 chars — an attacker-controlled blob
// is not) — warn once per process PER FIELD with only the field name and
// length, so a noisy traceparent doesn't permanently silence the
// diagnostically different oversized-tracestate warning (or vice versa).
const warnedInvalidEnvelopeTraceField = {
  traceparent: false,
  tracestate: false,
}
function warnInvalidFieldOnce(
  field: "traceparent" | "tracestate",
  value: unknown
): void {
  if (warnedInvalidEnvelopeTraceField[field]) return
  warnedInvalidEnvelopeTraceField[field] = true
  log.warn(
    {
      field,
      valueType: typeof value,
      valueLength: typeof value === "string" ? value.length : undefined,
    },
    "invalid trace field on a WS envelope — degraded to absent (warn-once)"
  )
}

/**
 * Per-message context from an envelope's optional `{traceparent, tracestate}`
 * fields: re-validate the traceparent against the canonical strict regex, run
 * the tracestate through the canonical gate (`sanitizeTracestateHeader`:
 * Level-2 ABNF, no duplicate keys, ≤32 members, ≤512 chars), then extract via
 * `extractTraceCarrierContext(ROOT_CONTEXT, carrier)`. This is defence-in-depth
 * — the control-plane hands RAW pre-zod params in here; the zod fragments have
 * already `.catch(undefined)`-degraded parsed envelopes — AND the stage-3
 * salvage guard: a gated key OTel-JS still drops per-member causes the whole
 * tracestate to fall away rather than re-mint partially salvaged. Anything
 * invalid ⇒ `ROOT_CONTEXT`; a malformed tracestate drops the FIELD, never the
 * traceparent (degrade-not-reject).
 */
export function extractEnvelopeTraceContext(envelope: unknown): Context {
  // markPublicIngress on EVERY exit: a WS frame is Ring-0 by construction, so
  // its per-message span is always an untrusted-ingress entry span (see header).
  if (typeof envelope !== "object" || envelope === null) {
    return markPublicIngress(ROOT_CONTEXT)
  }
  const { traceparent, tracestate } = envelope as Record<string, unknown>
  if (!isValidTraceparent(traceparent)) {
    if (traceparent !== undefined)
      warnInvalidFieldOnce("traceparent", traceparent)
    return markPublicIngress(ROOT_CONTEXT)
  }
  const carrier: TraceCarrier = { traceparent }
  if (typeof tracestate === "string") {
    const gated = sanitizeTracestateHeader(tracestate)
    if (gated !== undefined) carrier.tracestate = gated
    else warnInvalidFieldOnce("tracestate", tracestate)
  } else if (tracestate !== undefined) {
    warnInvalidFieldOnce("tracestate", tracestate)
  }
  return markPublicIngress(extractTraceCarrierContext(ROOT_CONTEXT, carrier))
}

/**
 * Connection-close telemetry — ONE structured log line per WS connection
 * (duration, inbound frame count, close code) instead of a connection-lifetime
 * span. Emitted by the ephemeral client surfaces: chat `/ws` and `/ws/asr`.
 * The device control-plane and the remote-agents machine surface deliberately
 * do NOT call this — their connection telemetry is the durable session rows
 * (`runtime_control_plane_sessions` / `remote_agent_machine_sessions`, opened
 * on connect and closed with a reason). (The designed `wsMetrics` OTel
 * instruments were cut: no MeterProvider exists in packages/api, so they
 * would be dead scaffolding — §8 backlog.)
 */
export function logWsConnectionClosed(
  surface: string,
  durationMs: number,
  messagesIn: number,
  closeCode: number | undefined
): void {
  log.info(
    { surface, durationMs: Math.round(durationMs), messagesIn, closeCode },
    "ws connection closed"
  )
}
