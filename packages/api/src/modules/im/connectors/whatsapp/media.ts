/**
 * WhatsApp Cloud media — inbound two-step Bearer download + outbound upload.
 *
 * INBOUND (placeholder → real media part):
 *   1. GET graph.facebook.com/<ver>/<MEDIA_ID> (Bearer) →
 *      { url, mime_type, sha256, file_size } — the `url` is valid ~5 min.
 *   2. GET <url> via `downloadToBufferWithLimit({ url, headers:{Authorization:
 *      Bearer}, allowedHosts: WHATSAPP_MEDIA_HOSTS, maxBytes })` — the Bearer
 *      header is only sent to an allowlisted host.
 *   3. verify sha256/size when present.
 *   4. storeFile (lazy file service; origin WHATSAPP_INBOUND_MEDIA_INGEST) →
 *      { sha256 } and replace the placeholder with a real part.
 * Best-effort: any per-part failure keeps the placeholder so a flaky
 * download never blocks ingestion (mirrors qq/inbound-media.ts).
 *
 * OUTBOUND (bytes → media_id):
 *   POST /<PHONE_NUMBER_ID>/media (multipart) → { id }. We prefer
 *   send-by-media_id over by-link. Per-type size caps (plan §5.1) reject
 *   oversize with PermanentTransportError BEFORE the upload.
 *
 * The lazy dynamic-import of the file service keeps `index.ts` IO-free (the
 * register-all contract test never drags the DB in).
 */

import crypto from "node:crypto"
import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import { downloadToBufferWithLimit } from "../../../../infrastructure/storage/index.js"
import {
  PermanentTransportError,
  type ConnectorLogger,
  type InboundEnvelope,
} from "../types.js"
import {
  getGraphMediaMetadata,
  uploadGraphMedia,
  type FetchImpl,
} from "./client.js"
import type { WhatsappCredentials } from "./credentials.js"
import {
  WHATSAPP_MEDIA_HOSTS,
  WHATSAPP_MEDIA_SIZE_LIMITS,
  type WhatsappMediaCategory,
  type WhatsappMediaMetadata,
} from "./types.js"

// ───────────────────────── Inbound store seam ─────────────────────────

/**
 * Lazy default store — imports the file service inside the call so merely
 * importing this module (e.g. via register-all in the connector unit tests)
 * never drags the DB/storage graph in. Copied from qq/inbound-media.ts;
 * origin swapped to WHATSAPP_INBOUND_MEDIA_INGEST.
 */
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
      system: FILE_ORIGIN_SYSTEMS.WHATSAPP_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  return { sha256: record.sha256 }
}

