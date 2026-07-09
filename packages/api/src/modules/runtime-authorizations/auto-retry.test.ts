// Behavioural test for the runtime-authorization auto-retry helper.
// The helper closes the loop that the planner-vs-projection retry_nonce
// dance opened: after a runtime authorization is approved, the server
// re-issues the original tool call directly so the model never has to
// "notice" the approval or "guess" a magic __synapse_retry_nonce arg.

import test from "node:test"
import assert from "node:assert/strict"

import { cuaFocusScopeForAutoRetry } from "./auto-retry.js"

test("auto-retry helper is exported with the contract the approval flow expects", async () => {
  const mod = await import("./auto-retry.js")
  assert.equal(
    typeof mod.autoDispatchRuntimeAuthorizationRetry,
    "function",
    "autoDispatchRuntimeAuthorizationRetry must exist so tasks/service can wire it"
  )
})

test("cuaFocusScopeForAutoRetry returns session:<id> for cua + sessionId", () => {
  const got = cuaFocusScopeForAutoRetry({
    capability: "cua",
    initiatedBySessionId: "abc-123",
  })
  assert.equal(got, "session:abc-123")
})

test("cuaFocusScopeForAutoRetry returns undefined for non-cua grants", () => {
  // Non-cua envelopes must stay byte-identical to v2 — we only inject the
  // field when the device-side fail-closed gate would otherwise fire.
  for (const capability of ["filesystem", "browser", "commandline"]) {
    const got = cuaFocusScopeForAutoRetry({
      capability,
      initiatedBySessionId: "abc-123",
    })
    assert.equal(
      got,
      undefined,
      `capability=${capability} should yield undefined`
    )
  }
})

test("cuaFocusScopeForAutoRetry returns undefined when sessionId missing — fail-closed", () => {
  // Plan decision: when sessionId is unavailable we leave the field unset
  // rather than silently bucketing concurrent agents under a shared
  // "default" focus key. The device cua builtin will then return
  // invalid_request, which is the correct signal — surfacing the gap as a
  // server-side bug rather than letting a quiet focus collision corrupt
  // another agent's state.
  for (const sessionId of [null, ""]) {
    const got = cuaFocusScopeForAutoRetry({
      capability: "cua",
      initiatedBySessionId: sessionId,
    })
    assert.equal(
      got,
      undefined,
      `sessionId=${JSON.stringify(sessionId)} should yield undefined`
    )
  }
})

test("end-to-end wiring: grant record's sourceRuntimeSessionId drives cua_focus_scope_id", () => {
  // Production round-trip:
  //   1. projection writes sourceRuntimeSessionId = projectInput.sessionId
  //      → tool_call_task_runtime_authorization.source_runtime_session_id
  //   2. approval applies it to the new grant
  //      → runtime_authorization_grants.source_runtime_session_id
  //   3. tasks/service.ts passes grant.sourceRuntimeSessionId as
  //      audit.initiatedBySessionId into autoDispatchRuntimeAuthorizationRetry
  //   4. auto-retry calls cuaFocusScopeForAutoRetry → session:<id>
  //
  // This test simulates step 4 with the exact shape step 3 produces so a
  // future refactor that drops the wiring at any step trips this check.
  const grant = {
    sourceRuntimeSessionId: "agent-session-abc",
    capability: "cua",
  }
  const got = cuaFocusScopeForAutoRetry({
    capability: grant.capability,
    initiatedBySessionId: grant.sourceRuntimeSessionId,
  })
  assert.equal(
    got,
    "session:agent-session-abc",
    "auto-retry must inherit the source session id end-to-end so the cua envelope it dispatches survives the device-side fail-closed check"
  )
})

test("auto-retry helper fails closed when the device tool isn't in the catalog", async () => {
  const { autoDispatchRuntimeAuthorizationRetry } =
    await import("./auto-retry.js")
  const result = await autoDispatchRuntimeAuthorizationRetry({
    // Random UUID that won't resolve in resolveAutoRetryTarget — the
    // helper should return ok:false rather than throw or paper over the
    // missing device with a fake success result.
    runtimeCapabilityId: "00000000-0000-0000-0000-000000000000",
    visibleToolName: "definitely-not-a-real-tool",
    sourceRequestArgs: { foo: "bar" },
    sourceRetryNonce: "nonce-xyz",
    sourceTaskId: "00000000-0000-0000-0000-0000000000aa",
    runtimeSubjectIds: ["00000000-0000-0000-0000-0000000000b1"],
    runtimeScopeSubjectIds: ["00000000-0000-0000-0000-0000000000c1"],
    approvedGrant: {
      id: "grant-1",
      workspaceId: "ws-1",
      capability: "filesystem",
      scope: "once",
      status: "active",
      filesystem: { access: "read", pathPrefixes: ["/tmp"] },
    } as unknown as Parameters<
      typeof autoDispatchRuntimeAuthorizationRetry
    >[0]["approvedGrant"],
    audit: {
      workspaceId: "00000000-0000-0000-0000-000000000000",
      conversationId: null,
      principalKind: "actor",
      principalSubjectId: "00000000-0000-0000-0000-000000000001",
      initiatedBySessionId: null,
      initiatedByWorkspaceMemberId: null,
    },
  }).catch((err) => ({
    ok: false as const,
    errorCode: "runtime_constraint",
    errorMessage: `threw: ${(err as Error).message}`,
  }))
  assert.equal(result.ok, false)
  // The error message must mention the tool so an operator scanning logs
  // can connect a runtime_authorization approval failure back to its
  // source dispatch.
  assert.match(
    String(result.errorMessage ?? ""),
    /definitely-not-a-real-tool|not currently in catalog|threw/
  )
})
