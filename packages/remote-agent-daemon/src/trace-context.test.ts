import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  activeWireTraceFields,
  getCarrier,
  getTraceparent,
  isValidTraceparent,
  runWithCarrier,
  runWithoutCarrier,
  sanitizeTracestateHeader,
  traceIdOf,
} from "./trace-context.js"

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

test("activeWireTraceFields: machine-message frames inside a carrier scope carry the pair; outside they carry NOTHING", () => {
  // Outside any scope (the heartbeat situation): spreading the fields adds
  // no keys — a heartbeat-style frame stays untraced by construction.
  const bare = {
    type: "agent:status",
    state: "running",
    ...activeWireTraceFields(),
  }
  assert.equal("traceparent" in bare, false)
  assert.equal("tracestate" in bare, false)

  // Inside a scope WITH tracestate: both fields ride the frame.
  runWithCarrier({ traceparent: TP, tracestate: "es=s:1.0" }, () => {
    const frame = {
      type: "agent:status",
      state: "running",
      ...activeWireTraceFields(),
    }
    assert.equal(frame.traceparent, TP)
    assert.equal(frame.tracestate, "es=s:1.0")
  })

  // Inside a scope WITHOUT tracestate: traceparent only, never an empty
  // tracestate key.
  runWithCarrier({ traceparent: TP }, () => {
    const fields = activeWireTraceFields()
    assert.deepEqual(fields, { traceparent: TP })
    assert.equal("tracestate" in fields, false)
  })
})

test("runWithCarrier: undefined scope is a plain call-through; scopes nest and restore", () => {
  assert.equal(
    runWithCarrier(undefined, () => getCarrier()),
    undefined
  )
  runWithCarrier({ traceparent: TP }, () => {
    assert.equal(getTraceparent(), TP)
    const inner = "00-1af7651916cd43dd8448eb211c80319d-c7ad6b7169203332-01"
    runWithCarrier({ traceparent: inner }, () => {
      assert.equal(getTraceparent(), inner)
    })
    assert.equal(getTraceparent(), TP, "outer scope restored")
  })
  assert.equal(getTraceparent(), undefined, "no leak outside the scope")
})

test("runWithoutCarrier: masks an ambient carrier scope (unlike runWithCarrier(undefined)) and restores it after", () => {
  runWithCarrier({ traceparent: TP, tracestate: "es=s:1.0" }, () => {
    // runWithCarrier(undefined) is a plain call-through — ambient stays visible.
    runWithCarrier(undefined, () => {
      assert.equal(getTraceparent(), TP)
    })
    // runWithoutCarrier MASKS the ambient scope: nothing reads a carrier, so
    // an outbound requestJson inside sends NO traceparent header (the
    // mixed-origin fail-deliveries contract — fresh api-side root).
    runWithoutCarrier(() => {
      assert.equal(getCarrier(), undefined)
      assert.equal(getTraceparent(), undefined)
      assert.deepEqual(activeWireTraceFields(), {})
    })
    assert.equal(getTraceparent(), TP, "ambient scope restored")
  })
  // Outside any scope it is inert.
  runWithoutCarrier(() => {
    assert.equal(getCarrier(), undefined)
  })
  assert.equal(getTraceparent(), undefined)
})

test("traceIdOf / isValidTraceparent follow the pinned §3c contract", () => {
  assert.equal(traceIdOf(TP), "0af7651916cd43dd8448eb211c80319c")
  assert.equal(traceIdOf("garbage"), undefined)
  assert.equal(
    traceIdOf("00-00000000000000000000000000000000-b7ad6b7169203331-01"),
    undefined,
    "all-zero trace-id is rejected"
  )
  assert.equal(isValidTraceparent(TP), true)
  assert.equal(isValidTraceparent(TP.toUpperCase()), false)
  assert.equal(isValidTraceparent(null), false)
})

// The SAME cross-language golden vectors the shared/Go/Rust tests read (test-
// only, monorepo-relative — the published bin is untouched). Proves the daemon
// duplicate returns verdicts byte-identical to the canonical gate.
type CarrierVectors = {
  traceparent: Array<{ v: string; accept: boolean; note: string }>
  tracestate: Array<{
    v: string
    gate: boolean
    capOnly: boolean
    note: string
  }>
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../shared/src/utils/traceparent-vectors.json", import.meta.url),
    "utf8"
  )
) as CarrierVectors

test("golden vectors: the daemon carrier gate matches the canonical gate", () => {
  for (const { v, accept, note } of vectors.traceparent) {
    assert.equal(
      isValidTraceparent(v),
      accept,
      `traceparent ${note}: ${JSON.stringify(v)}`
    )
  }
  for (const { v, gate, note } of vectors.tracestate) {
    assert.equal(
      sanitizeTracestateHeader(v) !== undefined,
      gate,
      `tracestate ${note}: ${JSON.stringify(v)}`
    )
  }
})

// The cap/member branches of THIS duplicate, asserted inline so they never
// depend solely on the shared JSON being present + carrying those categories
// (anti-drift belt-and-braces — a golden vector could be deleted upstream and
// the byte guard would not notice a member-count regression here).
test("daemon gate: >32 non-empty members and >512 chars both drop the whole header", () => {
  // 33 non-empty members > MAX_TRACESTATE_MEMBERS (32): rejected on member
  // count even though every member is individually legal and the header fits
  // well under the length cap.
  const overMembers = Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(",")
  assert.ok(
    overMembers.length < 512,
    "member-count fixture must stay under the length cap"
  )
  assert.equal(sanitizeTracestateHeader(overMembers), undefined)
  // Exactly 32 members is still accepted (the boundary is inclusive).
  const atMembers = Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(",")
  assert.equal(sanitizeTracestateHeader(atMembers), atMembers)

  // 513 chars > MAX_TRACESTATE_LENGTH (512), two otherwise-valid members:
  // rejected on length alone.
  const overLength = `a=${"v".repeat(254)},b=${"v".repeat(254)}`
  assert.equal(overLength.length, 513)
  assert.equal(sanitizeTracestateHeader(overLength), undefined)
})
