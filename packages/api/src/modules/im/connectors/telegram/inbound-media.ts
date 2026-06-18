/**
 * Telegram inbound media enrichment.
 *
 * `normalize.ts` is pure and emits a `system_marker` placeholder per inbound
 * media item, stashing `{file_id, file_unique_id, mime, name, duration, …}`
 * in `original`. This module performs the side-effecting second pass:
 *   1. `getFile(file_id)` → `file_path`
 *   2. GET `https://api.telegram.org/file/bot<token>/<file_path>` via
 *      `downloadToBufferWithLimit` (the file URL is UNAUTHENTICATED, valid
 *      ≥1h; cloud download cap 20 MB → omit `headers`).
 *   3. persist through the central file service → `{sha256}` and replace the
 *      placeholder with a real image/voice/video/file CanonicalPart.
 *
 * `file_unique_id` is the stable dedup/content key (the file service dedups
 * by sha256 of the bytes regardless). Best-effort: any per-part failure keeps
 * the placeholder so a flaky download never blocks ingestion.
 *
 * NOTE (OD-6): a self-hosted local Bot API server returns an ABSOLUTE
 * `file_path` on disk rather than a relative path — that branch (read from a
 * shared volume with its own path-traversal guard + size cap) is DEFERRED.
 * For now an absolute `file_path` is treated as un-downloadable (placeholder
 * kept).
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import { downloadToBufferWithLimit } from "../../../../infrastructure/storage/index.js"
import { callMethod } from "./client.js"
import type { TelegramCredentials } from "./credentials.js"
import { resolveApiRoot, getTelegramCredentialsOrThrow } from "./credentials.js"
import {
  TELEGRAM_CLOUD_DOWNLOAD_MAX_BYTES,
  telegramFileUrl,
  type TelegramFile,
} from "./types.js"

// Lazy file-service graph (mirrors qq/inbound-media.ts): importing this module
// — e.g. via register-all in the connector unit tests — never drags the DB
// layer in. It loads only when a real inbound download happens.
async function defaultStoreInboundMedia(input: {
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
      system: FILE_ORIGIN_SYSTEMS.TELEGRAM_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  return { sha256: record.sha256 }
}

interface TelegramMediaPlan {
  fileId: string
  fileUniqueId: string
  defaultMime: string
  originalName: string
  width?: number
  height?: number
  toPart: (fileRef: CanonicalFileRef) => CanonicalPart
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}
function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/**
 * Map a media `system_marker` placeholder (carrying the raw Telegram media in
 * `original`) to a download plan, or null when it isn't a downloadable
 * placeholder. Animated/video stickers are skipped (kept as placeholder).
 */
export function planTelegramMediaDownload(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): TelegramMediaPlan | null {
  const o = part.original || {}
  const fileId = strOf(o.file_id)
  const fileUniqueId = strOf(o.file_unique_id)
  if (!fileId || !fileUniqueId) return null
  // Skip animated/video stickers — only static WEBP downloads cleanly.
  if (o.is_animated === true || o.is_video === true) return null

  const mime = strOf(o.mime)
  const name = strOf(o.name)
  const width = numOf(o.width)
  const height = numOf(o.height)
  const duration = numOf(o.duration)

  switch (part.marker) {
    case "image_placeholder":
      return {
        fileId,
        fileUniqueId,
        defaultMime: mime || "image/jpeg",
        originalName: name || "image.jpg",
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        toPart: (fileRef) => ({ type: "image", fileRef }),
      }
    case "voice_placeholder":
      return {
        fileId,
        fileUniqueId,
        defaultMime: mime || "audio/ogg",
        originalName: name || "voice.ogg",
        toPart: (fileRef) => ({
          type: "voice",
          fileRef,
          // durationMs is MILLISECONDS; Telegram gives seconds.
          ...(duration != null ? { durationMs: duration * 1000 } : {}),
        }),
      }
    case "video_placeholder":
      return {
        fileId,
        fileUniqueId,
        defaultMime: mime || "video/mp4",
        originalName: name || "video.mp4",
        toPart: (fileRef) => ({
          type: "video",
          fileRef,
          ...(duration != null ? { durationMs: duration * 1000 } : {}),
          ...(width != null ? { width } : {}),
          ...(height != null ? { height } : {}),
        }),
      }
    case "file_placeholder":
      return {
        fileId,
        fileUniqueId,
        defaultMime: mime || "application/octet-stream",
        originalName: name || "file",
        toPart: (fileRef) => ({
          type: "file",
          fileRef: { ...fileRef, name: fileRef.name || name || "file" },
        }),
      }
    default:
      return null
  }
}

