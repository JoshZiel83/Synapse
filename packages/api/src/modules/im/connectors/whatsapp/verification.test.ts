import test from "node:test"
import assert from "node:assert/strict"
import { handleWhatsappWebhookVerification } from "./verification.js"
import type { WebhookVerificationInput } from "../types.js"

const account = {
  id: "acct-1",
  credentials: {
    phoneNumberId: "123",
    wabaId: "456",
    accessToken: "tok",
    appSecret: "sec",
    appId: "789",
    webhookVerifyToken: "the-verify-token",
  },
} as unknown as WebhookVerificationInput["account"]

function input(query: Record<string, unknown>): WebhookVerificationInput {
  return { account, query, headers: {} }
}

test("verification: echoes hub.challenge verbatim on token + subscribe match", async () => {
  const r = await handleWhatsappWebhookVerification(
    input({
      "hub.mode": "subscribe",
      "hub.verify_token": "the-verify-token",
      "hub.challenge": "1234567890",
    })
  )
  assert.equal(r.statusCode, 200)
  assert.equal(r.body, "1234567890")
})

test("verification: 403 on token mismatch", async () => {
  const r = await handleWhatsappWebhookVerification(
    input({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong",
      "hub.challenge": "x",
    })
  )
  assert.equal(r.statusCode, 403)
  assert.equal(r.body, "")
})

test("verification: 403 when mode is not subscribe", async () => {
  const r = await handleWhatsappWebhookVerification(
    input({
      "hub.mode": "unsubscribe",
      "hub.verify_token": "the-verify-token",
      "hub.challenge": "x",
    })
  )
  assert.equal(r.statusCode, 403)
})

test("verification: tolerates array-valued query params (takes first)", async () => {
  const r = await handleWhatsappWebhookVerification(
    input({
      "hub.mode": ["subscribe"],
      "hub.verify_token": ["the-verify-token"],
      "hub.challenge": ["nonce"],
    })
  )
  assert.equal(r.statusCode, 200)
  assert.equal(r.body, "nonce")
})

test("verification: 403 when credentials are invalid", async () => {
  const r = await handleWhatsappWebhookVerification({
    account: { id: "x", credentials: {} } as never,
    query: {
      "hub.mode": "subscribe",
      "hub.verify_token": "anything",
      "hub.challenge": "x",
    },
    headers: {},
  })
  assert.equal(r.statusCode, 403)
})
