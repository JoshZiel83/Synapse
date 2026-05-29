// Batch 18 regression locks — POST /devices/access-bindings wire-shape
// contract.
//
// Pre-Batch-18 the route used a hand-rolled `z.discriminatedUnion("kind",
// ...)` body schema while the SDK was already sending the wire shape
// (`{subject: SubjectRef, scope?: SubjectRef}`) parsed by
// `SetActiveDeviceCapabilitiesInputSchema` from @synapse/device-protocol.
// Result: every SDK POST 400'd at the server `safeParse`. These tests
// pin both directions of the contract so the divergence cannot reappear:
//
//   (a) The route's body schema accepts the SDK's wire shape verbatim.
//   (b) The route rejects the legacy flat `{kind: "actor_in_conversation",
//       actorId, conversationId}` shape (the user explicitly opted out of
//       legacy-client back-compat).
//   (c) The wire schema's `superRefine` whitelist still rejects scoped
//       combinations outside `(actor|remote_agent, conversation)`.

import test from "node:test"
import assert from "node:assert/strict"
import { SetActiveDeviceCapabilitiesInputSchema } from "@synapse/device-protocol"
import { setActiveBodySchema } from "./access-bindings.js"

const wsId = "00000000-0000-0000-0000-000000000001"
const actorId = "00000000-0000-0000-0000-000000000002"
const convId = "00000000-0000-0000-0000-000000000003"
const remoteAgentId = "00000000-0000-0000-0000-000000000004"
const capId = "00000000-0000-0000-0000-000000000005"

// (a) — wire shape SDK sends must parse server-side.
test("Batch 18: POST body accepts SDK wire shape — unscoped workspace target", () => {
  const wireBody = {
    workspaceId: wsId,
    target: { subject: { kind: "workspace" as const, workspaceId: wsId } },
    device_capability_ids: [capId],
  }
  // The SDK calls this first — protocol-side parse.
  const sdkParsed = SetActiveDeviceCapabilitiesInputSchema.safeParse(wireBody)
  assert.equal(sdkParsed.success, true)
  // The server-side route schema parses the same wire body.
  const serverParsed = setActiveBodySchema.safeParse(wireBody)
  assert.equal(
    serverParsed.success,
    true,
    "server schema rejected the SDK-sent ScopedSubjectTarget — the route diverged from @synapse/device-protocol"
  )
})

test("Batch 18: POST body accepts SDK wire shape — actor + scope=conversation", () => {
  const wireBody = {
    workspaceId: wsId,
    target: {
      subject: { kind: "actor" as const, actorId },
      scope: { kind: "conversation" as const, conversationId: convId },
    },
    device_capability_ids: [capId],
  }
  const sdkParsed = SetActiveDeviceCapabilitiesInputSchema.safeParse(wireBody)
  assert.equal(sdkParsed.success, true)
  const serverParsed = setActiveBodySchema.safeParse(wireBody)
  assert.equal(
    serverParsed.success,
    true,
    "server schema rejected actor+scope=conversation — group-chat picker writes would 400"
  )
})

test("Batch 18: POST body accepts SDK wire shape — remote_agent + scope=conversation", () => {
  const wireBody = {
    workspaceId: wsId,
    target: {
      subject: { kind: "remote_agent" as const, remoteAgentId },
      scope: { kind: "conversation" as const, conversationId: convId },
    },
    device_capability_ids: [capId],
  }
  const sdkParsed = SetActiveDeviceCapabilitiesInputSchema.safeParse(wireBody)
  assert.equal(sdkParsed.success, true)
  const serverParsed = setActiveBodySchema.safeParse(wireBody)
  assert.equal(serverParsed.success, true)
})

// (b) — legacy flat shape MUST NOT parse. The user opted out of back-
// compat; if a future revert reintroduces the `z.discriminatedUnion("kind"
// ...)` schema, this test fires.
test("Batch 18: POST body rejects legacy {kind: 'actor_in_conversation', ...} flat shape", () => {
  const legacyBody = {
    workspaceId: wsId,
    target: {
      kind: "actor_in_conversation",
      actorId,
      conversationId: convId,
    },
    device_capability_ids: [capId],
  }
  const parsed = setActiveBodySchema.safeParse(legacyBody)
  assert.equal(
    parsed.success,
    false,
    "server schema accepted the legacy flat target shape — the route diverged back from ScopedSubjectTargetWireSchema"
  )
})

test("Batch 18: POST body rejects legacy {kind: 'actor', actorId} flat shape", () => {
  const legacyBody = {
    workspaceId: wsId,
    target: { kind: "actor", actorId },
    device_capability_ids: [capId],
  }
  const parsed = setActiveBodySchema.safeParse(legacyBody)
  assert.equal(parsed.success, false)
})

// (c) — superRefine whitelist still locked at the wire layer.
test("Batch 18: POST body rejects scoped combinations outside (actor|remote_agent, conversation)", () => {
  // workspace_member subject is rejected by SubjectRefWireSchema
  // (device-protocol comment: workspace_member is platform-wide-narrow
  // and not on the device binding path).
  const memberBody = {
    workspaceId: wsId,
    target: {
      subject: { kind: "workspace_member", memberId: actorId },
    },
    device_capability_ids: [capId],
  }
  assert.equal(setActiveBodySchema.safeParse(memberBody).success, false)

  // actor + scope=workspace is rejected by superRefine.
  const actorScopeWsBody = {
    workspaceId: wsId,
    target: {
      subject: { kind: "actor" as const, actorId },
      scope: { kind: "workspace" as const, workspaceId: wsId },
    },
    device_capability_ids: [capId],
  }
  assert.equal(setActiveBodySchema.safeParse(actorScopeWsBody).success, false)

  // conversation + scope=conversation is rejected by superRefine.
  const convScopeConvBody = {
    workspaceId: wsId,
    target: {
      subject: { kind: "conversation" as const, conversationId: convId },
      scope: { kind: "conversation" as const, conversationId: convId },
    },
    device_capability_ids: [capId],
  }
  assert.equal(setActiveBodySchema.safeParse(convScopeConvBody).success, false)
})
