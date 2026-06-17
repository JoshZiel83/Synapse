/**
 * DingTalk inbound media enrichment.
 *
 * `normalize.ts` is pure and emits a `system_marker` placeholder for each
 * non-text payload (picture/audio/video/file, and richText embedded images),
 * stashing the raw inbound `content` in `original`. This module performs the
 * side-effecting second pass: resolve each `downloadCode` to bytes (the
 * two-step messageFiles/download → GET flow), persist them through the central
 * file service (content-addressed, deduped), and replace the placeholder with
 * a real `image`/`voice`/`video`/`file` CanonicalPart carrying a `{sha256}`
 * fileRef — the unified handle the chat layer serves bytes from.
 *
 * Best-effort: any per-part failure keeps the original placeholder so a flaky
 * download never blocks message ingestion. Runs after `normalize`, so
 * `normalize` stays pure. Mirrors the Feishu reference (inbound-media.ts).
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { ConnectorLogger, InboundEnvelope } from "../types.js"
import { getAccessToken } from "./client.js"
import { getDingtalkCredentialsOrThrow } from "./credentials.js"
import { downloadDingtalkMessageFile } from "./media.js"

async function defaultStoreInboundMedia(input: {
  buffer: Buffer
  workspaceId: string
  originalName: string
  mimeType: string
  downloadCode: string
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
      system: FILE_ORIGIN_SYSTEMS.DINGTALK_INBOUND_MEDIA_INGEST,
      externalResourceKey: input.downloadCode,
      details: { messageId: input.messageId },
    }),
  })
  return { sha256: record.sha256 }
}

interface DownloadSpec {
  downloadCode: string
  defaultMime: string
  originalName: string
  toPart: (fileRef: CanonicalFileRef) => CanonicalPart
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}
function numOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Map a media `system_marker` placeholder to the list of downloads it implies.
 * A picture/audio/video/file marker yields one download; a richText image
 * marker can yield several (one per embedded image segment).
 */
export function planDingtalkMediaDownloads(
  part: Extract<CanonicalPart, { type: "system_marker" }>
): DownloadSpec[] {
  const original = (part.original || {}) as Record<string, unknown>
  switch (part.marker) {
    case "image_placeholder": {
      // richText embeds images as an array of {downloadCode, type:"picture"}.
      const richText = original.richText
      if (Array.isArray(richText)) {
        const specs: DownloadSpec[] = []
        for (const seg of richText) {
          if (typeof seg !== "object" || seg === null) continue
          const code = strOf((seg as { downloadCode?: unknown }).downloadCode)
          if (!code) continue
          specs.push({
            downloadCode: code,
            defaultMime: "image/jpeg",
            originalName: "image",
            toPart: (fileRef) => ({ type: "image", fileRef }),
          })
        }
        return specs
      }
      const code = strOf(original.downloadCode)
      if (!code) return []
      return [
        {
          downloadCode: code,
          defaultMime: "image/jpeg",
          originalName: "image",
          toPart: (fileRef) => ({ type: "image", fileRef }),
        },
      ]
    }
    case "voice_placeholder": {
      const code = strOf(original.downloadCode)
      if (!code) return []
      return [
        {
          downloadCode: code,
          defaultMime: "audio/amr",
          originalName: "voice.amr",
          toPart: (fileRef) => ({ type: "voice", fileRef }),
        },
      ]
    }
    case "video_placeholder": {
      const code = strOf(original.downloadCode)
      if (!code) return []
      // DingTalk video duration is a string of seconds.
      const durationSec = numOf(original.duration)
      const durationMs =
        durationSec != null ? Math.round(durationSec * 1000) : undefined
      return [
        {
          downloadCode: code,
          defaultMime: "video/mp4",
          originalName: "video.mp4",
          toPart: (fileRef) => ({
            type: "video",
            fileRef,
            ...(durationMs != null ? { durationMs } : {}),
          }),
        },
      ]
    }
    case "file_placeholder": {
      const code = strOf(original.downloadCode)
      if (!code) return []
      const name = strOf(original.fileName) || "file"
      return [
        {
          downloadCode: code,
          defaultMime: "application/octet-stream",
          originalName: name,
          toPart: (fileRef) => ({
            type: "file",
            fileRef: { ...fileRef, name: fileRef.name || name },
          }),
        },
      ]
    }
    default:
      return []
  }
}

