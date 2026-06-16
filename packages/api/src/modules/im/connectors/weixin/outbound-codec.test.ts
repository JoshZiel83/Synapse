import test from "node:test"
import assert from "node:assert/strict"
import { parseWeixinSendResponseText } from "./outbound-codec.js"

test("parseWeixinSendResponseText: reads top-level message id aliases", () => {
  assert.deepEqual(parseWeixinSendResponseText('{"msg_id":"MSG-1"}'), {
    externalMessageId: "MSG-1",
  })
  assert.deepEqual(parseWeixinSendResponseText('{"message_id":"MSG-2"}'), {
    externalMessageId: "MSG-2",
  })
})

test("parseWeixinSendResponseText: reads nested message id aliases", () => {
  assert.deepEqual(
    parseWeixinSendResponseText('{"msg":{"message_id":"MSG-3"}}'),
    { externalMessageId: "MSG-3" }
  )
  assert.deepEqual(parseWeixinSendResponseText('{"msg":{"msg_id":"MSG-4"}}'), {
    externalMessageId: "MSG-4",
  })
  assert.deepEqual(
    parseWeixinSendResponseText('{"msg":{"item_list":[{"msg_id":"MSG-5"}]}}'),
    { externalMessageId: "MSG-5" }
  )
})

test("parseWeixinSendResponseText: accepts empty or id-less provider responses", () => {
  assert.deepEqual(parseWeixinSendResponseText(""), {})
  assert.deepEqual(parseWeixinSendResponseText('{"ret":0,"errcode":0}'), {})
  assert.deepEqual(parseWeixinSendResponseText('{"msg":{"item_list":[]}}'), {})
})

test("parseWeixinSendResponseText: rejects malformed or non-object provider responses", () => {
  assert.equal(parseWeixinSendResponseText("{not-json"), null)
  assert.equal(parseWeixinSendResponseText("[]"), null)
  assert.equal(parseWeixinSendResponseText("null"), null)
  assert.deepEqual(parseWeixinSendResponseText('{"msg_id":123}'), {})
  assert.deepEqual(
    parseWeixinSendResponseText('{"msg":{"item_list":[{"msg_id":123}]}}'),
    {}
  )
})
