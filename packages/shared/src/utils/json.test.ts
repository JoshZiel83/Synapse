import test from "node:test"
import assert from "node:assert/strict"
import { parseJsonObject, parseJsonObjectOrUndefined } from "./json.js"

test("parses a JSON object string", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 })
})

test("passes through a plain object", () => {
  const o = { a: 1 }
  assert.deepEqual(parseJsonObject(o), o)
})

test("rejects arrays (string and value forms) → {}", () => {
  assert.deepEqual(parseJsonObject("[1,2,3]"), {})
  assert.deepEqual(parseJsonObject([1, 2, 3]), {})
})

test("rejects primitives / null / invalid JSON → {}", () => {
  assert.deepEqual(parseJsonObject("not json"), {})
  assert.deepEqual(parseJsonObject(null), {})
  assert.deepEqual(parseJsonObject(42), {})
  assert.deepEqual(parseJsonObject('"a string"'), {})
})

test("parseJsonObjectOrUndefined distinguishes absent from empty", () => {
  assert.equal(parseJsonObjectOrUndefined(null), undefined)
  assert.equal(parseJsonObjectOrUndefined(undefined), undefined)
  assert.equal(parseJsonObjectOrUndefined("[1]"), undefined)
  assert.equal(parseJsonObjectOrUndefined("bad"), undefined)
  assert.deepEqual(parseJsonObjectOrUndefined('{"x":1}'), { x: 1 })
  assert.deepEqual(parseJsonObjectOrUndefined({}), {})
})
