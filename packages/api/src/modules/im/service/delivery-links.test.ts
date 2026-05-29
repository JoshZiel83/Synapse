import test from "node:test"
import assert from "node:assert/strict"
import { deepMergeJsonObjects } from "./delivery-links.js"

test("deepMergeJsonObjects: shallow keys are overwritten", () => {
  const out = deepMergeJsonObjects({ a: 1, b: 2 }, { b: 3, c: 4 })
  assert.deepEqual(out, { a: 1, b: 3, c: 4 })
})

test("deepMergeJsonObjects: nested objects are merged recursively", () => {
  const out = deepMergeJsonObjects(
    { qq: { msgSeq: 7, attempts: { "0": { outcome: "in_flight" } } } },
    { qq: { attempts: { "0": { outcome: "delivered" } } } }
  )
  assert.deepEqual(out, {
    qq: { msgSeq: 7, attempts: { "0": { outcome: "delivered" } } },
  })
})

test("deepMergeJsonObjects: arrays are replaced wholesale (not concatenated)", () => {
  const out = deepMergeJsonObjects({ tags: ["a", "b", "c"] }, { tags: ["x"] })
  assert.deepEqual(out, { tags: ["x"] })
})

test("deepMergeJsonObjects: nested keys are additive across attempts", () => {
  // The pattern QQ uses: each attempt writes its own subkey under attempts.
  const after0 = deepMergeJsonObjects(
    { qq: { attempts: {} } },
    { qq: { attempts: { "0": { outcome: "in_flight" } } } }
  )
  const after1 = deepMergeJsonObjects(after0, {
    qq: { attempts: { "1": { outcome: "in_flight" } } },
  })
  assert.deepEqual(after1, {
    qq: {
      attempts: {
        "0": { outcome: "in_flight" },
        "1": { outcome: "in_flight" },
      },
    },
  })
})

test("deepMergeJsonObjects: object replaces scalar (different shape)", () => {
  const out = deepMergeJsonObjects(
    { qq: "legacy-string" },
    { qq: { msgSeq: 1 } }
  )
  assert.deepEqual(out, { qq: { msgSeq: 1 } })
})

test("deepMergeJsonObjects: scalar replaces object", () => {
  const out = deepMergeJsonObjects({ qq: { msgSeq: 1 } }, { qq: null })
  assert.deepEqual(out, { qq: null })
})

test("deepMergeJsonObjects: empty patch returns equivalent base", () => {
  const base = { a: 1, nested: { x: 1 } }
  const out = deepMergeJsonObjects(base, {})
  assert.deepEqual(out, base)
  // Returns a fresh top-level object (shallow copy)
  assert.notStrictEqual(out, base)
})

test("deepMergeJsonObjects: null in patch wins (caller intends delete-via-null)", () => {
  const out = deepMergeJsonObjects(
    { qq: { msgSeq: 1, anchor: { id: "x" } } },
    { qq: { anchor: null } }
  )
  assert.deepEqual(out, { qq: { msgSeq: 1, anchor: null } })
})
