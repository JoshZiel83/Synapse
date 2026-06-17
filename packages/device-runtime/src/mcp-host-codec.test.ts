import assert from "node:assert/strict"
import test from "node:test"

import { parseMcpHostRequestBody } from "./mcp-host-codec.js"

test("parseMcpHostRequestBody rejects malformed JSON as parse error", () => {
  const parsed = parseMcpHostRequestBody("{not-json")

  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.error.httpStatus, 400)
  assert.equal(parsed.error.id, null)
  assert.equal(parsed.error.code, -32700)
  assert.equal(parsed.error.message, "parse error")
})

test("parseMcpHostRequestBody rejects non-object JSON-RPC bodies", () => {
  for (const raw of ["null", "[]", '"method"']) {
    const parsed = parseMcpHostRequestBody(raw)

    assert.equal(parsed.ok, false)
    if (parsed.ok) continue
    assert.equal(parsed.error.httpStatus, 200)
    assert.equal(parsed.error.id, null)
    assert.equal(parsed.error.code, -32600)
    assert.equal(parsed.error.message, "invalid request")
  }
})

test("parseMcpHostRequestBody rejects missing method while preserving request id", () => {
  const parsed = parseMcpHostRequestBody(JSON.stringify({ id: "req-1" }))

  assert.equal(parsed.ok, false)
  if (parsed.ok) return
  assert.equal(parsed.error.httpStatus, 200)
  assert.equal(parsed.error.id, "req-1")
  assert.equal(parsed.error.code, -32600)
  assert.equal(parsed.error.message, "method required")
})

test("parseMcpHostRequestBody accepts id 0 and preserves params", () => {
  const parsed = parseMcpHostRequestBody(
    JSON.stringify({ id: 0, method: "tools/list", params: { cursor: null } })
  )

  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.request.id, 0)
  assert.equal(parsed.request.method, "tools/list")
  assert.deepEqual(parsed.request.params, { cursor: null })
})