export interface TelegramMediaEnrichDeps {
  account: Pick<TransportAccountSummary, "workspaceId" | "credentials">
  logger?: ConnectorLogger
  /** Test seam — resolve a file_id to downloadable bytes. */
  download?: (input: {
    fileId: string
    maxBytes: number
  }) => Promise<{ buffer: Buffer; mime?: string }>
  /** Test seam — defaults to the central file service (CAS, deduped). */
  store?: (input: {
    buffer: Buffer
    workspaceId: string
    originalName: string
    mimeType: string
    resourceKey: string
    messageId: string
  }) => Promise<{ sha256: string }>
}

/** Default download seam: getFile → unauthenticated file URL → bytes. */
async function defaultDownload(
  creds: TelegramCredentials,
  input: { fileId: string; maxBytes: number }
): Promise<{ buffer: Buffer; mime?: string }> {
  const file = await callMethod<TelegramFile>(creds, "getFile", {
    file_id: input.fileId,
  })
  const filePath = file.file_path
  if (!filePath) throw new Error("getFile returned no file_path")
  // OD-6: a local Bot API server returns an absolute on-disk path. That
  // branch is deferred — refuse rather than build a bogus URL.
  if (filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath)) {
    throw new Error("local Bot API absolute file_path not supported (OD-6)")
  }
  const url = telegramFileUrl(resolveApiRoot(creds), creds.botToken, filePath)
  // File URL is unauthenticated → omit `headers`.
  const r = await downloadToBufferWithLimit({
    url,
    maxBytes: input.maxBytes,
    timeoutMs: 60_000,
  })
  return { buffer: r.buffer, mime: r.mimeType }
}

/**
 * Replace inbound media placeholders with real media parts whose bytes have
 * been downloaded into our CAS. Returns the envelope unchanged when there is
 * no downloadable media (no IO) or when every download fails.
 */
export async function enrichInboundTelegramMedia(
  envelope: InboundEnvelope,
  deps: TelegramMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) => p.type === "system_marker" && planTelegramMediaDownload(p) != null
  )
  if (!hasMedia) return envelope

  const creds = deps.download
    ? undefined
    : getTelegramCredentialsOrThrow({ credentials: deps.account.credentials })
  const download =
    deps.download ??
    ((input: { fileId: string; maxBytes: number }) =>
      defaultDownload(creds!, input))
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const plan =
      part.type === "system_marker" ? planTelegramMediaDownload(part) : null
    if (!plan) {
      out.push(part)
      continue
    }
    try {
      const { buffer, mime } = await download({
        fileId: plan.fileId,
        maxBytes: TELEGRAM_CLOUD_DOWNLOAD_MAX_BYTES,
      })
      const mimeType =
        mime && mime !== "application/octet-stream" ? mime : plan.defaultMime
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.account.workspaceId,
        originalName: plan.originalName,
        mimeType,
        resourceKey: plan.fileUniqueId,
        messageId: envelope.externalMessageId,
      })
      const fileRef: CanonicalFileRef = {
        sha256,
        mimeType,
        name: plan.originalName,
        sizeBytes: buffer.length,
      }
      if (plan.width != null) fileRef.width = plan.width
      if (plan.height != null) fileRef.height = plan.height
      out.push(plan.toPart(fileRef))
      changed = true
    } catch (err) {
      deps.logger?.warn(
        "telegram: inbound media download failed; keeping placeholder",
        {
          marker: part.type === "system_marker" ? part.marker : undefined,
          err: String(err),
        }
      )
      out.push(part)
    }
  }

  if (!changed) return envelope
  return { ...envelope, message: buildCanonicalMessage(out) }
}
