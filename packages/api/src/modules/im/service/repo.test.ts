import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeConversationItemMetadata,
  decodeTransportAccountConfig,
  decodeTransportAccountCredentials,
  decodeTransportAccountMetadata,
  decodeTransportMessageLinkMetadata,
} from "./repo.js"

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

test("decodeConversationItemMetadata preserves joined item metadata", () => {
  const metadata = decodeConversationItemMetadata({
    itemMetadata: { source: "projection", messageId: "m1" },
  })

  assert.deepEqual(metadata, {
    source: "projection",
    messageId: "m1",
  })
})
