/**
 * Feishu image/file upload + send.
 *
 * V1 native attachment delivery via Lark's `im.image.create` and
 * `im.file.create`. The flow per attachment:
 *
 *   1. Resolve the source bytes — either fetch CanonicalFileRef.url or
 *      throw if the ref has no addressable source. (We don't yet talk
 *      to Synapse's internal file service; that integration lands when
 *      the chat layer surfaces local uploads as fileId.)
 *   2. Buffer the response (small enough for messaging: Feishu caps
 *      image at 10 MB, file at 30 MB; we enforce 30 MB to fail fast).
 *   3. POST to im.image.create or im.file.create → `image_key` /
 *      `file_key`.
 *   4. Return the key so the caller can render a `msg_type: image|file`
 *      payload and send it via im.message.create / im.message.reply.
 *
 * Errors propagate (no silent fallback to placeholder text) so the
 * outer worker retries via BullMQ. The earlier placeholder behavior is
 * gone — capabilities advertise supportsImage / supportsFile = true now.
 */

import type * as Lark from "@larksuiteoapi/node-sdk"
import type { CanonicalFileRef } from "../../messaging/canonical-message.js"

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024 // 30 MB, Feishu's file cap

async function downloadToBuffer(url: string): Promise<{
  buffer: Buffer
  mime?: string
}> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download attachment ${url}: HTTP ${res.status}`)
  }
  const contentLength = Number(res.headers.get("content-length") || "0")
  if (contentLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment ${url} exceeds ${MAX_ATTACHMENT_BYTES} byte limit (content-length ${contentLength})`
    )
  }
  const arrayBuffer = await res.arrayBuffer()
  if (arrayBuffer.byteLength === 0) {
    throw new Error(`Attachment ${url} is empty`)
  }
  if (arrayBuffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment ${url} exceeds ${MAX_ATTACHMENT_BYTES} byte limit`
    )
  }
  return {
    buffer: Buffer.from(arrayBuffer),
    mime: res.headers.get("content-type") || undefined,
  }
}

function requireUrl(fileRef: CanonicalFileRef, kind: "image" | "file"): string {
  const url = fileRef.url?.trim()
  if (!url) {
    throw new Error(
      `Feishu ${kind} part requires a CanonicalFileRef.url; got fileRef=${JSON.stringify(fileRef)}`
    )
  }
  return url
}

/**
 * Upload an image to Feishu and return its `image_key` for use in an
 * `image` message payload.
 */
export async function uploadFeishuImage(input: {
  client: Lark.Client
  fileRef: CanonicalFileRef
}): Promise<string> {
  const url = requireUrl(input.fileRef, "image")
  const { buffer } = await downloadToBuffer(url)
  const resp = (await input.client.im.image.create({
    data: {
      image_type: "message",
      image: buffer as any,
    },
  })) as { image_key?: string } | null
  const key = resp?.image_key
  if (!key) {
    throw new Error(`Feishu im.image.create returned no image_key for ${url}`)
  }
  return key
}

/**
 * Map a mime / extension hint to one of Feishu's allowed file_type
 * buckets. Falls back to "stream" which accepts arbitrary binary.
 */
export function feishuFileTypeFor(
  fileRef: CanonicalFileRef
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const mime = (fileRef.mime || "").toLowerCase()
  const name = (fileRef.name || "").toLowerCase()

  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf"
  if (mime.includes("mp4") || name.endsWith(".mp4")) return "mp4"
  if (mime.includes("opus") || name.endsWith(".opus")) return "opus"
  if (
    mime.includes("msword") ||
    mime.includes("wordprocessingml") ||
    name.endsWith(".doc") ||
    name.endsWith(".docx")
  ) {
    return "doc"
  }
  if (
    mime.includes("excel") ||
    mime.includes("spreadsheetml") ||
    name.endsWith(".xls") ||
    name.endsWith(".xlsx")
  ) {
    return "xls"
  }
  if (
    mime.includes("powerpoint") ||
    mime.includes("presentationml") ||
    name.endsWith(".ppt") ||
    name.endsWith(".pptx")
  ) {
    return "ppt"
  }
  return "stream"
}

/**
 * Upload a file to Feishu and return its `file_key` for use in a `file`
 * message payload. `fileRef.name` is required — Feishu uses it as the
 * displayed filename.
 */
export async function uploadFeishuFile(input: {
  client: Lark.Client
  fileRef: CanonicalFileRef & { name: string }
}): Promise<string> {
  const url = requireUrl(input.fileRef, "file")
  const { buffer } = await downloadToBuffer(url)
  const resp = (await input.client.im.file.create({
    data: {
      file_type: feishuFileTypeFor(input.fileRef),
      file_name: input.fileRef.name,
      file: buffer as any,
    },
  })) as { file_key?: string } | null
  const key = resp?.file_key
  if (!key) {
    throw new Error(`Feishu im.file.create returned no file_key for ${url}`)
  }
  return key
}
