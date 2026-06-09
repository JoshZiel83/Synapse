import assert from "node:assert/strict"
import { test } from "node:test"

import { assertIsoInstantString, isIsoInstantString } from "./instant.js"

const CANONICAL = "2026-06-08T12:34:56.789Z"

test("isIsoInstantString accepts canonical UTC ISO strings", () => {
  assert.equal(isIsoInstantString(CANONICAL), true)
})

test("isIsoInstantString rejects non-canonical or non-UTC strings", () => {
  assert.equal(isIsoInstantString("2026-06-08T12:34:56Z"), false)
  assert.equal(isIsoInstantString("2026-06-08T20:34:56.789+08:00"), false)
  assert.equal(isIsoInstantString("not-a-date"), false)
  assert.equal(isIsoInstantString(null), false)
})

test("assertIsoInstantString returns branded value for canonical strings", () => {
  assert.equal(assertIsoInstantString(CANONICAL), CANONICAL)
})

test("assertIsoInstantString throws on invalid strings", () => {
  assert.throws(() => assertIsoInstantString("2026-06-08T12:34:56Z"))
})
