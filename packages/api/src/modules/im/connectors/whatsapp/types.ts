/**
 * WhatsApp Business Cloud API — constant + type vocabulary.
 *
 * Sourced from the Meta Graph API docs (Cloud API / WhatsApp Business
 * Platform) and centralized here so:
 *   - connector files import names instead of magic strings/numbers
 *   - the Graph API version bump lives in ONE place (default v25.0; see the
 *     research-uncertainty note in docs plan §8 — re-check currency at build
 *     time)
 *   - tests reference the same constants the runtime uses
 *
 * NO top-level IO: this module is pure data + type declarations.
 */

// ───────────────────────── Graph API base ─────────────────────────

/** Graph API host. The version segment is supplied per-account. */
export const WHATSAPP_GRAPH_BASE = "https://graph.facebook.com"

/**
 * Default Graph API version when the credential omits one.
 *
 * v25.0 is the current stable release (shipped 2026-02-18), verified against
 * Meta's Graph API changelog (https://developers.facebook.com/docs/graph-api/changelog).
 * Meta keeps a version callable for ~2 years; per-account override still works.
 */
export const WHATSAPP_DEFAULT_GRAPH_VERSION = "v25.0"

/**
 * Hosts Meta serves inbound media bytes from. The Bearer token is only sent
 * to an allowlisted host (`downloadToBufferWithLimit({ allowedHosts })`), so
 * a redirect can never leak the Graph token to an arbitrary host. The
 * resolved media URL (from `GET /<MEDIA_ID>`) commonly lives on
 * `lookaside.fbsbx.com`; `mmg.whatsapp.net` + `media.*.fna.whatsapp.net` and
 * the `scontent` CDN are the other observed origins. List them explicitly —
 * subdomains are NOT auto-allowed by the downloader.
 *
 * ⚠ Empirical: Meta does not document a stable media-host list and may add
 * CDN hosts. If legitimate inbound media starts failing host-allowlist, add
 * the observed host here. // verify in live sandbox
 */
export const WHATSAPP_MEDIA_HOSTS: readonly string[] = [
  "lookaside.fbsbx.com",
  "mmg.whatsapp.net",
  "media.whatsapp.net",
  "scontent.whatsapp.net",
]

// ───────────────────────── Per-type size caps (plan §5.1) ─────────────────────────

/**
 * Cloud API media size ceilings (bytes), enforced per `WhatsappMediaCategory`
 * on both outbound upload (media.ts) and inbound download (media.ts).
 *
 *   - image  5 MB  — also the enforced cap for INBOUND stickers, which
 *                    normalize maps to `image_placeholder` → category `image`
 *                    (there is no `sticker` category on any enforced path, so
 *                    the static 100 KB / animated 500 KB split is NOT applied).
 *   - audio  16 MB — applied to both voice notes and regular audio.
 *   - video  16 MB
 *   - document 8 MB — capped well below Meta's 100 MB document ceiling because
 *                    both outbound upload (`readContentBuffer`) and inbound
 *                    download read the whole file into memory; on the
 *                    concurrency-1 worker a 100 MB inline read + copy is an OOM
 *                    risk. 8 MB keeps a single document send/receive
 *                    inline-safe. Raise only alongside a streaming upload path.
 *
 * Oversize → reject (outbound: PermanentTransportError, no upload attempt;
 * inbound: keep the placeholder, skip the download).
 *
 * NOTE: there is deliberately NO `sticker` cap constant — see the image note
 * above. Adding one would be dead, since no enforcement path ever resolves to
 * a `sticker` category.
 */
export const WHATSAPP_MEDIA_SIZE_LIMITS = {
  image: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 8 * 1024 * 1024,
} as const

export type WhatsappMediaCategory = keyof typeof WHATSAPP_MEDIA_SIZE_LIMITS

// ───────────────────────── Error codes (plan §4.4) ─────────────────────────

/**
 * Retryable Cloud API error codes: throughput / pair-rate / business /
 * app-level rate limits. The worker only special-cases
 * `PermanentTransportError`; a bare throw / RetryableTransportError both
 * retry, so membership here means "throw (retryable)".
 */
export const WHATSAPP_RETRYABLE_ERROR_CODES: ReadonlySet<number> = new Set([
  130429, // rate limit hit (throughput)
  131056, // (business account) pair rate limit
  80007, // rate limit issues (business)
  4, // application request limit reached
])

