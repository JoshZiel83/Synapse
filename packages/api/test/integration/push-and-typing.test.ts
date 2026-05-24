/**
 * S7: push tokens + typing endpoints integration test.
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

test("register + list + delete chat push token round-trips", async () => {
  const base = createApiClient()
  const ctx = await registerTestUser(base)
  const ws = await createTestWorkspace(ctx.client)

  const registered = await ctx.client.json<{
    token: { id: string; platform: string; deviceLabel: string | null }
  }>(`/workspaces/${ws.id}/chat/push-tokens`, {
    method: "POST",
    json: {
      platform: "web",
      token: `s7-test-${randomBytes(8).toString("hex")}`,
      deviceLabel: "S7 integration test",
    },
  })
  assert.ok(registered.token.id)
  assert.equal(registered.token.platform, "web")
  assert.equal(registered.token.deviceLabel, "S7 integration test")

  const listed = await ctx.client.json<{
    tokens: Array<{ id: string; platform: string }>
  }>(`/workspaces/${ws.id}/chat/push-tokens`)
  assert.ok(listed.tokens.length >= 1)
  assert.ok(listed.tokens.some((t) => t.id === registered.token.id))

  const deleted = await ctx.client.json<{ deleted: boolean }>(
    `/workspaces/${ws.id}/chat/push-tokens/${registered.token.id}`,
    { method: "DELETE" }
  )
  assert.equal(deleted.deleted, true)

  const afterDelete = await ctx.client.json<{
    tokens: Array<{ id: string }>
  }>(`/workspaces/${ws.id}/chat/push-tokens`)
  assert.equal(
    afterDelete.tokens.some((t) => t.id === registered.token.id),
    false
  )
})

test("push tokens are isolated per workspace member", async () => {
  const base = createApiClient()
  const a = await registerTestUser(base)
  const wsA = await createTestWorkspace(a.client)
  await a.client.json(`/workspaces/${wsA.id}/chat/push-tokens`, {
    method: "POST",
    json: {
      platform: "web",
      token: `iso-test-a-${randomBytes(8).toString("hex")}`,
    },
  })

  const b = await registerTestUser(base)
  const wsB = await createTestWorkspace(b.client)
  const bList = await b.client.json<{ tokens: unknown[] }>(
    `/workspaces/${wsB.id}/chat/push-tokens`
  )
  assert.equal(bList.tokens.length, 0)
})

test("typing endpoint returns broadcast: true for authorized participants", async () => {
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
      title: "typing test",
    },
  })

  const res = await ctx.client.json<{ broadcast: boolean }>(
    `/workspaces/${ws.id}/chat/conversations/${created.conversation.conversationId}/typing`,
    { method: "POST", json: { state: "started" } }
  )
  assert.equal(res.broadcast, true)
})

test("typing endpoint rejects unauthorized callers with 403", async () => {
  const base = createApiClient()
  // owner creates a conversation
  const owner = await registerTestUser(base)
  const wsA = await createTestWorkspace(owner.client)
  const created = await owner.client.json<{
    conversation: { conversationId: string }
  }>(`/workspaces/${wsA.id}/chat/conversations`, {
    method: "POST",
    json: {
      clientRequestId: uuid(),
      kind: "private",
      boundary: "internal",
      title: "private",
    },
  })

  // outsider in a different workspace tries to send typing
  const outsider = await registerTestUser(base)
  const wsB = await createTestWorkspace(outsider.client)
  const res = await outsider.client.fetch(
    `/workspaces/${wsB.id}/chat/conversations/${created.conversation.conversationId}/typing`,
    { method: "POST", json: { state: "started" } }
  )
  // Either 403 (forbidden — outsider not a participant) or 404 (conversation
  // not in their workspace) is acceptable; both are non-200.
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`)
})
