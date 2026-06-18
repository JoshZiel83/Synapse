import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import type { InboundEnvelope, WebhookHandlerInput } from "../types.js"
import { handleWhatsappWebhook } from "./inbound.js"
import type { WhatsappWindowStore } from "./window-store.js"

const APP_SECRET = "sec"
const account = {
  id: "acct-1",
  workspaceId: "ws",
  credentials: {
    phoneNumberId: "PNID",
    wabaId: "W",
    accessToken: "TOK",
    appSecret: APP_SECRET,
    appId: "A",
    webhookVerifyToken: "V",
    graphApiVersion: "v23.0",
  },
} as unknown as WebhookHandlerInput["account"]

function sign(rawBody: string): string {
  return (
    "sha256=" +
    crypto
      .createHmac("sha256", APP_SECRET)
      .update(rawBody, "utf8")
      .digest("hex")
  )
}

function makeInput(
  body: unknown,
  opts: {
    emitInbound?: (e: InboundEnvelope) => Promise<void>
    badSignature?: boolean
    noRawBody?: boolean
  } = {}
): WebhookHandlerInput {
  const rawBody = JSON.stringify(body)
  const emitted: InboundEnvelope[] = []
  const input: WebhookHandlerInput = {
    account,
    headers: {
      "x-hub-signature-256": opts.badSignature ? "sha256=bad" : sign(rawBody),
    },
    body,
    ...(opts.noRawBody ? {} : { rawBody }),
    emitInbound:
      opts.emitInbound ??
      (async (e) => {
        emitted.push(e)
      }),
  }
  return Object.assign(input, { _emitted: emitted })
}

function trackedWindowStore(): WhatsappWindowStore & {
  recorded: Array<{ accountId: string; waId: string }>
} {
  const recorded: Array<{ accountId: string; waId: string }> = []
  return {
    recorded,
    recordInbound: async ({ accountId, waId }) => {
      recorded.push({ accountId, waId })
    },
    getLastInboundMs: async () => null,
    isWithin24h: async () => true,
  }
}

const textMessageBody = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: "15551230000", profile: { name: "Alice" } }],
            messages: [
              {
                id: "wamid.IN",
                from: "15551230000",
                timestamp: "1700000000",
                type: "text",
                text: { body: "hello" },
              },
            ],
          },
        },
      ],
    },
  ],
}

test("inbound: rejects a bad signature with 401", async () => {
  const input = makeInput(textMessageBody, { badSignature: true })
  const res = await handleWhatsappWebhook(input)
  assert.equal(res.statusCode, 401)
})

test("inbound: 400 when rawBody is missing (cannot verify)", async () => {
  const input = makeInput(textMessageBody, { noRawBody: true })
  const res = await handleWhatsappWebhook(input)
  assert.equal(res.statusCode, 400)
})

test("inbound: valid signature → 200, emits the normalized envelope, updates window", async () => {
  const emitted: InboundEnvelope[] = []
  const input = makeInput(textMessageBody, {
    emitInbound: async (e) => {
      emitted.push(e)
    },
  })
  const windowStore = trackedWindowStore()
  const res = await handleWhatsappWebhook(input, { windowStore })
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.externalMessageId, "wamid.IN")
  assert.equal(emitted[0]?.endpointDisplayName, "Alice")
  assert.equal(emitted[0]?.message.plainText, "hello")
  assert.deepEqual(windowStore.recorded, [
    { accountId: "acct-1", waId: "15551230000" },
  ])
})

test("inbound: a message missing id/from is skipped without failing the batch", async () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "", timestamp: "1700000000", type: "text" },
                {
                  id: "wamid.OK",
                  from: "p",
                  timestamp: "1700000000",
                  type: "text",
                  text: { body: "ok" },
                },
              ],
            },
          },
        ],
      },
    ],
  }
  const emitted: InboundEnvelope[] = []
  const input = makeInput(body, {
    emitInbound: async (e) => {
      emitted.push(e)
    },
  })
  const res = await handleWhatsappWebhook(input, {
    windowStore: trackedWindowStore(),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.externalMessageId, "wamid.OK")
})

test("inbound: malformed-but-signed body → 200 ack (no retry storm)", async () => {
  const input = makeInput("not-an-object")
  const res = await handleWhatsappWebhook(input, {
    windowStore: trackedWindowStore(),
  })
  assert.equal(res.statusCode, 200)
})

test("inbound: missing credentials → 500", async () => {
  const rawBody = JSON.stringify(textMessageBody)
  const res = await handleWhatsappWebhook(
    {
      account: { id: "x", credentials: {} } as never,
      headers: { "x-hub-signature-256": sign(rawBody) },
      body: textMessageBody,
      rawBody,
      emitInbound: async () => {},
    },
    { windowStore: trackedWindowStore() }
  )
  assert.equal(res.statusCode, 500)
})
