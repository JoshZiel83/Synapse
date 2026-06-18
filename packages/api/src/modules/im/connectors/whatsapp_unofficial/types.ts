/**
 * WhatsApp (unofficial / Baileys) local types + constants.
 *
 * Pure helpers only — no IO, no Baileys socket. JID classification, content
 * type mapping, and the small set of tuning constants the driver reads.
 *
 * JID suffixes (verified against WhatsApp multi-device):
 *   - `@s.whatsapp.net` → a personal number (direct chat)
 *   - `@g.us`           → a group
 *   - `@broadcast`      → broadcast / status list (we do not ingest)
 *   - `@lid`            → a "hidden" / privacy-masked identity (groups). We
 *     classify it as direct-ish for endpoint purposes but never crash on it.
 *   - `@newsletter`     → channels (out of scope; ignored)
 */

import type { TransportEndpointType } from "@synapse/shared/types"

export const WHATSAPP_LOG_SCOPE = "im.whatsapp_unofficial"

// ───────────────────────── JID helpers ─────────────────────────

export const JID_SUFFIX = {
  user: "@s.whatsapp.net",
  group: "@g.us",
  broadcast: "@broadcast",
  lid: "@lid",
  newsletter: "@newsletter",
} as const

export type JidClass = "direct" | "group" | "broadcast" | "lid" | "other"

/** Classify a raw JID by its suffix. Never throws. */
export function classifyJid(jid: string | null | undefined): JidClass {
  if (!jid) return "other"
  if (jid.endsWith(JID_SUFFIX.group)) return "group"
  if (jid.endsWith(JID_SUFFIX.user)) return "direct"
  if (jid.endsWith(JID_SUFFIX.lid)) return "lid"
  if (jid.endsWith(JID_SUFFIX.broadcast)) return "broadcast"
  return "other"
}

/**
 * Map a JID class to the connector's `TransportEndpointType`. `lid` is
 * treated as direct (it is a person, just privacy-masked). `group` → group.
 * Anything else falls back to direct so an endpoint is always resolvable.
 */
export function endpointTypeForJid(
  jid: string | null | undefined
): TransportEndpointType {
  return classifyJid(jid) === "group" ? "group" : "direct"
}

/** The bare phone (or lid) part of a JID — everything before the `@`. */
export function jidUser(jid: string | null | undefined): string {
  if (!jid) return ""
  const at = jid.indexOf("@")
  return at === -1 ? jid : jid.slice(0, at)
}

/** Strip the `:device` suffix some JIDs carry (e.g. `1555…:12@s.whatsapp.net`). */
export function normalizeJid(jid: string | null | undefined): string {
  if (!jid) return ""
  const at = jid.indexOf("@")
  if (at === -1) return jid
  const user = jid.slice(0, at)
  const domain = jid.slice(at)
  const colon = user.indexOf(":")
  return (colon === -1 ? user : user.slice(0, colon)) + domain
}

/** Build a direct-chat JID from an E.164 number (with or without the leading +). */
export function jidFromE164(e164: string): string {
  const digits = e164.replace(/[^\d]/g, "")
  return `${digits}${JID_SUFFIX.user}`
}

/** Baileys' `requestPairingCode` wants the number with NO leading "+". */
export function e164ForPairing(e164: string): string {
  return e164.replace(/[^\d]/g, "")
}

// ───────────────────── Baileys content-type mapping ─────────────────────

/**
 * The `getContentType()` keys Baileys returns for the message shapes we
 * handle on inbound. Kept as a const so `normalize.ts` can branch exhaustively.
 */
export const WA_CONTENT = {
  conversation: "conversation",
  extendedText: "extendedTextMessage",
  image: "imageMessage",
  video: "videoMessage",
  audio: "audioMessage",
  document: "documentMessage",
  sticker: "stickerMessage",
  reaction: "reactionMessage",
} as const

export type WaMediaKind = "image" | "video" | "audio" | "document" | "sticker"

/**
 * Map a Baileys content-type key to the `downloadContentFromMessage` /
 * `downloadMediaMessage` media type token. Returns null for non-media.
 */
export function mediaKindForContentType(
  contentType: string | undefined
): WaMediaKind | null {
  switch (contentType) {
    case WA_CONTENT.image:
      return "image"
    case WA_CONTENT.video:
      return "video"
    case WA_CONTENT.audio:
      return "audio"
    case WA_CONTENT.document:
      return "document"
    case WA_CONTENT.sticker:
      return "sticker"
    default:
      return null
  }
}

// ───────────────────────── tuning constants ─────────────────────────

/** Connection must survive this long before we reset the backoff counter. */
export const MIN_STABLE_CONNECTION_MS = 30_000
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 60_000
export const BACKOFF_JITTER_MS = 1_000

/** Bounded inbound dedup window (message.key.id LRU). */
export const DEDUP_MAX_ENTRIES = 2_000

/**
 * `sendPresenceUpdate("composing")` lapses after ~10s on WhatsApp, so the
 * typing controller must re-send well before that.
 */
export const TYPING_HEARTBEAT_MS = 8_000

/**
 * `coerceFileLength`: Baileys' `fileLength` can be a JS number, a string, or a
 * protobuf Long ({ low, high, unsigned }) — coerce all three to a number.
 */
export function coerceFileLength(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  if (
    value &&
    typeof value === "object" &&
    "low" in (value as Record<string, unknown>) &&
    "high" in (value as Record<string, unknown>)
  ) {
    const l = value as { low: number; high: number; unsigned?: boolean }
    // Reconstruct the 64-bit value; high * 2^32 + (low >>> 0).
    const n = l.high * 0x1_0000_0000 + (l.low >>> 0)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
