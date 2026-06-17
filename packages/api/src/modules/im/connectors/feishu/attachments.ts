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
 *   2. Stream the response, aborting once the per-kind cap is exceeded
 *      (Feishu caps images at 10 MB and files at 30 MB) so a hostile or
 *      misdeclared Content-Length can't force an unbounded buffer.
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

// Feishu enforces different ceilings per kind: images ≤ 10 MB, files ≤ 30 MB.
// Using a single 30 MB cap let a 10–30 MB image pass the local guard only to be
// rejected server-side after a wasted download + upload round-trip.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // Feishu im.image.create cap
const MAX_FILE_BYTES = 30 * 1024 * 1024 // Feishu im.file.create cap
// Feishu caps message-resource downloads at 100 MB (im-v1/message-resource/get).
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024

async function downloadToBuffer(
  url: string,
  maxBytes: number
): Promise<{ buffer: Buffer; mime?: string }> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download attachment ${url}: HTTP ${res.status}`)
  }
  // Content-Length is only an early-exit hint — it is absent under chunked
  // Transfer-Encoding and can be understated by a hostile server. The
  // streaming byte count below is the authoritative guard, and it aborts the
  // download instead of buffering an unbounded body fully into memory.
  const declared = Number(res.headers.get("content-length") || "0")
  if (declared > maxBytes) {
    throw new Error(
      `Attachment ${url} exceeds ${maxBytes} byte limit (content-length ${declared})`
    )
  }
  const mime = res.headers.get("content-type") || undefined
  if (!res.body) {
    throw new Error(`Attachment ${url} is empty`)
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Attachment ${url} exceeds ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }
  if (total === 0) {
    throw new Error(`Attachment ${url} is empty`)
  }
  return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))), mime }
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
  const { buffer } = await downloadToBuffer(url, MAX_IMAGE_BYTES)
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
  const { buffer } = await downloadToBuffer(url, MAX_FILE_BYTES)
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

function headerContentType(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  const h = headers as Record<string, unknown> & {
    get?: (k: string) => unknown
  }
  const raw =
    typeof h.get === "function"
      ? h.get("content-type")
      : (h["content-type"] ?? h["Content-Type"])
  if (typeof raw !== "string") return undefined
  const value = raw.split(";")[0]?.trim()
  return value || undefined
}

/**
 * Download a resource attached to an INBOUND message (image / audio / video /
 * file) via GET /open-apis/im/v1/messages/:message_id/resources/:file_key.
 *
 * `type` MUST be "image" for an image message's image_key and "file" for the
 * file_key of audio / media(video) / file messages — the endpoint rejects the
 * wrong pairing (im/v1/images/:image_key only serves bot-uploaded images, not
 * user-sent ones). Streams the response and aborts past Feishu's 100 MB cap so
 * a large resource can't be buffered unbounded into memory.
 */
export async function downloadFeishuMessageResource(input: {
  client: Lark.Client
  messageId: string
  fileKey: string
  type: "image" | "file"
  maxBytes?: number
}): Promise<{ buffer: Buffer; mime?: string }> {
  const maxBytes = input.maxBytes ?? MAX_RESOURCE_BYTES
  const res = await input.client.im.messageResource.get({
    path: { message_id: input.messageId, file_key: input.fileKey },
    params: { type: input.type },
  })
  const stream = res.getReadableStream()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) {
        stream.destroy?.()
        throw new Error(
          `Feishu resource ${input.fileKey} exceeds ${maxBytes} byte limit`
        )
      }
      chunks.push(buf)
    }
  } finally {
    stream.destroy?.()
  }
  if (total === 0) {
    throw new Error(`Feishu resource ${input.fileKey} is empty`)
  }
  return { buffer: Buffer.concat(chunks), mime: headerContentType(res.headers) }
}
