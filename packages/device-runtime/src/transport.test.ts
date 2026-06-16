import assert from "node:assert/strict"
import { test } from "node:test"
import { parseControlPlaneInboundFrame } from "./transport.js"

test("parseControlPlaneInboundFrame accepts JSON-RPC responses", () => {
  assert.deepEqual(
    parseControlPlaneInboundFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "request-1",
        result: { ok: true },
      })
    ),
    {
      type: "response",
      response: {
        jsonrpc: "2.0",
        id: "request-1",
        result: { ok: true },
      },
    }
  )

  assert.deepEqual(
    parseControlPlaneInboundFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "request-2",
        error: { code: -32000, message: "failed" },
      })
    ),
    {
      type: "response",
      response: {
        jsonrpc: "2.0",
        id: "request-2",
        error: { code: -32000, message: "failed" },
      },
    }
  )
})

test("parseControlPlaneInboundFrame accepts JSON-RPC requests", () => {
  assert.deepEqual(
    parseControlPlaneInboundFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "server.challenge",
        params: { nonce: "nonce-1" },
      })
    ),
    {
      type: "request",
      request: {
        jsonrpc: "2.0",
        method: "server.challenge",
        params: { nonce: "nonce-1" },
      },
    }
  )
})

test("parseControlPlaneInboundFrame rejects malformed control-plane frames", () => {
  for (const raw of [
    "{not-json",
    "[]",
    "null",
    JSON.stringify({ jsonrpc: "2.0", id: "response-without-body" }),
    JSON.stringify({ jsonrpc: "2.0", id: "bad-error", error: "boom" }),
    JSON.stringify({ jsonrpc: "2.0", params: { nonce: "missing-method" } }),
  ]) {
    assert.equal(parseControlPlaneInboundFrame(raw), null)
  }
})
