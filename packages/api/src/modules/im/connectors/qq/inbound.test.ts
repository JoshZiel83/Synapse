import test, { after } from "node:test"
import assert from "node:assert/strict"
import type { InboundEnvelope, WebhookHandlerInput } from "../types.js"
import { handleQqWebhook } from "./inbound.js"
import { signEd25519UrlVerification } from "./webhook-signature.js"
import { QQ_OP } from "./types.js"
import { shutdownRedisConnections } from "../../../../infrastructure/redis/index.js"

// A successful inbound dispatch calls recordInboundAnchor → redis.set on the
// shared ioredis singleton, which opens a connection. Close it so the test
// process exits instead of hanging on the open socket.
after(async () => {
  await shutdownRedisConnections().catch(() => {})
})

const SECRET = "DG5g3B4j9X2KOErG"

function buildAccount(
  overrides: Partial<{
    config: Record<string, unknown>
    credentials: Record<string, unknown>
  }> = {}
) {
  return {
    id: "acc-1",
    workspaceId: "ws-1",
    transportKind: "qq" as const,
    accountKey: "key",
    displayName: "QQ Test",
    ownerScope: "workspace" as const,
    connectionMode: "webhook" as const,
    status: "active" as const,
    credentials: {
      appId: "APPID",
      clientSecret: SECRET,
      ...overrides.credentials,
    },
    config: overrides.config ?? {},
    metadata: {},
    inboundActorMode: "none" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function buildInput(
  body: unknown,
  opts: {
    rawBody?: string
    headers?: Record<string, unknown>
    config?: Record<string, unknown>
    emitted?: InboundEnvelope[]
  } = {}
): WebhookHandlerInput {
  return {
    account: buildAccount({ config: opts.config }),
    headers: opts.headers ?? {},
    body,
    rawBody: opts.rawBody,
    emitInbound: async (envelope) => {
      opts.emitted?.push(envelope)
    },
    logger: undefined,
  }
}

test("op=13 URL verification returns signed plain_token", async () => {
  const body = {
    op: QQ_OP.WEBHOOK_VERIFY,
    d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" },
  }
  const res = await handleQqWebhook(buildInput(body))
  assert.equal(res.statusCode, 200)
  const out = res.body as { plain_token: string; signature: string }
  assert.equal(out.plain_token, "Arq0D5A61EgUu4OxUvOp")
  assert.equal(out.signature.length, 128)
  // Signature must match what we'd compute independently
  const expected = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: "Arq0D5A61EgUu4OxUvOp",
    eventTs: "1725442341",
  })
  assert.equal(out.signature, expected)
})

test("op=13 with missing plain_token → 400", async () => {
  const body = { op: QQ_OP.WEBHOOK_VERIFY, d: { event_ts: "1" } }
  const res = await handleQqWebhook(buildInput(body))
  assert.equal(res.statusCode, 400)
})

test("op=0 dispatch with no raw body → 400", async () => {
  const body = { op: QQ_OP.DISPATCH, t: "C2C_MESSAGE_CREATE", d: {} }
  const res = await handleQqWebhook(buildInput(body))
  assert.equal(res.statusCode, 400)
})

test("op=0 dispatch with no signature headers → 401", async () => {
  const body = { op: QQ_OP.DISPATCH, t: "C2C_MESSAGE_CREATE", d: {} }
  const rawBody = JSON.stringify(body)
  const res = await handleQqWebhook(buildInput(body, { rawBody }))
  assert.equal(res.statusCode, 401)
})

test("op=0 dispatch with bad signature → 401", async () => {
  const body = { op: QQ_OP.DISPATCH, t: "C2C_MESSAGE_CREATE", d: {} }
  const rawBody = JSON.stringify(body)
  const res = await handleQqWebhook(
    buildInput(body, {
      rawBody,
      headers: {
        "x-signature-ed25519": "ff".repeat(64),
        "x-signature-timestamp": "1725442341",
      },
    })
  )
  assert.equal(res.statusCode, 401)
})

