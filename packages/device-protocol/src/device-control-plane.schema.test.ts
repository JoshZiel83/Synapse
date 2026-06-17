import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DeviceEventEmitParamsSchema,
  DeviceRuntimeSessionClosedParamsSchema,
  DeviceRuntimeSessionOpenedParamsSchema,
  DeviceTaskOutputParamsSchema,
  DeviceTaskRefParamsSchema,
  DeviceTaskResultParamsSchema,
  DeviceTunnelDownParamsSchema,
  DeviceTunnelUpParamsSchema,
  DeviceVfsExposureUpsertParamsSchema,
  parseJsonRpcRequestFrame,
} from "./schemas.js"

const RUNTIME_SESSION_ID = "00000000-0000-4000-8000-000000000030"
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000031"
const ACTOR_ID = "00000000-0000-4000-8000-000000000032"
const OPERATION_ID = "00000000-0000-4000-8000-000000000033"
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000034"
const EXPOSURE_ID = "00000000-0000-4000-8000-000000000035"

test("parseJsonRpcRequestFrame validates request frames", () => {
  const parsed = parseJsonRpcRequestFrame(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "hello-1",
      method: "device.hello",
      params: { device_id: "d" },
    })
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error("expected valid request")
  assert.equal(parsed.request.method, "device.hello")
  assert.equal(parsed.request.id, "hello-1")
})

test("parseJsonRpcRequestFrame distinguishes invalid JSON from invalid request", () => {
  assert.deepEqual(parseJsonRpcRequestFrame("{"), {
    ok: false,
    error: "parse_error",
  })

  const invalid = parseJsonRpcRequestFrame(
    JSON.stringify({ jsonrpc: "2.0", id: "missing-method" })
  )
  assert.equal(invalid.ok, false)
  if (invalid.ok) throw new Error("expected invalid request")
  assert.equal(invalid.error, "invalid_request")
  assert.ok(invalid.details)
})

test("DeviceTunnelUpParamsSchema accepts snake_case tunnel URL", () => {
  const parsed = DeviceTunnelUpParamsSchema.parse({
    internal_url: "http://127.0.0.1:7890/d/token",
  })
  assert.equal(parsed.internal_url, "http://127.0.0.1:7890/d/token")
})

test("DeviceTunnelUpParamsSchema rejects camelCase tunnel URL", () => {
  assert.throws(() =>
    DeviceTunnelUpParamsSchema.parse({
      internalUrl: "http://127.0.0.1:7890/d/token",
    })
  )
})

test("DeviceTunnelDownParamsSchema accepts optional reason", () => {
  assert.deepEqual(DeviceTunnelDownParamsSchema.parse({}), {})
  assert.deepEqual(
    DeviceTunnelDownParamsSchema.parse({ reason: "frpc died" }),
    {
      reason: "frpc died",
    }
  )
})

test("DeviceRuntimeSessionOpenedParamsSchema accepts snake_case session refs", () => {
  const parsed = DeviceRuntimeSessionOpenedParamsSchema.parse({
    runtime_session_id: RUNTIME_SESSION_ID,
    conversation_id: CONVERSATION_ID,
    actor_id: ACTOR_ID,
  })
  assert.equal(parsed.runtime_session_id, RUNTIME_SESSION_ID)
  assert.equal(parsed.conversation_id, CONVERSATION_ID)
  assert.equal(parsed.actor_id, ACTOR_ID)
})

test("DeviceRuntimeSessionOpenedParamsSchema rejects camelCase session refs", () => {
  assert.throws(() =>
    DeviceRuntimeSessionOpenedParamsSchema.parse({
      runtimeSessionId: RUNTIME_SESSION_ID,
      conversationId: CONVERSATION_ID,
      actorId: ACTOR_ID,
    })
  )
})

test("DeviceRuntimeSessionClosedParamsSchema accepts only runtime_session_id", () => {
  const parsed = DeviceRuntimeSessionClosedParamsSchema.parse({
    runtime_session_id: RUNTIME_SESSION_ID,
  })
  assert.equal(parsed.runtime_session_id, RUNTIME_SESSION_ID)
  assert.throws(() =>
    DeviceRuntimeSessionClosedParamsSchema.parse({
      runtimeSessionId: RUNTIME_SESSION_ID,
    })
  )
})

test("DeviceTaskRefParamsSchema accepts snake_case operation refs", () => {
  const parsed = DeviceTaskRefParamsSchema.parse({
    operation_id: OPERATION_ID,
    attempt_id: ATTEMPT_ID,
  })
  assert.equal(parsed.operation_id, OPERATION_ID)
  assert.equal(parsed.attempt_id, ATTEMPT_ID)
  assert.throws(() =>
    DeviceTaskRefParamsSchema.parse({
      operationId: OPERATION_ID,
      attemptId: ATTEMPT_ID,
    })
  )
})

test("DeviceTaskOutputParamsSchema preserves opaque output", () => {
  const parsed = DeviceTaskOutputParamsSchema.parse({
    operation_id: OPERATION_ID,
    output: { nested_value: true },
  })
  assert.deepEqual(parsed.output, { nested_value: true })
})

test("DeviceTaskResultParamsSchema accepts snake_case result fields", () => {
  const parsed = DeviceTaskResultParamsSchema.parse({
    operation_id: OPERATION_ID,
    attempt_id: ATTEMPT_ID,
    ok: false,
    error_code: "tool_error",
    error_message: "failed",
    result_hash: "sha256:abc",
  })
  assert.equal(parsed.error_code, "tool_error")
  assert.equal(parsed.error_message, "failed")
  assert.equal(parsed.result_hash, "sha256:abc")
  assert.throws(() =>
    DeviceTaskResultParamsSchema.parse({
      operationId: OPERATION_ID,
      ok: true,
      resultHash: "sha256:abc",
    })
  )
})

test("DeviceEventEmitParamsSchema accepts snake_case event payload", () => {
  const parsed = DeviceEventEmitParamsSchema.parse({
    event_type: "device.tool.progress",
    level: "info",
    conversation_id: CONVERSATION_ID,
    payload: { percent: 50 },
  })
  assert.equal(parsed.event_type, "device.tool.progress")
  assert.equal(parsed.conversation_id, CONVERSATION_ID)
  assert.deepEqual(parsed.payload, { percent: 50 })
  assert.throws(() =>
    DeviceEventEmitParamsSchema.parse({
      eventType: "device.tool.progress",
      conversationId: CONVERSATION_ID,
    })
  )
})

test("DeviceVfsExposureUpsertParamsSchema accepts snake_case exposure id", () => {
  const parsed = DeviceVfsExposureUpsertParamsSchema.parse({
    exposure_id: EXPOSURE_ID,
    vfs: { root: { kind: "dir" } },
  })
  assert.equal(parsed.exposure_id, EXPOSURE_ID)
  assert.deepEqual(parsed.vfs, { root: { kind: "dir" } })
  assert.throws(() =>
    DeviceVfsExposureUpsertParamsSchema.parse({
      exposureId: EXPOSURE_ID,
      vfs: {},
    })
  )
})