/**
 * Permanent Cloud API error codes: re-engagement window, undeliverable, bad
 * media, template errors. Mapped to PermanentTransportError so BullMQ stops
 * retrying immediately.
 */
export const WHATSAPP_PERMANENT_ERROR_CODES: ReadonlySet<number> = new Set([
  131047, // re-engagement message — 24h window closed
  131026, // message undeliverable
  131053, // media upload error (bad MIME / corrupt)
])

/**
 * Template-family errors (132xxx) are all permanent. Tested by prefix
 * rather than enumerated.
 */
export function isWhatsappTemplateErrorCode(code: number): boolean {
  return code >= 132000 && code <= 132999
}

/**
 * Account-restricted codes. Permanent, but their exact semantics are
 * EMPIRICAL — confirm against a live sandbox before relying on the mapping.
 * // verify in live sandbox
 */
export const WHATSAPP_PERMANENT_EMPIRICAL_ERROR_CODES: ReadonlySet<number> =
  new Set([
    368, // temporarily blocked for policy violations (treated permanent)
    131031, // account has been locked/restricted
  ])

/**
 * The 24h-window code we synthesize when the window-gate rejects a free-form
 * send locally (before any HTTP call). Mirrors Meta's 131047 so dashboards
 * see a consistent code whether the rejection is local or remote.
 */
export const WHATSAPP_RE_ENGAGEMENT_ERROR_CODE = 131047

// ───────────────────────── Message-object TS interfaces ─────────────────────────

/** A single inbound message object (`value.messages[]`). */
export interface WhatsappInboundMessage {
  /** wamid — the dedup key + externalMessageId. */
  id?: string
  /** Sender wa_id (E.164 without +). */
  from?: string
  /** Unix SECONDS as a string. → fromUnixSeconds(...). */
  timestamp?: string
  type?: string
  text?: { body?: string }
  image?: WhatsappInboundMedia
  audio?: WhatsappInboundMedia & { voice?: boolean }
  video?: WhatsappInboundMedia
  document?: WhatsappInboundMedia & { filename?: string }
  sticker?: WhatsappInboundMedia & { animated?: boolean }
  reaction?: { message_id?: string; emoji?: string }
  location?: {
    latitude?: number
    longitude?: number
    name?: string
    address?: string
  }
  contacts?: unknown[]
  context?: { from?: string; id?: string }
}

/** The media sub-object Meta nests under image/audio/video/document/sticker. */
export interface WhatsappInboundMedia {
  id?: string
  mime_type?: string
  sha256?: string
  caption?: string
}

/** A status receipt object (`value.statuses[]`). */
export interface WhatsappStatusEntry {
  /** wamid of the OUTBOUND message this receipt is for. */
  id?: string
  status?: "sent" | "delivered" | "read" | "failed" | "played"
  timestamp?: string
  recipient_id?: string
  errors?: WhatsappStatusError[]
}

export interface WhatsappStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

/** The webhook envelope: entry[].changes[].value. */
export interface WhatsappWebhookValue {
  messaging_product?: string
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: WhatsappInboundMessage[]
  statuses?: WhatsappStatusEntry[]
}

export interface WhatsappWebhookEnvelope {
  object?: string
  entry?: Array<{
    id?: string
    changes?: Array<{ field?: string; value?: WhatsappWebhookValue }>
  }>
}

/** The shape `GET /<MEDIA_ID>` returns (resolve step of the two-step pull). */
export interface WhatsappMediaMetadata {
  url?: string
  mime_type?: string
  sha256?: string
  file_size?: number
  id?: string
}

/** The shape `POST /<PHONE_NUMBER_ID>/messages` returns on success. */
export interface WhatsappSendResponse {
  messaging_product?: string
  contacts?: Array<{ input?: string; wa_id?: string }>
  messages?: Array<{ id?: string }>
}

/** The shape `POST /<PHONE_NUMBER_ID>/media` returns on success. */
export interface WhatsappMediaUploadResponse {
  id?: string
}

/** A Graph API error body (both send + media endpoints). */
export interface WhatsappGraphError {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    error_data?: { messaging_product?: string; details?: string }
    fbtrace_id?: string
  }
}
