import { z } from "zod"
import {
  isValidTracestateHeader,
  TRACEPARENT_RE,
} from "../utils/traceparent.js"

/**
 * Optional W3C trace-context fields for message ENVELOPES (WS frames, wire
 * bodies) — the carrier contract's zod fragment
 * (docs/trace-propagation-policy.md, "Carrier contract").
 *
 * Spread into an envelope schema's shape:
 *
 *   z.object({ type: z.literal("auth"), ..., ...wireTraceContextFields })
 *
 * The regex and the whole tracestate gate come from `../utils/traceparent.js` —
 * the single in-repo validation artifact; this file defines NO second regex.
 * `tracestate` runs the FULL Level-2 gate (`isValidTracestateHeader`: key/value
 * ABNF, no duplicate keys, ≤32 non-empty members, ≤512 chars) rather than a
 * bare length cap — the 512 cap now lives inside the gate.
 *
 * The `.catch(undefined)` fail-open is load-bearing (receiver rule,
 * degrade-not-reject): a malformed, duplicate-keyed or oversized trace field
 * degrades to ABSENT — it never rejects the business frame it rides on.
 * Verified on zod 4.3.6 including inside `strictObject`, where the failed key
 * is dropped from the parse output.
 */
export const wireTraceContextFields = {
  traceparent: z.string().regex(TRACEPARENT_RE).optional().catch(undefined),
  tracestate: z
    .string()
    .refine(isValidTracestateHeader)
    .optional()
    .catch(undefined),
}

const WireTraceContextSchema = z.object(wireTraceContextFields)

/** The `{traceparent?, tracestate?}` pair as it lands after envelope parsing. */
export type WireTraceContext = z.infer<typeof WireTraceContextSchema>
