import assert from "node:assert/strict"
import test from "node:test"
import { parseRealtimeAsrClientFrame } from "./asr-client-frame.js"

test("parseRealtimeAsrClientFrame accepts auth and start frames", () => {
  assert.deepEqual(
    parseRealtimeAsrClientFrame(
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
    parseRealtimeAsrClientFrame(
      JSON.stringify({
        type: "start",
        audio: {
          format: "pcm",
          codec: "raw",
          rate: 16000,
          bits: 16,
          channel: 1,
        },
      })
    ),
    {
      type: "start",
      audio: {
        format: "pcm",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
      },
    }
  )
})

test("parseRealtimeAsrClientFrame accepts stop, cancel, and pong frames", () => {
  assert.deepEqual(parseRealtimeAsrClientFrame('{"type":"stop"}'), {
    type: "stop",
  })
  assert.deepEqual(parseRealtimeAsrClientFrame('{"type":"cancel"}'), {
    type: "cancel",
  })
  assert.deepEqual(parseRealtimeAsrClientFrame('{"type":"pong"}'), {
    type: "pong",
  })
})

test("parseRealtimeAsrClientFrame rejects invalid JSON separately from invalid payloads", () => {
  assert.throws(
    () => parseRealtimeAsrClientFrame("{"),
    /Invalid realtime ASR client JSON/
  )
  assert.throws(
    () =>
      parseRealtimeAsrClientFrame(
        JSON.stringify({
          type: "start",
          audio: {
            format: "pcm",
            codec: "opus",
            rate: 16000,
            bits: 16,
            channel: 1,
          },
        })
      ),
    /Invalid realtime ASR client payload/
  )
})
