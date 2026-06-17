/**
 * Personal-WeChat (ilink) inbound media enrichment.
 *
 * `normalize.ts` is pure and emits a `system_marker` placeholder for each
 * image/file/video payload, stashing the CDN reference (encrypt_query_param /
 * full_url / aes key) in `original`. This module is the side-effecting second
 * pass: download + AES-128-ECB decrypt the bytes, persist them through the
 * central file service (content-addressed, deduped), and replace the
 * placeholder with a real `image`/`video`/`file` CanonicalPart carrying a
 * `{ sha256 }` fileRef — the unified handle the chat layer serves bytes by.
 *
 * Voice is intentionally left as a placeholder/transcript: the audio is SILK
 * encoded and we don't ship a transcoder (matches the outbound no-voice scope).
 *
 * Best-effort: any per-part failure keeps the original placeholder so a flaky
 * download never blocks message ingestion. Runs after `normalize`, so
 * `normalize` stays pure.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import { downloadAndDecryptWeixinMedia } from "./media-download.js"

// The file service (and its DB/storage graph) is imported lazily so merely
// importing this module (e.g. via register-all in connector unit tests) never
// drags the database layer in. It loads only when a real download happens.
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
      system: FILE_ORIGIN_SYSTEMS.WEIXIN_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  return { sha256: record.sha256 }
}

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return EXT_MIME[ext] ?? "application/octet-stream"
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

export interface WeixinMediaPlan {
  encryptQueryParam?: string
  aesKeyBase64?: string
  fullUrl?: string
  defaultMime: string
  originalName: string
  resourceKey: string
  toPart: (fileRef: CanonicalFileRef) => CanonicalPart
}

/**
 * Map a media `system_marker` (with its stashed CDN ref) to a download plan,
 * or null if it isn't a downloadable media placeholder.
 */
export function planWeixinMediaDownload(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): WeixinMediaPlan | null {
  const o = part.original || {}
  const encryptQueryParam = strOf(o.encrypt_query_param)
  const fullUrl = strOf(o.full_url)
  if (!encryptQueryParam && !fullUrl) return null

  // aes key: image prefers `aeskey_hex` (hex), else `aes_key` (already base64).
  const aeskeyHex = strOf(o.aeskey_hex)
  const aesKeyBase64 = aeskeyHex
    ? Buffer.from(aeskeyHex, "hex").toString("base64")
    : strOf(o.aes_key)
  const resourceKey = encryptQueryParam || fullUrl || "weixin-media"

  if (part.marker === "image_placeholder") {
    // Images may be unencrypted; download with or without a key.
    return {
      encryptQueryParam,
      aesKeyBase64,
      fullUrl,
      defaultMime: "image/jpeg",
      originalName: "image.jpg",
      resourceKey,
      toPart: (fileRef) => ({ type: "image", fileRef }),
    }
  }
  if (part.marker === "video_placeholder") {
    if (!aesKeyBase64) return null
    return {
      encryptQueryParam,
      aesKeyBase64,
      fullUrl,
      defaultMime: "video/mp4",
      originalName: "video.mp4",
      resourceKey,
      toPart: (fileRef) => ({ type: "video", fileRef }),
    }
  }
  if (part.marker === "file_placeholder") {
    if (!aesKeyBase64) return null
    const name = strOf(o.file_name) || "file"
    return {
      encryptQueryParam,
      aesKeyBase64,
      fullUrl,
      defaultMime: mimeFromName(name),
      originalName: name,
      resourceKey,
      toPart: (fileRef) => ({ type: "file", fileRef: { ...fileRef, name } }),
    }
  }
  return null
}

export interface WeixinMediaEnrichDeps {
  account: TransportAccountSummary
  cdnBaseUrl: string
  logger?: ConnectorLogger
  /** Test seam — defaults to a real CDN download + decrypt. */
  download?: (plan: WeixinMediaPlan) => Promise<Buffer>
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

/**
 * Replace inbound media placeholders in `envelope` with real media parts whose
 * bytes have been downloaded, decrypted and stored. Returns the original
 * envelope unchanged when there is no downloadable media (no IO incurred) or
 * when every download fails.
 */
export async function enrichInboundWeixinMedia(
  envelope: InboundEnvelope,
  deps: WeixinMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) => p.type === "system_marker" && planWeixinMediaDownload(p) != null
  )
  if (!hasMedia) return envelope

  const download =
    deps.download ??
    ((plan: WeixinMediaPlan) =>
      downloadAndDecryptWeixinMedia({
        encryptQueryParam: plan.encryptQueryParam,
        aesKeyBase64: plan.aesKeyBase64,
        fullUrl: plan.fullUrl,
        cdnBaseUrl: deps.cdnBaseUrl,
        label: `weixin inbound ${plan.originalName}`,
      }))
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const plan =
      part.type === "system_marker" ? planWeixinMediaDownload(part) : null
    if (!plan) {
      out.push(part)
      continue
    }
    try {
      const buffer = await download(plan)
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.account.workspaceId,
        originalName: plan.originalName,
        mimeType: plan.defaultMime,
        resourceKey: plan.resourceKey,
        messageId: envelope.externalMessageId,
      })
      out.push(
        plan.toPart({
          sha256,
          mimeType: plan.defaultMime,
          name: plan.originalName,
          sizeBytes: buffer.length,
        })
      )
      changed = true
    } catch (err) {
      deps.logger?.warn(
        "weixin: inbound media download failed; keeping placeholder",
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
