import assert from "node:assert/strict"
import { test } from "node:test"
import {
  parseRuntimeCommandEnvelopeFields,
  parseRuntimeCommandPayload,
  parseRuntimeCommandResult,
} from "./runtime-control-plane.js"

test("parseRuntimeCommandEnvelopeFields accepts redis stream fields", () => {
  const envelope = parseRuntimeCommandEnvelopeFields("stream-1", [
    "id",
    "command-1",
    "type",
    "mcp.instance.command",
    "payload",
    JSON.stringify({ command: "describe" }),
    "reply_key",
    "mcp:runtime:reply:command-1",
  ])

  assert.deepEqual(envelope, {
    id: "command-1",
    type: "mcp.instance.command",
    payload: JSON.stringify({ command: "describe" }),
    replyKey: "mcp:runtime:reply:command-1",
  })
})

test("parseRuntimeCommandEnvelopeFields rejects incomplete command envelopes", () => {
  assert.equal(
    parseRuntimeCommandEnvelopeFields("stream-1", [
      "type",
      "mcp.instance.command",
      "payload",
      "{}",
    ]),
    null
  )
  assert.equal(
    parseRuntimeCommandEnvelopeFields("stream-1", [
      "reply_key",
      "mcp:runtime:reply:command-1",
      "payload",
      "{}",
    ]),
    null
  )
})

test("parseRuntimeCommandPayload parses payload JSON and treats empty as object", () => {
  assert.deepEqual(parseRuntimeCommandPayload(""), {})
  assert.deepEqual(
    parseRuntimeCommandPayload(JSON.stringify({ key: "value" })),
    {
      key: "value",
    }
  )
})

test("parseRuntimeCommandPayload rejects invalid or non-object payloads", () => {
  assert.throws(
    () => parseRuntimeCommandPayload("{"),
    /Runtime command payload is invalid JSON/
  )
  for (const payload of [
    JSON.stringify(null),
    JSON.stringify([]),
    JSON.stringify("command"),
    JSON.stringify(1),
  ]) {
    assert.throws(
      () => parseRuntimeCommandPayload(payload),
      /Runtime command payload must be a JSON object/
    )
  }
})

test("parseRuntimeCommandResult validates success and error reply shapes", () => {
  assert.deepEqual(parseRuntimeCommandResult(JSON.stringify({ ok: true })), {
    ok: true,
  })
  assert.deepEqual(
    parseRuntimeCommandResult(
      JSON.stringify({
        ok: false,
        error: { name: "RuntimeError", message: "failed" },
      })
    ),
    {
      ok: false,
      error: { name: "RuntimeError", message: "failed" },
    }
  )
})

test("parseRuntimeCommandResult rejects invalid reply JSON or shape", () => {
  assert.throws(
    () => parseRuntimeCommandResult("{"),
    /Runtime command reply is invalid JSON/
  )
  assert.throws(
    () => parseRuntimeCommandResult(JSON.stringify({ ok: false })),
    /Runtime command reply has invalid shape/
  )
})
