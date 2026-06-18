import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundSendInput,
} from "../types.js"
import { sendWhatsappMessage, type SendWhatsappDeps } from "./outbound.js"
import type { WhatsappWindowStore } from "./window-store.js"

const account = {
  id: "acct-1",
  workspaceId: "ws",
  credentials: {
    phoneNumberId: "PNID",
    wabaId: "W",
    accessToken: "TOK",
    appSecret: "S",
    appId: "A",
    webhookVerifyToken: "V",
    graphApiVersion: "v23.0",
  },
} as unknown as OutboundSendInput["account"]

function openWindow(within = true): WhatsappWindowStore {
  return {
    recordInbound: async () => {},
    getLastInboundMs: async () => 0,
    isWithin24h: async () => within,
  }
}

function input(message: OutboundSendInput["message"]): OutboundSendInput {
  return {
    account,
    endpoint: {
      endpointType: "direct",
      externalId: "15551230000",
      metadata: {},
    },
    message,
    transportMessageLinkId: "link-1",
    linkMetadata: {},
    attemptNumber: 0,
    patchLinkMetadata: async () => {},
  }
}

function fetchReturning(
  status: number,
  body: unknown
): { fn: typeof fetch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const fn = (async (_url: unknown, init?: RequestInit) => {
    // JSON message-send bodies parse; multipart (FormData) media-upload
    // bodies don't — record an empty marker for those so call indexing stays
    // aligned with the send order.
    let parsed: Record<string, unknown> = {}
    if (init?.body && typeof init.body === "string") {
      try {
        parsed = JSON.parse(init.body)
      } catch {
        parsed = {}
      }
    }
    calls.push(parsed)
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

test("outbound: closed window + free-form text → PermanentTransportError(131047-coded)", async () => {
  const deps: SendWhatsappDeps = {
    windowStore: openWindow(false),
    fetchImpl: fetchReturning(200, {}).fn,
  }
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "hi" }])),
      deps
    ),
    (err: unknown) =>
      err instanceof PermanentTransportError &&
      err.code === "whatsapp_24h_window_closed"
  )
})

test("outbound: open window + text → sends and returns messages[0].id", async () => {
  const f = fetchReturning(200, { messages: [{ id: "wamid.OUT" }] })
  const res = await sendWhatsappMessage(
    input(buildCanonicalMessage([{ type: "text", text: "hi" }])),
    { windowStore: openWindow(true), fetchImpl: f.fn }
  )
  assert.equal(res.externalMessageId, "wamid.OUT")
  assert.equal(f.calls[0]?.type, "text")
})

test("outbound: replyTo attaches context.message_id to the FIRST item only", async () => {
  const calls: Array<Record<string, unknown>> = []
  // Distinguish media-upload (multipart/FormData) from JSON message sends.
  const fn = (async (_url: unknown, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      return new Response(JSON.stringify({ id: "media-1" }), { status: 200 })
    }
    const parsed =
      init?.body && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}
    calls.push(parsed)
    return new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), {
      status: 200,
    })
  }) as unknown as typeof fetch

  const baseInput = input(
    buildCanonicalMessage([
      { type: "text", text: "one" },
      { type: "image", fileRef: { sha256: "img" } },
    ])
  )
  await sendWhatsappMessage(
    {
      ...baseInput,
      replyTo: { externalMessageId: "wamid.PARENT", endpointExternalId: "p" },
    },
    {
      windowStore: openWindow(true),
      fetchImpl: fn,
      readBytes: async () => Buffer.from("imgbytes"),
    }
  )
  const textSend = calls.find((c) => c.type === "text")
  const imageSend = calls.find((c) => c.type === "image")
  assert.deepEqual(textSend?.context, { message_id: "wamid.PARENT" })
  assert.equal(imageSend?.context, undefined)
})

test("outbound: reaction → type:reaction body (no upload)", async () => {
  const f = fetchReturning(200, { messages: [{ id: "wamid.R" }] })
  await sendWhatsappMessage(
    input(
      buildCanonicalMessage([
        {
          type: "reaction",
          emoji: "👍",
          target: { externalMessageId: "wamid.P" },
        },
      ])
    ),
    { windowStore: openWindow(true), fetchImpl: f.fn }
  )
  assert.equal(f.calls[0]?.type, "reaction")
  assert.deepEqual(f.calls[0]?.reaction, {
    message_id: "wamid.P",
    emoji: "👍",
  })
})

test("outbound: voice media is transcoded + uploaded with voice flag", async () => {
  // First fetch = media upload (returns id); second = the audio message send.
  let n = 0
  const fn = (async (_url: unknown, init?: RequestInit) => {
    n += 1
    if (n === 1) {
      // upload (multipart) → media id
      return new Response(JSON.stringify({ id: "media-1" }), { status: 200 })
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.A" }] }), {
      status: 200,
    })
  }) as unknown as typeof fetch

  let transcoded = false
  const res = await sendWhatsappMessage(
    input(
      buildCanonicalMessage([{ type: "voice", fileRef: { sha256: "aud" } }])
    ),
    {
      windowStore: openWindow(true),
      fetchImpl: fn,
      readBytes: async () => Buffer.from("rawaudio"),
      transcodeVoice: async (b) => {
        transcoded = true
        return b
      },
    }
  )
  assert.equal(transcoded, true)
  assert.equal(res.externalMessageId, "wamid.A")
})

test("outbound: retryable error code 130429 → RetryableTransportError", async () => {
  const f = fetchReturning(400, { error: { code: 130429, message: "rate" } })
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "x" }])),
      { windowStore: openWindow(true), fetchImpl: f.fn }
    ),
    RetryableTransportError
  )
})

test("outbound: permanent error code 131026 → PermanentTransportError(coded)", async () => {
  const f = fetchReturning(400, {
    error: { code: 131026, message: "undeliverable" },
  })
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "x" }])),
      { windowStore: openWindow(true), fetchImpl: f.fn }
    ),
    (err: unknown) =>
      err instanceof PermanentTransportError && err.code === "whatsapp_131026"
  )
})

test("outbound: template error 132xxx → permanent (prefix match)", async () => {
  const f = fetchReturning(400, { error: { code: 132012, message: "tpl" } })
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "x" }])),
      { windowStore: openWindow(true), fetchImpl: f.fn }
    ),
    PermanentTransportError
  )
})

test("outbound: 5xx → retryable", async () => {
  const f = fetchReturning(503, { error: { code: 999999 } })
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "x" }])),
      { windowStore: openWindow(true), fetchImpl: f.fn }
    ),
    RetryableTransportError
  )
})

test("outbound: empty (all-unsupported) message → permanent no-op", async () => {
  await assert.rejects(
    sendWhatsappMessage(input(buildCanonicalMessage([])), {
      windowStore: openWindow(true),
      fetchImpl: fetchReturning(200, {}).fn,
    }),
    (err: unknown) =>
      err instanceof PermanentTransportError &&
      err.code === "whatsapp_empty_message"
  )
})
