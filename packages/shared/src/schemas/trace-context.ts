import { z } from "zod"
import { MAX_TRACESTATE_LENGTH, TRACEPARENT_RE } from "../utils/traceparent.js"

/**
 * Optional W3C trace-context fields for message ENVELOPES (WS frames, wire
 * bodies) — the carrier contract's zod fragment
 * (docs/trace-correctness-remediation-plan-2026-07-12.md §3c / §4.D).
 *
 * Spread into an envelope schema's shape:
 *
 *   z.object({ type: z.literal("auth"), ..., ...wireTraceContextFields })
 *
 * The regex/cap are imported from `../utils/traceparent.js` — the single
 * in-repo validation artifact; this file deliberately defines NO second regex.
 *
 * The `.catch(undefined)` fail-open is load-bearing (receiver rule §4.F,
 * degrade-not-reject): a malformed or oversized trace field degrades to
 * ABSENT — it never rejects the business frame it rides on. Verified on
 * zod 4.3.6 including inside `strictObject`, where the failed key is dropped
 * from the parse output.
 */
export const wireTraceContextFields = {
  traceparent: z.string().regex(TRACEPARENT_RE).optional().catch(undefined),
  tracestate: z.string().max(MAX_TRACESTATE_LENGTH).optional().catch(undefined),
}

const WireTraceContextSchema = z.object(wireTraceContextFields)

/** The `{traceparent?, tracestate?}` pair as it lands after envelope parsing. */
export type WireTraceContext = z.infer<typeof WireTraceContextSchema>
