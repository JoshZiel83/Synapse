/**
 * Feishu image/file upload + send.
 *
 * V1 native attachment delivery via Lark's `im.image.create` and
 * `im.file.create`. The flow per attachment:
 *
 *   1. Read the source bytes from OUR content-addressed store by
 *      `fileRef.sha256` (the unified handle — the connector owns the
 *      third-party upload; nothing hands it a transient URL). Fail fast
 *      on a declared `sizeBytes` over the per-kind cap, then verify the
 *      actual byte length (Feishu caps images at 10 MB, files at 30 MB).
 *   2. POST to im.image.create or im.file.create → `image_key` /
 *      `file_key`.
 *   3. Return the key so the caller can render a `msg_type: image|file`
 *      payload and send it via im.message.create / im.message.reply.
 *
 * Errors propagate (no silent fallback to placeholder text) so the
 * outer worker retries via BullMQ. The earlier placeholder behavior is
 * gone — capabilities advertise supportsImage / supportsFile = true now.
 */

import type * as Lark from "@larksuiteoapi/node-sdk"
import { readCasBlob } from "../../../../infrastructure/storage/index.js"
import type { CanonicalFileRef } from "../../messaging/canonical-message.js"

// Feishu enforces different ceilings per kind: images ≤ 10 MB, files ≤ 30 MB.
// Using a single 30 MB cap let a 10–30 MB image pass the local guard only to be
// rejected server-side after a wasted download + upload round-trip.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // Feishu im.image.create cap
const MAX_FILE_BYTES = 30 * 1024 * 1024 // Feishu im.file.create cap
// Feishu caps message-resource downloads at 100 MB (im-v1/message-resource/get).
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024

/** Bytes reader for outbound media; defaults to our content-addressed store. */
export type MediaBytesReader = (sha256: string) => Promise<Buffer>

/**
 * Read the bytes for an outbound media part from our CAS by `sha256` and
 * enforce the per-kind size cap. Fails fast on a declared oversize before
 * touching the bytes, then verifies the actual length.
 */
async function resolveMediaBytes(
  fileRef: CanonicalFileRef,
  kind: "image" | "file",
  maxBytes: number,
  readBytes: MediaBytesReader
): Promise<Buffer> {
  const sha256 = fileRef.sha256?.trim()
  if (!sha256) {
    throw new Error(
      `Feishu ${kind} part requires a CanonicalFileRef.sha256; got fileRef=${JSON.stringify(fileRef)}`
    )
  }
  if (fileRef.sizeBytes != null && fileRef.sizeBytes > maxBytes) {
    throw new Error(
      `Feishu ${kind} exceeds ${maxBytes} byte limit (sizeBytes ${fileRef.sizeBytes})`
    )
  }
  const buffer = await readBytes(sha256)
  if (buffer.length === 0) {
    throw new Error(`Feishu ${kind} resource ${sha256} is empty`)
  }
  if (buffer.length > maxBytes) {
    throw new Error(`Feishu ${kind} exceeds ${maxBytes} byte limit`)
  }
  return buffer
}

/**
 * Upload an image to Feishu and return its `image_key` for use in an
 * `image` message payload.
 */
export async function uploadFeishuImage(input: {
  client: Lark.Client
  fileRef: CanonicalFileRef
  /** Test seam — defaults to reading our CAS by sha256. */
  readBytes?: MediaBytesReader
}): Promise<string> {
  const buffer = await resolveMediaBytes(
    input.fileRef,
    "image",
    MAX_IMAGE_BYTES,
    input.readBytes ?? readCasBlob
  )
  const resp = (await input.client.im.image.create({
    data: {
      image_type: "message",
      image: buffer as any,
    },
  })) as { image_key?: string } | null
  const key = resp?.image_key
  if (!key) {
    throw new Error(
      `Feishu im.image.create returned no image_key for sha256=${input.fileRef.sha256}`
    )
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
  const mime = (fileRef.mimeType || "").toLowerCase()
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
  /** Test seam — defaults to reading our CAS by sha256. */
  readBytes?: MediaBytesReader
}): Promise<string> {
  const buffer = await resolveMediaBytes(
    input.fileRef,
    "file",
    MAX_FILE_BYTES,
    input.readBytes ?? readCasBlob
  )
  const resp = (await input.client.im.file.create({
    data: {
      file_type: feishuFileTypeFor(input.fileRef),
      file_name: input.fileRef.name,
      file: buffer as any,
    },
  })) as { file_key?: string } | null
  const key = resp?.file_key
  if (!key) {
    throw new Error(
      `Feishu im.file.create returned no file_key for sha256=${input.fileRef.sha256}`
    )
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
