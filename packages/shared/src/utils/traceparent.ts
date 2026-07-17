/**
 * Canonical W3C trace-context carrier validation — the single in-repo source of
 * truth for traceparent syntax and the tracestate size cap
 * (docs/trace-correctness-remediation-plan-2026-07-12.md §3c).
 *
 * Dependency-free on purpose: consumed by the api (re-exported from
 * `infrastructure/observability/traceparent.ts`) and device-runtime without
 * pulling anything beyond this module.
 *
 * Sanctioned literal duplicates — packages that must NOT depend on
 * `@synapse/shared` pin the SAME regex/cap with a cross-reference comment.
 * Any change here must be mirrored byte-for-byte in:
 *   - `packages/remote-agent-daemon` (independently published bin, no
 *     `@synapse/shared` dependency)
 *   - `packages/device-protocol/src/schemas.ts` (zod-only wire fragment)
 *   - `sidecars/cua/cmd/synapse-device-cua-helper/main.go` and
 *     `sidecars/fs-helper/src/telemetry.rs` (Go/Rust JSON-RPC extractors)
 */

/**
 * Strict version-00 traceparent. Internal carriers are always minted by our own
 * code, which emits version 00, so no version-agnostic parsing: exactly
 * `00-<32 hex>-<16 hex>-<2 hex>`, with the all-zero trace-id and span-id
 * (invalid per W3C trace-context §3.2) rejected. A valid value is exactly 55
 * characters — safely under the 64-char log-ingest field cap, so receivers can
 * ship it verbatim.
 */
export const TRACEPARENT_RE =
  /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/

/**
 * Uniform cap on a serialized `tracestate` header at every carrier position
 * (wire receivers degrade oversized values to absent; minters drop the header).
 * Matches the smallest MUST-support size in W3C trace-context §3.3.1.
 */
export const MAX_TRACESTATE_LENGTH = 1024

/**
 * The `{traceparent, tracestate?}` pair carried at every non-HTTP hop position:
 * MCP `_meta`, JSON-RPC frame top-level, daemon WS message top-level, BullMQ
 * `__otelctx`, WS message envelope fields.
 */
export interface TraceCarrier {
  traceparent: string
  tracestate?: string
}

/** True iff `value` is a strict version-00 traceparent (see TRACEPARENT_RE). */
export function isValidTraceparent(value: unknown): value is string {
  return typeof value === "string" && TRACEPARENT_RE.test(value)
}

/**
 * The 32-hex trace-id of a valid traceparent (chars 3..35), or undefined for
 * anything malformed. For log shipping / persisted `origin_traceparent`-family
 * correlation, which need only the trace-id.
 */
export function traceIdFromTraceparent(
  traceparent: string
): string | undefined {
  return TRACEPARENT_RE.test(traceparent) ? traceparent.slice(3, 35) : undefined
}
