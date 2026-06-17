import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCodexJsonRpcLine } from "./codex-json-rpc-codec.js"

test("parseCodexJsonRpcLine accepts response, request, and notification frames", () => {
  assert.deepEqual(
    parseCodexJsonRpcLine(
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: { ok: true } })
    ),
    { jsonrpc: "2.0", id: 0, result: { ok: true } }
  )
  assert.deepEqual(
    parseCodexJsonRpcLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "item/tool/requestUserInput",
        params: { questions: [] },
      })
    ),
    {
      jsonrpc: "2.0",
      id: "req-1",
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    }
  )
  assert.deepEqual(
    parseCodexJsonRpcLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {},
      })
    ),
    {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {},
    }
  )
})

test("parseCodexJsonRpcLine rejects malformed or drifted frames", () => {
  assert.equal(parseCodexJsonRpcLine("{"), null)
  assert.equal(parseCodexJsonRpcLine("null"), null)
  assert.equal(parseCodexJsonRpcLine("[]"), null)
  assert.equal(parseCodexJsonRpcLine(JSON.stringify({ id: {} })), null)
  assert.equal(
    parseCodexJsonRpcLine(JSON.stringify({ method: ["turn/completed"] })),
    null
  )
  assert.equal(
    parseCodexJsonRpcLine(JSON.stringify({ id: 1, error: { message: 42 } })),
    null
  )
})
