/**
 * Tests for weixin inbound media enrichment: image/file/video placeholders are
 * replaced with real parts once the bytes are downloaded + decrypted + stored.
 * Uses injected download/store seams so no CDN or DB is touched.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import {
  enrichInboundWeixinMedia,
  planWeixinMediaDownload,
} from "./inbound-media.js"

const account = { id: "a", workspaceId: "ws_1", transportKind: "weixin" } as any

function envelopeWith(parts: CanonicalPart[]): InboundEnvelope {
  return {
    endpointType: "direct",
    endpointExternalId: "user_1",
    externalMessageId: "msg_1",
    sender: { externalId: "user_1" },
    receivedAt: "2026-01-01T00:00:00.000Z" as any,
    message: buildCanonicalMessage(parts),
  }
}

function fakeDeps(
  overrides?: Partial<Parameters<typeof enrichInboundWeixinMedia>[1]>
) {
  const downloads: any[] = []
  const stores: any[] = []
  const warns: any[] = []
  const deps = {
    account,
    cdnBaseUrl: "https://cdn.example",
    logger: {
      debug() {},
      info() {},
      warn: (_m: string, f?: any) => warns.push(f),
      error() {},
    },
    download: async (plan: any) => {
      downloads.push(plan)
      return Buffer.from([1, 2, 3])
    },
    store: async (input: any) => {
      stores.push(input)
      return { sha256: `sha_${input.resourceKey}` }
    },
    ...overrides,
  }
  return { deps, downloads, stores, warns }
}

test("planWeixinMediaDownload requires a CDN ref and (file/video) an aes key", () => {
  assert.ok(
    planWeixinMediaDownload({
      type: "system_marker",
      marker: "image_placeholder",
      original: { encrypt_query_param: "eqp", aes_key: "k" },
    })
  )
  // images may be unencrypted (no aes key) but still need a CDN ref
  assert.ok(
    planWeixinMediaDownload({
      type: "system_marker",
      marker: "image_placeholder",
      original: { full_url: "https://x/y" },
    })
  )
  // no CDN ref → not downloadable
  assert.equal(
    planWeixinMediaDownload({
      type: "system_marker",
      marker: "image_placeholder",
      original: {},
    }),
    null
  )
  // file without an aes key → not downloadable (always encrypted)
  assert.equal(
    planWeixinMediaDownload({
      type: "system_marker",
      marker: "file_placeholder",
      original: { encrypt_query_param: "eqp" },
    }),
    null
  )
})

test("image placeholder becomes an image part with a stored fileRef", async () => {
  const { deps, downloads, stores } = fakeDeps()
  const env = await enrichInboundWeixinMedia(
    envelopeWith([
      { type: "text", text: "看图" },
      {
        type: "system_marker",
        marker: "image_placeholder",
        original: { encrypt_query_param: "eqp_img", aes_key: "k" },
      },
    ]),
    deps
  )
  assert.equal(downloads.length, 1)
  assert.equal(stores[0].workspaceId, "ws_1")
  const img = env.message.parts.find((p) => p.type === "image")
  assert.ok(img && img.type === "image")
  if (img.type === "image") {
    assert.equal(img.fileRef.sha256, "sha_eqp_img")
    assert.equal(img.fileRef.mimeType, "image/jpeg")
    assert.equal(img.fileRef.sizeBytes, 3)
  }
})

test("file + video placeholders become their parts; file keeps its name/mime", async () => {
  const { deps } = fakeDeps()
  const env = await enrichInboundWeixinMedia(
    envelopeWith([
      {
        type: "system_marker",
        marker: "file_placeholder",
        original: {
          encrypt_query_param: "fk",
          aes_key: "k",
          file_name: "report.pdf",
        },
      },
      {
        type: "system_marker",
        marker: "video_placeholder",
        original: { encrypt_query_param: "vd", aes_key: "k" },
      },
    ]),
    deps
  )
  const file = env.message.parts.find((p) => p.type === "file")
  assert.ok(file && file.type === "file")
  if (file.type === "file") {
    assert.equal(file.fileRef.name, "report.pdf")
    assert.equal(file.fileRef.mimeType, "application/pdf")
  }
  const video = env.message.parts.find((p) => p.type === "video")
  assert.ok(video && video.type === "video")
})

test("download failure keeps the original placeholder (best-effort)", async () => {
  const { deps, warns } = fakeDeps({
    download: async () => {
      throw new Error("boom")
    },
  })
  const env = await enrichInboundWeixinMedia(
    envelopeWith([
      {
        type: "system_marker",
        marker: "image_placeholder",
        original: { encrypt_query_param: "eqp", aes_key: "k" },
      },
    ]),
    deps
  )
  const marker = env.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(warns.length, 1)
})

test("envelope with no downloadable media is returned unchanged (no IO)", async () => {
  let called = false
  const original = envelopeWith([
    { type: "text", text: "hi" },
    // voice placeholder has no CDN ref — not downloadable (STT text only)
    { type: "system_marker", marker: "voice_placeholder" },
  ])
  const env = await enrichInboundWeixinMedia(original, {
    account,
    cdnBaseUrl: "",
    download: async () => {
      called = true
      return Buffer.alloc(0)
    },
    store: async () => ({ sha256: "x" }),
  })
  assert.equal(env, original, "same reference — nothing rebuilt")
  assert.equal(called, false, "no download attempted")
})
