/**
 * WhatsApp media: inbound decrypt+store, and outbound per-type send shaping.
 *
 * INBOUND: Baileys decrypts media internally. We call `downloadMediaMessage`
 * (buffer mode) to get DECRYPTED bytes, re-sniff/repair the MIME, then persist
 * via the lazy `storeFile` recipe (origin WHATSAPP_UNOFFICIAL_INBOUND_MEDIA_INGEST).
 * The placeholder `system_marker` part produced by normalize.ts is rewritten
 * in place into a real image/voice/video/file part carrying the fileRef.
 *
 *   - MIME fallback for the "audio-inside-documentMessage / Bad decrypt" case:
 *     when a documentMessage's mimetype is an audio type we treat it as voice.
 *   - `fileLength` may be string | number | Long — already coerced by normalize.
 *
 * OUTBOUND: we build `AnyMessageContent` per canonical part. Bytes come from
 * our CAS (`readContentBuffer(sha256)`). Voice = `transcodeToOpusVoiceNote` +
 * `{ audio, ptt:true, mimetype:"audio/ogg; codecs=opus" }`. Stickers must be
 * 512² webp (we send the bytes as-is; the caller is expected to provide webp).
 */

import type { AnyMessageContent, WAMessage } from "baileys"
import type {
  CanonicalMessage,
  CanonicalPart,
} from "../../messaging/canonical-message.js"
import { PermanentTransportError, type ConnectorLogger } from "../types.js"
import { coerceFileLength } from "./types.js"

/**
 * Per-kind inbound download size caps. A media placeholder whose declared
 * `fileLength` exceeds its cap is SKIPPED (placeholder kept, nothing downloaded)
 * so a single large/malicious attachment cannot OOM the concurrency-1 worker.
 * Mirrors the sibling connectors (whatsapp Cloud / telegram / qq), all of which
 * cap inbound downloads.
 */
export const WHATSAPP_UNOFFICIAL_INBOUND_SIZE_LIMITS: Record<
  "image" | "video" | "audio" | "document" | "sticker",
  number
> = {
  image: 16 * 1024 * 1024,
  video: 64 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 64 * 1024 * 1024,
  sticker: 2 * 1024 * 1024,
}

// ───────────────────────── inbound ─────────────────────────

/** DI seam: download decrypted media bytes from a Baileys message. */
export type DownloadMediaFn = (raw: WAMessage) => Promise<Buffer>

/** DI seam: persist bytes → CAS, returns the sha256. */
export type StoreInboundMediaFn = (input: {
  buffer: Buffer
  workspaceId: string
  originalName: string
  mimeType: string
  resourceKey: string
  messageId: string
}) => Promise<{ sha256: string }>

const AUDIO_MIME_HINTS = ["audio/", "ogg", "opus", "mpeg", "mp3", "m4a", "amr"]

/** Treat an audio-typed documentMessage as voice (the Bad-decrypt fallback). */
export function mapMediaKindWithMimeFallback(
  declaredKind: "image" | "video" | "audio" | "document" | "sticker",
  mimetype: string | undefined
): "image" | "video" | "voice" | "file" {
  const mime = (mimetype ?? "").toLowerCase()
  if (declaredKind === "image" || declaredKind === "sticker") return "image"
  if (declaredKind === "video") return "video"
  if (declaredKind === "audio") return "voice"
  // documentMessage: sniff for audio.
  if (AUDIO_MIME_HINTS.some((h) => mime.includes(h))) return "voice"
  return "file"
}

/**
 * The lazy store recipe (mirrors qq/inbound-media.ts). Dynamic imports keep
 * `index.ts` IO-free so register-all stays DB-dependency-free.
 */
