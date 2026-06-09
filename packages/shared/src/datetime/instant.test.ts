import assert from "node:assert/strict"
import { test } from "node:test"

import {
  assertIsoInstant,
  dateToIsoInstant,
  dateToOptionalIsoInstant,
  isIsoInstant,
  nowIsoInstant,
  parseIsoInstant,
} from "./instant.js"

const CANONICAL = "2026-06-08T12:34:56.789Z"

test("dateToIsoInstant returns canonical UTC ISO strings", () => {
  assert.equal(dateToIsoInstant(new Date(CANONICAL)), CANONICAL)
})

test("dateToOptionalIsoInstant preserves nullish values", () => {
  assert.equal(dateToOptionalIsoInstant(null), undefined)
  assert.equal(dateToOptionalIsoInstant(undefined), undefined)
})

test("assertIsoInstant returns the branded canonical string", () => {
  assert.equal(assertIsoInstant(CANONICAL), CANONICAL)
})

test("parseIsoInstant round-trips canonical strings", () => {
  assert.equal(parseIsoInstant(CANONICAL).toISOString(), CANONICAL)
})

test("isIsoInstant recognizes only canonical strings", () => {
  assert.equal(isIsoInstant(CANONICAL), true)
  assert.equal(isIsoInstant("2026-06-08T12:34:56Z"), false)
})

test("nowIsoInstant produces a canonical instant", () => {
  assert.equal(isIsoInstant(nowIsoInstant()), true)
})
