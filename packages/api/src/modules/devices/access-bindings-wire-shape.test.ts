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
//   (d) Batch 19: the server-side mapper actually translates every
//       wire-accepted combination into a real service-layer flat target.
//       Previously `(remote_agent, conversation)` parsed at the schema
//       layer but threw at the mapper, so the route still 400'd.

import test from "node:test"
import assert from "node:assert/strict"
import type { Kysely } from "kysely"
import { SetActiveDeviceCapabilitiesInputSchema } from "@synapse/device-protocol"
import {
  setActiveBodySchema,
  wireTargetToInternalAccessTarget,
} from "./access-bindings.js"
import { resolveScopedSubjectTarget } from "../capability-projection/device-capabilities.js"
import { withTestDb } from "../../test/helpers/db.js"

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

// (d) — every wire-accepted shape MUST translate to a real flat target.
// Pre-Batch-19 the wire schema admitted `(remote_agent, conversation)` but
// the mapper threw, so the route 400'd on a valid SDK body. These tests
// pin the contract: every shape that survives the wire-schema parse also
// survives `wireTargetToInternalAccessTarget`.

test("Batch 19: wireTargetToInternalAccessTarget — unscoped shapes", () => {
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "workspace", workspaceId: wsId },
    }),
    { kind: "workspace", workspaceId: wsId }
  )
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "actor", actorId },
    }),
    { kind: "actor", actorId }
  )
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "conversation", conversationId: convId },
    }),
    { kind: "conversation", conversationId: convId }
  )
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "remote_agent", remoteAgentId },
    }),
    { kind: "remote_agent", remoteAgentId }
  )
})

test("Batch 19: wireTargetToInternalAccessTarget — actor + scope=conversation", () => {
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "actor", actorId },
      scope: { kind: "conversation", conversationId: convId },
    }),
    {
      kind: "actor_in_conversation",
      actorId,
      conversationId: convId,
    }
  )
})

test("Batch 19: wireTargetToInternalAccessTarget — remote_agent + scope=conversation translates (no longer throws)", () => {
  // Pre-Batch-19 this threw inside the mapper, surfacing as a route 400
  // even though the wire schema admitted the shape. Lock the fix: the
  // mapper now returns a `remote_agent_in_conversation` flat target.
  assert.deepEqual(
    wireTargetToInternalAccessTarget({
      subject: { kind: "remote_agent", remoteAgentId },
      scope: { kind: "conversation", conversationId: convId },
    }),
    {
      kind: "remote_agent_in_conversation",
      remoteAgentId,
      conversationId: convId,
    }
  )
})

// (e) — resolver round-trip for the new shape. Pre-Batch-19 the
// `remote_agent_in_conversation` kind didn't exist in the AccessTargetInput
// union, so even if a caller had constructed it by hand, the
// resolveScopedSubjectTarget switch had no branch for it. Lock the new
// branch via a real DB round-trip: insert remote_agent + conversation
// fixtures, ask the resolver, assert both subject_id + scope_subject_id
// are populated and FK-valid.
test(
  "Batch 19: resolveScopedSubjectTarget(remote_agent_in_conversation) returns (subjectId, scopeSubjectId)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db: Kysely<any>) => {
      const rid = () => Math.random().toString(36).slice(2, 10)
      const user = await db
        .insertInto("users")
        .values({
          email: `${rid()}@batch19`,
          name: "u",
          password_hash: "x",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const ws = await db
        .insertInto("workspaces")
        .values({
          owner_id: user.id as string,
          slug: `ws-${rid()}`,
          name: "ws",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const agent = await db
        .insertInto("remote_agents")
        .values({
          workspace_id: ws.id as string,
          name: `ra-${rid()}`,
          title: "ra",
          runtime_kind: "claude_code",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const conv = await db
        .insertInto("conversations")
        .values({
          kind: "group",
          boundary: "internal",
          internal_workspace_id: ws.id as string,
          title: "c",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const resolved = await resolveScopedSubjectTarget(
        {
          kind: "remote_agent_in_conversation",
          remoteAgentId: agent.id as string,
          conversationId: conv.id as string,
        },
        { db }
      )
      assert.ok(
        resolved.subjectId,
        "resolver returned no subjectId for remote_agent_in_conversation"
      )
      assert.ok(
        resolved.scopeSubjectId,
        "resolver returned no scopeSubjectId — the scope-narrowed branch is missing"
      )
      // Sanity-check the subjects are the right kinds.
      const subjectRow = await db
        .selectFrom("access_subjects")
        .select(["kind", "remote_agent_id"])
        .where("id", "=", resolved.subjectId)
        .executeTakeFirstOrThrow()
      assert.equal(subjectRow.kind, "remote_agent")
      assert.equal(subjectRow.remote_agent_id, agent.id)
      const scopeRow = await db
        .selectFrom("access_subjects")
        .select(["kind", "conversation_id"])
        .where("id", "=", resolved.scopeSubjectId as string)
        .executeTakeFirstOrThrow()
      assert.equal(scopeRow.kind, "conversation")
      assert.equal(scopeRow.conversation_id, conv.id)
    })
  }
)
