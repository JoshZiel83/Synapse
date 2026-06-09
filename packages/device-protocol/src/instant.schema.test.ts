import assert from "node:assert/strict"
import { test } from "node:test"

import { IsoInstantStringSchema } from "./instant.schema.js"

const CANONICAL = "2026-06-08T12:34:56.789Z"

test("IsoInstantStringSchema accepts canonical UTC ISO strings", () => {
  assert.equal(IsoInstantStringSchema.parse(CANONICAL), CANONICAL)
})

test("IsoInstantStringSchema rejects non-canonical strings", () => {
  assert.throws(() => IsoInstantStringSchema.parse("2026-06-08T12:34:56Z"))
  assert.throws(() =>
    IsoInstantStringSchema.parse("2026-06-08T20:34:56.789+08:00")
  )
  assert.throws(() => IsoInstantStringSchema.parse("not-a-date"))
})
