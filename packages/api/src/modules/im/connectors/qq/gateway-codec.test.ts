import test from "node:test"
import assert from "node:assert/strict"
import {
  parseQqGatewayFrame,
  parseQqGatewayHelloPayload,
  parseQqGatewayReadyPayload,
  parseQqGatewayUrlResponse,
} from "./gateway-codec.js"

test("parseQqGatewayUrlResponse: accepts provider gateway URL response", () => {
  assert.equal(
    parseQqGatewayUrlResponse({
      url: "wss://gateway.example.test",
      shards: 1,
    }),
    "wss://gateway.example.test"
  )
  assert.equal(parseQqGatewayUrlResponse({ url: "" }), null)
  assert.equal(parseQqGatewayUrlResponse({ url: 123 }), null)
})

test("parseQqGatewayFrame: parses valid dispatch frames", () => {
  assert.deepEqual(
    parseQqGatewayFrame(
      JSON.stringify({
        op: 0,
        s: 42,
        t: "READY",
        d: { session_id: "SESSION-1" },
        extra: true,
      })
    ),
    {
      ok: true,
      frame: {
        op: 0,
        s: 42,
        t: "READY",
        d: { session_id: "SESSION-1" },
        extra: true,
      },
    }
  )
})

test("parseQqGatewayFrame: rejects invalid JSON or drifted frame shape", () => {
  assert.deepEqual(parseQqGatewayFrame("{not-json"), {
    ok: false,
    reason: "invalid_json",
  })
  assert.deepEqual(parseQqGatewayFrame(JSON.stringify({ op: "0" })), {
    ok: false,
    reason: "invalid_shape",
  })
  assert.deepEqual(parseQqGatewayFrame(JSON.stringify({ op: 0, s: -1 })), {
    ok: false,
    reason: "invalid_shape",
  })
})

test("parseQqGatewayHelloPayload: extracts positive heartbeat interval only", () => {
  assert.deepEqual(parseQqGatewayHelloPayload({ heartbeat_interval: 45_000 }), {
    heartbeatInterval: 45_000,
  })
  assert.deepEqual(
    parseQqGatewayHelloPayload({ heartbeat_interval: "45000" }),
    {}
  )
  assert.deepEqual(parseQqGatewayHelloPayload({ heartbeat_interval: 0 }), {})
  assert.deepEqual(parseQqGatewayHelloPayload(null), {})
})

test("parseQqGatewayReadyPayload: extracts session and username without trusting full payload", () => {
  assert.deepEqual(
    parseQqGatewayReadyPayload({
      session_id: "SESSION-1",
      user: { username: "bot" },
      version: 1,
    }),
    { sessionId: "SESSION-1", username: "bot" }
  )
  assert.deepEqual(
    parseQqGatewayReadyPayload({
      session_id: 42,
      user: { username: "bot" },
    }),
    {}
  )
  assert.deepEqual(
    parseQqGatewayReadyPayload({
      session_id: "SESSION-2",
      user: "not-object",
    }),
    { sessionId: "SESSION-2" }
  )
})
