import assert from "node:assert/strict"
import test from "node:test"

import { parseSidecarResponseFrame } from "./sidecar-codec.js"

test("parseSidecarResponseFrame rejects malformed and non-object frames", () => {
  for (const line of ["{not-json", "null", "[]", '"scalar"']) {
    assert.equal(parseSidecarResponseFrame(line), null)
  }
})

test("parseSidecarResponseFrame normalizes string and numeric ids", () => {
  assert.deepEqual(
    parseSidecarResponseFrame(
      JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { ok: true } })
    ),
    { id: "req-1", result: { ok: true } }
  )
  assert.deepEqual(
    parseSidecarResponseFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: "pong" })
    ),
    { id: "0", result: "pong" }
  )
})

test("parseSidecarResponseFrame rejects malformed error frames", () => {
  for (const error of ["boom", null, { code: "bad", message: "boom" }]) {
    assert.equal(
      parseSidecarResponseFrame(
        JSON.stringify({ jsonrpc: "2.0", id: "1", error })
      ),
      null
    )
  }
})

test("parseSidecarResponseFrame preserves JSON-RPC error data", () => {
  assert.deepEqual(
    parseSidecarResponseFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        error: { code: -32010, message: "boom", data: { reason: "test" } },
      })
    ),
    {
      id: "1",
      error: { code: -32010, message: "boom", data: { reason: "test" } },
    }
  )
})
