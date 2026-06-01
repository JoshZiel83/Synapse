/**
 * S16: retry endpoint on the chat URL namespace.
 *
 * The client posts `/workspaces/:wsId/chat/conversations/:cid/messages/:itemId/retry`
 * when the user taps "retry" on a failed assistant message. Verifies:
 *  - route exists (no 404 from missing handler)
 *  - non-existent itemId returns 404 from the service guard
 *  - non-retryable items (e.g. a plain message) return 400
 *
 * Must be run via tests/integration/scripts/run-test.sh.
 */

if (process.env.SYNAPSE_INT_TEST !== "1") {
  throw new Error(
    "retry-route.test.ts must be run via packages/api/tests/integration/scripts/run-test.sh"
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

test("retry endpoint is mounted under /chat/conversations/.../messages/:itemId/retry", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "direct",
      title: "retry-route-test",
    },
  })

  const fakeItem = uuid()
  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${created.conversation.conversationId}/messages/${fakeItem}/retry`,
    { method: "POST", json: {} }
  )
  // Route exists -> NOT Fastify-not-found ("Not Found"). Should be 404 from
  // our own "item_not_found" guard.
  assert.notEqual(res.status, 0)
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    code?: string
  }
  if (res.status === 404 && body.error === "Not Found") {
    throw new Error("retry route is not mounted")
  }
  assert.equal(res.status, 404)
  assert.equal(body.code, "item_not_found")
})

test("retry returns 400 for a non-retryable item (e.g. user message)", async () => {
  const ctx = await registerTestUser(stack!.baseClient)
  const ws = await createTestWorkspace(ctx.client)
  const created = await ctx.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${ws.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "direct",
      title: "retry-validation-test",
    },
  })
  const conversationId = created.conversation.conversationId
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    { method: "POST", json: { platform: "test" } }
  )
  const sent = await ctx.client.json<{ item: { id: string } }>(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/messages`,
    {
      method: "POST",
      json: {
        clientMessageId: uuid(),
        clientInstanceId: instance.clientInstanceId,
        contentBlocks: [{ type: "text", text: "hello" }],
      },
    }
  )

  const res = await ctx.client.fetch(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/messages/${sent.item.id}/retry`,
    { method: "POST", json: {} }
  )
  assert.equal(res.status, 400)
  const body = (await res.json().catch(() => ({}))) as { code?: string }
  assert.equal(body.code, "item_not_retryable")
})
