// P5c/d: PRE-AUTHORIZED-ONLY sandboxes (owner decision). An unauthorized tool
// call whose target runtime is a SANDBOX must fail SYNCHRONOUSLY in-turn
// (permission_denied) instead of minting an async runtime-authorization REQUEST
// — a sandbox request would need a control-plane approval session the bare plane
// never has AND target a runtime the turn-end teardown soft-deletes. Real
// devices keep the async approval path unchanged.
//
// The branch point (capability-projection's requestAuthorizationOrDeny) is owned
// by another agent; this covers the discriminator + deny helper this module
// exposes for that wiring, and SIMULATES the intended call so the "no request is
// minted for a sandbox" property is actually exercised.

import test from "node:test"
import assert from "node:assert/strict"

import { isSandboxRuntime, sandboxUnauthorizedDeny } from "./service.js"
import type { SandboxRow } from "./repo.js"

const SANDBOX_ROW: SandboxRow = {
  id: "rt-sandbox",
  workspaceId: "ws-1",
  sessionId: "sess-1",
  mode: "bare",
  adapter: "local",
  state: "active",
  resourceId: null,
  hostPid: null,
  pairingSessionId: null,
}

const sandboxDeps = { getSandboxById: async () => SANDBOX_ROW }
const deviceDeps = { getSandboxById: async () => null }

test("isSandboxRuntime: resolvable sandboxes row → true; none → false; empty id → false (no query)", async () => {
  assert.equal(await isSandboxRuntime("rt-sandbox", sandboxDeps), true)
  assert.equal(await isSandboxRuntime("rt-device", deviceDeps), false)
  assert.equal(
    await isSandboxRuntime("", {
      getSandboxById: async () => {
        throw new Error("must not query for an empty runtimeId")
      },
    }),
    false
  )
})

test("sandboxUnauthorizedDeny: SANDBOX → synchronous permission_denied; DEVICE → null (async path preserved)", async () => {
  const deny = await sandboxUnauthorizedDeny("rt-sandbox", "cap-1", sandboxDeps)
  assert.ok(deny, "a sandbox must produce a synchronous deny")
  assert.equal(deny?.code, "permission_denied")

  assert.equal(
    await sandboxUnauthorizedDeny("rt-device", "cap-1", deviceDeps),
    null,
    "a real device must NOT be gated — it keeps the async approval-request path"
  )
})

test("P5c/d: an unauthorized SANDBOX call denies synchronously and does NOT create an approval request", async () => {
  // Simulate capability-projection's requestAuthorizationOrDeny no_match branch
  // with the intended pre-check wired at its top.
  let approvalRequestsCreated = 0
  const createApprovalRequest = async () => {
    approvalRequestsCreated += 1
    return "task-created"
  }
  async function requestAuthorizationOrDeny(
    runtimeId: string,
    deps: { getSandboxById: () => Promise<SandboxRow | null> }
  ): Promise<{ kind: "deny"; code: string } | { kind: "request" }> {
    const deny = await sandboxUnauthorizedDeny(runtimeId, "cap-1", deps)
    if (deny) return { kind: "deny", code: deny.code }
    await createApprovalRequest()
    return { kind: "request" }
  }

  const sandboxOutcome = await requestAuthorizationOrDeny(
    "rt-sandbox",
    sandboxDeps
  )
  assert.deepEqual(sandboxOutcome, { kind: "deny", code: "permission_denied" })
  assert.equal(
    approvalRequestsCreated,
    0,
    "a sandbox must NOT mint a runtime-authorization request"
  )

  // Control: a real device still mints the async approval request.
  const deviceOutcome = await requestAuthorizationOrDeny(
    "rt-device",
    deviceDeps
  )
  assert.deepEqual(deviceOutcome, { kind: "request" })
  assert.equal(approvalRequestsCreated, 1, "device path is unchanged")
})
