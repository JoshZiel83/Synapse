import test from "node:test"
import assert from "node:assert/strict"
import { buildCanonicalMessage } from "../../messaging/canonical-message.js"
import type { ConnectorLogger } from "../types.js"
import { PermanentTransportError } from "../types.js"
import {
  buildOutboundContent,
  enrichInboundWhatsappMedia,
  mapMediaKindWithMimeFallback,
  WHATSAPP_UNOFFICIAL_INBOUND_SIZE_LIMITS,
} from "./media.js"

const noopLogger: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

test("mapMediaKindWithMimeFallback: audio-typed document → voice", () => {
  assert.equal(mapMediaKindWithMimeFallback("document", "audio/ogg"), "voice")
  assert.equal(
    mapMediaKindWithMimeFallback("document", "application/pdf"),
    "file"
  )
  assert.equal(mapMediaKindWithMimeFallback("audio", "audio/ogg"), "voice")
  assert.equal(mapMediaKindWithMimeFallback("image", "image/jpeg"), "image")
  assert.equal(mapMediaKindWithMimeFallback("sticker", "image/webp"), "image")
  assert.equal(mapMediaKindWithMimeFallback("video", "video/mp4"), "video")
})

test("enrich downloads + stores, rewriting placeholder into a real image part", async () => {
  const message = buildCanonicalMessage([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: { kind: "image", mimetype: "image/jpeg", fileName: "pic.jpg" },
    },
  ])
  const out = await enrichInboundWhatsappMedia(
    message,
    [{ partIndex: 0, kind: "image" }],
    {
      raw: {} as never,
      workspaceId: "ws1",
      messageId: "M1",
      download: async () => Buffer.from("imgbytes"),
      store: async (input) => {
        assert.equal(input.workspaceId, "ws1")
        assert.equal(input.mimeType, "image/jpeg")
        assert.equal(input.originalName, "pic.jpg")
        return { sha256: "sha-img" }
      },
      logger: noopLogger,
    }
  )
  const part = out.parts[0]
  assert.ok(part.type === "image")
  assert.equal(part.fileRef.sha256, "sha-img")
  assert.equal(part.fileRef.sizeBytes, Buffer.from("imgbytes").length)
})

test("enrich keeps the placeholder on download failure (no silent drop)", async () => {
  const message = buildCanonicalMessage([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: { kind: "image" },
    },
  ])
  const out = await enrichInboundWhatsappMedia(
    message,
    [{ partIndex: 0, kind: "image" }],
    {
      raw: {} as never,
      workspaceId: "ws1",
      messageId: "M1",
      download: async () => {
        throw new Error("bad decrypt")
      },
      logger: noopLogger,
    }
  )
  assert.equal(out.parts[0].type, "system_marker")
})

test("enrich maps an audio-typed document to a voice part (Bad-decrypt fallback)", async () => {
  const message = buildCanonicalMessage([
    {
      type: "system_marker",
      marker: "file_placeholder",
      original: {
        kind: "document",
        mimetype: "audio/ogg; codecs=opus",
        seconds: 5,
      },
    },
  ])
  const out = await enrichInboundWhatsappMedia(
    message,
    [{ partIndex: 0, kind: "document" }],
    {
      raw: {} as never,
      workspaceId: "ws1",
      messageId: "M2",
      download: async () => Buffer.from("oggbytes"),
      store: async () => ({ sha256: "sha-voice" }),
      logger: noopLogger,
    }
  )
  const part = out.parts[0]
  assert.ok(part.type === "voice")
  assert.equal(part.durationMs, 5000)
})

test("enrich SKIPS download when declared fileLength exceeds the per-kind cap (WU-6)", async () => {
  const tooBig = WHATSAPP_UNOFFICIAL_INBOUND_SIZE_LIMITS.video + 1
  const message = buildCanonicalMessage([
    {
      type: "system_marker",
      marker: "video_placeholder",
      original: { kind: "video", mimetype: "video/mp4", fileLength: tooBig },
    },
  ])
  let downloaded = false
  const out = await enrichInboundWhatsappMedia(
    message,
    [{ partIndex: 0, kind: "video" }],
    {
      raw: {} as never,
      workspaceId: "ws1",
      messageId: "M-big",
      download: async () => {
        downloaded = true
        return Buffer.from("x")
      },
      store: async () => ({ sha256: "should-not-happen" }),
      logger: noopLogger,
    }
  )
  assert.equal(downloaded, false, "oversized media must NOT be downloaded")
  assert.equal(out.parts[0].type, "system_marker", "placeholder is kept")
})

