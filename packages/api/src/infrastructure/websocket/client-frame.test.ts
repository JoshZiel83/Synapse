import assert from "node:assert/strict"
import test from "node:test"
import { parseChatSocketClientFrame } from "./client-frame.js"

test("parseChatSocketClientFrame accepts auth and subscription frames", () => {
  assert.deepEqual(
    parseChatSocketClientFrame(
      JSON.stringify({
        type: "auth",
        token: "token-1",
        workspaceId: "workspace-1",
      })
    ),
    {
      type: "auth",
      token: "token-1",
      workspaceId: "workspace-1",
    }
  )

  assert.deepEqual(
    parseChatSocketClientFrame(
      JSON.stringify({
        type: "subscribe",
        key: "inbox",
        topic: "inbox",
      })
    ),
    {
      type: "subscribe",
      key: "inbox",
      topic: "inbox",
    }
  )

  assert.deepEqual(
    parseChatSocketClientFrame(
      JSON.stringify({
        type: "subscribe",
        key: "conversation:1",
        topic: "conversation",
        conversationId: "conversation-1",
      })
    ),
    {
      type: "subscribe",
      key: "conversation:1",
      topic: "conversation",
      conversationId: "conversation-1",
    }
  )
})

test("parseChatSocketClientFrame accepts control frames", () => {
  assert.deepEqual(parseChatSocketClientFrame('{"type":"pong"}'), {
    type: "pong",
  })
  assert.deepEqual(
    parseChatSocketClientFrame(
      JSON.stringify({
        type: "unsubscribe",
        key: "conversation:1",
      })
    ),
    {
      type: "unsubscribe",
      key: "conversation:1",
    }
  )
  assert.deepEqual(
    parseChatSocketClientFrame(
      JSON.stringify({
        type: "typing",
        conversationId: "conversation-1",
        state: "started",
      })
    ),
    {
      type: "typing",
      conversationId: "conversation-1",
      state: "started",
    }
  )
})

test("parseChatSocketClientFrame rejects invalid JSON separately from invalid payloads", () => {
  assert.throws(
    () => parseChatSocketClientFrame("{"),
    /Invalid chat websocket client JSON/
  )
  assert.throws(
    () =>
      parseChatSocketClientFrame(
        JSON.stringify({
          type: "typing",
          conversationId: "conversation-1",
          state: "paused",
        })
      ),
    /Invalid chat websocket client payload/
  )
})
