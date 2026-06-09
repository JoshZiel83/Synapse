/**
 * S5/S27: protocol completeness checks.
 *
 * - clients can create conversations with remoteAgentIds
 * - send-message rejects unknown block types
 * - send-message rejects malformed file_ref blocks
 * - messages endpoint paginates via beforeSequence
 *
 * Must be run via tests/integration/scripts/run-test.sh.
 */

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "chat-content-blocks.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
  )
}

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import pg from "pg"
import {
  setupChatStack,
  teardownChatStack,
  registerTestUser,
  createTestWorkspace,
  buildDatabaseUrl,
  type ChatStack,
} from "./harness/index.js"

const uuid = () => randomUUID()

// External participants are first-class, single-address identities: the API
// requires a real transport_addresses row. Create one directly over pg (there
// is no public transport-address create endpoint in this harness).
async function createTransportAddress(workspaceId: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: buildDatabaseUrl() })
  try {
    const account = await pool.query<{ id: string }>(
      `INSERT INTO transport_accounts
         (workspace_id, transport_kind, account_key, display_name, connection_mode, owner_scope)
       VALUES ($1, 'qq', $2, 'Test account', 'webhook', 'workspace')
       RETURNING id`,
      [workspaceId, `acct-${randomBytes(4).toString("hex")}`]
    )
    const addr = await pool.query<{ id: string }>(
      `INSERT INTO transport_addresses
         (workspace_id, transport_account_id, transport_kind, address_type, external_id)
       VALUES ($1, $2, 'qq', 'user', $3)
       RETURNING id`,
      [workspaceId, account.rows[0].id, `ext-${randomBytes(4).toString("hex")}`]
    )
    return addr.rows[0].id
  } finally {
    await pool.end()
  }
}

type ParticipantSummary = {
  participantId: string
  participantType: string
  remoteAgentId?: string
  actorId?: string
  workspaceMemberId?: string
  externalUserKey?: string
  name?: string
}

let stack: ChatStack | undefined

before(async () => {
  stack = await setupChatStack()
})

after(async () => {
  if (stack) await teardownChatStack(stack)
})

test("create conversation forwards remoteAgentIds: response participants include a remote_agent entry", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)

  // Provision a remote agent in this workspace so we have a valid id.
  const agentResponse = await ctx.client.json<{
    app: { id: string }
  }>(`/workspaces/${ws.id}/workspace-apps`, {
    method: "POST",
    json: {
      kind: "remote_agent",
      displayName: `s27-agent-${randomBytes(3).toString("hex")}`,
      title: "S27 Tester",
      runtimeKind: "claude_code",
    },
  })
  const agent = agentResponse.app
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

test("send-message rejects unknown block types with 400", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "direct",
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
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "direct",
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
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "direct",
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
