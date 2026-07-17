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

import { propagation, ROOT_CONTEXT, type Context } from "@opentelemetry/api"
import { MAX_TRACESTATE_LENGTH, type TraceCarrier } from "@synapse/shared"
import { createLogger } from "../logger/index.js"
import { isValidTraceparent } from "./traceparent.js"

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
 * fields: re-validate against the canonical strict regex (defense-in-depth —
 * the control-plane hands RAW pre-zod params in here; the zod fragments have
 * already `.catch(undefined)`-degraded parsed envelopes), then
 * `propagation.extract(ROOT_CONTEXT, carrier)` through the global propagator
 * (under Sentry-ON that is the composite behind FirstPartyOnlyPropagator,
 * whose extract delegates unconditionally — probe P-D2). Anything invalid ⇒
 * `ROOT_CONTEXT`; a malformed tracestate drops the FIELD, never the
 * traceparent (degrade-not-reject, §4.F).
 */
export function extractEnvelopeTraceContext(envelope: unknown): Context {
  if (typeof envelope !== "object" || envelope === null) return ROOT_CONTEXT
  const { traceparent, tracestate } = envelope as Record<string, unknown>
  if (!isValidTraceparent(traceparent)) {
    if (traceparent !== undefined)
      warnInvalidFieldOnce("traceparent", traceparent)
    return ROOT_CONTEXT
  }
  const carrier: TraceCarrier = { traceparent }
  if (
    typeof tracestate === "string" &&
    tracestate.length <= MAX_TRACESTATE_LENGTH
  ) {
    carrier.tracestate = tracestate
  } else if (tracestate !== undefined) {
    warnInvalidFieldOnce("tracestate", tracestate)
  }
  return propagation.extract(ROOT_CONTEXT, carrier)
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
