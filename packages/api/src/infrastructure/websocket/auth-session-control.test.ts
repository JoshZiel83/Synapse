import assert from "node:assert/strict"
import test from "node:test"
import {
  parseAuthSessionControlMessage,
  serializeAuthSessionControlMessage,
} from "./auth-session-control.js"

test("parseAuthSessionControlMessage accepts session and user disconnect frames", () => {
  assert.deepEqual(
    parseAuthSessionControlMessage(
      JSON.stringify({
        type: "session.disconnect",
        sessionId: "session-1",
        reason: "Session logged out",
      })
    ),
    {
      type: "session.disconnect",
      sessionId: "session-1",
      reason: "Session logged out",
    }
  )

  assert.deepEqual(
    parseAuthSessionControlMessage(
      JSON.stringify({
        type: "user.disconnect",
        userId: "user-1",
        exceptSessionId: "session-2",
        reason: "All sessions were logged out",
      })
    ),
    {
      type: "user.disconnect",
      userId: "user-1",
      exceptSessionId: "session-2",
      reason: "All sessions were logged out",
    }
  )
})

test("parseAuthSessionControlMessage rejects invalid JSON separately from invalid payloads", () => {
  assert.throws(
    () => parseAuthSessionControlMessage("{"),
    /Invalid auth session control JSON/
  )
  assert.throws(
    () =>
      parseAuthSessionControlMessage(
        JSON.stringify({
          type: "user.disconnect",
          userId: "",
          reason: "Session logged out",
        })
      ),
    /Invalid auth session control payload/
  )
})

test("serializeAuthSessionControlMessage emits validated control JSON", () => {
  assert.equal(
    serializeAuthSessionControlMessage({
      type: "session.disconnect",
      sessionId: "session-1",
      reason: "Session revoked",
    }),
    JSON.stringify({
      type: "session.disconnect",
      sessionId: "session-1",
      reason: "Session revoked",
    })
  )
})