export async function defaultStoreInboundMedia(input: {
  buffer: Buffer
  workspaceId: string
  originalName: string
  mimeType: string
  resourceKey: string
  messageId: string
}): Promise<{ sha256: string }> {
  const [{ FILE_ORIGIN_SYSTEMS }, { buildExternalImportOrigin }, fileService] =
    await Promise.all([
      import("@synapse/shared/constants"),
      import("../../../files/model.js"),
      import("../../../files/service.js"),
    ])
  const record = await fileService.storeFile({
    buffer: input.buffer,
    originalName: input.originalName,
    mimeType: input.mimeType,
    workspaceId: input.workspaceId,
    origin: buildExternalImportOrigin({
      system: FILE_ORIGIN_SYSTEMS.WHATSAPP_UNOFFICIAL_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  return { sha256: record.sha256 }
}

export interface EnrichInboundMediaDeps {
  raw: WAMessage
  workspaceId: string
  messageId: string
  download: DownloadMediaFn
  store?: StoreInboundMediaFn
  logger: ConnectorLogger
}

/**
 * Download + store each media placeholder, rewriting the placeholder
 * `system_marker` parts into real fileRef parts. On failure the placeholder is
 * KEPT (no silent drop). Returns a NEW message (input not mutated).
 */
export async function enrichInboundWhatsappMedia(
  message: CanonicalMessage,
  mediaParts: Array<{
    partIndex: number
    kind: "image" | "video" | "audio" | "document" | "sticker"
  }>,
  deps: EnrichInboundMediaDeps
): Promise<CanonicalMessage> {
  if (mediaParts.length === 0) return message
  const store = deps.store ?? defaultStoreInboundMedia
  const parts = message.parts.map((p) => ({ ...p })) as CanonicalPart[]

  for (const { partIndex, kind } of mediaParts) {
    const placeholder = parts[partIndex]
    if (!placeholder || placeholder.type !== "system_marker") continue
    const original = (placeholder.original ?? {}) as Record<string, unknown>
    const declaredMime =
      typeof original.mimetype === "string" ? original.mimetype : undefined
    const fileName =
      typeof original.fileName === "string" ? original.fileName : undefined
    const projected = mapMediaKindWithMimeFallback(kind, declaredMime)

    // Enforce a per-kind size cap from the declared fileLength hint BEFORE the
    // unbounded `download` so a huge/malicious attachment can't OOM the worker.
    const declaredLength = coerceFileLength(original.fileLength)
    const cap = WHATSAPP_UNOFFICIAL_INBOUND_SIZE_LIMITS[kind]
    if (declaredLength != null && declaredLength > cap) {
      deps.logger.warn(
        "whatsapp_unofficial: inbound media exceeds size cap — keeping placeholder",
        { messageId: deps.messageId, kind, declaredLength, cap }
      )
      continue // keep placeholder
    }

    try {
      const buffer = await deps.download(deps.raw)
      const mimeType = declaredMime || defaultMimeForKind(projected)
      const originalName =
        fileName || defaultNameForKind(projected, deps.messageId, mimeType)
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.workspaceId,
        originalName,
        mimeType,
        resourceKey: `${deps.messageId}:${partIndex}`,
        messageId: deps.messageId,
      })
      parts[partIndex] = buildFileRefPart(projected, {
        sha256,
        mimeType,
        name: originalName,
        sizeBytes: buffer.length,
        durationMs:
          typeof original.seconds === "number"
            ? original.seconds * 1000
            : undefined,
        width: typeof original.width === "number" ? original.width : undefined,
        height:
          typeof original.height === "number" ? original.height : undefined,
      })
    } catch (err) {
      deps.logger.error(
        "whatsapp_unofficial: inbound media download failed",
        err,
        {
          messageId: deps.messageId,
          kind,
        }
      )
      // keep placeholder
    }
  }

  const { buildCanonicalMessage } =
    await import("../../messaging/canonical-message.js")
  return buildCanonicalMessage(parts)
}

function buildFileRefPart(
  kind: "image" | "video" | "voice" | "file",
  ref: {
    sha256: string
    mimeType: string
    name: string
    sizeBytes: number
    durationMs?: number
    width?: number
    height?: number
  }
): CanonicalPart {
  const fileRef = {
    sha256: ref.sha256,
    mimeType: ref.mimeType,
    name: ref.name,
    sizeBytes: ref.sizeBytes,
    ...(ref.width ? { width: ref.width } : {}),
    ...(ref.height ? { height: ref.height } : {}),
  }
  switch (kind) {
    case "image":
      return { type: "image", fileRef }
    case "video":
      return {
        type: "video",
        fileRef,
        ...(ref.durationMs ? { durationMs: ref.durationMs } : {}),
        ...(ref.width ? { width: ref.width } : {}),
        ...(ref.height ? { height: ref.height } : {}),
      }
    case "voice":
      return {
        type: "voice",
        fileRef,
        ...(ref.durationMs ? { durationMs: ref.durationMs } : {}),
      }
    case "file":
      return { type: "file", fileRef: { ...fileRef, name: ref.name || "file" } }
  }
}

function defaultMimeForKind(
  kind: "image" | "video" | "voice" | "file"
): string {
  switch (kind) {
    case "image":
      return "image/jpeg"
    case "video":
      return "video/mp4"
    case "voice":
      return "audio/ogg"
    case "file":
      return "application/octet-stream"
  }
}

function defaultNameForKind(
  kind: "image" | "video" | "voice" | "file",
  messageId: string,
  mime: string
): string {
  const ext = mime.split("/")[1]?.split(";")[0] || "bin"
  return `${kind}-${messageId}.${ext}`
}

// ───────────────────────── outbound ─────────────────────────

/** DI seam: read outbound bytes from the CAS. */
export type ReadContentFn = (sha256: string) => Promise<Buffer>
/** DI seam: transcode arbitrary audio → mono OGG/Opus voice note. */
export type TranscodeVoiceFn = (input: Buffer) => Promise<Buffer>

export interface BuildOutboundDeps {
  readContent: ReadContentFn
  transcodeVoice: TranscodeVoiceFn
  logger: ConnectorLogger
}

export interface OutboundBuild {
  /** The Baileys `AnyMessageContent` to send. */
  content: AnyMessageContent
  /** JIDs to mention (collected from `mention` parts). */
  mentionedJid: string[]
}

/**
 * Build the Baileys send payload from a (already-degraded) CanonicalMessage.
 *
 * Single-attachment semantics: WhatsApp sends one media item per message. We
 * build the FIRST media part as the media message (with the collected text as
 * caption); if there are extra media parts the caller may send them as
 * follow-ups — but for v1 we collapse to: [media? + text] in one send, and
 * surplus text/media are folded into caption/ignored gracefully.
 */
export async function buildOutboundContent(
  message: CanonicalMessage,
  deps: BuildOutboundDeps
): Promise<OutboundBuild> {
  const mentionedJid: string[] = []
  const textChunks: string[] = []
  let mediaPart: CanonicalPart | undefined

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        if (part.text) textChunks.push(part.text)
        break
      case "mention":
        if (part.externalId) mentionedJid.push(part.externalId)
        textChunks.push(`@${part.displayName.replace(/^@/, "")}`)
        break
      case "image":
      case "video":
      case "voice":
      case "file":
        if (!mediaPart) mediaPart = part
        break
      case "reaction":
        // handled by the reaction send path, not here
        break
      default:
        break
    }
  }

  const text = textChunks.join(" ").trim()

  if (mediaPart) {
    const content = await buildMediaContent(mediaPart, text, deps)
    return { content, mentionedJid }
  }

  return { content: { text } as AnyMessageContent, mentionedJid }
}

