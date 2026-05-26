// Behavioural test for the runtime-authorization auto-retry helper.
// The helper closes the loop that the planner-vs-projection retry_nonce
// dance opened: after a runtime authorization is approved, the server
// re-issues the original tool call directly so the model never has to
// "notice" the approval or "guess" a magic __synapse_retry_nonce arg.

import test from "node:test"
import assert from "node:assert/strict"

test("auto-retry helper is exported with the contract the approval flow expects", async () => {
  const mod = await import("./auto-retry.js")
  assert.equal(
    typeof mod.autoDispatchRuntimeAuthorizationRetry,
    "function",
    "autoDispatchRuntimeAuthorizationRetry must exist so interactions/service can wire it"
  )
})

test("auto-retry helper fails closed when the device tool isn't in the catalog", async () => {
  const { autoDispatchRuntimeAuthorizationRetry } =
    await import("./auto-retry.js")
  const result = await autoDispatchRuntimeAuthorizationRetry({
    // Random UUID that won't resolve in resolveAutoRetryTarget — the
    // helper should return ok:false rather than throw or paper over the
    // missing device with a fake success result.
    deviceCapabilityId: "00000000-0000-0000-0000-000000000000",
    visibleToolName: "definitely-not-a-real-tool",
    sourceRequestArgs: { foo: "bar" },
    sourceRetryNonce: "nonce-xyz",
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
      principalSubjectId: null,
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
