import test from "node:test"
import assert from "node:assert/strict"
import { enrichInboundQqMedia } from "./inbound-media.js"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"

function envelopeWith(parts: CanonicalPart[]): InboundEnvelope {
  return {
    endpointType: "direct",
    endpointExternalId: "c2c:U",
    externalMessageId: "MSG1",
    sender: { externalId: "c2c:U" },
    receivedAt: "2026-01-01T00:00:00.000Z" as InboundEnvelope["receivedAt"],
    message: buildCanonicalMessage(parts),
  }
}

const account = { workspaceId: "ws-1" }

test("enrichInboundQqMedia: no media → unchanged, no download", async () => {
  let downloaded = 0
  const env = envelopeWith([{ type: "text", text: "hi" }])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async () => {
      downloaded++
      return { buffer: Buffer.from(""), mime: "x" }
    },
    store: async () => ({ sha256: "s" }),
  })
  assert.equal(out, env)
  assert.equal(downloaded, 0)
})

test("enrichInboundQqMedia: image placeholder → image part with sha256 (scheme prepended)", async () => {
  let seenUrl = ""
  let seenStore:
    | { workspaceId: string; mimeType: string; originalName: string }
    | undefined
  const env = envelopeWith([
    { type: "text", text: "look" },
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: {
        url: "multimedia.nt.qq.com.cn/x",
        content_type: "image/png",
        filename: "p.png",
        width: 10,
        height: 20,
      },
    },
  ])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async (i) => {
      seenUrl = i.url
      return { buffer: Buffer.from("abc"), mime: "image/png" }
    },
    store: async (i) => {
      seenStore = i
      return { sha256: "deadbeef" }
    },
  })
  assert.equal(seenUrl, "https://multimedia.nt.qq.com.cn/x")
  assert.equal(seenStore?.workspaceId, "ws-1")
  assert.equal(seenStore?.mimeType, "image/png")
  const parts = out.message.parts
  assert.equal(parts.length, 2)
  assert.equal(parts[0]!.type, "text")
  const img = parts[1]!
  assert.equal(img.type, "image")
  if (img.type === "image") {
    assert.equal(img.fileRef.sha256, "deadbeef")
    assert.equal(img.fileRef.mimeType, "image/png")
    assert.equal(img.fileRef.name, "p.png")
    assert.equal(img.fileRef.sizeBytes, 3)
    assert.equal(img.fileRef.width, 10)
    assert.equal(img.fileRef.height, 20)
  }
})

test("enrichInboundQqMedia: generic CDN mime falls back to attachment content_type", async () => {
  const env = envelopeWith([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: {
        url: "https://multimedia.nt.qq.com.cn/y",
        content_type: "image/jpeg",
      },
    },
  ])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async () => ({
      buffer: Buffer.from("x"),
      mime: "application/octet-stream",
    }),
    store: async (i) => ({
      sha256: i.mimeType === "image/jpeg" ? "ok" : "bad",
    }),
  })
  const img = out.message.parts[0]!
  assert.equal(img.type, "image")
  if (img.type === "image") assert.equal(img.fileRef.sha256, "ok")
})

test("enrichInboundQqMedia: download failure → keeps placeholder (unchanged)", async () => {
  const env = envelopeWith([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: { url: "https://multimedia.nt.qq.com.cn/x" },
    },
  ])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async () => {
      throw new Error("boom")
    },
    store: async () => ({ sha256: "s" }),
  })
  // No successful change → same envelope reference, placeholder retained.
  assert.equal(out, env)
  assert.equal(out.message.parts[0]!.type, "system_marker")
})

test("enrichInboundQqMedia: voice prefers voice_wav_url + captures asr_refer_text transcript", async () => {
  let seenUrl = ""
  const env = envelopeWith([
    {
      type: "system_marker",
      marker: "voice_placeholder",
      original: {
        url: "https://multimedia.nt.qq.com.cn/silk",
        voice_wav_url: "multimedia.nt.qq.com.cn/wav",
        asr_refer_text: "你好世界",
      },
    },
  ])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async (i) => {
      seenUrl = i.url
      return { buffer: Buffer.from("x"), mime: "audio/wav" }
    },
    store: async () => ({ sha256: "v" }),
  })
  // WAV preferred over the raw SILK url; schemeless wav url gets https://.
  assert.equal(seenUrl, "https://multimedia.nt.qq.com.cn/wav")
  const part = out.message.parts[0]!
  assert.equal(part.type, "voice")
  if (part.type === "voice") {
    assert.equal(part.fileRef.sha256, "v")
    assert.equal(part.transcript, "你好世界")
  }
})

test("enrichInboundQqMedia: voice/video/file markers map to their parts", async () => {
  const env = envelopeWith([
    {
      type: "system_marker",
      marker: "voice_placeholder",
      original: { url: "https://multimedia.nt.qq.com.cn/v" },
    },
    {
      type: "system_marker",
      marker: "video_placeholder",
      original: { url: "https://multimedia.nt.qq.com.cn/m" },
    },
    {
      type: "system_marker",
      marker: "file_placeholder",
      original: {
        url: "https://multimedia.nt.qq.com.cn/f",
        filename: "doc.pdf",
      },
    },
  ])
  const out = await enrichInboundQqMedia(env, {
    account,
    download: async () => ({ buffer: Buffer.from("x"), mime: undefined }),
    store: async () => ({ sha256: "h" }),
  })
  assert.deepEqual(
    out.message.parts.map((p) => p.type),
    ["voice", "video", "file"]
  )
  const file = out.message.parts[2]!
  if (file.type === "file") assert.equal(file.fileRef.name, "doc.pdf")
})
