import { test } from "node:test"
import assert from "node:assert/strict"

import { createUuid, isUuid } from "./index.js"

test("createUuid produces a string that passes strict isUuid", () => {
  for (let i = 0; i < 50; i += 1) {
    const id = createUuid()
    assert.equal(isUuid(id), true, `expected ${id} to be a valid UUID`)
  }
})

test("createUuid sets the v4 version + RFC-4122 variant nibbles", () => {
  const id = createUuid()
  // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx ; y in [89ab]
  assert.equal(id[14], "4", `version nibble should be 4 in ${id}`)
  assert.ok(["8", "9", "a", "b"].includes(id[19]!.toLowerCase()), id)
})

test("createUuid returns distinct values", () => {
  const a = createUuid()
  const b = createUuid()
  assert.notEqual(a, b)
})

test("isUuid rejects non-UUID strings (incl. generateId-style ids)", () => {
  assert.equal(isUuid(""), false)
  assert.equal(isUuid(null), false)
  assert.equal(isUuid(undefined), false)
  assert.equal(isUuid("not-a-uuid"), false)
  // generateId() fallback shape — must NOT validate as a UUID
  assert.equal(isUuid("id_abc123_1700000000000"), false)
  assert.equal(isUuid("block_xyz_1700000000000"), false)
})