export interface DingtalkMediaEnrichDeps {
  account: TransportAccountSummary
  logger?: ConnectorLogger
  /** Test seam — defaults to the real messageFiles/download two-step flow. */
  download?: (input: {
    downloadCode: string
  }) => Promise<{ buffer: Buffer; mime?: string }>
  /** Test seam — defaults to the central file service (CAS, deduped). */
  store?: (input: {
    buffer: Buffer
    workspaceId: string
    originalName: string
    mimeType: string
    downloadCode: string
    messageId: string
  }) => Promise<{ sha256: string }>
}

/**
 * Replace inbound media placeholders in `envelope` with real media parts whose
 * bytes have been downloaded and stored. Returns the original envelope
 * unchanged when there is no media (no token/IO incurred) or when every
 * download fails.
 */
export async function enrichInboundDingtalkMedia(
  envelope: InboundEnvelope,
  deps: DingtalkMediaEnrichDeps
): Promise<InboundEnvelope> {
  const parts = envelope.message.parts
  const hasMedia = parts.some(
    (p) =>
      p.type === "system_marker" && planDingtalkMediaDownloads(p).length > 0
  )
  if (!hasMedia) return envelope

  // robotCode is required by the download API; the inbound payload seeds it
  // into endpoint metadata (normalize), with the account clientId as fallback.
  const robotCode =
    strOf(
      (envelope.endpointMetadata as Record<string, unknown> | undefined)
        ?.robotCode
    ) ?? getDingtalkCredentialsOrThrow(deps.account).clientId

  let token: string | undefined
  const download =
    deps.download ??
    (async ({ downloadCode }) => {
      token ??= await getAccessToken(deps.account)
      return downloadDingtalkMessageFile({
        accessToken: token,
        robotCode,
        downloadCode,
      })
    })
  const store = deps.store ?? defaultStoreInboundMedia

  const out: CanonicalPart[] = []
  let changed = false
  for (const part of parts) {
    const specs =
      part.type === "system_marker" ? planDingtalkMediaDownloads(part) : []
    if (specs.length === 0) {
      out.push(part)
      continue
    }
    const replacements: CanonicalPart[] = []
    let anyFailed = false
    for (const spec of specs) {
      try {
        const { buffer, mime } = await download({
          downloadCode: spec.downloadCode,
        })
        const mimeType = mime || spec.defaultMime
        const { sha256 } = await store({
          buffer,
          workspaceId: deps.account.workspaceId,
          originalName: spec.originalName,
          mimeType,
          downloadCode: spec.downloadCode,
          messageId: envelope.externalMessageId,
        })
        replacements.push(
          spec.toPart({
            sha256,
            mimeType,
            name: spec.originalName,
            sizeBytes: buffer.length,
          })
        )
      } catch (err) {
        anyFailed = true
        deps.logger?.warn(
          "dingtalk: inbound media download failed; keeping placeholder",
          {
            marker: part.type === "system_marker" ? part.marker : undefined,
            err: String(err),
          }
        )
      }
    }
    // Per-item granularity (matching the Feishu reference): emit EVERY
    // successfully-downloaded media part rather than discarding the whole
    // batch when one fails. A multi-image richText placeholder expands to N
    // specs — if some fail, keep the parts that succeeded (their bytes are
    // already in CAS) and append one residual placeholder so the missing
    // image(s) still surface as "[图片]". When nothing succeeded, keep the
    // original placeholder untouched so a transient failure degrades cleanly.
    if (replacements.length > 0) {
      out.push(...replacements)
      if (anyFailed) out.push(part)
      changed = true
    } else {
      out.push(part)
    }
  }

  if (!changed) return envelope
  return { ...envelope, message: buildCanonicalMessage(out) }
}
