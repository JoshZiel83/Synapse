import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  isValidTraceparent,
  isValidTracestateHeader,
  MAX_TRACESTATE_LENGTH,
  MAX_TRACESTATE_MEMBERS,
  sanitizeTracestateHeader,
  TRACEPARENT_RE,
  traceIdFromTraceparent,
  tracestateKeys,
} from "./traceparent.js"

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

test("accepts a canonical version-00 traceparent", () => {
  assert.ok(isValidTraceparent(VALID))
  assert.ok(isValidTraceparent(VALID.replace(/01$/, "00"))) // flags-00 is syntactically valid
  assert.equal(VALID.length, 55)
})

test("rejects all-zero trace-id and span-id", () => {
  assert.ok(
    !isValidTraceparent(
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
    )
  )
  assert.ok(
    !isValidTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"
    )
  )
})

test("rejects non-00 versions, bad hex, casing, and junk", () => {
  assert.ok(!isValidTraceparent(VALID.replace(/^00/, "01")))
  assert.ok(!isValidTraceparent(VALID.replace(/^00/, "ff")))
  assert.ok(!isValidTraceparent(VALID.toUpperCase())) // hex must be lowercase
  assert.ok(!isValidTraceparent(`${VALID}-extra`))
  assert.ok(!isValidTraceparent(VALID.slice(0, 54)))
  assert.ok(!isValidTraceparent(` ${VALID}`))
  assert.ok(!isValidTraceparent(""))
  assert.ok(!isValidTraceparent(null))
  assert.ok(!isValidTraceparent(42))
})

test("regex is anchored and non-global (no lastIndex statefulness)", () => {
  assert.ok(!TRACEPARENT_RE.global)
  assert.ok(TRACEPARENT_RE.test(VALID))
  assert.ok(TRACEPARENT_RE.test(VALID)) // second call must not flip on a stateful regex
})

test("traceIdFromTraceparent extracts chars 3..35, undefined on malformed", () => {
  assert.equal(
    traceIdFromTraceparent(VALID),
    "4bf92f3577b34da6a3ce929d0e0e4736"
  )
  assert.equal(traceIdFromTraceparent("garbage"), undefined)
  assert.equal(
    traceIdFromTraceparent(
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
    ),
    undefined
  )
})

test("tracestate cap is reconciled DOWN to OTel-JS core's 512", () => {
  assert.equal(MAX_TRACESTATE_LENGTH, 512)
  assert.equal(MAX_TRACESTATE_MEMBERS, 32)
})

// ── the tracestate gate (moved down from packages/api) ───────────────────────

test("gate passes legitimate vendor lists verbatim", () => {
  for (const header of [
    "es=s:1.0",
    "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    "tenant@system=1", // multi-tenant key form (Level 1, still legal at Level 2)
    "foo=bar,", // trailing empty member is spec-VALID (OWS alternative)
    "foo=bar, baz=qux ", // OWS around members
    "foo=bar,\tbaz=qux", // HTAB is OWS too
    "a= b", // leading space inside a value is grammar-valid chr
  ]) {
    assert.equal(sanitizeTracestateHeader(header), header)
  }
})

test("gate accepts Level-2-only keys the deleted Level-1 union rejected", () => {
  for (const header of [
    "1abc=v", // digit-initial key
    "a@b@c=v", // multiple @ in one key
    "a@abcdefghijklmno=v", // 15-char system id (>13, illegal at Level 1)
  ]) {
    assert.equal(sanitizeTracestateHeader(header), header, header)
  }
})

test("gate drops the WHOLE header on any invalid member", () => {
  for (const header of [
    "sentry.dsc=trace_id=1", // `.` in key AND `=` in value
    "othervendor=xyz,sentry.url=http://x", // one bad member poisons all
    "a=b=c", // `=` in value
    "Foo=bar", // uppercase key
    "@x=v", // key may not start with @
    "foobar", // no `=`
    "日=1", // non-ASCII
    "foo=bar,\nbaz=qux", // \n is NOT OWS — no String.trim() masking
    `long=${"x".repeat(257)}`, // value over the 256-char ABNF bound
    Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(","), // >32 members
  ]) {
    assert.equal(sanitizeTracestateHeader(header), undefined, header)
  }
})

