/**
 * Tests for inbound media enrichment: media placeholders are replaced with
 * real image/voice/video/file parts once the bytes are downloaded + stored.
 * Uses injected download/store seams so no Feishu client or DB is touched.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import {
  enrichInboundFeishuMedia,
  planFeishuMediaDownload,
} from "./inbound-media.js"

const account = { id: "a", workspaceId: "ws_1", transportKind: "feishu" } as any

function envelopeWith(parts: CanonicalPart[]): InboundEnvelope {
  return {
    endpointType: "group",
    endpointExternalId: "oc_x",
    externalMessageId: "om_1",
    sender: { externalId: "ou_a" },
    receivedAt: "2026-01-01T00:00:00.000Z" as any,
    message: buildCanonicalMessage(parts),
  }
}

function fakeDeps(
  overrides?: Partial<Parameters<typeof enrichInboundFeishuMedia>[1]>
) {
  const downloads: any[] = []
  const stores: any[] = []
  const warns: any[] = []
  const deps = {
    account,
    logger: {
      debug() {},
      info() {},
      warn: (_m: string, f?: any) => warns.push(f),
      error() {},
    },
    download: async (input: any) => {
      downloads.push(input)
      return { buffer: Buffer.from([1, 2, 3]), mime: undefined }
    },
    store: async (input: any) => {
      stores.push(input)
      return { sha256: `sha_${input.resourceKey}` }
    },
    ...overrides,
  }
  return { deps, downloads, stores, warns }
}

test("planFeishuMediaDownload maps markers to type+key and drops keyless markers", () => {
  assert.deepEqual(
    planFeishuMediaDownload({
      type: "system_marker",
      marker: "image_placeholder",
      original: { image_key: "img_k" },
    })?.resourceType,
    "image"
  )
  assert.equal(
    planFeishuMediaDownload({
      type: "system_marker",
      marker: "file_placeholder",
      original: { file_key: "fk" },
    })?.resourceType,
    "file"
  )
  // No usable resource key → not downloadable.
  assert.equal(
    planFeishuMediaDownload({
      type: "system_marker",
      marker: "image_placeholder",
      original: {},
    }),
    null
  )
})

test("image placeholder becomes an image part with a stored fileRef", async () => {
  const { deps, downloads, stores } = fakeDeps()
  const env = await enrichInboundFeishuMedia(
    envelopeWith([
      { type: "text", text: "看图" },
      {
        type: "system_marker",
        marker: "image_placeholder",
        original: { image_key: "img_k" },
      },
    ]),
    deps
  )
  assert.deepEqual(downloads, [
    { messageId: "om_1", fileKey: "img_k", type: "image" },
  ])
  assert.equal(stores[0].workspaceId, "ws_1")
  const img = env.message.parts.find((p) => p.type === "image")
  assert.ok(img && img.type === "image")
  if (img.type === "image") {
    assert.equal(img.fileRef.sha256, "sha_img_k")
    assert.equal(img.fileRef.mimeType, "image/jpeg") // default when download mime absent
    assert.equal(img.fileRef.sizeBytes, 3)
  }
})

test("file/voice/video placeholders become their respective parts", async () => {
  const { deps } = fakeDeps()
  const env = await enrichInboundFeishuMedia(
    envelopeWith([
      {
        type: "system_marker",
        marker: "file_placeholder",
        original: { file_key: "fk", file_name: "report.pdf" },
      },
      {
        type: "system_marker",
        marker: "voice_placeholder",
        original: { file_key: "vk", duration: 4200 },
      },
      {
        type: "system_marker",
        marker: "video_placeholder",
        original: { file_key: "vd", duration: 8000 },
      },
    ]),
    deps
  )
  const file = env.message.parts.find((p) => p.type === "file")
  assert.ok(file && file.type === "file")
  if (file.type === "file") assert.equal(file.fileRef.name, "report.pdf")
  const voice = env.message.parts.find((p) => p.type === "voice")
  assert.ok(voice && voice.type === "voice")
  if (voice.type === "voice") assert.equal(voice.durationMs, 4200)
  const video = env.message.parts.find((p) => p.type === "video")
  assert.ok(video && video.type === "video")
  if (video.type === "video") assert.equal(video.durationMs, 8000)
})

test("download failure keeps the original placeholder (best-effort)", async () => {
  const { deps, warns } = fakeDeps({
    download: async () => {
      throw new Error("boom")
    },
  })
  const env = await enrichInboundFeishuMedia(
    envelopeWith([
      {
        type: "system_marker",
        marker: "image_placeholder",
        original: { image_key: "img_k" },
      },
    ]),
    deps
  )
  const marker = env.message.parts.find((p) => p.type === "system_marker")
  assert.ok(marker && marker.type === "system_marker")
  assert.equal(warns.length, 1)
})

test("envelope with no media is returned unchanged (no IO)", async () => {
  let called = false
  const original = envelopeWith([{ type: "text", text: "hi" }])
  const env = await enrichInboundFeishuMedia(original, {
    account,
    download: async () => {
      called = true
      return { buffer: Buffer.alloc(0) }
    },
    store: async () => ({ sha256: "x" }),
  })
  assert.equal(env, original, "same reference — nothing rebuilt")
  assert.equal(called, false, "no download attempted")
})
