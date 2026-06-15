import assert from "node:assert/strict"
import { test } from "node:test"

import {
  DeviceRuntimeSessionClosedParamsSchema,
  DeviceRuntimeSessionOpenedParamsSchema,
  DeviceTunnelDownParamsSchema,
  DeviceTunnelUpParamsSchema,
} from "./schemas.js"

const RUNTIME_SESSION_ID = "00000000-0000-4000-8000-000000000030"
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000031"
const ACTOR_ID = "00000000-0000-4000-8000-000000000032"

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
