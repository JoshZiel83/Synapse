/**
 * Telegram outbound media upload.
 *
 * Reads outbound bytes via `readContentBuffer(fileRef.sha256!)`, transcodes
 * voice to OGG/Opus when needed, enforces the 50 MB cloud upload cap, and
 * returns a `PreparedUpload` describing the Bot API method + multipart fields
 * + the file part. The actual `fetch` happens in `outbound.ts` via the
 * client's multipart variant.
 *
 * `attach://<name>` is the nested-attachment pattern (thumbnails, album
 * items); v1 sends a single top-level file per message so the file field name
 * IS the API param name (`photo`/`voice`/`video`/`document`) — no `attach://`
 * indirection needed yet, but the helper is structured so adding it is local.
 */

import { readContentBuffer } from "../../../../infrastructure/storage/content-store.js"
import {
  ffmpegAvailable,
  isOggOpus,
  transcodeToOpusVoiceNote,
} from "../../../../infrastructure/media/transcode.js"
import { PermanentTransportError } from "../types.js"
import type { ConnectorLogger } from "../types.js"
import type { CanonicalFileRef } from "../../messaging/canonical-message.js"
import { TELEGRAM_CLOUD_UPLOAD_MAX_BYTES } from "./types.js"

/** A prepared upload: the API method, the file field, and its bytes. */
export interface PreparedUpload {
  /** Bot API method name (sendPhoto/sendVoice/sendVideo/sendDocument). */
  method: string
  /** The multipart field name that holds the file (== the API param). */
  fileField: string
  filename: string
  buffer: Buffer
  contentType: string
  /** Extra scalar fields specific to this media type (e.g. duration). */
  extraFields: Record<string, string | number | boolean | undefined>
  /**
   * True when a voice part had to fall back to a document send (no ffmpeg /
   * un-transcodable) — the caller surfaces this so the message still goes out.
   */
  voiceDowngradedToDocument?: boolean
}

/** DI seam: how to read the outbound bytes for a sha256 (defaults to CAS). */
export type ReadBytes = (sha256: string) => Promise<Buffer>

async function loadBytes(
  fileRef: CanonicalFileRef,
  readBytes: ReadBytes
): Promise<Buffer> {
  if (!fileRef.sha256) {
    throw new PermanentTransportError("telegram: media has no sha256", {
      code: "telegram_media_no_sha256",
    })
  }
  const buffer = await readBytes(fileRef.sha256)
  if (!buffer || buffer.length === 0) {
    throw new PermanentTransportError("telegram: media resource is empty", {
      code: "telegram_media_empty",
    })
  }
  return buffer
}

function assertWithinUploadCap(buffer: Buffer): void {
  if (buffer.length > TELEGRAM_CLOUD_UPLOAD_MAX_BYTES) {
    throw new PermanentTransportError(
      `telegram: file exceeds ${TELEGRAM_CLOUD_UPLOAD_MAX_BYTES} byte upload cap`,
      { code: "telegram_file_too_big" }
    )
  }
}

export async function preparePhotoUpload(
  fileRef: CanonicalFileRef,
  readBytes: ReadBytes = readContentBuffer
): Promise<PreparedUpload> {
  const buffer = await loadBytes(fileRef, readBytes)
  assertWithinUploadCap(buffer)
  return {
    method: "sendPhoto",
    fileField: "photo",
    filename: fileRef.name || "image.jpg",
    buffer,
    contentType: fileRef.mimeType || "image/jpeg",
    extraFields: {},
  }
}

export async function prepareVideoUpload(
  fileRef: CanonicalFileRef,
  opts: {
    durationSec?: number
    width?: number
    height?: number
    readBytes?: ReadBytes
  } = {}
): Promise<PreparedUpload> {
  const buffer = await loadBytes(fileRef, opts.readBytes ?? readContentBuffer)
  assertWithinUploadCap(buffer)
  return {
    method: "sendVideo",
    fileField: "video",
    filename: fileRef.name || "video.mp4",
    buffer,
    contentType: fileRef.mimeType || "video/mp4",
    extraFields: {
      duration: opts.durationSec,
      width: opts.width,
      height: opts.height,
    },
  }
}

export async function prepareDocumentUpload(
  fileRef: CanonicalFileRef,
  readBytes: ReadBytes = readContentBuffer
): Promise<PreparedUpload> {
  const buffer = await loadBytes(fileRef, readBytes)
  assertWithinUploadCap(buffer)
  return {
    method: "sendDocument",
    fileField: "document",
    filename: fileRef.name || "file",
    buffer,
    contentType: fileRef.mimeType || "application/octet-stream",
    extraFields: {},
  }
}

/**
 * Voice note upload. A true Telegram voice note requires OGG/Opus. If the
 * bytes are already OGG/Opus we send as-is; otherwise we transcode via ffmpeg.
 * If ffmpeg is unavailable (or transcode fails) we DEGRADE to a document send
 * (flagged) rather than fail the whole message.
 */
export async function prepareVoiceUpload(
  fileRef: CanonicalFileRef,
  opts: {
    durationSec?: number
    logger?: ConnectorLogger
    readBytes?: ReadBytes
  } = {}
): Promise<PreparedUpload> {
  const buffer = await loadBytes(fileRef, opts.readBytes ?? readContentBuffer)

  if (isOggOpus(buffer)) {
    assertWithinUploadCap(buffer)
    return {
      method: "sendVoice",
      fileField: "voice",
      filename: fileRef.name || "voice.ogg",
      buffer,
      contentType: "audio/ogg",
      extraFields: { duration: opts.durationSec },
    }
  }

  const canTranscode = await ffmpegAvailable()
  if (canTranscode) {
    try {
      const ogg = await transcodeToOpusVoiceNote(buffer)
      assertWithinUploadCap(ogg)
      return {
        method: "sendVoice",
        fileField: "voice",
        filename: "voice.ogg",
        buffer: ogg,
        contentType: "audio/ogg",
        extraFields: { duration: opts.durationSec },
      }
    } catch (err) {
      opts.logger?.warn(
        "telegram: voice transcode failed; sending as document",
        { err: String(err) }
      )
    }
  } else {
    opts.logger?.warn("telegram: ffmpeg unavailable; sending voice as document")
  }

  // Degrade to a document so the audio still reaches the user.
  assertWithinUploadCap(buffer)
  return {
    method: "sendDocument",
    fileField: "document",
    filename: fileRef.name || "audio",
    buffer,
    contentType: fileRef.mimeType || "audio/mpeg",
    extraFields: {},
    voiceDowngradedToDocument: true,
  }
}
