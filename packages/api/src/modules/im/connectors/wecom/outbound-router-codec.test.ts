import test from "node:test"
import assert from "node:assert/strict"
import {
  parseWecomOutboundRequestPayload,
  parseWecomOutboundResponsePayload,
} from "./outbound-router-codec.js"

test("parseWecomOutboundRequestPayload: validates internal Redis request wrapper", () => {
  assert.deepEqual(
    parseWecomOutboundRequestPayload(
      JSON.stringify({
        requestId: "REQ-1",
        frameBody: {
          chatid: "CHAT-1",
          body: { msgtype: "markdown", markdown: { content: "hello" } },
        },
      })
    ),
    {
      requestId: "REQ-1",
      frameBody: {
        chatid: "CHAT-1",
        body: { msgtype: "markdown", markdown: { content: "hello" } },
      },
    }
  )
})

test("parseWecomOutboundRequestPayload: rejects malformed or drifted request payloads", () => {
  assert.equal(parseWecomOutboundRequestPayload("{not-json"), null)
  assert.equal(
    parseWecomOutboundRequestPayload(
      JSON.stringify({
        requestId: "",
        frameBody: { chatid: "CHAT-1", body: { msgtype: "markdown" } },
      })
    ),
    null
  )
  assert.equal(
    parseWecomOutboundRequestPayload(
      JSON.stringify({
        requestId: "REQ-1",
        frameBody: { chatid: "", body: { msgtype: "markdown" } },
      })
    ),
    null
  )
  assert.equal(
    parseWecomOutboundRequestPayload(
      JSON.stringify({
        requestId: "REQ-1",
        frameBody: { chatid: "CHAT-1", body: "not-object" },
      })
    ),
    null
  )
})

test("parseWecomOutboundResponsePayload: validates success and failure wrappers", () => {
  assert.deepEqual(
    parseWecomOutboundResponsePayload(
      JSON.stringify({
        ok: true,
        raw: { headers: { req_id: "RID-1" }, body: { msgid: "MSG-1" } },
      })
    ),
    {
      ok: true,
      raw: { headers: { req_id: "RID-1" }, body: { msgid: "MSG-1" } },
    }
  )
  assert.deepEqual(
    parseWecomOutboundResponsePayload(
      JSON.stringify({ ok: false, error: "send failed" })
    ),
    { ok: false, error: "send failed" }
  )
})

test("parseWecomOutboundResponsePayload: rejects malformed or drifted responses", () => {
  assert.equal(parseWecomOutboundResponsePayload("{not-json"), null)
  assert.equal(
    parseWecomOutboundResponsePayload(JSON.stringify({ ok: true })),
    null
  )
  assert.equal(
    parseWecomOutboundResponsePayload(JSON.stringify({ ok: false, error: "" })),
    null
  )
  assert.equal(
    parseWecomOutboundResponsePayload(JSON.stringify({ ok: "true", raw: {} })),
    null
  )
})
