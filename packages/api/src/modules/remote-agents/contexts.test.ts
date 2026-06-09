import test from "node:test"
import assert from "node:assert/strict"
import {
  pickRepresentativeContext,
  shouldDispatchAgentStart,
} from "./contexts.js"

test("pickRepresentativeContext returns null for empty input", () => {
  assert.equal(pickRepresentativeContext([]), null)
})

test("pickRepresentativeContext prefers active runtime states over idle/error/offline", () => {
  const ctxs = [
    {
      remoteAgentId: "r1",
      conversationId: "c-offline",
      runtimeKind: "claude_code",
      runtimeSessionId: null,
      runtimeState: "offline" as const,
      statusText: null,
      activeTaskId: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastActivityAt: "2026-05-22T11:59:00.000Z",
      lastError: null,
    },
    {
      remoteAgentId: "r1",
      conversationId: "c-idle",
      runtimeKind: "claude_code",
      runtimeSessionId: "sess-1",
      runtimeState: "idle" as const,
      statusText: null,
      activeTaskId: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastActivityAt: "2026-05-22T12:01:00.000Z",
      lastError: null,
    },
    {
      remoteAgentId: "r1",
      conversationId: "c-running",
      runtimeKind: "claude_code",
      runtimeSessionId: "sess-2",
      runtimeState: "running" as const,
      statusText: "Processing",
      activeTaskId: null,
      lastRunStartedAt: "2026-05-22T12:00:30.000Z",
      lastRunFinishedAt: null,
      lastActivityAt: "2026-05-22T12:00:30.000Z",
      lastError: null,
    },
  ]
  const pick = pickRepresentativeContext(ctxs)
  assert.equal(pick?.conversationId, "c-running")
})

test("pickRepresentativeContext tie-breaks by lastActivityAt within the same priority bucket", () => {
  const older = {
    remoteAgentId: "r1",
    conversationId: "c-older",
    runtimeKind: "claude_code",
    runtimeSessionId: "sess-1",
    runtimeState: "running" as const,
    statusText: null,
    activeTaskId: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastActivityAt: "2026-05-22T10:00:00.000Z",
    lastError: null,
  }
  const newer = {
    ...older,
    conversationId: "c-newer",
    lastActivityAt: "2026-05-22T13:00:00.000Z",
  }
  const pick = pickRepresentativeContext([older, newer])
  assert.equal(pick?.conversationId, "c-newer")
})

test("pickRepresentativeContext handles missing lastActivityAt as least recent", () => {
  const withActivity = {
    remoteAgentId: "r1",
    conversationId: "c-known",
    runtimeKind: "claude_code",
    runtimeSessionId: null,
    runtimeState: "idle" as const,
    statusText: null,
    activeTaskId: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastActivityAt: "2026-05-22T11:00:00.000Z",
    lastError: null,
  }
  const withoutActivity = {
    ...withActivity,
    conversationId: "c-blank",
    lastActivityAt: null,
  }
  const pick = pickRepresentativeContext([withoutActivity, withActivity])
  assert.equal(pick?.conversationId, "c-known")
})

test("shouldDispatchAgentStart returns true only when a delivery is pending", () => {
  assert.equal(shouldDispatchAgentStart({ hasPendingDelivery: true }), true)
  assert.equal(shouldDispatchAgentStart({ hasPendingDelivery: false }), false)
})

test("shouldDispatchAgentStart does NOT wake an idle context just because a session id is known", () => {
  // The old behavior accepted an idle context if a runtime_session_id was on
  // file; the refactored dispatch path drops that — daemons reconnect into a
  // quiet state and only wake when there is queued work.
  assert.equal(
    shouldDispatchAgentStart({ hasPendingDelivery: false } as never),
    false
  )
})
