import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeConversationItemMetadata,
  decodeTransportAccountConfig,
  decodeTransportAccountCredentials,
  decodeTransportAccountMetadata,
  decodeTransportMessageLinkMetadata,
  normalizeTransportAddressRow,
  normalizeTransportExternalUserRow,
  normalizeTransportOutboxSweepCandidateRow,
} from "./repo.js"

const createdAt = new Date("2026-06-15T09:00:00.000Z")
const updatedAt = new Date("2026-06-15T09:00:01.000Z")

test("decodeTransportAccountCredentials decodes account credentials at repo exit", () => {
  const credentials = decodeTransportAccountCredentials({
    credentials: JSON.stringify({ appId: "demo", appSecret: "secret" }),
  })

  assert.deepEqual(credentials, { appId: "demo", appSecret: "secret" })
})

test("decodeTransportAccountConfig accepts object config without shape loss", () => {
  const config = decodeTransportAccountConfig({
    config: { robotCode: "bot-1", enableGroupMessages: true },
  })

  assert.deepEqual(config, {
    robotCode: "bot-1",
    enableGroupMessages: true,
  })
})

test("decodeTransportAccountMetadata normalizes non-object metadata", () => {
  assert.deepEqual(
    decodeTransportAccountMetadata({
      metadata: JSON.stringify(["not", "an", "object"]),
    }),
    {}
  )
})

test("decodeTransportMessageLinkMetadata decodes link metadata at repo exit", () => {
  const metadata = decodeTransportMessageLinkMetadata({
    metadata: JSON.stringify({ delivery: { attempt: 1 } }),
  })

  assert.deepEqual(metadata, { delivery: { attempt: 1 } })
})

test("normalizeTransportAddressRow decodes address metadata at repo exit", () => {
  const row = normalizeTransportAddressRow({
    id: "addr-1",
    workspaceId: "workspace-1",
    transportAccountId: "account-1",
    transportKind: "weixin",
    addressType: "user",
    externalId: "openid-1",
    displayName: "Alice",
    workspaceMemberId: null,
    metadata: JSON.stringify({ contextToken: "ctx-1" }),
    createdAt,
    updatedAt,
  })

  assert.deepEqual(row, {
    id: "addr-1",
    workspaceId: "workspace-1",
    transportAccountId: "account-1",
    transportKind: "weixin",
    addressType: "user",
    externalId: "openid-1",
    displayName: "Alice",
    workspaceMemberId: null,
    metadata: { contextToken: "ctx-1" },
    createdAt,
    updatedAt,
  })
})

test("normalizeTransportAddressRow normalizes non-object address metadata", () => {
  const base = {
    id: "addr-1",
    workspaceId: "workspace-1",
    transportAccountId: "account-1",
    transportKind: "weixin" as const,
    addressType: "user",
    externalId: "openid-1",
    displayName: null,
    workspaceMemberId: null,
    createdAt,
    updatedAt,
  }

  assert.deepEqual(
    normalizeTransportAddressRow({
      ...base,
      metadata: "not an object",
    }).metadata,
    {}
  )
  assert.deepEqual(
    normalizeTransportAddressRow({
      ...base,
      metadata: [1, 2, 3],
    }).metadata,
    {}
  )
})

test("normalizeTransportExternalUserRow decodes session aggregate arrays at repo exit", () => {
  const row = normalizeTransportExternalUserRow({
    id: "external-user-1",
    workspaceId: "workspace-1",
    transportAccountId: "account-1",
    transportKind: "weixin",
    accountDisplayName: "Weixin",
    externalId: "openid-1",
    displayName: "Alice",
    linkedWorkspaceMemberId: null,
    linkedWorkspaceMemberName: null,
    metadata: JSON.stringify({ source: "qr" }),
    createdAt,
    updatedAt,
    sessions: JSON.stringify([{ conversationId: "conversation-1" }]),
  } as never)

  assert.deepEqual(row.sessions, [{ conversationId: "conversation-1" }])
})

test("normalizeTransportExternalUserRow rejects malformed session aggregates", () => {
  const base = {
    id: "external-user-1",
    workspaceId: "workspace-1",
    transportAccountId: "account-1",
    transportKind: "weixin",
    accountDisplayName: "Weixin",
    externalId: "openid-1",
    displayName: null,
    linkedWorkspaceMemberId: null,
    linkedWorkspaceMemberName: null,
    metadata: {},
    createdAt,
    updatedAt,
  }

  assert.throws(
    () =>
      normalizeTransportExternalUserRow({
        ...base,
        sessions: '{"conversationId":"conversation-1"}',
      } as never),
    /transportExternalUser\.sessions must be a JSON array/
  )
  assert.throws(
    () =>
      normalizeTransportExternalUserRow({
        ...base,
        sessions: "{bad json",
      } as never),
    /transportExternalUser\.sessions must be valid JSON/
  )
})

test("normalizeTransportOutboxSweepCandidateRow decodes sweep metadata at repo exit", () => {
  const row = normalizeTransportOutboxSweepCandidateRow({
    id: "link-1",
    delivery_status: "failed",
    metadata: JSON.stringify({ qq: { attempts: { a1: "unknown" } } }),
    created_at: createdAt,
    skipped_reason: null,
    has_unknown_attempt: true,
    last_error: "qq_5xx: upstream failed",
  })

  assert.deepEqual(row, {
    id: "link-1",
    deliveryStatus: "failed",
    metadata: { qq: { attempts: { a1: "unknown" } } },
    createdAt,
    skippedReason: null,
    hasUnknownAttempt: true,
    lastError: "qq_5xx: upstream failed",
  })
})

test("decodeConversationItemMetadata preserves joined item metadata", () => {
  const metadata = decodeConversationItemMetadata({
    itemMetadata: { source: "projection", messageId: "m1" },
  })

  assert.deepEqual(metadata, {
    source: "projection",
    messageId: "m1",
  })
})
