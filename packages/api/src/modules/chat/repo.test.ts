import assert from "node:assert/strict"
import test from "node:test"
import { decodeChatJsonRecord } from "./repo.js"

test("decodeChatJsonRecord decodes JSONB string records at repo exit", () => {
  assert.deepEqual(decodeChatJsonRecord('{"draft":"hello","count":2}'), {
    draft: "hello",
    count: 2,
  })
})

test("decodeChatJsonRecord accepts object records without shape loss", () => {
  const record = { metadata: { source: "chat" }, visible: true }

  assert.deepEqual(decodeChatJsonRecord(record), record)
})

test("decodeChatJsonRecord normalizes non-object JSON to an empty object", () => {
  assert.deepEqual(decodeChatJsonRecord("[1,2,3]"), {})
  assert.deepEqual(decodeChatJsonRecord("not json"), {})
  assert.deepEqual(decodeChatJsonRecord(null), {})
})
