/**
 * DingTalk media transfer — inbound download + outbound upload + send shaping.
 *
 * Protocol (verified against the official open-dingtalk SDKs + docs):
 *
 *   INBOUND (downloadCode → bytes), two steps, same for every media type:
 *     1. POST https://api.dingtalk.com/v1.0/robot/messageFiles/download
 *        headers: x-acs-dingtalk-access-token (v1.0 token), Content-Type json
 *        body: { robotCode, downloadCode }  → { downloadUrl }
 *     2. GET <downloadUrl>  (NO auth header — the URL is pre-signed) → bytes
 *     The downloadUrl/downloadCode are short-lived & single-use; fetch now.
 *
 *   OUTBOUND upload (bytes → mediaId):
 *     POST https://oapi.dingtalk.com/media/upload?access_token=<OAPI token>&type=<image|voice|video|file>
 *     multipart/form-data, field "media".  → { errcode, media_id }
 *     The token here is the LEGACY OAPI token in the QUERY param (NOT the
 *     v1.0 header token). media_id is passed THROUGH UNCHANGED (keep the
 *     leading "@"/"$"); it only resolves inside the DingTalk client.
 *
 *   OUTBOUND send: the mediaId goes into a robot sample*Msg msgKey/msgParam
 *     sent through the existing OpenAPI senders (groupMessages/send or
 *     oToMessages/batchSend). sessionWebhook cannot carry media.
 */

import { readDingtalkProviderResponse } from "./response-codec.js"

const MESSAGE_FILES_DOWNLOAD_URL =
  "https://api.dingtalk.com/v1.0/robot/messageFiles/download"
const MEDIA_UPLOAD_URL = "https://oapi.dingtalk.com/media/upload"

// Memory bounds. DingTalk enforces the precise per-type single-shot limits
// server-side (documented as image 1MB / voice 2MB / video 10MB / file 10MB,
// though tenants vary), surfacing an errcode; these caps only stop us from
// buffering an absurd blob into memory.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

export type DingtalkMediaUploadType = "image" | "voice" | "video" | "file"

/** Bytes reader for outbound media; defaults to our content-addressed store. */
export type MediaBytesReader = (sha256: string) => Promise<Buffer>

// ───────────────────────── inbound download ─────────────────────────

export interface DownloadDingtalkMessageFileInput {
  /** v1.0 access token (x-acs-dingtalk-access-token). */
  accessToken: string
  /** Robot client_id / appKey. Required by the download API. */
  robotCode: string
  downloadCode: string
  maxBytes?: number
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Resolve an inbound `downloadCode` to raw bytes via the two-step
 * messageFiles/download → GET flow. Throws on any failure so the caller
 * (best-effort enrich) can keep the placeholder.
 */
export async function downloadDingtalkMessageFile(
  input: DownloadDingtalkMessageFileInput
): Promise<{ buffer: Buffer; mime?: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxBytes = input.maxBytes ?? MAX_DOWNLOAD_BYTES

  // Step 1: downloadCode → temporary signed downloadUrl.
  const step1 = await fetchImpl(MESSAGE_FILES_DOWNLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "*/*",
      "x-acs-dingtalk-access-token": input.accessToken,
    },
    body: JSON.stringify({
      robotCode: input.robotCode,
      downloadCode: input.downloadCode,
    }),
  })
  if (!step1.ok) {
    const body = await step1.text().catch(() => "")
    throw new Error(
      `dingtalk messageFiles/download HTTP ${step1.status}: ${body.slice(0, 200)}`
    )
  }
  const meta = await readDingtalkProviderResponse(step1)
  const downloadUrl =
    typeof meta.downloadUrl === "string" ? meta.downloadUrl.trim() : ""
  if (!downloadUrl) {
    throw new Error(
      `dingtalk messageFiles/download returned no downloadUrl: ${JSON.stringify(meta).slice(0, 200)}`
    )
  }

  // Step 2: GET the pre-signed URL (no auth header) for the raw bytes.
  const step2 = await fetchImpl(downloadUrl, { method: "GET" })
  if (!step2.ok) {
    throw new Error(
      `dingtalk media download GET HTTP ${step2.status} for downloadCode=${input.downloadCode}`
    )
  }
  const arrayBuf = await step2.arrayBuffer()
  if (arrayBuf.byteLength === 0) {
    throw new Error(
      `dingtalk media download for downloadCode=${input.downloadCode} is empty`
    )
  }
  if (arrayBuf.byteLength > maxBytes) {
    throw new Error(
      `dingtalk media download exceeds ${maxBytes} byte limit (downloadCode=${input.downloadCode})`
    )
  }
  const mime = headerContentType(step2.headers)
  return { buffer: Buffer.from(arrayBuf), mime }
}

function headerContentType(headers: Headers): string | undefined {
  const raw = headers.get("content-type")
  if (!raw) return undefined
  const value = raw.split(";")[0]?.trim()
  return value || undefined
}

// ───────────────────────── outbound upload ─────────────────────────

export interface UploadDingtalkMediaInput {
  /** LEGACY OAPI token (gettoken) — goes in the ?access_token= query param. */
  oapiToken: string
  type: DingtalkMediaUploadType
  buffer: Buffer
  filename: string
  mime?: string
  maxBytes?: number
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Upload bytes to oapi.dingtalk.com/media/upload and return the raw media_id
 * (UNCHANGED — keep any leading "@"/"$"). Throws on HTTP / business failure.
 */
export async function uploadDingtalkMedia(
  input: UploadDingtalkMediaInput
): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES
  if (input.buffer.length === 0) {
    throw new Error("dingtalk media upload: empty buffer")
  }
  if (input.buffer.length > maxBytes) {
    throw new Error(
      `dingtalk media upload exceeds ${maxBytes} byte local cap (${input.buffer.length})`
    )
  }
  const url = `${MEDIA_UPLOAD_URL}?access_token=${encodeURIComponent(input.oapiToken)}&type=${input.type}`
  const form = new FormData()
  // Field name MUST be "media"; multipart boundary is set by fetch from the
  // FormData body. Use a Blob so the part carries a filename + content-type.
  const blob = new Blob([new Uint8Array(input.buffer)], {
    type: input.mime || "application/octet-stream",
  })
  form.append("media", blob, input.filename)
  const resp = await fetchImpl(url, { method: "POST", body: form })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(
      `dingtalk media/upload HTTP ${resp.status}: ${body.slice(0, 200)}`
    )
  }
  const data = await readDingtalkProviderResponse(resp)
  const mediaId = typeof data.media_id === "string" ? data.media_id.trim() : ""
  if (!mediaId) {
    throw new Error(
      `dingtalk media/upload returned no media_id: ${JSON.stringify(data).slice(0, 200)}`
    )
  }
  return mediaId
}

// ───────────────────────── outbound send shaping ─────────────────────────

export interface DingtalkMediaSend {
  /** /media/upload `type` for this kind of part. */
  uploadType: DingtalkMediaUploadType
  msgKey: string
  /** Build the JSON-stringified msgParam given the uploaded mediaId. */
  buildMsgParam: (mediaId: string) => string
  /** Default filename hint for the upload part. */
  filename: string
  /** Default mime when the fileRef carries none. */
  defaultMime: string
}

/** Pick the extension (lowercased, no dot) from a filename, or "". */
export function extensionOf(name: string | undefined): string {
  if (!name) return ""
  const dot = name.lastIndexOf(".")
  if (dot < 0 || dot === name.length - 1) return ""
  return name.slice(dot + 1).toLowerCase()
}
