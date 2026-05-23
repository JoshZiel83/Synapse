/**
 * S35: end-to-end verification that the chat dedup counters fire.
 *
 * The S6 plan called for duplicate_watermark_post_total and
 * duplicate_clientmessageid_send_total observability counters so we can
 * monitor whether the main-thread vs SW mutex (S23) is actually
 * holding. These tests:
 *
 * 1. Issue a real duplicate read-watermark POST (same conversation,
 *    same sequence twice) against the staging API and assert
 *    duplicate_watermark_post_total advances.
 * 2. Issue a real duplicate send-message POST (same clientMessageId
 *    twice) and assert duplicate_clientmessageid_send_total advances.
 *
 * Counters are read from the authenticated debug endpoint
 * GET /_debug/chat/dedup-counters which returns the in-process
 * snapshot.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import {
  createApiClient,
  registerTestUser,
  createTestWorkspace,
} from "./setup.ts"

const uuid = () =>
  ([8, 4, 4, 4, 12] as const)
    .map((len) => randomBytes(len / 2).toString("hex"))
    .join("-")

async function readDedupCounters(client: ReturnType<typeof createApiClient>) {
  return client.json<Record<string, number>>("/_debug/chat/dedup-counters")
}

test("duplicate read-watermark POST bumps duplicate_watermark_post_total", async () => {
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
      title: "s35-watermark-dedup",
    },
  })
  const conversationId = created.conversation.conversationId
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    { method: "POST", json: { platform: "test" } }
  )

  // Two consecutive POSTs with the same readUpTo. Even if the resolved
  // sequence is 0 (empty conversation), the second call cannot advance
  // anything past the first, so the dedup counter must fire on the
  // second call.
  const watermarkBody = {
    clientInstanceId: instance.clientInstanceId,
    readUpToSequence: 0,
    lastVisibleSequence: 0,
  }
  await ctx.client.json(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/read-watermark`,
    { method: "POST", json: watermarkBody }
  )

  const before = await readDedupCounters(ctx.client)
  const beforeWatermark = before.duplicate_watermark_post_total ?? 0

  await ctx.client.json(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/read-watermark`,
    { method: "POST", json: watermarkBody }
  )

  const after = await readDedupCounters(ctx.client)
  const afterWatermark = after.duplicate_watermark_post_total ?? 0
  assert.ok(
    afterWatermark > beforeWatermark,
    `duplicate_watermark_post_total must advance after a no-op POST; before=${beforeWatermark} after=${afterWatermark}`
  )
})

test("first read-watermark POST on a fresh conversation does NOT bump duplicate_watermark_post_total", async () => {
  // Regression for the S37 false positive: the previous heuristic
  // compared nextSequence to toNumber(undefined) (=0) when no
  // conversation_participant_states row existed yet. If the first POST
  // shipped readUpToSequence=0 (the common case on an empty
  // conversation), it was wrongly counted as a duplicate even though
  // it was the inaugural write. Now the counter requires an existing
  // row before firing.
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
      title: "s37-watermark-first-post",
    },
  })
  const conversationId = created.conversation.conversationId
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    { method: "POST", json: { platform: "test" } }
  )

  const before = await readDedupCounters(ctx.client)
  const beforeWatermark = before.duplicate_watermark_post_total ?? 0

  await ctx.client.json(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/read-watermark`,
    {
      method: "POST",
      json: {
        clientInstanceId: instance.clientInstanceId,
        readUpToSequence: 0,
        lastVisibleSequence: 0,
      },
    }
  )

  const after = await readDedupCounters(ctx.client)
  const afterWatermark = after.duplicate_watermark_post_total ?? 0
  assert.equal(
    afterWatermark,
    beforeWatermark,
    `the first read-watermark POST on a fresh conversation must NOT increment duplicate_watermark_post_total (before=${beforeWatermark} after=${afterWatermark})`
  )
})

test("duplicate clientMessageId send-message bumps duplicate_clientmessageid_send_total", async () => {
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
      title: "s35-send-dedup",
    },
  })
  const conversationId = created.conversation.conversationId
  const instance = await ctx.client.json<{ clientInstanceId: string }>(
    `/workspaces/${ws.id}/chat/client-instances`,
    { method: "POST", json: { platform: "test" } }
  )

  const clientMessageId = randomUUID()
  const sendBody = {
    clientMessageId,
    clientInstanceId: instance.clientInstanceId,
    contentBlocks: [{ type: "text", text: "s35 dedup probe" }],
  }

  await ctx.client.json(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/messages`,
    { method: "POST", json: sendBody }
  )

  const before = await readDedupCounters(ctx.client)
  const beforeSend = before.duplicate_clientmessageid_send_total ?? 0

  // Same clientMessageId, second POST. Server must dedupe and counter
  // must advance.
  await ctx.client.json(
    `/workspaces/${ws.id}/chat/conversations/${conversationId}/messages`,
    { method: "POST", json: sendBody }
  )

  const after = await readDedupCounters(ctx.client)
  const afterSend = after.duplicate_clientmessageid_send_total ?? 0
  assert.ok(
    afterSend > beforeSend,
    `duplicate_clientmessageid_send_total must advance after a same-id resend; before=${beforeSend} after=${afterSend}`
  )
})
