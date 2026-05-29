// Unit tests for deriveCuaFocusScopeId — the pure function that picks the
// per-Agent-session key the device sidecar's focusStore is bucketed by.
//
// Locked in here so a future refactor can't silently regress the "sessionId
// always wins" rule or the principal-kind fallback table.

import test from "node:test"
import assert from "node:assert/strict"
import { deriveCuaFocusScopeId } from "./cua-scope.js"

const WS = "00000000-0000-0000-0000-000000000001"
const ACTOR = "00000000-0000-0000-0000-000000000002"
const CONV = "00000000-0000-0000-0000-000000000003"
const SESSION = "00000000-0000-0000-0000-000000000004"
const RA = "00000000-0000-0000-0000-000000000005"
const AIC = "00000000-0000-0000-0000-000000000006"
const WM = "00000000-0000-0000-0000-000000000007"

test("sessionId always wins, regardless of principal kind", () => {
  for (const principal of [
    { kind: "actor" as const, actorId: ACTOR, conversationId: CONV },
    {
      kind: "actor_in_conversation" as const,
      conversationActorContextId: AIC,
    },
    {
      kind: "remote_agent" as const,
      remoteAgentId: RA,
      conversationId: CONV,
    },
    { kind: "conversation" as const, conversationId: CONV },
    { kind: "workspace_member" as const, workspaceMemberId: WM },
  ]) {
    const got = deriveCuaFocusScopeId({
      sessionId: SESSION,
      workspaceId: WS,
      principal,
    })
    assert.equal(got, `session:${SESSION}`)
  }
})

test("fallback for actor_in_conversation uses conversationActorContextId", () => {
  const got = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: {
      kind: "actor_in_conversation",
      conversationActorContextId: AIC,
    },
  })
  assert.equal(got, `aic:${AIC}`)
})

test("fallback for remote_agent factors in both conversationId and remoteAgentId", () => {
  const got = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: {
      kind: "remote_agent",
      remoteAgentId: RA,
      conversationId: CONV,
    },
  })
  assert.equal(got, `ra:${CONV}:${RA}`)
})

test("fallback for actor uses conversationId+actorId when present, actorId alone otherwise", () => {
  const withConv = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: { kind: "actor", actorId: ACTOR, conversationId: CONV },
  })
  assert.equal(withConv, `actor:${CONV}:${ACTOR}`)
  const withoutConv = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: { kind: "actor", actorId: ACTOR },
  })
  assert.equal(withoutConv, `actor:${ACTOR}`)
})

test("fallback for conversation principal uses conversationId", () => {
  const got = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: { kind: "conversation", conversationId: CONV },
  })
  assert.equal(got, `conv:${CONV}`)
})

test("fallback for workspace_member uses workspaceId+workspaceMemberId", () => {
  const got = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: { kind: "workspace_member", workspaceMemberId: WM },
  })
  assert.equal(got, `wm:${WS}:${WM}`)
})

test("isolation: different principals with no sessionId produce different scope ids", () => {
  const a = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: { kind: "actor", actorId: ACTOR, conversationId: CONV },
  })
  const b = deriveCuaFocusScopeId({
    workspaceId: WS,
    principal: {
      kind: "remote_agent",
      remoteAgentId: RA,
      conversationId: CONV,
    },
  })
  // Without this isolation, two different agents in the same conversation
  // would overwrite each other's focus — see decision 1 in the plan.
  assert.notEqual(a, b)
})
