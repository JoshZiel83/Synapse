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

test("outbound (WC-2): absent window key (lost/expired write) → RetryableTransportError, not permanent drop", async () => {
  // getLastInboundMs === null models a window key that was never written or
  // expired (recordInbound is best-effort). OLD code mapped this to
  // PermanentTransportError(131047) → BullMQ never retries → a valid reply is
  // dropped forever. It must now be retryable so Meta's real 131047 is
  // authoritative.
  const absentWindow: WhatsappWindowStore = {
    recordInbound: async () => {},
    getLastInboundMs: async () => null,
    isWithin24h: async () => false,
  }
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "hi" }])),
      { windowStore: absentWindow, fetchImpl: fetchReturning(200, {}).fn }
    ),
    (err: unknown) => err instanceof RetryableTransportError
  )
})

test("outbound (WC-2): present-but-elapsed window key → still PermanentTransportError(131047)", async () => {
  // A present key (getLastInboundMs returns a number) with isWithin24h false is
  // a GENUINELY closed window — Meta would reject it too, so it stays permanent.
  const closedWindow: WhatsappWindowStore = {
    recordInbound: async () => {},
    getLastInboundMs: async () => 1_700_000_000_000,
    isWithin24h: async () => false,
  }
  await assert.rejects(
    sendWhatsappMessage(
      input(buildCanonicalMessage([{ type: "text", text: "hi" }])),
      { windowStore: closedWindow, fetchImpl: fetchReturning(200, {}).fn }
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

// ── WC-1: multi-item idempotency across BullMQ retries ──

/**
 * Deep-merge a JSON patch into a metadata object, mirroring the worker's
 * patchLinkMetadata semantics closely enough for the idempotency contract
 * (recursive object merge; scalars/arrays overwrite).
 */
function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k]
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      target[k] = v
    }
  }
  return target
}

function statefulInput(message: OutboundSendInput["message"]): {
  base: OutboundSendInput
  metadata: Record<string, unknown>
} {
  const metadata: Record<string, unknown> = {}
  const base: OutboundSendInput = {
    account,
    endpoint: {
      endpointType: "direct",
      externalId: "15551230000",
      metadata: {},
    },
    message,
    transportMessageLinkId: "link-1",
    linkMetadata: metadata,
    attemptNumber: 0,
    patchLinkMetadata: async (patch) => {
      deepMerge(metadata, patch)
    },
  }
  return { base, metadata }
}

test("outbound (WC-1): a mid-batch failure does not re-send earlier items on retry", async () => {
  // Two items: a text send (item 0) + an image send (item 1). The image's
  // message-send fails with a retryable 130429 on attempt 0; the retry
  // (attempt 1) must NOT re-POST the text item.
  const textSends: string[] = []
  let failImageOnce = true
  const fn = (async (_url: unknown, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      // media upload (multipart) → media id
      return new Response(JSON.stringify({ id: "media-1" }), { status: 200 })
    }
    const parsed =
      init?.body && typeof init.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {}
    if (parsed.type === "text") {
      textSends.push(String((parsed.text as { body?: string })?.body))
      return new Response(JSON.stringify({ messages: [{ id: "wamid.T" }] }), {
        status: 200,
      })
    }
    if (parsed.type === "image") {
      if (failImageOnce) {
        failImageOnce = false
        return new Response(
          JSON.stringify({ error: { code: 130429, message: "rate" } }),
          { status: 400 }
        )
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.I" }] }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), {
      status: 200,
    })
  }) as unknown as typeof fetch

  const { base } = statefulInput(
    buildCanonicalMessage([
      { type: "text", text: "hello" },
      { type: "image", fileRef: { sha256: "img" } },
    ])
  )
  const deps: SendWhatsappDeps = {
    windowStore: openWindow(true),
    fetchImpl: fn,
    readBytes: async () => Buffer.from("imgbytes"),
  }

  // Attempt 0: text sends, image fails retryably.
  await assert.rejects(sendWhatsappMessage(base, deps), RetryableTransportError)
  assert.equal(textSends.length, 1, "text sent once on attempt 0")

  // Attempt 1 (retry): same link metadata, attemptNumber bumped. The text
  // item is already checkpointed, so it must NOT be re-sent; only the image.
  const res = await sendWhatsappMessage({ ...base, attemptNumber: 1 }, deps)
  assert.equal(
    textSends.length,
    1,
    "text NOT re-sent on retry (idempotent) — OLD code would re-POST it"
  )
  // The first item's wamid is recovered from metadata and returned.
  assert.equal(res.externalMessageId, "wamid.T")
})

test("outbound (WC-1): checkpoints each sent item under metadata.whatsapp.items", async () => {
  const f = fetchReturning(200, { messages: [{ id: "wamid.OUT" }] })
  const { base, metadata } = statefulInput(
    buildCanonicalMessage([{ type: "text", text: "hi" }])
  )
  await sendWhatsappMessage(base, {
    windowStore: openWindow(true),
    fetchImpl: f.fn,
  })
  const wa = metadata.whatsapp as Record<string, unknown> | undefined
  const items = wa?.items as Record<string, unknown> | undefined
  const item0 = items?.["0"] as Record<string, unknown> | undefined
  assert.equal(item0?.sent, true)
  assert.equal(item0?.wamid, "wamid.OUT")
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
