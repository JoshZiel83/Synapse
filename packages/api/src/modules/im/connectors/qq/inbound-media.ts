/**
 * QQ inbound media enrichment.
 *
 * `normalize.ts` is pure and emits a `system_marker` placeholder for each
 * inbound attachment (image / voice / video / file), stashing the raw
 * attachment object (url / content_type / filename / size / width / height)
 * in `original`. This module performs the side-effecting second pass:
 * download the bytes from QQ's CDN url, persist them through the central
 * file service (content-addressed, deduped), and replace the placeholder
 * with a real `image`/`voice`/`video`/`file` CanonicalPart carrying a
 * `{sha256}` fileRef.
 *
 * That sha256 is the unified handle `service/inbound-message.ts` projects
 * into a `file_ref` conversation-item part — the only way the agent sees
 * the attachment instead of the bare "[图片]" / "[文件]" placeholder text.
 *
 * Best-effort: any per-part failure keeps the original placeholder so a
 * flaky download never blocks message ingestion. Runs after `normalize`,
 * so `normalize` stays pure.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import { downloadToBufferWithLimit } from "../../../../infrastructure/storage/index.js"
import {
  QQ_FILE_TYPE,
  QQ_UPLOAD_SIZE_LIMITS,
  type QqFileType,
} from "./media-constants.js"

// The file service (and its DB/storage graph) is imported lazily inside the
// default `store` so merely importing this module — e.g. via register-all in
// the connector unit tests — never drags the database layer in. It loads only
// when a real inbound media download actually happens at runtime.
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
      system: FILE_ORIGIN_SYSTEMS.QQ_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  // The content-addressed sha256 is the unified handle: inbound-message.ts
  // persists it as a file_ref item part and the chat layer serves bytes by
  // /content/:sha256.
  return { sha256: record.sha256 }
}

interface QqMediaPlan {
  /** Download cap = the per-type upload ceiling (bounds memory). */
  fileType: QqFileType
  /** Fully-qualified download URL (scheme prepended if QQ omitted it). */
  url: string
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
 * QQ inbound attachment urls frequently arrive WITHOUT a scheme (e.g.
 * `multimedia.nt.qq.com.cn/...`); prepend https:// so the downloader can
 * resolve + host-allowlist them.
 */
function ensureScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`
}

/**
 * Map a media `system_marker` placeholder (carrying the raw QQ attachment in
 * `original`) to a download plan, or null when it isn't a downloadable media
 * placeholder / has no url.
 */
export function planQqMediaDownload(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): QqMediaPlan | null {
  const o = part.original || {}
  const rawUrl = strOf(o.url)
  if (!rawUrl) return null
  const url = ensureScheme(rawUrl)
  const mime = strOf(o.content_type)
  const name = strOf(o.filename)
  const width = numOf(o.width)
  const height = numOf(o.height)
  switch (part.marker) {
    case "image_placeholder":
      return {
        fileType: QQ_FILE_TYPE.IMAGE,
        url,
        defaultMime: mime || "image/jpeg",
        originalName: name || "image",
        ...(width != null ? { width } : {}),
        ...(height != null ? { height } : {}),
        toPart: (fileRef) => ({ type: "image", fileRef }),
      }
    case "voice_placeholder": {
      // QQ inbound voice carries the raw SILK at `url`, and frequently also a
      // ready-to-use WAV at `voice_wav_url` plus QQ's own speech-to-text at
      // `asr_refer_text`. Prefer the WAV (the agent can't process SILK) and
      // thread the transcript onto the part so the model sees the words.
      const wavUrl = strOf(o.voice_wav_url)
      const transcript = strOf(o.asr_refer_text)
      return {
        fileType: QQ_FILE_TYPE.VOICE,
        url: wavUrl ? ensureScheme(wavUrl) : url,
        defaultMime: wavUrl ? "audio/wav" : mime || "audio/silk",
        originalName: name || (wavUrl ? "voice.wav" : "voice.silk"),
        toPart: (fileRef) => ({
          type: "voice",
          fileRef,
          ...(transcript ? { transcript } : {}),
        }),
      }
    }
    case "video_placeholder":
      return {
        fileType: QQ_FILE_TYPE.VIDEO,
        url,
        defaultMime: mime || "video/mp4",
        originalName: name || "video.mp4",
        toPart: (fileRef) => ({ type: "video", fileRef }),
      }
    case "file_placeholder":
      return {
        fileType: QQ_FILE_TYPE.FILE,
        url,
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

export interface QqMediaEnrichDeps {
  account: Pick<TransportAccountSummary, "workspaceId">
  logger?: ConnectorLogger
  /** Test seam — defaults to a host-allowlisted, size-capped download. */
  download?: (input: {
    url: string
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

/**
 * Replace inbound media placeholders in `envelope` with real media parts
 * whose bytes have been downloaded into our CAS. Returns the envelope
 * unchanged when there is no media (no IO incurred) or when every download
 * fails.
 */
export async function enrichInboundQqMedia(
  envelope: InboundEnvelope,
  deps: QqMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) => p.type === "system_marker" && planQqMediaDownload(p) != null
  )
  if (!hasMedia) return envelope

  const download =
    deps.download ??
    (async (input: { url: string; maxBytes: number }) => {
      // No host allowlist: QQ rotates/shards its media CDN hosts and the
      // attachment url arrives inside a signature-verified event, so a fixed
      // host literal would silently drop legitimate media on a new host (the
      // exact failure reputable adapters — nonebot/botpy — avoid by
      // downloading the url directly). downloadToBufferWithLimit STILL always
      // applies SSRF protection (rejects private/loopback/link-local/metadata
      // hosts) plus the size/redirect/timeout caps.
      const r = await downloadToBufferWithLimit({
        url: input.url,
        maxBytes: input.maxBytes,
        timeoutMs: 60_000,
      })
      return { buffer: r.buffer, mime: r.mimeType }
    })
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const plan =
      part.type === "system_marker" ? planQqMediaDownload(part) : null
    if (!plan) {
      out.push(part)
      continue
    }
    try {
      const { buffer, mime } = await download({
        url: plan.url,
        maxBytes: QQ_UPLOAD_SIZE_LIMITS[plan.fileType],
      })
      // Prefer the attachment's declared content_type (baked into
      // defaultMime) over a generic octet-stream from the CDN response.
      const mimeType =
        mime && mime !== "application/octet-stream" ? mime : plan.defaultMime
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.account.workspaceId,
        originalName: plan.originalName,
        mimeType,
        resourceKey: plan.url,
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
        "qq: inbound media download failed; keeping placeholder",
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
