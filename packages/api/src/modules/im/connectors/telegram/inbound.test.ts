import test from "node:test"
import assert from "node:assert/strict"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { InboundEnvelope, WebhookHandlerInput } from "../types.js"
import { handleTelegramWebhook, startTelegramAccount } from "./inbound.js"

const WEBHOOK_ACCOUNT = {
  id: "acc",
  connectionMode: "webhook",
  workspaceId: "ws",
  credentials: { botToken: "t", webhookSecretToken: "s3cr3t" },
} as unknown as TransportAccountSummary

function webhookInput(over: Partial<WebhookHandlerInput> = {}): {
  input: WebhookHandlerInput
  emitted: InboundEnvelope[]
} {
  const emitted: InboundEnvelope[] = []
  const input: WebhookHandlerInput = {
    account: WEBHOOK_ACCOUNT,
    headers: { "x-telegram-bot-api-secret-token": "s3cr3t" },
    body: {
      update_id: 10,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: 555, type: "private", first_name: "A" },
        from: { id: 777, first_name: "A" },
        text: "hello",
      },
    },
    emitInbound: async (e) => {
      emitted.push(e)
    },
    ...over,
  }
  return { input, emitted }
}

const NO_DEDUP = {
  isDuplicate: async () => false,
  enrich: async (e: InboundEnvelope) => e,
}

test("startTelegramAccount: webhook mode => no-op stop", async () => {
  const running = await startTelegramAccount({
    account: WEBHOOK_ACCOUNT,
    signal: new AbortController().signal,
    emitInbound: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  await running.stop() // must not throw
  assert.ok(running)
})

test("handleWebhook: valid secret + message => emits + 200", async () => {
  const { input, emitted } = webhookInput()
  const res = await handleTelegramWebhook(input, NO_DEDUP)
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].externalMessageId, "1")
})

test("handleWebhook: bad secret => 401, no emit", async () => {
  const { input, emitted } = webhookInput({
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
  })
  const res = await handleTelegramWebhook(input, NO_DEDUP)
  assert.equal(res.statusCode, 401)
  assert.equal(emitted.length, 0)
})

test("handleWebhook: missing creds => 500", async () => {
  const { input } = webhookInput({
    account: { ...WEBHOOK_ACCOUNT, credentials: {} } as TransportAccountSummary,
  })
  const res = await handleTelegramWebhook(input, NO_DEDUP)
  assert.equal(res.statusCode, 500)
})

test("handleWebhook: malformed body => 400", async () => {
  const { input } = webhookInput({ body: { not_an_update: true } })
  const res = await handleTelegramWebhook(input, NO_DEDUP)
  assert.equal(res.statusCode, 400)
})

test("handleWebhook: duplicate update_id => 200, no emit", async () => {
  const { input, emitted } = webhookInput()
  const res = await handleTelegramWebhook(input, {
    isDuplicate: async () => true,
    enrich: async (e) => e,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 0)
})

test("handleWebhook: reaction-only update (no message) => 200, no emit", async () => {
  const { input, emitted } = webhookInput({
    body: {
      update_id: 11,
      message_reaction: { chat: { id: 1 }, message_id: 2 },
    },
  })
  const res = await handleTelegramWebhook(input, NO_DEDUP)
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 0)
})
