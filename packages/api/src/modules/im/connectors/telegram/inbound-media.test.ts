import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import {
  enrichInboundTelegramMedia,
  planTelegramMediaDownload,
} from "./inbound-media.js"

function envWith(
  part: Parameters<typeof buildCanonicalMessage>[0]
): InboundEnvelope {
  return {
    endpointType: "direct",
    endpointExternalId: "555",
    externalMessageId: "100",
    receivedAt: "2023-11-14T22:13:20.000Z" as InboundEnvelope["receivedAt"],
    sender: { externalId: "777" },
    message: buildCanonicalMessage(part),
  }
}

test("planTelegramMediaDownload: image placeholder => plan", () => {
  const plan = planTelegramMediaDownload({
    type: "system_marker",
    marker: "image_placeholder",
    original: {
      file_id: "fid",
      file_unique_id: "uid",
      mime: "image/png",
      width: 100,
      height: 50,
    },
  })
  assert.ok(plan)
  assert.equal(plan!.fileId, "fid")
  assert.equal(plan!.fileUniqueId, "uid")
  assert.equal(plan!.width, 100)
})

test("planTelegramMediaDownload: animated sticker skipped", () => {
  const plan = planTelegramMediaDownload({
    type: "system_marker",
    marker: "image_placeholder",
    original: { file_id: "f", file_unique_id: "u", is_animated: true },
  })
  assert.equal(plan, null)
})

test("planTelegramMediaDownload: no file_id => null", () => {
  const plan = planTelegramMediaDownload({
    type: "system_marker",
    marker: "image_placeholder",
    original: {},
  })
  assert.equal(plan, null)
})

test("enrichInboundTelegramMedia: replaces placeholder with image part", async () => {
  const env = envWith([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: { file_id: "fid", file_unique_id: "uid", mime: "image/png" },
    },
  ])
  const out = await enrichInboundTelegramMedia(env, {
    account: { workspaceId: "ws", credentials: { botToken: "t" } },
    download: async ({ fileId }) => {
      assert.equal(fileId, "fid")
      return { buffer: Buffer.from("PNGDATA"), mime: "image/png" }
    },
    store: async ({ resourceKey, mimeType }) => {
      assert.equal(resourceKey, "uid") // file_unique_id is the dedup key
      assert.equal(mimeType, "image/png")
      return { sha256: "abc123" }
    },
  })
  const img = out.message.parts.find((p) => p.type === "image")
  assert.ok(img && img.type === "image")
  assert.equal(img.fileRef.sha256, "abc123")
  assert.equal(img.fileRef.sizeBytes, 7)
})

test("enrichInboundTelegramMedia: voice carries durationMs (sec*1000)", async () => {
  const env = envWith([
    {
      type: "system_marker",
      marker: "voice_placeholder",
      original: {
        file_id: "v",
        file_unique_id: "uv",
        mime: "audio/ogg",
        duration: 6,
      },
    },
  ])
  const out = await enrichInboundTelegramMedia(env, {
    account: { workspaceId: "ws", credentials: { botToken: "t" } },
    download: async () => ({ buffer: Buffer.from("OGG"), mime: "audio/ogg" }),
    store: async () => ({ sha256: "v-sha" }),
  })
  const voice = out.message.parts.find((p) => p.type === "voice")
  assert.ok(voice && voice.type === "voice")
  assert.equal(voice.durationMs, 6000)
})

test("enrichInboundTelegramMedia: download failure keeps placeholder", async () => {
  const env = envWith([
    {
      type: "system_marker",
      marker: "file_placeholder",
      original: { file_id: "d", file_unique_id: "ud", name: "x.bin" },
    },
  ])
  const out = await enrichInboundTelegramMedia(env, {
    account: { workspaceId: "ws", credentials: { botToken: "t" } },
    download: async () => {
      throw new Error("boom")
    },
    store: async () => ({ sha256: "never" }),
  })
  // Placeholder retained, no real file part.
  assert.ok(out.message.parts.some((p) => p.type === "system_marker"))
  assert.ok(!out.message.parts.some((p) => p.type === "file"))
})

test("enrichInboundTelegramMedia: no media => returns same envelope (no IO)", async () => {
  const env = envWith([{ type: "text", text: "hi" }])
  let downloaded = false
  const out = await enrichInboundTelegramMedia(env, {
    account: { workspaceId: "ws", credentials: { botToken: "t" } },
    download: async () => {
      downloaded = true
      return { buffer: Buffer.from(""), mime: "x" }
    },
  })
  assert.equal(downloaded, false)
  assert.equal(out, env)
})
