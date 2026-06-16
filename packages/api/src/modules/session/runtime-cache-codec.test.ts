import test from "node:test"
import assert from "node:assert/strict"
import { parseCachedActorRuntimeState } from "./runtime.js"

const validRuntimeState = {
  conversationId: "conversation-1",
  sessionId: "session-1",
  actorId: "actor-1",
  actorDisplayName: "Assistant",
  laneState: "idle",
  health: "ok",
  phase: "idle",
  pendingWakeupCount: 0,
  updatedAt: "2026-06-16T00:00:00.000Z",
}

test("parseCachedActorRuntimeState accepts a valid runtime snapshot", () => {
  assert.deepEqual(
    parseCachedActorRuntimeState(JSON.stringify(validRuntimeState)),
    validRuntimeState
  )
})

test("parseCachedActorRuntimeState fails closed on malformed JSON", () => {
  assert.equal(parseCachedActorRuntimeState("{"), null)
})

test("parseCachedActorRuntimeState fails closed on drifted runtime shape", () => {
  assert.equal(
    parseCachedActorRuntimeState(
      JSON.stringify({ ...validRuntimeState, pendingWakeupCount: -1 })
    ),
    null
  )
  assert.equal(
    parseCachedActorRuntimeState(
      JSON.stringify({ ...validRuntimeState, health: "unknown" })
    ),
    null
  )
})
