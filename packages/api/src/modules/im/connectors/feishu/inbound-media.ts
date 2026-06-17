/**
 * Feishu inbound media enrichment.
 *
 * `normalize.ts` is pure and emits a `system_marker` placeholder for each
 * non-text payload (image / audio / media(video) / file), stashing the
 * resource key in `original`. This module performs the side-effecting second
 * pass: download the actual bytes via the message-resource endpoint, persist
 * them through the central file service (content-addressed, deduped), and
 * replace the placeholder with a real `image`/`voice`/`video`/`file`
 * CanonicalPart carrying a `{fileId, url}` fileRef.
 *
 * That fileRef is what `messaging/canonical-encoding.ts` needs to emit a
 * `file_ref` content block (it drops media parts lacking fileId+url), which is
 * how the chat layer surfaces the attachment to the agent. Without this pass
 * the agent only ever sees the "[图片]" / "[文件]" placeholder text.
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
import { downloadFeishuMessageResource } from "./attachments.js"
import { createFeishuClient } from "./client.js"

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
      system: FILE_ORIGIN_SYSTEMS.FEISHU_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.resourceKey,
      details: { messageId: input.messageId },
    }),
  })
  // The content-addressed sha256 is the unified handle: encode persists it as
  // a file_ref item part and the chat layer serves bytes by /content/:sha256.
  return { sha256: record.sha256 }
}

type ResourceType = "image" | "file"

interface MediaPlan {
  /** `type` query param for the message-resource endpoint. */
  resourceType: ResourceType
  /** image_key (image messages) or file_key (audio/media/file messages). */
  fileKey: string
  defaultMime: string
  originalName: string
  toPart: (fileRef: CanonicalFileRef) => CanonicalPart
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}
function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/**
 * Map a media `system_marker` to a download plan, or null if it isn't a
 * downloadable media placeholder (or the resource key is missing).
 */
export function planFeishuMediaDownload(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): MediaPlan | null {
  const o = part.original || {}
  switch (part.marker) {
    case "image_placeholder": {
      const fileKey = strOf(o.image_key)
      if (!fileKey) return null
      return {
        resourceType: "image",
        fileKey,
        defaultMime: "image/jpeg",
        originalName: "image",
        toPart: (fileRef) => ({ type: "image", fileRef }),
      }
    }
    case "voice_placeholder": {
      const fileKey = strOf(o.file_key)
      if (!fileKey) return null
      const durationMs = numOf(o.duration)
      return {
        resourceType: "file",
        fileKey,
        defaultMime: "audio/opus",
        originalName: "voice.opus",
        toPart: (fileRef) => ({
          type: "voice",
          fileRef,
          ...(durationMs != null ? { durationMs } : {}),
        }),
      }
    }
    case "video_placeholder": {
      const fileKey = strOf(o.file_key)
      if (!fileKey) return null
      const durationMs = numOf(o.duration)
      return {
        resourceType: "file",
        fileKey,
        defaultMime: "video/mp4",
        originalName: "video.mp4",
        toPart: (fileRef) => ({
          type: "video",
          fileRef,
          ...(durationMs != null ? { durationMs } : {}),
        }),
      }
    }
    case "file_placeholder": {
      const fileKey = strOf(o.file_key)
      if (!fileKey) return null
      const name = strOf(o.file_name) || "file"
      return {
        resourceType: "file",
        fileKey,
        defaultMime: "application/octet-stream",
        originalName: name,
        toPart: (fileRef) => ({
          type: "file",
          fileRef: { ...fileRef, name: fileRef.name || name },
        }),
      }
    }
    default:
      return null
  }
}

export interface FeishuMediaEnrichDeps {
  account: TransportAccountSummary
  logger?: ConnectorLogger
  /** Test seam — defaults to a real message-resource download. */
  download?: (input: {
    messageId: string
    fileKey: string
    type: ResourceType
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
 * Replace inbound media placeholders in `envelope` with real media parts whose
 * bytes have been downloaded and stored. Returns the original envelope
 * unchanged when there is no media (no client/IO incurred) or when every
 * download fails.
 */
export async function enrichInboundFeishuMedia(
  envelope: InboundEnvelope,
  deps: FeishuMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) => p.type === "system_marker" && planFeishuMediaDownload(p) != null
  )
  if (!hasMedia) return envelope

  let client: ReturnType<typeof createFeishuClient> | undefined
  const download =
    deps.download ??
    ((input) => {
      client ??= createFeishuClient(deps.account)
      return downloadFeishuMessageResource({ client, ...input })
    })
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const plan =
      part.type === "system_marker" ? planFeishuMediaDownload(part) : null
    if (!plan) {
      out.push(part)
      continue
    }
    try {
      const { buffer, mime } = await download({
        messageId: envelope.externalMessageId,
        fileKey: plan.fileKey,
        type: plan.resourceType,
      })
      const mimeType = mime || plan.defaultMime
      const { sha256 } = await store({
        buffer,
        workspaceId: deps.account.workspaceId,
        originalName: plan.originalName,
        mimeType,
        resourceKey: plan.fileKey,
        messageId: envelope.externalMessageId,
      })
      out.push(
        plan.toPart({
          sha256,
          mimeType,
          name: plan.originalName,
          sizeBytes: buffer.length,
        })
      )
      changed = true
    } catch (err) {
      deps.logger?.warn(
        "feishu: inbound media download failed; keeping placeholder",
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
