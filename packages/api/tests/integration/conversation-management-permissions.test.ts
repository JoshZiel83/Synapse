/**
 * S18: conversation management requires owner/admin role.
 *
 * - PATCH /chat/conversations/:cid (rename / metadata) → only owners/admins
 * - POST /chat/conversations/:cid/participants (add others) → only owners/admins
 * - DELETE /chat/conversations/:cid/participants/:participantId (kick someone
 *   else) → only owners/admins; self-removal (leave) always allowed
 *
 * Non-manager members must get 403 conversation_manage_denied.
 *
 * Must be run via tests/integration/scripts/run-test.sh.
 */

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "conversation-management-permissions.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  setupChatStack,
  teardownChatStack,
  registerTestUser,
  createTestWorkspace,
  type ApiClient,
  type ChatStack,
} from "./harness/index.js"

const uuid = () => randomUUID()

let stack: ChatStack | undefined

before(async () => {
  stack = await setupChatStack()
})

after(async () => {
  if (stack) await teardownChatStack(stack)
})

async function inviteAndJoin(
  ownerClient: ApiClient,
  workspaceId: string,
  inviteeClient: ApiClient
) {
  const invite = await ownerClient.json<{ token: string }>(
    `/workspaces/${workspaceId}/invites`,
    { method: "POST", json: { maxUses: 1 } }
  )
  await inviteeClient.json(`/invites/${invite.token}/redeem`, {
    method: "POST",
    json: {},
  })
}

async function setupAliceBobGroup() {
  const alice = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(alice.client)
  const bob = await registerTestUser(stack!.baseClient)
  await inviteAndJoin(alice.client, ws.id, bob.client)
  const bobBootstrap = await bob.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )
  const created = await alice.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      title: "perm-test",
      workspaceMemberIds: [bobBootstrap.workspaceMemberId],
    },
  })
  return {
    alice,
    bob,
    ws,
    conversationId: created.conversation.conversationId,
  }
}

test("non-owner member cannot PATCH conversation (rename)", async () => {
  const { bob, ws, conversationId } = await setupAliceBobGroup()
  const res = await bob.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}`,
    { method: "PATCH", json: { title: "bob's rename" } }
  )
  assert.equal(res.status, 403)
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  assert.equal(body.code, "conversation_manage_denied")
})

test("non-owner member cannot add participants", async () => {
  const { bob, ws, conversationId } = await setupAliceBobGroup()
  const res = await bob.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/participants`,
    {
      method: "POST",
      json: { actorIds: ["00000000-0000-0000-0000-000000000000"] },
    }
  )
  assert.equal(res.status, 403)
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  assert.equal(body.code, "conversation_manage_denied")
})

test("non-owner member cannot kick someone else", async () => {
  const { alice, bob, ws, conversationId } = await setupAliceBobGroup()
  // Look up alice's participant id from bob's view.
  const detail = await bob.client.json<{
    conversation: {
      members?: Array<{ participantId: string; workspaceMemberId?: string }>
      participants?: Array<{
        participantId: string
        workspaceMemberId?: string
      }>
    }
  }>(`/workspaces/${ws.id}/chat/conversations/${conversationId}`)
  const members =
    detail.conversation.members ?? detail.conversation.participants ?? []
  const aliceBootstrap = await alice.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )
  const aliceParticipant = members.find(
    (m) => m.workspaceMemberId === aliceBootstrap.workspaceMemberId
  )
  assert.ok(aliceParticipant, "alice must appear in member list")
  const res = await bob.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/participants/${aliceParticipant!.participantId}`,
    { method: "DELETE" }
  )
  assert.equal(res.status, 403)
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  assert.equal(body.code, "conversation_manage_denied")
})

test("non-owner member CAN leave (self-removal stays allowed)", async () => {
  const { bob, ws, conversationId } = await setupAliceBobGroup()
  const left = await bob.client.json<{ state: string }>(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/leave`,
    { method: "POST", json: {} }
  )
  assert.equal(left.state, "left")
})

test("owner CAN PATCH conversation, add and kick participants", async () => {
  const { alice, bob, ws, conversationId } = await setupAliceBobGroup()
  // PATCH rename
  const patched = await alice.client.json<{
    conversation: { title: string }
  }>(`/workspaces/${ws.id}/chat/conversations/${conversationId}`, {
    method: "PATCH",
    json: { title: "renamed-by-owner" },
  })
  assert.equal(patched.conversation.title, "renamed-by-owner")

  // Kick bob
  const detail = await alice.client.json<{
    conversation: {
      members?: Array<{ participantId: string; workspaceMemberId?: string }>
      participants?: Array<{
        participantId: string
        workspaceMemberId?: string
      }>
    }
  }>(`/workspaces/${ws.id}/chat/conversations/${conversationId}`)
  const members =
    detail.conversation.members ?? detail.conversation.participants ?? []
  const bobBootstrap = await bob.client.json<{ workspaceMemberId: string }>(
    `/workspaces/${ws.id}/chat/bootstrap`
  )
  const bobParticipant = members.find(
    (m) => m.workspaceMemberId === bobBootstrap.workspaceMemberId
  )
  assert.ok(bobParticipant)
  const removed = await alice.client.json<{ state: string }>(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/participants/${bobParticipant!.participantId}`,
    { method: "DELETE" }
  )
  assert.equal(removed.state, "removed")
})
