/**
 * QQ single-step media upload (Stage 5).
 *
 * Strategy:
 *   - If the source has a public URL the QQ CDN can reach, send
 *     `{file_type, url, srv_send_msg:false}` to the upload endpoint
 *     and let the platform pull from us.
 *   - Otherwise (we have raw bytes), send `{file_type, file_data}`
 *     with base64-encoded bytes.
 *
 * Endpoint:
 *   - C2C  → POST /v2/users/{openid}/files
 *   - group → POST /v2/groups/{group_openid}/files
 *
 * On success the API returns `{file_uuid, file_info, ttl}` — we cache
 * `file_info` keyed by content hash so a repeat send of the same image
 * (e.g. the same TTS waveform) doesn't re-upload.
 *
 * Out of scope here:
 *   - chunked upload via /upload_prepare + COS PUT + /upload_part_finish
 *     (Stage 5.5 — kept off the critical path for v1 because v1 users
 *     mostly hit the single-step path with sub-30MB images).
 *   - The 2GB daily quota — surfaces as biz code 40093002 which we map
 *     to PermanentTransportError(qq_40093002).
 */

import crypto from "node:crypto"
import { qqApiFetch } from "./client.js"
import { downloadToBufferWithLimit } from "../../../../infrastructure/storage/index.js"
import {
  QQ_FILE_TYPE,
  QQ_INBOUND_MEDIA_HOSTS,
  QQ_UPLOAD_SIZE_LIMITS,
  type QqFileType,
} from "./media-constants.js"
import { getCachedFileInfo, setCachedFileInfo } from "./upload-cache.js"
import { redis } from "../../../../infrastructure/redis/index.js"
import { PermanentTransportError, RetryableTransportError } from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"
import {
  extractQqProviderBizCode,
  parseQqUploadSuccessResponse,
} from "./response-codec.js"

export interface UploadSource {
  /** Either a URL the platform can pull, or in-memory bytes. */
  url?: string
  buffer?: Buffer
  /** mime hint used to validate file_type when URL-source bytes aren't local. */
  mime?: string
}

export interface UploadResult {
  fileInfo: string
  fileUuid?: string
  cached: boolean
}

export interface UploadOptions {
  account: Pick<TransportAccountSummary, "id" | "credentials">
  scope: "c2c" | "group"
  /** openid for c2c, group_openid for group. */
  targetId: string
  fileType: QqFileType
  source: UploadSource
}

/**
 * Upload media or return a cached file_info if we've sent the same
 * content recently. The cache key is content-hashed so two distinct
 * uploads of the same bytes share a token.
 */
export async function uploadQqMedia(
  opts: UploadOptions
): Promise<UploadResult> {
  // Group-file is documented as "暂不开放" on the QQ wiki for v1.
  // Fail loud (no quota burn) so operators see the rejection in dashboards.
  if (opts.scope === "group" && opts.fileType === QQ_FILE_TYPE.FILE) {
    throw new PermanentTransportError(
      "qq: group_openid + file_type=4 (file) is not opened by the platform",
      { code: "qq_group_file_not_supported" }
    )
  }

  // Hash the content (bytes or URL string) so cache hits work for both
  // url-mode and inline-bytes sends of the same payload.
  let md5: string
  let bytes: Buffer | undefined
  if (opts.source.buffer) {
    bytes = opts.source.buffer
    md5 = hashBuffer(bytes)
  } else if (opts.source.url) {
    // We hash the URL itself; if two distinct URLs serve the same bytes
    // we cache them separately, which is fine and avoids a download just
    // to compute the hash.
    md5 = hashString(opts.source.url)
  } else {
    throw new PermanentTransportError("qq: upload requires url or buffer", {
      code: "qq_invalid_upload_source",
    })
  }

  const cached = await getCachedFileInfo(redis, {
    accountId: opts.account.id,
    scope: opts.scope,
    targetId: opts.targetId,
    fileType: opts.fileType,
    md5,
  })
  if (cached) {
    return { fileInfo: cached, cached: true }
  }

  // Validate size cap before bothering the platform.
  if (bytes && bytes.length > QQ_UPLOAD_SIZE_LIMITS[opts.fileType]) {
    throw new PermanentTransportError(
      `qq: upload exceeds size limit (${bytes.length} > ${QQ_UPLOAD_SIZE_LIMITS[opts.fileType]} bytes for file_type=${opts.fileType})`,
      { code: "qq_upload_too_large" }
    )
  }

  const body = bytes
    ? {
        file_type: opts.fileType,
        file_data: bytes.toString("base64"),
        srv_send_msg: false,
      }
    : {
        file_type: opts.fileType,
        url: opts.source.url,
        srv_send_msg: false,
      }
  const url =
    opts.scope === "c2c"
      ? `/v2/users/${encodeURIComponent(opts.targetId)}/files`
      : `/v2/groups/${encodeURIComponent(opts.targetId)}/files`

  const res = await qqApiFetch(opts.account, url, {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await safeText(res)
    const code = extractBizCode(text)
    if (code === 40093002) {
      throw new PermanentTransportError(
        "qq: account hit 2GB daily upload limit (40093002)",
        { code: "qq_40093002" }
      )
    }
    if (res.status >= 500 || code === 304082 || code === 304083) {
      throw new RetryableTransportError(
        `qq upload retryable: ${res.status} ${text.slice(0, 120)}`
      )
    }
    throw new PermanentTransportError(
      `qq upload failed: ${res.status} ${text.slice(0, 200)}`,
      { code: code ? `qq_${code}` : `qq_http_${res.status}` }
    )
  }
  const json = parseQqUploadSuccessResponse(await safeJson(res))
  if (!json) {
    throw new PermanentTransportError("qq upload returned no file_info", {
      code: "qq_missing_file_info",
    })
  }
  await setCachedFileInfo(redis, {
    accountId: opts.account.id,
    scope: opts.scope,
    targetId: opts.targetId,
    fileType: opts.fileType,
    md5,
    fileInfo: json.fileInfo,
  })
  return { fileInfo: json.fileInfo, fileUuid: json.fileUuid, cached: false }
}

/**
 * Download remote media (e.g. an HTTP url from an actor's tool output)
 * into a buffer for inline-base64 upload. Wraps the safe downloader so
 * QQ outbound never silently reads unbounded bytes.
 */
export async function downloadForQqUpload(params: {
  url: string
  fileType: QqFileType
}): Promise<Buffer> {
  const downloaded = await downloadToBufferWithLimit({
    url: params.url,
    maxBytes: QQ_UPLOAD_SIZE_LIMITS[params.fileType],
    allowedHosts: QQ_INBOUND_MEDIA_HOSTS,
    timeoutMs: 60_000,
  })
  return downloaded.buffer
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash("md5").update(buf).digest("hex")
}

function hashString(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex")
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function extractBizCode(text: string): number | undefined {
  return extractQqProviderBizCode(text)
}