async function buildMediaContent(
  part: CanonicalPart,
  caption: string,
  deps: BuildOutboundDeps
): Promise<AnyMessageContent> {
  if (
    part.type !== "image" &&
    part.type !== "video" &&
    part.type !== "voice" &&
    part.type !== "file"
  ) {
    return { text: caption } as AnyMessageContent
  }
  const sha256 = part.fileRef.sha256
  if (!sha256) {
    // A media part that lost its bytes must FAIL loudly (so it can be inspected),
    // not silently ship a literal "[media]" placeholder to the recipient. Mirrors
    // the Cloud-API sibling (whatsapp/outbound.ts).
    throw new PermanentTransportError(
      "whatsapp_unofficial: media part missing sha256",
      { code: "whatsapp_unofficial_media_missing_sha" }
    )
  }
  const bytes = await deps.readContent(sha256)

  switch (part.type) {
    case "image":
      return {
        image: bytes,
        ...(caption ? { caption } : {}),
      } as AnyMessageContent
    case "video":
      return {
        video: bytes,
        ...(caption ? { caption } : {}),
      } as AnyMessageContent
    case "voice": {
      // A permanently un-transcodable file (ffmpeg missing / bad audio) must
      // fail PERMANENT — otherwise the worker treats the bare TranscodeError as
      // retryable and burns the full BullMQ attempt budget. Mirrors the Cloud
      // sibling (whatsapp/outbound.ts).
      let opus: Buffer
      try {
        opus = await deps.transcodeVoice(bytes)
      } catch (err) {
        throw new PermanentTransportError(
          `whatsapp_unofficial: voice transcode failed: ${(err as Error).message}`,
          { code: "whatsapp_unofficial_voice_transcode_failed", cause: err }
        )
      }
      return {
        audio: opus,
        ptt: true,
        mimetype: "audio/ogg; codecs=opus",
      } as AnyMessageContent
    }
    case "file":
      return {
        document: bytes,
        mimetype: part.fileRef.mimeType || "application/octet-stream",
        fileName: part.fileRef.name || "file",
        ...(caption ? { caption } : {}),
      } as AnyMessageContent
  }
}
