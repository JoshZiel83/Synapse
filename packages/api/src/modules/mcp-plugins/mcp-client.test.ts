import test from "node:test"
import assert from "node:assert/strict"
import { parseMcpSsePayload } from "./mcp-client.js"

const rpc = (id: number, result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result })

test("parses a single well-terminated event", () => {
  const text = `data: ${rpc(1, { ok: true })}\n\n`
  assert.deepEqual(parseMcpSsePayload(text, 1), { ok: true })
})

test("parses a FINAL event with no trailing blank line (flush gap)", () => {
  // No trailing \n\n — the previous impl reported "No data in SSE response".
  const text = `data: ${rpc(7, { v: 42 })}`
  assert.deepEqual(parseMcpSsePayload(text, 7), { v: 42 })
})

test("picks the event whose id matches, ignoring others", () => {
  const text =
    `data: ${rpc(1, "other")}\n\n` +
    `event: message\ndata: ${rpc(2, "mine")}\n\n`
  assert.equal(parseMcpSsePayload(text, 2), "mine")
})

test("handles multi-line (folded) data within one event", () => {
  // A JSON-RPC message pretty-printed across several `data:` lines must rejoin
  // (with \n) into one valid JSON object — not be read as only the last line.
  const json = JSON.stringify(
    { jsonrpc: "2.0", id: 9, result: { a: 1 } },
    null,
    2
  )
  const folded = json
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")
  const text = `${folded}\n\n`
  assert.deepEqual(parseMcpSsePayload(text, 9), { a: 1 })
})

test("throws a JSON-RPC error matching our id", () => {
  const text = `data: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    error: { code: -32000, message: "boom" },
  })}\n\n`
  assert.throws(() => parseMcpSsePayload(text, 5), /MCP RPC error -32000: boom/)
})

test("throws when there is no data at all", () => {
  assert.throws(() => parseMcpSsePayload(": just a comment\n\n", 1), /No data/)
})

test("CRLF framing + optional space after colon", () => {
  const text = `data:${rpc(3, "crlf")}\r\n\r\n`
  assert.equal(parseMcpSsePayload(text, 3), "crlf")
})

test("THROWS when JSON-RPC events exist but none match our id (mismatch)", () => {
  // Only an unrelated id is present — must not silently degrade to "".
  const text = `data: ${rpc(1, "other")}\n\n`
  assert.throws(
    () => parseMcpSsePayload(text, 99),
    /no JSON-RPC message matching request id 99/
  )
})

test("non-JSON-RPC (legacy/raw) payload falls back to the raw string", () => {
  // A server that streams a plain text event (no JSON-RPC framing) — keep the
  // best-effort raw passthrough rather than throwing.
  const text = `data: just-some-text\n\n`
  assert.equal(parseMcpSsePayload(text, 1), "just-some-text")
})