test("enrich downloads when declared fileLength is within the cap", async () => {
  const message = buildCanonicalMessage([
    {
      type: "system_marker",
      marker: "image_placeholder",
      original: { kind: "image", mimetype: "image/jpeg", fileLength: 1024 },
    },
  ])
  const out = await enrichInboundWhatsappMedia(
    message,
    [{ partIndex: 0, kind: "image" }],
    {
      raw: {} as never,
      workspaceId: "ws1",
      messageId: "M-ok",
      download: async () => Buffer.from("img"),
      store: async () => ({ sha256: "sha-ok" }),
      logger: noopLogger,
    }
  )
  assert.equal(out.parts[0].type, "image")
})

test("outbound: media part with NO sha256 throws PermanentTransportError (WU-7)", async () => {
  const msg = buildCanonicalMessage([
    // sha256 omitted: a media part that lost its bytes must fail loudly.
    { type: "image", fileRef: { mimeType: "image/png" } as never },
  ])
  await assert.rejects(
    () =>
      buildOutboundContent(msg, {
        readContent: async () => Buffer.from("nope"),
        transcodeVoice: async (b) => b,
        logger: noopLogger,
      }),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      return true
    }
  )
})

test("outbound: a voice transcode failure is PERMANENT, not retryable (WU-8)", async () => {
  const msg = buildCanonicalMessage([
    { type: "voice", fileRef: { sha256: "sha-v" } },
  ])
  await assert.rejects(
    () =>
      buildOutboundContent(msg, {
        readContent: async () => Buffer.from("raw-audio"),
        transcodeVoice: async () => {
          throw new Error("ffmpeg not found")
        },
        logger: noopLogger,
      }),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      return true
    }
  )
})

test("outbound: plain text → { text }", async () => {
  const msg = buildCanonicalMessage([{ type: "text", text: "hi" }])
  const build = await buildOutboundContent(msg, {
    readContent: async () => Buffer.from(""),
    transcodeVoice: async (b) => b,
    logger: noopLogger,
  })
  assert.deepEqual(build.content, { text: "hi" })
  assert.equal(build.mentionedJid.length, 0)
})

test("outbound: image part → { image, caption } with bytes from CAS", async () => {
  const msg = buildCanonicalMessage([
    { type: "image", fileRef: { sha256: "sha-1", mimeType: "image/png" } },
    { type: "text", text: "caption!" },
  ])
  const build = await buildOutboundContent(msg, {
    readContent: async (sha) => {
      assert.equal(sha, "sha-1")
      return Buffer.from("bytes")
    },
    transcodeVoice: async (b) => b,
    logger: noopLogger,
  })
  const c = build.content as Record<string, unknown>
  assert.ok(Buffer.isBuffer(c.image))
  assert.equal(c.caption, "caption!")
})

test("outbound: voice part → transcoded ogg/opus ptt", async () => {
  const msg = buildCanonicalMessage([
    { type: "voice", fileRef: { sha256: "sha-v" } },
  ])
  let transcoded = false
  const build = await buildOutboundContent(msg, {
    readContent: async () => Buffer.from("raw-audio"),
    transcodeVoice: async (b) => {
      transcoded = true
      return Buffer.concat([b, Buffer.from("-opus")])
    },
    logger: noopLogger,
  })
  assert.ok(transcoded)
  const c = build.content as Record<string, unknown>
  assert.equal(c.ptt, true)
  assert.equal(c.mimetype, "audio/ogg; codecs=opus")
  assert.ok(Buffer.isBuffer(c.audio))
})

test("outbound: file part → { document, mimetype, fileName }", async () => {
  const msg = buildCanonicalMessage([
    {
      type: "file",
      fileRef: {
        sha256: "sha-f",
        mimeType: "application/pdf",
        name: "doc.pdf",
      },
    },
  ])
  const build = await buildOutboundContent(msg, {
    readContent: async () => Buffer.from("pdf"),
    transcodeVoice: async (b) => b,
    logger: noopLogger,
  })
  const c = build.content as Record<string, unknown>
  assert.ok(Buffer.isBuffer(c.document))
  assert.equal(c.mimetype, "application/pdf")
  assert.equal(c.fileName, "doc.pdf")
})

test("outbound: collects mentionedJid from mention parts", async () => {
  const msg = buildCanonicalMessage([
    {
      type: "mention",
      externalId: "15550001111@s.whatsapp.net",
      displayName: "@15550001111",
    },
    { type: "text", text: "ping" },
  ])
  const build = await buildOutboundContent(msg, {
    readContent: async () => Buffer.from(""),
    transcodeVoice: async (b) => b,
    logger: noopLogger,
  })
  assert.deepEqual(build.mentionedJid, ["15550001111@s.whatsapp.net"])
})
