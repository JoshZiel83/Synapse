import test from "node:test"
import assert from "node:assert/strict"
import { computeBackoff } from "./backoff.js"

test("grows exponentially and clamps at maxMs", () => {
  const opts = { baseMs: 1000, maxMs: 30000, random: () => 0.5 } // 0.5 → no symmetric jitter
  assert.equal(computeBackoff(0, opts), 1000)
  assert.equal(computeBackoff(1, opts), 2000)
  assert.equal(computeBackoff(2, opts), 4000)
  assert.equal(computeBackoff(5, opts), 30000) // 32000 clamped
  assert.equal(computeBackoff(50, opts), 30000) // far past clamp
})

test("never returns below minMs (floor)", () => {
  const out = computeBackoff(0, {
    baseMs: 1000,
    maxMs: 30000,
    minMs: 1000,
    jitter: 0.25,
    random: () => 0, // 0 → maximally negative symmetric jitter
  })
  assert.ok(out >= 1000)
})

test("symmetric jitter spreads around the value", () => {
  // random=1 → +jitter, random=0 → -jitter
  const hi = computeBackoff(1, {
    baseMs: 1000,
    maxMs: 30000,
    jitter: 0.25,
    random: () => 1,
  })
  const lo = computeBackoff(1, {
    baseMs: 1000,
    maxMs: 30000,
    jitter: 0.25,
    minMs: 0,
    random: () => 0,
  })
  assert.equal(hi, 2500) // 2000 * 1.25
  assert.equal(lo, 1500) // 2000 * 0.75
})

test("additive jitter only ever adds", () => {
  const out = computeBackoff(0, {
    baseMs: 1000,
    maxMs: 60000,
    jitterMode: "additive",
    jitterMs: 1000,
    random: () => 1,
  })
  assert.equal(out, 2000) // 1000 + 1000
  const out0 = computeBackoff(0, {
    baseMs: 1000,
    maxMs: 60000,
    jitterMode: "additive",
    jitterMs: 1000,
    random: () => 0,
  })
  assert.equal(out0, 1000)
})

test("caps the exponent so it cannot overflow", () => {
  const out = computeBackoff(1000, {
    baseMs: 1000,
    maxMs: 60000,
    maxExponent: 30,
    random: () => 0.5,
  })
  assert.equal(out, 60000)
  assert.ok(Number.isFinite(out))
})

test("handles negative/fractional attempts defensively", () => {
  const opts = { baseMs: 1000, maxMs: 30000, random: () => 0.5 }
  assert.equal(computeBackoff(-5, opts), 1000)
  assert.equal(computeBackoff(1.9, opts), 2000) // floored to attempt 1
})