test("gate rejects duplicate keys (Level 2: one entry per key)", () => {
  assert.equal(sanitizeTracestateHeader("ok=1,ok=2"), undefined)
  assert.equal(sanitizeTracestateHeader("a=1,b=2,a=3"), undefined)
  // distinct keys with the same value are fine
  assert.equal(sanitizeTracestateHeader("a=1,b=1"), "a=1,b=1")
})

test("gate counts NON-EMPTY members, so a spec-legal a=1,,b=2 is two members", () => {
  assert.equal(sanitizeTracestateHeader("a=1,,b=2"), "a=1,,b=2")
  // 32 non-empty members interleaved with empties still passes (<=32)
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => `k${i}=v`).join(",,")
  assert.equal(sanitizeTracestateHeader(thirtyTwo), thirtyTwo)
})

test("gate drops a header over the 512-char cap whole (no truncation)", () => {
  // 12 spec-valid members, ~709 chars — passes a bare length<=1024 check but
  // OTel-JS core silently drops the members past 512; whole-or-nothing instead.
  const oversized = Array.from(
    { length: 12 },
    (_, i) => `k${i}=${"v".repeat(55)}`
  ).join(",")
  assert.ok(oversized.length > MAX_TRACESTATE_LENGTH)
  assert.equal(sanitizeTracestateHeader(oversized), undefined)
  // exactly at the cap passes — two members (a single value is ABNF-capped at
  // 256 chars, so 512 needs more than one member).
  const atCap = `a=${"x".repeat(254)},b=${"x".repeat(253)}`
  assert.equal(atCap.length, MAX_TRACESTATE_LENGTH)
  assert.equal(sanitizeTracestateHeader(atCap), atCap)
  // one over the cap fails whole
  assert.equal(sanitizeTracestateHeader(`${atCap}x`), undefined)
})

test("gate degrades headers with no key=value member to undefined", () => {
  assert.equal(sanitizeTracestateHeader(""), undefined)
  assert.equal(sanitizeTracestateHeader(" , ,"), undefined)
})

test("isValidTracestateHeader mirrors the gate's accept/reject verdict", () => {
  assert.equal(isValidTracestateHeader("es=s:1.0"), true)
  assert.equal(isValidTracestateHeader("ok=1,ok=2"), false)
  assert.equal(isValidTracestateHeader(""), false)
})

test("tracestateKeys returns the ordered keys of a gated header", () => {
  assert.deepEqual(tracestateKeys("congo=t61,rojo=00f067,es=s:1.0"), [
    "congo",
    "rojo",
    "es",
  ])
  assert.deepEqual(tracestateKeys("foo=bar, baz=qux "), ["foo", "baz"])
  assert.deepEqual(tracestateKeys("a=1,,b=2"), ["a", "b"])
})

// ── cross-language golden vectors ────────────────────────────────────────────
// The SAME JSON the Go (sidecars/cua) and Rust (sidecars/fs-helper) tests read,
// so all three languages assert identical behaviour on identical inputs.

type Vectors = {
  traceparent: Array<{ v: string; accept: boolean; note: string }>
  tracestate: Array<{
    v: string
    gate: boolean
    capOnly: boolean
    note: string
  }>
}

const vectors = JSON.parse(
  readFileSync(new URL("./traceparent-vectors.json", import.meta.url), "utf8")
) as Vectors

test("golden vectors: traceparent accept matches the gate", () => {
  for (const { v, accept, note } of vectors.traceparent) {
    assert.equal(isValidTraceparent(v), accept, `${note}: ${JSON.stringify(v)}`)
  }
})

test("golden vectors: tracestate gate verdict matches the ABNF gate", () => {
  for (const { v, gate, note } of vectors.tracestate) {
    assert.equal(
      isValidTracestateHeader(v),
      gate,
      `${note}: ${JSON.stringify(v)}`
    )
  }
})
