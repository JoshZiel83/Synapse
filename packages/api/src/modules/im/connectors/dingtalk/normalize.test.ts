import test from "node:test"
import assert from "node:assert/strict"
import { normalizeDingtalkPayload } from "./normalize.js"

const baseGroup = {
  msgtype: "text",
  msgId: "msg-1",
  conversationId: "cid-group-1",
  conversationType: "2",
  conversationTitle: "Test Group",
  openConversationId: "ocid-group-1",
  createAt: 1700000000000,
  senderId: "sender-1",
  senderStaffId: "alice",
  senderNick: "Alice",
  senderCorpId: "corp-A",
  chatbotUserId: "bot-1",
  chatbotCorpId: "corp-bot",
  robotCode: "ding-robot-1",
  sessionWebhook: "https://example.com/wh/xyz",
  sessionWebhookExpiredTime: 1700003600000,
  text: { content: "hello bot" },
  atUsers: [
    { dingtalkId: "ding-A", staffId: "alice" },
    { dingtalkId: "bot-1", staffId: "bot-staff" },
  ],
}

test("normalize: group payload with staffId produces a complete envelope", () => {
  const env = normalizeDingtalkPayload(baseGroup)
  assert.ok(env, "expected an envelope")
  assert.equal(env!.endpointType, "group")
  assert.equal(env!.endpointExternalId, "cid-group-1")
  assert.equal(env!.externalMessageId, "msg-1")
  assert.equal(env!.sender.externalId, "alice")
  assert.equal(
    (env!.sender.metadata as { externalIdSource: string }).externalIdSource,
    "staffId"
  )
  assert.equal(
    (env!.endpointMetadata as { lastSenderStaffId: string }).lastSenderStaffId,
    "alice"
  )
  assert.equal(
    (env!.endpointMetadata as { sessionWebhook: string }).sessionWebhook,
    "https://example.com/wh/xyz"
  )
  assert.equal(
    (env!.endpointMetadata as { openConversationId: string })
      .openConversationId,
    "ocid-group-1"
  )
  // mention parts: alice kept, bot dropped
  const mentionParts = env!.message.parts.filter((p) => p.type === "mention")
  assert.equal(mentionParts.length, 1)
  assert.equal((mentionParts[0] as { externalId: string }).externalId, "alice")
})

test("normalize: direct payload uses 'direct' endpointType", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    conversationType: "1",
  })
  assert.equal(env!.endpointType, "direct")
})

test("normalize: missing staffId falls back to senderId:-prefixed externalId", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    senderStaffId: undefined,
  })
  assert.ok(env)
  assert.equal(env!.sender.externalId, "senderId:sender-1")
  assert.equal(
    (env!.sender.metadata as { externalIdSource: string }).externalIdSource,
    "senderId"
  )
  // lastSenderStaffId must NOT be written when staffId is absent
  assert.equal("lastSenderStaffId" in (env!.endpointMetadata as object), false)
})

test("normalize: sender.metadata uses `senderId` field name (not `dingtalkId`)", () => {
  const env = normalizeDingtalkPayload(baseGroup)
  const md = env!.sender.metadata as Record<string, unknown>
  assert.equal(md.senderId, "sender-1")
  assert.equal(md.staffId, "alice")
  assert.ok(!("dingtalkId" in md))
})

test("normalize: bot self-message via senderId returns null", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    senderId: "bot-1",
  })
  assert.equal(env, null)
})

test("normalize: bot self-message via senderStaffId returns null", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    senderStaffId: "bot-1",
    chatbotUserId: "bot-1",
    senderId: "other-sender",
  })
  assert.equal(env, null)
})

test("normalize: missing both senderId and senderStaffId is dropped with a warning", () => {
  const warns: string[] = []
  const env = normalizeDingtalkPayload(
    { ...baseGroup, senderId: undefined, senderStaffId: undefined },
    { logger: { warn: (m) => warns.push(m) } }
  )
  assert.equal(env, null)
  assert.ok(
    warns.some((m) => /missing both senderStaffId and senderId/.test(m))
  )
})

test("normalize: missing conversationId is dropped", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    conversationId: undefined,
  })
  assert.equal(env, null)
})

test("normalize: picture msgtype emits image_placeholder system_marker", () => {
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    msgtype: "picture",
    text: undefined,
    content: { downloadCode: "dc-1" },
  })
  assert.ok(env)
  const markerPart = env!.message.parts.find((p) => p.type === "system_marker")
  assert.equal(
    markerPart && (markerPart as { marker: string }).marker,
    "image_placeholder"
  )
})

test("normalize: markdown msgtype reads from text.content or content.text", () => {
  const fromText = normalizeDingtalkPayload({
    ...baseGroup,
    msgtype: "markdown",
    text: { content: "# heading" },
  })
  assert.equal(
    (fromText!.message.parts[0] as { text: string }).text,
    "# heading"
  )
})

test("normalize: when sessionWebhookExpiredTime absent, the key is written as null (not omitted)", () => {
  // Writing the key as null is intentional: transport_endpoints.metadata
  // upsert is a JSONB shallow merge, so omitting the key would let a
  // stale expiry from a previous inbound leak across and cause the
  // outbound flow to skip the (still-valid) new webhook.
  const env = normalizeDingtalkPayload({
    ...baseGroup,
    sessionWebhookExpiredTime: undefined,
  })
  const md = env!.endpointMetadata as Record<string, unknown>
  assert.equal("sessionWebhookExpiredTime" in md, true)
  assert.equal(md.sessionWebhookExpiredTime, null)
  assert.equal(typeof md.sessionWebhookObservedAt, "string")
})
