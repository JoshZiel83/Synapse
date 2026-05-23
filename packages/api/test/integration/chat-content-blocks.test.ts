/**
 * S5/S27: protocol completeness checks.
 *
 * - clients can create conversations with remoteAgentIds + externalParticipants
 * - send-message rejects unknown block types
 * - send-message rejects malformed file_ref blocks
 * - messages endpoint paginates via beforeSequence
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

const uuid = () =>
  ([8, 4, 4, 4, 12] as const)
    .map((len) => randomBytes(len / 2).toString("hex"))
    .join("-")

type ParticipantSummary = {
  participantId: string
  participantType: string
  remoteAgentId?: string
  actorId?: string
  workspaceMemberId?: string
  externalUserKey?: string
  name?: string
}

test("create conversation forwards remoteAgentIds: response participants include a remote_agent entry", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)

  // Provision a remote agent in this workspace so we have a valid id.
  const agentResponse = await ctx.client.json<{
    remoteAgent: { id: string; name: string }
  }>(`/workspaces/${ws.id}/remote-agents`, {
    method: "POST",
    json: {
      name: `s27-agent-${randomBytes(3).toString("hex")}`,
      title: "S27 Tester",
      runtimeKind: "claude_code",
    },
  })
  const agent = agentResponse.remoteAgent
  assert.ok(agent.id, "remote agent id must come back")

  const created = await ctx.client.json<{
    conversation: {
      conversationId: string
      participants: ParticipantSummary[]
    }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      boundary: "internal",
      title: "s27-remote-agent",
      remoteAgentIds: [agent.id],
    },
  })

  const remoteParticipant = created.conversation.participants.find(
    (p) => p.participantType === "remote_agent"
  )
  assert.ok(
    remoteParticipant,
    `conversation must include a remote_agent participant; got ${JSON.stringify(
      created.conversation.participants.map((p) => p.participantType)
    )}`
  )
  assert.equal(
    remoteParticipant!.remoteAgentId,
    agent.id,
    "remote_agent participant must point back at the provisioned agent id"
  )
})

test("create conversation forwards externalParticipants: response includes an external entry with the displayName", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)

  const externalName = `S27 External ${randomBytes(2).toString("hex")}`
  const created = await ctx.client.json<{
    conversation: {
      conversationId: string
      participants: ParticipantSummary[]
    }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      boundary: "external",
      title: "s27-external",
      externalParticipants: [{ displayName: externalName }],
    },
  })

  const external = created.conversation.participants.find(
    (p) => p.participantType === "external"
  )
  assert.ok(
    external,
    `conversation must include an external participant; got ${JSON.stringify(
      created.conversation.participants.map((p) => p.participantType)
    )}`
  )
  assert.equal(
    external!.name,
    externalName,
    "external participant name must round-trip through the API"
  )
})

test("create conversation accepts mixed actorIds + remoteAgentIds + externalParticipants in one call", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)

  const agentResponse = await ctx.client.json<{
    remoteAgent: { id: string }
  }>(`/workspaces/${ws.id}/remote-agents`, {
    method: "POST",
    json: {
      name: `s27-mixed-${randomBytes(3).toString("hex")}`,
      title: "S27 Mixed",
      runtimeKind: "codex",
    },
  })
  const agent = agentResponse.remoteAgent

  const externalName = `S27 Mixed External ${randomBytes(2).toString("hex")}`
  const created = await ctx.client.json<{
    conversation: { participants: ParticipantSummary[] }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "group",
      boundary: "external",
      title: "s27-mixed",
      actorIds: [],
      remoteAgentIds: [agent.id],
      externalParticipants: [{ displayName: externalName }],
      metadata: { s27Marker: "mixed" },
    },
  })

  const kinds = created.conversation.participants.map((p) => p.participantType)
  assert.ok(
    kinds.includes("remote_agent"),
    "mixed conversation must include remote_agent participant"
  )
  assert.ok(
    kinds.includes("external"),
    "mixed conversation must include external participant"
  )
})

test("send-message rejects unknown block types with 400", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "private",
      boundary: "internal",
      title: "send-validation",
    },
  })

  // First need a client instance to send.
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    {
      method: "POST",
      json: { platform: "test", deviceLabel: "integration-test" },
    }
  )

  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${created.conversation.conversationId}/messages`,
    {
      method: "POST",
      json: {
        clientMessageId: uuid(),
        clientInstanceId: instance.clientInstanceId,
        contentBlocks: [{ type: "weird", text: "nope" }],
      },
    }
  )
  assert.equal(res.status, 400)
})

test("send-message rejects file_ref blocks missing required fields", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "private",
      boundary: "internal",
      title: "block-validation",
    },
  })
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    {
      method: "POST",
      json: { platform: "test" },
    }
  )

  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${created.conversation.conversationId}/messages`,
    {
      method: "POST",
      json: {
        clientMessageId: uuid(),
        clientInstanceId: instance.clientInstanceId,
        contentBlocks: [{ type: "file_ref", url: "missing-everything-else" }],
      },
    }
  )
  assert.equal(res.status, 400)
})

test("messages endpoint accepts beforeSequence pagination param", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "private",
      boundary: "internal",
      title: "pagination",
    },
  })
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    { method: "POST", json: { platform: "test" } }
  )

  const params = new URLSearchParams({
    clientInstanceId: instance.clientInstanceId,
    beforeSequence: "10",
    limit: "20",
  })
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${created.conversation.conversationId}/messages?${params}`
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    items: unknown[]
    hasMoreBefore: boolean
  }
  assert.ok(Array.isArray(body.items))
  assert.equal(typeof body.hasMoreBefore, "boolean")
})