test("op=0 dispatch with valid signature + webhookInboundConfirmed=false → ack only, no emit", async () => {
  const body = {
    op: QQ_OP.DISPATCH,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "MSG1",
      author: { user_openid: "USER1" },
      content: "hello",
    },
  }
  const rawBody = JSON.stringify(body)
  const timestamp = "1725442341"
  const sig = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: rawBody,
    eventTs: timestamp,
  })
  const emitted: InboundEnvelope[] = []
  const res = await handleQqWebhook(
    buildInput(body, {
      rawBody,
      headers: {
        "x-signature-ed25519": sig,
        "x-signature-timestamp": timestamp,
      },
      emitted,
    })
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { op: QQ_OP.HTTP_CALLBACK_ACK })
  assert.equal(
    emitted.length,
    0,
    "must not emit until webhookInboundConfirmed=true"
  )
})

test("op=0 dispatch with valid signature + webhookInboundConfirmed=true → emits envelope", async () => {
  const body = {
    op: QQ_OP.DISPATCH,
    t: "C2C_MESSAGE_CREATE",
    d: {
      id: "MSG1",
      author: { user_openid: "USER1" },
      content: "hello",
    },
  }
  const rawBody = JSON.stringify(body)
  const timestamp = "1725442341"
  const sig = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: rawBody,
    eventTs: timestamp,
  })
  const emitted: InboundEnvelope[] = []
  const res = await handleQqWebhook(
    buildInput(body, {
      rawBody,
      headers: {
        "x-signature-ed25519": sig,
        "x-signature-timestamp": timestamp,
      },
      config: { webhookInboundConfirmed: true },
      emitted,
    })
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { op: QQ_OP.HTTP_CALLBACK_ACK })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].externalMessageId, "MSG1")
  assert.equal(emitted[0].endpointExternalId, "c2c:USER1")
})

test("op=0 dispatch GROUP_AT_MESSAGE_CREATE emits with gm:{group}:{member}", async () => {
  const body = {
    op: QQ_OP.DISPATCH,
    t: "GROUP_AT_MESSAGE_CREATE",
    d: {
      id: "MSG2",
      group_openid: "GRP1",
      author: { member_openid: "MEM1" },
      content: "<@BOT> hi",
    },
  }
  const rawBody = JSON.stringify(body)
  const timestamp = "1725442341"
  const sig = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: rawBody,
    eventTs: timestamp,
  })
  const emitted: InboundEnvelope[] = []
  await handleQqWebhook(
    buildInput(body, {
      rawBody,
      headers: {
        "x-signature-ed25519": sig,
        "x-signature-timestamp": timestamp,
      },
      config: { webhookInboundConfirmed: true },
      emitted,
    })
  )
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].endpointExternalId, "GRP1")
  assert.equal(emitted[0].sender.externalId, "gm:GRP1:MEM1")
  assert.equal(emitted[0].message.plainText, "hi")
})

test("op=0 dispatch GROUP_MESSAGE_CREATE (non-@) is silently ignored", async () => {
  const body = {
    op: QQ_OP.DISPATCH,
    t: "GROUP_MESSAGE_CREATE",
    d: { id: "M", group_openid: "G", author: { member_openid: "MEM" } },
  }
  const rawBody = JSON.stringify(body)
  const sig = signEd25519UrlVerification({
    secret: SECRET,
    plainToken: rawBody,
    eventTs: "1",
  })
  const emitted: InboundEnvelope[] = []
  const res = await handleQqWebhook(
    buildInput(body, {
      rawBody,
      headers: {
        "x-signature-ed25519": sig,
        "x-signature-timestamp": "1",
      },
      config: { webhookInboundConfirmed: true },
      emitted,
    })
  )
  assert.equal(res.statusCode, 200)
  assert.equal(emitted.length, 0)
})

test("non-dispatch op (e.g. WS opcodes mis-delivered) → 200 ack, no emit", async () => {
  const body = { op: QQ_OP.HEARTBEAT, d: 5 }
  const res = await handleQqWebhook(buildInput(body))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { op: QQ_OP.HTTP_CALLBACK_ACK })
})
