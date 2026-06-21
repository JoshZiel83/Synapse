import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import { PermanentTransportError } from "../types.js"
import type { InboundEnvelope } from "../types.js"
import {
  enrichInboundWhatsappMedia,
  planWhatsappMediaDownload,
  uploadWhatsappMediaBytes,
} from "./media.js"

const creds = { accessToken: "TOK", graphApiVersion: "v23.0" }

function envelopeWith(
  marker:
    | "image_placeholder"
    | "voice_placeholder"
    | "video_placeholder"
    | "file_placeholder",
  original: Record<string, unknown>
): InboundEnvelope {
  return {
    endpointType: "direct",
    endpointExternalId: "p",
    externalMessageId: "wamid.X",
    sender: { externalId: "p" },
    receivedAt: "2023-11-14T22:13:20.000Z" as never,
    message: buildCanonicalMessage([
      { type: "system_marker", marker, original },
    ]),
  }
}

test("planWhatsappMediaDownload: maps each placeholder to a category + part builder", () => {
  const img = planWhatsappMediaDownload({
    type: "system_marker",
    marker: "image_placeholder",
    original: { media_id: "m1", mime_type: "image/png" },
  })
  assert.equal(img?.category, "image")
  assert.equal(img?.mediaId, "m1")

  const none = planWhatsappMediaDownload({
    type: "system_marker",
    marker: "image_placeholder",
    original: {},
  })
  assert.equal(none, null)
})

test("enrich: replaces placeholder with a real part via injected download+store", async () => {
  const env = envelopeWith("image_placeholder", {
    media_id: "m1",
    mime_type: "image/jpeg",
  })
  let downloadedId = ""
  const enriched = await enrichInboundWhatsappMedia(env, {
    account: { workspaceId: "ws" },
    creds,
    download: async ({ mediaId }) => {
      downloadedId = mediaId
      return { buffer: Buffer.from("bytes"), mime: "image/jpeg" }
    },
    store: async () => ({ sha256: "SHA256" }),
  })
  assert.equal(downloadedId, "m1")
  const part = enriched.message.parts[0]
  assert.equal(part?.type, "image")
  assert.equal(
    (part as { fileRef: { sha256: string } }).fileRef.sha256,
    "SHA256"
  )
})

test("enrich: download failure keeps the placeholder (best-effort)", async () => {
  const env = envelopeWith("file_placeholder", {
    media_id: "m9",
    filename: "x.pdf",
  })
  const enriched = await enrichInboundWhatsappMedia(env, {
    account: { workspaceId: "ws" },
    creds,
    download: async () => {
      throw new Error("boom")
    },
    store: async () => ({ sha256: "X" }),
  })
  const part = enriched.message.parts[0]
  assert.equal(part?.type, "system_marker")
})

test("enrich: no media → returns envelope unchanged (no IO)", async () => {
  const env: InboundEnvelope = {
    endpointType: "direct",
    endpointExternalId: "p",
    externalMessageId: "wamid.X",
    sender: { externalId: "p" },
    receivedAt: "2023-11-14T22:13:20.000Z" as never,
    message: buildCanonicalMessage([{ type: "text", text: "hi" }]),
  }
  let called = false
  const out = await enrichInboundWhatsappMedia(env, {
    account: { workspaceId: "ws" },
    creds,
    download: async () => {
      called = true
      return { buffer: Buffer.from(""), mime: "x" }
    },
    store: async () => ({ sha256: "X" }),
  })
  assert.equal(called, false)
  assert.equal(out, env)
})

test("uploadWhatsappMediaBytes: rejects oversize with PermanentTransportError", async () => {
  // image cap is 5 MB; 6 MB buffer must reject BEFORE any fetch.
  let fetched = false
  await assert.rejects(
    uploadWhatsappMediaBytes({
      creds: { ...creds, phoneNumberId: "PNID" },
      buffer: Buffer.alloc(6 * 1024 * 1024),
      mimeType: "image/png",
      category: "image",
      fetchImpl: (async () => {
        fetched = true
        return new Response("{}")
      }) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof PermanentTransportError &&
      err.code === "whatsapp_media_too_large"
  )
  assert.equal(fetched, false)
})

test("uploadWhatsappMediaBytes: returns the media id on success", async () => {
  const res = await uploadWhatsappMediaBytes({
    creds: { ...creds, phoneNumberId: "PNID" },
    buffer: Buffer.from("small"),
    mimeType: "image/png",
    category: "image",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ id: "media-77" }), {
        status: 200,
      })) as unknown as typeof fetch,
  })
  assert.equal(res.mediaId, "media-77")
})

test("uploadWhatsappMediaBytes: HTTP error surfaces as a (retryable-by-caller) Error", async () => {
  await assert.rejects(
    uploadWhatsappMediaBytes({
      creds: { ...creds, phoneNumberId: "PNID" },
      buffer: Buffer.from("x"),
      mimeType: "image/png",
      category: "image",
      fetchImpl: (async () =>
        new Response("server boom", {
          status: 500,
        })) as unknown as typeof fetch,
    }),
    /HTTP 500/
  )
})