interface WhatsappMediaPlan {
  category: WhatsappMediaCategory
  mediaId: string
  defaultMime: string
  originalName: string
  toPart: (fileRef: CanonicalFileRef) => CanonicalPart
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/**
 * Map an inbound media `system_marker` placeholder (carrying the WhatsApp
 * media id in `original`) to a download plan, or null when it isn't a
 * downloadable media placeholder.
 */
export function planWhatsappMediaDownload(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): WhatsappMediaPlan | null {
  const o = part.original || {}
  const mediaId = strOf(o.media_id)
  if (!mediaId) return null
  const mime = strOf(o.mime_type)
  const name = strOf(o.filename)
  switch (part.marker) {
    case "image_placeholder":
      return {
        category: "image",
        mediaId,
        defaultMime: mime || "image/jpeg",
        originalName: name || "image",
        toPart: (fileRef) => ({ type: "image", fileRef }),
      }
    case "voice_placeholder":
      return {
        category: "audio",
        mediaId,
        defaultMime: mime || "audio/ogg",
        originalName: name || "voice.ogg",
        toPart: (fileRef) => ({ type: "voice", fileRef }),
      }
    case "video_placeholder":
      return {
        category: "video",
        mediaId,
        defaultMime: mime || "video/mp4",
        originalName: name || "video.mp4",
        toPart: (fileRef) => ({ type: "video", fileRef }),
      }
    case "file_placeholder":
      return {
        category: "document",
        mediaId,
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

export interface WhatsappMediaDownloadResult {
  buffer: Buffer
  mime?: string
}

export interface WhatsappMediaEnrichDeps {
  account: Pick<TransportAccountSummary, "workspaceId">
  creds: Pick<WhatsappCredentials, "accessToken" | "graphApiVersion">
  logger?: ConnectorLogger
  fetchImpl?: FetchImpl
  /** Test seam — defaults to the real two-step Bearer download. */
  download?: (input: {
    mediaId: string
    maxBytes: number
  }) => Promise<WhatsappMediaDownloadResult>
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
 * The real two-step Bearer download: resolve media id → signed URL, then GET
 * the bytes with the Bearer header restricted to the Meta media hosts.
 * Verifies sha256 + file_size from the metadata when present.
 */
async function defaultDownloadInboundMedia(input: {
  mediaId: string
  maxBytes: number
  creds: Pick<WhatsappCredentials, "accessToken" | "graphApiVersion">
  fetchImpl?: FetchImpl
}): Promise<WhatsappMediaDownloadResult> {
  const metaRes = await getGraphMediaMetadata({
    creds: input.creds,
    mediaId: input.mediaId,
    fetchImpl: input.fetchImpl,
  })
  if (!metaRes.ok) {
    throw new Error(
      `whatsapp media metadata HTTP ${metaRes.status} for ${input.mediaId}`
    )
  }
  const meta = (await metaRes.json()) as WhatsappMediaMetadata
  const url = strOf(meta.url)
  if (!url) {
    throw new Error(`whatsapp media metadata missing url for ${input.mediaId}`)
  }

  const dl = await downloadToBufferWithLimit({
    url,
    maxBytes: input.maxBytes,
    allowedHosts: [...WHATSAPP_MEDIA_HOSTS],
    headers: { Authorization: `Bearer ${input.creds.accessToken}` },
    timeoutMs: 60_000,
  })

  // Verify sha256 + size when the metadata provided them (integrity).
  const expectedSha = strOf(meta.sha256)
  if (expectedSha) {
    const actual = crypto.createHash("sha256").update(dl.buffer).digest("hex")
    if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new Error(
        `whatsapp media sha256 mismatch for ${input.mediaId} (expected ${expectedSha}, got ${actual})`
      )
    }
  }
  if (
    typeof meta.file_size === "number" &&
    meta.file_size > 0 &&
    dl.buffer.length !== meta.file_size
  ) {
    throw new Error(
      `whatsapp media size mismatch for ${input.mediaId} (expected ${meta.file_size}, got ${dl.buffer.length})`
    )
  }

  return { buffer: dl.buffer, mime: dl.mimeType || strOf(meta.mime_type) }
}

/**
 * Replace inbound media placeholders in `envelope` with real media parts
 * whose bytes have been downloaded into our CAS. Returns the envelope
 * unchanged when there is no media (no IO) or when every download fails.
 */
export async function enrichInboundWhatsappMedia(
  envelope: InboundEnvelope,
  deps: WhatsappMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) => p.type === "system_marker" && planWhatsappMediaDownload(p) != null
  )
  if (!hasMedia) return envelope

  const download =
    deps.download ??
    ((input: { mediaId: string; maxBytes: number }) =>
      defaultDownloadInboundMedia({
        ...input,
        creds: deps.creds,
        fetchImpl: deps.fetchImpl,
      }))
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const plan =
      part.type === "system_marker" ? planWhatsappMediaDownload(part) : null
    if (!plan) {
      out.push(part)
      continue
    }
    try {
      const { buffer, mime } = await download({
        mediaId: plan.mediaId,
        maxBytes: WHATSAPP_MEDIA_SIZE_LIMITS[plan.category],
      })
      const mimeType =
        mime && mime !== "application/octet-stream" ? mime : plan.defaultMime
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.account.workspaceId,
        originalName: plan.originalName,
        mimeType,
        resourceKey: plan.mediaId,
        messageId: envelope.externalMessageId,
      })
      const fileRef: CanonicalFileRef = {
        sha256,
        mimeType,
        name: plan.originalName,
        sizeBytes: buffer.length,
      }
      out.push(plan.toPart(fileRef))
      changed = true
    } catch (err) {
      deps.logger?.warn(
        "whatsapp: inbound media download failed; keeping placeholder",
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

// ───────────────────────── Outbound upload ─────────────────────────

export interface UploadWhatsappMediaInput {
  creds: Pick<
    WhatsappCredentials,
    "accessToken" | "graphApiVersion" | "phoneNumberId"
  >
  buffer: Buffer
  mimeType: string
  category: WhatsappMediaCategory
  filename?: string
  fetchImpl?: FetchImpl
}

/**
 * Upload outbound bytes → media_id. Rejects oversize per the §5.1 caps with
 * PermanentTransportError (no quota-burning attempt). HTTP errors surface as
 * a generic Error — the caller (outbound.ts) classifies them via the error
 * taxonomy.
 */
export async function uploadWhatsappMediaBytes(
  input: UploadWhatsappMediaInput
): Promise<{ mediaId: string }> {
  const cap = WHATSAPP_MEDIA_SIZE_LIMITS[input.category]
  if (input.buffer.length > cap) {
    throw new PermanentTransportError(
      `whatsapp: ${input.category} exceeds size limit (${input.buffer.length} > ${cap} bytes)`,
      { code: "whatsapp_media_too_large" }
    )
  }
  const res = await uploadGraphMedia({
    creds: input.creds,
    buffer: input.buffer,
    mimeType: input.mimeType,
    filename: input.filename,
    fetchImpl: input.fetchImpl,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(
      `whatsapp media upload HTTP ${res.status}: ${text.slice(0, 200)}`
    )
  }
  const json = (await res.json().catch(() => ({}))) as { id?: unknown }
  const mediaId = typeof json.id === "string" ? json.id.trim() : ""
  if (!mediaId) {
    throw new Error("whatsapp media upload returned no id")
  }
  return { mediaId }
}
