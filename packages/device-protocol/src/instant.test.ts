import assert from "node:assert/strict"
import { test } from "node:test"

import {
  assertIsoInstantString,
  dateToIsoInstant,
  fromExternalRfc3339,
  fromUnixMillis,
  fromUnixSeconds,
  isIsoInstantString,
  nowIsoInstant,
  requireEpochMillis,
  unixSecondsToEpochMillis,
} from "./instant.js"

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

test("dateToIsoInstant returns branded canonical UTC ISO strings", () => {
  assert.equal(
    dateToIsoInstant(new Date("2026-06-08T12:34:56.789Z")),
    CANONICAL
  )
})

test("dateToIsoInstant rejects invalid Date values", () => {
  assert.throws(() => dateToIsoInstant(new Date(Number.NaN)))
})

test("nowIsoInstant produces a canonical instant", () => {
  assert.equal(isIsoInstantString(nowIsoInstant()), true)
})

// --- explicit-unit adapters (C2: fail-loud, no magnitude heuristic) ---

// Derive epochs from CANONICAL so the test is self-consistent.
const CANONICAL_MS = Date.parse(CANONICAL) // 1780922096789
const CANONICAL_S = Math.floor(CANONICAL_MS / 1000) // 1780922096
const CANONICAL_SEC_FLOOR = "2026-06-08T12:34:56.000Z"

test("fromUnixSeconds converts an explicit seconds value", () => {
  assert.equal(fromUnixSeconds(CANONICAL_S), CANONICAL_SEC_FLOOR)
})

test("fromUnixMillis converts an explicit millis value", () => {
  assert.equal(fromUnixMillis(CANONICAL_MS), CANONICAL)
})

test("fromUnixSeconds rejects a millis value passed as seconds (plausibility window)", () => {
  // millis-as-seconds -> year ~58000 -> above the window: catches the classic
  // "passed millis to the seconds adapter" unit error.
  assert.throws(() => fromUnixSeconds(CANONICAL_MS))
})

test("fromUnixMillis rejects a seconds value passed as millis (lands in 1970)", () => {
  assert.throws(() => fromUnixMillis(CANONICAL_S))
})

test("fromUnixSeconds/Millis reject non-finite", () => {
  assert.throws(() => fromUnixSeconds(Number.NaN))
  assert.throws(() => fromUnixMillis(Number.POSITIVE_INFINITY))
})

test("fromExternalRfc3339 normalizes offset/non-canonical input to canonical", () => {
  assert.equal(fromExternalRfc3339("2026-06-08T20:34:56.789+08:00"), CANONICAL)
  assert.equal(fromExternalRfc3339("2026-06-08T12:34:56Z"), CANONICAL_SEC_FLOOR)
})

test("fromExternalRfc3339 throws on empty/unparseable input (never fabricates)", () => {
  assert.throws(() => fromExternalRfc3339(""))
  assert.throws(() => fromExternalRfc3339("not-a-date"))
})

test("unixSecondsToEpochMillis returns plausible millis or throws", () => {
  assert.equal(unixSecondsToEpochMillis(CANONICAL_S), CANONICAL_S * 1000)
  assert.throws(() => unixSecondsToEpochMillis(CANONICAL_MS))
})

test("requireEpochMillis honours explicit unit and rejects garbage", () => {
  assert.equal(requireEpochMillis(CANONICAL_S, "s"), CANONICAL_S * 1000)
  assert.equal(requireEpochMillis(String(CANONICAL_MS), "ms"), CANONICAL_MS)
  assert.throws(() => requireEpochMillis(undefined, "ms"))
  assert.throws(() => requireEpochMillis("nope", "s"))
})
