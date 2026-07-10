// Unit tests for buildRuntimeAuthorizationDedupeKey — the per-session
// isolation contract is the whole reason sourceRuntimeSessionId is in the key.
// If a refactor accidentally drops that field, two Agent sessions making
// the same CUA call would merge into one pending task and the
// post-approval auto-retry would stamp the wrong cua_focus_scope_id into
// the dispatched envelope.

import test from "node:test"
import assert from "node:assert/strict"

import { buildRuntimeAuthorizationDedupeKey } from "./service.js"

const baseParams = {
  runtimeId: "00000000-0000-0000-0000-000000000001",
  runtimeCapabilityId: "00000000-0000-0000-0000-000000000002",
  runtimeExposureId: "00000000-0000-0000-0000-000000000003",
  requestedToolName: "cua_click",
  runtimeToolStableKey: "cua/click",
  requestMode: "background" as const,
  requestedAction: {
    capability: "cua" as const,
    toolName: "cua_click",
    summary: "click",
    detail: "x=10 y=10",
    cua: { access: "write" as const },
  },
  grantOptions: [],
  availablePresets: [],
}

test("dedupe key differs for two Agent sessions making the same CUA call", () => {
  // This is the CUA-isolation regression guard. Without sourceRuntimeSessionId in
  // the key, both calls produce the same key → same pending task →
  // shared source_runtime_session_id → wrong cua_focus_scope_id after
  // approval. With the field, they're independent.
  const sessionA = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "agent-session-A",
  })
  const sessionB = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "agent-session-B",
  })
  assert.notEqual(sessionA, sessionB)
})

test("dedupe key is stable for repeat calls within the same session", () => {
  // Same session must still dedupe — otherwise an agent's own retries
  // would spam the user with N identical approval requests.
  const first = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "agent-session-X",
  })
  const second = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "agent-session-X",
  })
  assert.equal(first, second)
})

test("dedupe key includes sourceRuntimeSessionId in its JSON shape", () => {
  // Belt-and-suspenders: parse the key to confirm the field is there
  // verbatim, so a renamed field on the dedupe shape can't silently slip.
  const key = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "agent-session-Y",
  })
  const parsed = JSON.parse(key) as Record<string, unknown>
  assert.equal(parsed["sourceRuntimeSessionId"], "agent-session-Y")
})

test("empty-string sourceRuntimeSessionId is honored (legacy bucket)", () => {
  // Legacy callers that don't have a session pass "". Two such calls still
  // dedupe together — they share the "no-session" bucket. The key only
  // diverges when at least one side has a real id.
  const first = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "",
  })
  const second = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "",
  })
  assert.equal(first, second)
  const withId = buildRuntimeAuthorizationDedupeKey({
    ...baseParams,
    sourceRuntimeSessionId: "real-session",
  })
  assert.notEqual(first, withId)
})
