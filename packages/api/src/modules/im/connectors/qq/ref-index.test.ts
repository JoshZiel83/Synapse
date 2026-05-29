import test from "node:test"
import assert from "node:assert/strict"
import { parseRefIndices } from "./ref-index.js"

test("parseRefIndices: extracts msg_idx + ref_msg_idx from array ext", () => {
  const result = parseRefIndices({
    ext: ["msg_idx=REF_A", "ref_msg_idx=REF_B", "other=ignored"],
  })
  assert.deepEqual(result, { msgIdx: "REF_A", refMsgIdx: "REF_B" })
})

test("parseRefIndices: tolerates a single string ext (not array)", () => {
  const result = parseRefIndices({ ext: "ref_msg_idx=REF_B" })
  assert.equal(result.refMsgIdx, "REF_B")
  assert.equal(result.msgIdx, undefined)
})

test("parseRefIndices: missing fields stay undefined", () => {
  assert.deepEqual(parseRefIndices({ ext: undefined }), {})
  assert.deepEqual(parseRefIndices({ ext: [] }), {})
  // No msg_idx/ref_msg_idx anywhere → both keys absent from result.
  const result = parseRefIndices({ ext: ["foo=bar"] })
  assert.equal(result.msgIdx, undefined)
  assert.equal(result.refMsgIdx, undefined)
})

test("parseRefIndices: ignores entries without '=' separator", () => {
  const result = parseRefIndices({ ext: ["malformed", "msg_idx="] })
  assert.equal(result.msgIdx, undefined)
  assert.equal(result.refMsgIdx, undefined)
})

test("parseRefIndices: first-occurrence wins on duplicates", () => {
  const result = parseRefIndices({
    ext: ["msg_idx=FIRST", "msg_idx=SECOND"],
  })
  assert.equal(result.msgIdx, "FIRST")
})
