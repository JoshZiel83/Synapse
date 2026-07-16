import test from "node:test"
import assert from "node:assert/strict"
import {
  isValidTraceparent,
  MAX_TRACESTATE_LENGTH,
  TRACEPARENT_RE,
  traceIdFromTraceparent,
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

test("tracestate cap is the uniform 1024", () => {
  assert.equal(MAX_TRACESTATE_LENGTH, 1024)
})
