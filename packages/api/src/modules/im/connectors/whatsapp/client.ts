/**
 * WhatsApp Cloud API HTTP client — lazy raw-fetch Graph client.
 *
 * Node 22 ships global `fetch`/`FormData`/`Blob`, so there is no SDK
 * dependency. Three operations:
 *   - sendGraphMessage: POST /<version>/<PHONE_NUMBER_ID>/messages
 *   - uploadGraphMedia: POST /<version>/<PHONE_NUMBER_ID>/media (multipart)
 *   - getGraphMediaMetadata: GET /<version>/<MEDIA_ID> (resolve step)
 *
 * NO top-level IO — every function takes the credentials it needs and makes
 * the call on demand. The Bearer token is the System User access token; it
 * does not need refreshing (unlike QQ's getAppAccessToken), so there is no
 * token cache here.
 *
 * The `fetchImpl` seam lets tests inject a mock without touching
 * `globalThis.fetch`.
 */

import { WHATSAPP_GRAPH_BASE } from "./types.js"
import type { WhatsappCredentials as Creds } from "./credentials.js"

export type FetchImpl = typeof globalThis.fetch

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Build the per-account Graph API base, e.g.
 * `https://graph.facebook.com/v23.0`.
 */
export function graphApiBase(creds: Pick<Creds, "graphApiVersion">): string {
  return `${WHATSAPP_GRAPH_BASE}/${creds.graphApiVersion}`
}

export interface SendGraphMessageInput {
  creds: Pick<Creds, "accessToken" | "graphApiVersion" | "phoneNumberId">
  /** The fully-shaped message body (text / image / template / reaction…). */
  body: Record<string, unknown>
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

/**
 * POST a single outbound message. Returns the raw `Response` so the caller's
 * error taxonomy (outbound.ts) can inspect status + Graph error body. The
 * `messaging_product: "whatsapp"` field is injected here so every call site
 * doesn't have to remember it.
 */
export async function sendGraphMessage(
  input: SendGraphMessageInput
): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = `${graphApiBase(input.creds)}/${encodeURIComponent(input.creds.phoneNumberId)}/messages`
  return await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      ...input.body,
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
}

export interface UploadGraphMediaInput {
  creds: Pick<Creds, "accessToken" | "graphApiVersion" | "phoneNumberId">
  buffer: Buffer
  /** The media MIME type — sent as both the multipart part type and `type`. */
  mimeType: string
  filename?: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

/**
 * Upload media bytes, returning the raw `Response` (`{ id }` on success).
 * Multipart body: `messaging_product`, `type` (the MIME — included even
 * though some references omit it, matching all OSS adapters), and `file`.
 */
export async function uploadGraphMedia(
  input: UploadGraphMediaInput
): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = `${graphApiBase(input.creds)}/${encodeURIComponent(input.creds.phoneNumberId)}/media`

  const form = new FormData()
  form.append("messaging_product", "whatsapp")
  form.append("type", input.mimeType)
  // Node's FormData accepts a Blob for binary parts. Copy into a fresh
  // Uint8Array so a pooled Buffer's backing ArrayBuffer is not shared (and so
  // the BlobPart type is a plain ArrayBuffer-backed view).
  const bytes = Uint8Array.from(input.buffer)
  form.append(
    "file",
    new Blob([bytes], { type: input.mimeType }),
    input.filename ?? "upload"
  )

  return await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.creds.accessToken}`,
      // NOTE: do NOT set Content-Type — fetch derives the multipart boundary.
    },
    body: form,
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
}

export interface GetGraphMediaMetadataInput {
  creds: Pick<Creds, "accessToken" | "graphApiVersion">
  mediaId: string
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

/**
 * Resolve a media id to its short-lived (~5 min) signed URL + sha256 +
 * size. Returns the raw `Response`; the binary GET (with the Bearer header)
 * is performed by `media.ts` via `downloadToBufferWithLimit`.
 */
export async function getGraphMediaMetadata(
  input: GetGraphMediaMetadataInput
): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch
  const url = `${graphApiBase(input.creds)}/${encodeURIComponent(input.mediaId)}`
  return await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${input.creds.accessToken}` },
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
}
