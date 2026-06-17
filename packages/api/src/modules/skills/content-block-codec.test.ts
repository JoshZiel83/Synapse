import assert from "node:assert/strict"
import test from "node:test"
import {
  normalizeStoredBlocks,
  readDecodedArray,
} from "./content-block-codec.js"

test("readDecodedArray only accepts already-decoded arrays", () => {
  assert.deepEqual(readDecodedArray([{ type: "text", text: "decoded" }]), [
    { type: "text", text: "decoded" },
  ])
  assert.deepEqual(readDecodedArray('[{"type":"text","text":"legacy"}]'), [])
  assert.deepEqual(readDecodedArray({ value: [] }), [])
})

test("normalizeStoredBlocks normalizes decoded canonical content blocks", () => {
  const blocks = normalizeStoredBlocks([{ type: "text", text: "hello" }])
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, "text")
  if (blocks[0]?.type === "text") {
    assert.equal(blocks[0].text, "hello")
  }
  assert.deepEqual(
    normalizeStoredBlocks('[{"type":"text","text":"legacy"}]'),
    []
  )
})
