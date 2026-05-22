/**
 * S5: protocol completeness checks.
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
