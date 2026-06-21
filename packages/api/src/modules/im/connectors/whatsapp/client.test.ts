import test from "node:test"
import assert from "node:assert/strict"
import {
  getGraphMediaMetadata,
  graphApiBase,
  sendGraphMessage,
  uploadGraphMedia,
} from "./client.js"

const creds = {
  accessToken: "TOKEN",
  graphApiVersion: "v23.0",
  phoneNumberId: "PNID",
}

interface Captured {
  url: string
  init: RequestInit | undefined
}

function mockFetch(status = 200, body: unknown = { ok: true }) {
  const calls: Captured[] = []
  const fn = (async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

test("graphApiBase: builds the versioned base", () => {
  assert.equal(graphApiBase(creds), "https://graph.facebook.com/v23.0")
})

test("sendGraphMessage: posts to /<PNID>/messages with bearer + messaging_product", async () => {
  const m = mockFetch(200, { messages: [{ id: "wamid.1" }] })
  await sendGraphMessage({
    creds,
    body: { to: "p", type: "text", text: { body: "hi" } },
    fetchImpl: m.fn,
  })
  const call = m.calls[0]!
  assert.equal(call.url, "https://graph.facebook.com/v23.0/PNID/messages")
  assert.equal(call.init?.method, "POST")
  const headers = call.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, "Bearer TOKEN")
  const parsed = JSON.parse(String(call.init?.body))
  assert.equal(parsed.messaging_product, "whatsapp")
  assert.equal(parsed.type, "text")
})

test("getGraphMediaMetadata: GETs /<MEDIA_ID> with bearer", async () => {
  const m = mockFetch(200, { url: "https://lookaside.fbsbx.com/x" })
  await getGraphMediaMetadata({ creds, mediaId: "MID", fetchImpl: m.fn })
  const call = m.calls[0]!
  assert.equal(call.url, "https://graph.facebook.com/v23.0/MID")
  assert.equal(call.init?.method, "GET")
  assert.equal(
    (call.init?.headers as Record<string, string>).Authorization,
    "Bearer TOKEN"
  )
})

test("uploadGraphMedia: posts multipart (no manual Content-Type) with the bytes", async () => {
  const m = mockFetch(200, { id: "media-9" })
  await uploadGraphMedia({
    creds,
    buffer: Buffer.from("abc"),
    mimeType: "image/png",
    filename: "x.png",
    fetchImpl: m.fn,
  })
  const call = m.calls[0]!
  assert.equal(call.url, "https://graph.facebook.com/v23.0/PNID/media")
  assert.equal(call.init?.method, "POST")
  // Must NOT set Content-Type manually (fetch derives the boundary).
  const headers = call.init?.headers as Record<string, string>
  assert.equal(headers["Content-Type"], undefined)
  assert.ok(call.init?.body instanceof FormData)
  const form = call.init?.body as FormData
  assert.equal(form.get("messaging_product"), "whatsapp")
  assert.equal(form.get("type"), "image/png")
  assert.ok(form.get("file") instanceof Blob)
})
