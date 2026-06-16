import assert from "node:assert/strict"
import test from "node:test"
import { parseSystemEventRedisFrame } from "./codec.js"

test("parseSystemEventRedisFrame accepts a valid internal Redis system event", () => {
  const event = parseSystemEventRedisFrame(
    JSON.stringify({
      type: "chat.sync.event",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      recipientWorkspaceMemberId: "00000000-0000-4000-8000-000000000002",
      payload: { sequence: 12 },
      timestamp: "2026-06-16T00:00:00.000Z",
    })
  )

  assert.deepEqual(event, {
    type: "chat.sync.event",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    recipientWorkspaceMemberId: "00000000-0000-4000-8000-000000000002",
    payload: { sequence: 12 },
    timestamp: "2026-06-16T00:00:00.000Z",
  })
})

test("parseSystemEventRedisFrame rejects invalid JSON separately from invalid payloads", () => {
  assert.throws(
    () => parseSystemEventRedisFrame("{"),
    /Invalid system event JSON/
  )
  assert.throws(
    () =>
      parseSystemEventRedisFrame(
        JSON.stringify({
          type: "not.registered",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          payload: {},
          timestamp: "2026-06-16T00:00:00.000Z",
        })
      ),
    /Invalid system event payload/
  )
})

test("parseSystemEventRedisFrame rejects non-canonical timestamps", () => {
  assert.throws(
    () =>
      parseSystemEventRedisFrame(
        JSON.stringify({
          type: "chat.sync.event",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          payload: {},
          timestamp: "2026-06-16T00:00:00Z",
        })
      ),
    /Invalid system event payload/
  )
})
