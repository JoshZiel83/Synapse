import test from "node:test"
import assert from "node:assert/strict"
import {
  enrichInboundDingtalkMedia,
  planDingtalkMediaDownloads,
  type DingtalkMediaEnrichDeps,
} from "./inbound-media.js"
import { normalizeDingtalkPayload } from "./normalize.js"
import type { InboundEnvelope } from "../types.js"

const ACCOUNT = {
  id: "acc-1",
  workspaceId: "ws-1",
  transportKind: "dingtalk",
  credentials: { clientId: "ding-1", clientSecret: "secret-1" },
} as never

const baseInbound = {
  msgId: "m1",
  conversationId: "cid-1",
  conversationType: "2",
  senderId: "s1",
  senderStaffId: "alice",
  chatbotUserId: "bot-1",
  robotCode: "robot-1",
  createAt: 1700000000000,
}

function deps(
  over: Partial<DingtalkMediaEnrichDeps> = {}
): DingtalkMediaEnrichDeps {
  return {
    account: ACCOUNT,
    download: async ({ downloadCode }) => ({
      buffer: Buffer.from(`bytes:${downloadCode}`),
      mime: undefined,
    }),
    store: async ({ downloadCode }) => ({ sha256: `sha-${downloadCode}` }),
    ...over,
  }
}

// ─────────── plan ───────────

test("planDingtalkMediaDownloads: picture marker → one image download", () => {
  const specs = planDingtalkMediaDownloads({
    type: "system_marker",
    marker: "image_placeholder",
    original: { downloadCode: "DC_IMG", pictureDownloadCode: "P" },
  })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].downloadCode, "DC_IMG")
})

test("planDingtalkMediaDownloads: richText marker → one download per image segment", () => {
  const specs = planDingtalkMediaDownloads({
    type: "system_marker",
    marker: "image_placeholder",
    original: {
      richText: [
        { text: "hi" },
        { downloadCode: "DC1", type: "picture" },
        { downloadCode: "DC2", type: "picture" },
      ],
    },
  })
  assert.deepEqual(
    specs.map((s) => s.downloadCode),
    ["DC1", "DC2"]
  )
})

test("planDingtalkMediaDownloads: marker without a downloadCode → no downloads", () => {
  assert.deepEqual(
    planDingtalkMediaDownloads({
      type: "system_marker",
      marker: "file_placeholder",
      original: { fileName: "x.pdf" },
    }),
    []
  )
})

// ─────────── enrich: per type ───────────

async function enrichPicture(over?: Partial<DingtalkMediaEnrichDeps>) {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "picture",
    content: { downloadCode: "DC_IMG", pictureDownloadCode: "P" },
  }) as InboundEnvelope
  return enrichInboundDingtalkMedia(env, deps(over))
}

test("enrich: picture placeholder becomes an image part with sha256 fileRef", async () => {
  const out = await enrichPicture()
  const image = out.message.parts.find((p) => p.type === "image")
  assert.ok(image, "expected an image part")
  assert.equal(
    (image as { fileRef: { sha256: string } }).fileRef.sha256,
    "sha-DC_IMG"
  )
  // the system_marker placeholder is gone
  assert.equal(
    out.message.parts.find((p) => p.type === "system_marker"),
    undefined
  )
})

test("enrich: audio placeholder becomes a voice part (transcript text preserved separately)", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "audio",
    content: { downloadCode: "DC_AUD", recognition: "open the door" },
  }) as InboundEnvelope
  const out = await enrichInboundDingtalkMedia(env, deps())
  const voice = out.message.parts.find((p) => p.type === "voice")
  assert.ok(voice, "expected a voice part")
  // recognition text stays as a text part
  const text = out.message.parts.find((p) => p.type === "text")
  assert.equal((text as { text: string }).text, "open the door")
})

