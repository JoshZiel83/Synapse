import test from "node:test"
import assert from "node:assert/strict"
import { parseDingtalkStreamPayload } from "./stream-codec.js"

test("parseDingtalkStreamPayload: accepts JSON object provider payload", () => {
  assert.deepEqual(
    parseDingtalkStreamPayload(
      JSON.stringify({
        msgId: "msg-1",
        msgtype: "text",
        conversationId: "cid-1",
        text: { content: "hello" },
      })
    ),
    {
      msgId: "msg-1",
      msgtype: "text",
      conversationId: "cid-1",
      text: { content: "hello" },
    }
  )
})

test("parseDingtalkStreamPayload: rejects malformed or non-object payloads", () => {
  assert.equal(parseDingtalkStreamPayload("{not-json"), null)
  assert.equal(parseDingtalkStreamPayload(JSON.stringify(null)), null)
  assert.equal(parseDingtalkStreamPayload(JSON.stringify([])), null)
  assert.equal(parseDingtalkStreamPayload(JSON.stringify("text")), null)
  assert.equal(parseDingtalkStreamPayload({ msgId: "msg-1" }), null)
})
