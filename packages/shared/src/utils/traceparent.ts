/**
 * Canonical W3C trace-context carrier validation — the single in-repo source of
 * truth for traceparent syntax AND the tracestate ABNF gate
 * (docs/trace-propagation-policy.md, "Carrier contract").
 *
 * Dependency-free on purpose: consumed by the api (re-exported from
 * `infrastructure/observability/traceparent.ts`) and device-runtime (direct
 * import) without pulling anything beyond this module.
 *
 * Sanctioned literal duplicates — packages/languages that CANNOT depend on
 * `@synapse/shared` re-declare the SAME regexes and numeric caps under a
 * `synapse-trace-contract v2` block that scripts/guard-trace-propagation.mjs
 * (rule `carrier_contract_drift`) byte-compares against the literals in THIS
 * file. There is no honour system: the guard fails CI on any drift, and a
 * shared golden-vector JSON (`traceparent-vectors.json`) is asserted from the
 * TS, Go and Rust tests so behaviour stays identical too. The four duplicates:
 *   - `packages/remote-agent-daemon/src/trace-context.ts` (independently
 *     published bin, no `@synapse/shared` dependency) — full gate.
 *   - `packages/device-protocol/src/schemas.ts` (zod-only wire fragment;
 *     `@synapse/shared` DEPENDS ON device-protocol, so importing would cycle) —
 *     full gate.
 *   - `sidecars/cua/cmd/synapse-device-cua-helper/main.go` and
 *     `sidecars/fs-helper/src/telemetry.rs` — traceparent + cap only; their
 *     OTel libraries own the tracestate ABNF (whole-or-nothing) natively.
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
 * Uniform cap on a serialized `tracestate` header at every carrier position.
 * 512 is the value `@opentelemetry/core` 2.8.0 actually enforces during parse
 * (`MAX_TRACE_STATE_LEN`, verified in
 * node_modules/@opentelemetry/core/build/src/trace/TraceState.js) AND the W3C
 * trace-context §3.3.1 MUST-propagate floor. A larger cap only lets the library
 * silently drop the members past its own 512-char budget — partial salvage on
 * legitimate traffic — so the gate rejects an over-512 header WHOLE. Our own
 * mints never exceed 484 chars (TraceState.set() refuses anything past 512), so
 * this is free on the emit side.
 */
export const MAX_TRACESTATE_LENGTH = 512

/**
 * Uniform cap on the number of NON-EMPTY list members in a serialized
 * `tracestate` (W3C §3.3.1 `list = list-member 0*31(...)`, and OTel-JS core's
 * `MAX_TRACE_STATE_ITEMS`). Empty OWS-only members are spec-valid and are NOT
 * counted (`a=1,,b=2` is two members), matching what both OTel-JS and Go count.
 */
export const MAX_TRACESTATE_MEMBERS = 32

/**
 * W3C trace-context **Level 2** key grammar
 * (`key = (lcalpha / DIGIT) 0*255(keychar)`, where `keychar` includes `@` as a
 * plain character — Level 2 unified the Level-1 `simple-key / multi-tenant-key`
 * split into this one production). A proven strict SUPERSET of the deleted
 * Level-1 union, so widening to it can only STOP dropping legal headers, never
 * start: `1abc`, `a@b@c` and any tenant@system longer than 13 chars are now
 * accepted; `@x`, `A`, `-x` stay rejected.
 */
export const TRACESTATE_KEY_RE = /^[a-z0-9][a-z0-9_\-*/@]{0,255}$/

/**
 * W3C §3.3.2.1 value grammar: `value = 0*255(chr) nblk-chr`. `chr` excludes `,`
 * (0x2c) and `=` (0x3d); the last char additionally excludes space (0x20). The
 * value production is identical between Level 1 and Level 2.
 */
export const TRACESTATE_VALUE_RE =
  /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/

/**
 * OWS = `*( SP / HTAB )`. Deliberately NOT `String.trim()`, which would also
 * erase spec-invalid padding (`\n`, `\v`, …) and mask a malformed member.
 */
const MEMBER_OWS_RE = /^[ \t]+|[ \t]+$/g

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

/**
 * THE tracestate gate: whole-or-nothing validation of a serialized `tracestate`
 * header against the W3C **Level 2** list ABNF. Returns `raw` verbatim when
 * every member is legal, `undefined` otherwise — partial salvage IS the
 * corruption mechanism (a receiver that keeps the good members re-mints a
 * different header downstream), so any single defect drops the whole field.
 *
 * Enforced, in order:
 *   1. `≤ MAX_TRACESTATE_LENGTH` (512) — over-budget headers are dropped whole
 *      rather than silently truncated by the transport library.
 *   2. key ⇒ TRACESTATE_KEY_RE, value ⇒ TRACESTATE_VALUE_RE, each member has
 *      exactly one `=`.
 *   3. **No duplicate key** (Level 2: "Only one entry per key is allowed";
 *      mirrors go.opentelemetry.io/otel `ParseTraceState`'s `errDuplicate`).
 *   4. `≤ MAX_TRACESTATE_MEMBERS` (32) NON-EMPTY members.
 *
 * Empty/OWS-only members are spec-valid (`foo=bar,` passes, the trailing empty
 * member is the OWS alternative) and are not counted; a header with no
 * `key=value` member at all carries nothing and degrades to `undefined`.
 */
export function sanitizeTracestateHeader(raw: string): string | undefined {
  if (raw.length > MAX_TRACESTATE_LENGTH) return undefined
  const seen = new Set<string>()
  let nonEmpty = 0
  for (const member of raw.split(",")) {
    const m = member.replace(MEMBER_OWS_RE, "")
    if (m === "") continue
    const eq = m.indexOf("=")
    if (eq === -1) return undefined
    const key = m.slice(0, eq)
    if (
      !TRACESTATE_KEY_RE.test(key) ||
      !TRACESTATE_VALUE_RE.test(m.slice(eq + 1))
    ) {
      return undefined
    }
    if (seen.has(key)) return undefined
    seen.add(key)
    nonEmpty += 1
    if (nonEmpty > MAX_TRACESTATE_MEMBERS) return undefined
  }
  return nonEmpty > 0 ? raw : undefined
}

/** Predicate form of {@link sanitizeTracestateHeader} for zod `.refine(...)`. */
export function isValidTracestateHeader(raw: string): boolean {
  return sanitizeTracestateHeader(raw) !== undefined
}

/**
 * The ordered keys of an already-gated tracestate header (the caller passes the
 * output of {@link sanitizeTracestateHeader}). Used by the api's stage-3
 * transport-salvage detector to assert every gated key survived
 * `propagation.extract`.
 */
export function tracestateKeys(header: string): string[] {
  const keys: string[] = []
  for (const member of header.split(",")) {
    const m = member.replace(MEMBER_OWS_RE, "")
    if (m === "") continue
    const eq = m.indexOf("=")
    if (eq === -1) continue
    keys.push(m.slice(0, eq))
  }
  return keys
}