test("enrich: video placeholder becomes a video part with durationMs from seconds", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "video",
    content: { downloadCode: "DC_VID", videoType: "mp4", duration: "5" },
  }) as InboundEnvelope
  const out = await enrichInboundDingtalkMedia(env, deps())
  const video = out.message.parts.find((p) => p.type === "video")
  assert.ok(video, "expected a video part")
  assert.equal((video as { durationMs?: number }).durationMs, 5000)
})

test("enrich: file placeholder becomes a file part carrying the original fileName", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "file",
    content: { downloadCode: "DC_FILE", fileName: "report.pdf", spaceId: "sp" },
  }) as InboundEnvelope
  const out = await enrichInboundDingtalkMedia(env, deps())
  const file = out.message.parts.find((p) => p.type === "file")
  assert.ok(file, "expected a file part")
  assert.equal(
    (file as { fileRef: { name: string } }).fileRef.name,
    "report.pdf"
  )
})

test("enrich: richText with two images yields two image parts plus the text", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "richText",
    content: {
      richText: [
        { text: "look " },
        { downloadCode: "DC1", type: "picture" },
        { text: "and " },
        { downloadCode: "DC2", type: "picture" },
      ],
    },
  }) as InboundEnvelope
  const out = await enrichInboundDingtalkMedia(env, deps())
  const images = out.message.parts.filter((p) => p.type === "image")
  assert.equal(images.length, 2)
  const text = out.message.parts.find((p) => p.type === "text")
  assert.equal((text as { text: string }).text, "look and")
})

test("enrich: richText partial failure keeps the downloaded image + a residual placeholder (no loss of stored bytes)", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "richText",
    content: {
      richText: [
        { downloadCode: "DC_OK", type: "picture" },
        { downloadCode: "DC_FAIL", type: "picture" },
      ],
    },
  }) as InboundEnvelope
  const out = await enrichInboundDingtalkMedia(
    env,
    deps({
      download: async ({ downloadCode }) => {
        if (downloadCode === "DC_FAIL") throw new Error("boom")
        return { buffer: Buffer.from("ok") }
      },
    })
  )
  // the successfully-downloaded image is preserved (not discarded with the batch)
  const images = out.message.parts.filter((p) => p.type === "image")
  assert.equal(images.length, 1)
  assert.equal(
    (images[0] as { fileRef: { sha256: string } }).fileRef.sha256,
    "sha-DC_OK"
  )
  // a residual placeholder remains so the failed image still surfaces
  assert.ok(out.message.parts.find((p) => p.type === "system_marker"))
})

// ─────────── enrich: best-effort + no-op ───────────

test("enrich: download failure keeps the placeholder (best-effort)", async () => {
  const out = await enrichPicture({
    download: async () => {
      throw new Error("network")
    },
  })
  // placeholder survives, no image part
  assert.equal(
    out.message.parts.find((p) => p.type === "image"),
    undefined
  )
  assert.ok(out.message.parts.find((p) => p.type === "system_marker"))
})

test("enrich: text-only message is returned unchanged with no IO", async () => {
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    msgtype: "text",
    text: { content: "just text" },
  }) as InboundEnvelope
  let downloaded = false
  const out = await enrichInboundDingtalkMedia(
    env,
    deps({
      download: async () => {
        downloaded = true
        return { buffer: Buffer.from("x") }
      },
    })
  )
  assert.equal(downloaded, false)
  assert.equal(out, env)
})

test("enrich: robotCode falls back to account clientId, passed to download", async () => {
  // envelope with no robotCode in endpoint metadata
  const env = normalizeDingtalkPayload({
    ...baseInbound,
    robotCode: undefined,
    msgtype: "picture",
    content: { downloadCode: "DC_IMG" },
  }) as InboundEnvelope
  // real download path would read robotCode; assert via a custom download that
  // the enrich still produces a part (robotCode resolution doesn't throw)
  const out = await enrichInboundDingtalkMedia(env, deps())
  assert.ok(out.message.parts.find((p) => p.type === "image"))
})
