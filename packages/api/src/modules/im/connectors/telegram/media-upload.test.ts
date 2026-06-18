import test from "node:test"
import assert from "node:assert/strict"
import { PermanentTransportError } from "../types.js"
import {
  prepareDocumentUpload,
  preparePhotoUpload,
  prepareVideoUpload,
  prepareVoiceUpload,
} from "./media-upload.js"
import { TELEGRAM_CLOUD_UPLOAD_MAX_BYTES } from "./types.js"

const reader = (buf: Buffer) => async () => buf

test("preparePhotoUpload: sendPhoto + photo field", async () => {
  const p = await preparePhotoUpload(
    { sha256: "s", mimeType: "image/png", name: "a.png" },
    reader(Buffer.from("PNG"))
  )
  assert.equal(p.method, "sendPhoto")
  assert.equal(p.fileField, "photo")
  assert.equal(p.filename, "a.png")
  assert.equal(p.contentType, "image/png")
})

test("prepareDocumentUpload: sendDocument", async () => {
  const p = await prepareDocumentUpload(
    { sha256: "s", name: "x.bin" },
    reader(Buffer.from("BYTES"))
  )
  assert.equal(p.method, "sendDocument")
  assert.equal(p.fileField, "document")
})

test("prepareVideoUpload: duration/width/height carried", async () => {
  const p = await prepareVideoUpload(
    { sha256: "s" },
    {
      durationSec: 12,
      width: 640,
      height: 480,
      readBytes: reader(Buffer.from("V")),
    }
  )
  assert.equal(p.method, "sendVideo")
  assert.equal(p.extraFields.duration, 12)
  assert.equal(p.extraFields.width, 640)
})

test("prepareVoiceUpload: already OGG/Opus => sendVoice as-is", async () => {
  // Minimal OGG header "OggS" makes isOggOpus pass enough to send as voice.
  const oggOpus = Buffer.concat([
    Buffer.from("OggS"),
    Buffer.alloc(24),
    Buffer.from("OpusHead"),
  ])
  const p = await prepareVoiceUpload(
    { sha256: "s" },
    { durationSec: 4, readBytes: reader(oggOpus) }
  )
  assert.equal(p.method, "sendVoice")
  assert.equal(p.fileField, "voice")
  assert.equal(p.extraFields.duration, 4)
})

test("prepareVoiceUpload: non-opus with no ffmpeg => downgrade to document", async () => {
  // A plain MP3-ish buffer; ffmpeg is not on PATH in CI so it downgrades.
  const mp3 = Buffer.from("ID3plain-audio-bytes")
  const p = await prepareVoiceUpload(
    { sha256: "s", mimeType: "audio/mpeg", name: "a.mp3" },
    { readBytes: reader(mp3) }
  )
  // Either transcoded to voice (if ffmpeg present) or downgraded to document.
  assert.ok(p.method === "sendVoice" || p.method === "sendDocument")
  if (p.method === "sendDocument") {
    assert.equal(p.voiceDowngradedToDocument, true)
  }
})

test("loadBytes: empty buffer => PermanentTransportError", async () => {
  await assert.rejects(
    () => preparePhotoUpload({ sha256: "s" }, reader(Buffer.alloc(0))),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      assert.equal(
        (err as PermanentTransportError).code,
        "telegram_media_empty"
      )
      return true
    }
  )
})

test("loadBytes: missing sha256 => PermanentTransportError", async () => {
  await assert.rejects(
    () => preparePhotoUpload({}, reader(Buffer.from("x"))),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      assert.equal(
        (err as PermanentTransportError).code,
        "telegram_media_no_sha256"
      )
      return true
    }
  )
})

test("assertWithinUploadCap: oversize => telegram_file_too_big", async () => {
  const big = Buffer.alloc(TELEGRAM_CLOUD_UPLOAD_MAX_BYTES + 1)
  await assert.rejects(
    () => preparePhotoUpload({ sha256: "s" }, reader(big)),
    (err: unknown) => {
      assert.ok(err instanceof PermanentTransportError)
      assert.equal(
        (err as PermanentTransportError).code,
        "telegram_file_too_big"
      )
      return true
    }
  )
})
