/**
 * WhatsApp Cloud inbound → CanonicalMessage normalization. PURE.
 *
 * Maps a single `value.messages[]` object to an InboundEnvelope:
 *   - text                         → text part
 *   - image/audio/video/document/sticker → media `system_marker` placeholder
 *     stashing { media_id, mime_type, filename, voice } in `original`; the
 *     side-effecting `enrichInboundWhatsappMedia` pass (media.ts) does the
 *     two-step Bearer download and upgrades the placeholder to a real
 *     image/voice/video/file part with a `{sha256}` fileRef.
 *   - reaction                     → reaction part (target = message_id)
 *   - location                     → text part ("📍 lat,lng (name)")
 *   - contacts                     → text placeholder ("[contact card]")
 *
 * The endpoint is always DIRECT (Cloud API v1 = 1:1; group out of scope,
 * OD-5). `endpointExternalId` + `sender.externalId` are the wa_id
 * (`messages[].from`, the customer's phone in E.164 without +).
 *
 * Dedup is by `messages[].id` (wamid) — surfaced as `externalMessageId`.
 * Blank id ⇒ null (a blank externalMessageId silently disables dedup — a
 * known trap; we refuse rather than emit one).
 *
 * `receivedAt` comes from `messages[].timestamp` (Unix SECONDS string) via
 * `fromUnixSeconds(...)` (ISO instant; the datetime guard is strict). A
 * genuinely absent/garbage timestamp falls back to the server-receive
 * instant (logged via the caller — this module stays pure and doesn't log).
 */

import { fromUnixSeconds, serverReceiveInstant } from "@synapse/shared/datetime"
import type { Timestamp } from "@synapse/shared/types"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope } from "../types.js"
import type { WhatsappInboundMedia, WhatsappInboundMessage } from "./types.js"

function trimmed(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/**
 * Parse a WhatsApp `timestamp` (Unix SECONDS as a string) into a canonical
 * instant. Present-but-unparseable / absent → server-receive instant
 * (datetime-ok: there is no genuine event time to thread). We do NOT throw —
 * the webhook handler returns 200 unconditionally and Meta retries non-200
 * for 7 days, so a poison timestamp must never block ingestion.
 */
export function whatsappMessageInstant(raw: unknown): Timestamp {
  const s = trimmed(raw)
  if (!s) {
    // datetime-ok: genuine no-event-time default (timestamp absent).
    return serverReceiveInstant()
  }
  const n = Number(s)
  if (!Number.isFinite(n)) {
    // datetime-ok: present-but-garbage timestamp; explicit logged default.
    return serverReceiveInstant()
  }
  try {
    return fromUnixSeconds(n)
  } catch {
    // datetime-ok: out-of-range epoch; explicit default rather than throw.
    return serverReceiveInstant()
  }
}

/** Pick a `system_marker` media placeholder for a media-bearing message. */
function mediaPlaceholder(
  message: WhatsappInboundMessage
): CanonicalPart | null {
  const build = (
    marker:
      | "image_placeholder"
      | "voice_placeholder"
      | "video_placeholder"
      | "file_placeholder",
    media: WhatsappInboundMedia | undefined,
    extra: Record<string, unknown> = {}
  ): CanonicalPart | null => {
    const mediaId = trimmed(media?.id)
    if (!mediaId) return null
    return {
      type: "system_marker",
      marker,
      original: {
        media_id: mediaId,
        mime_type: trimmed(media?.mime_type),
        caption: trimmed(media?.caption),
        ...extra,
      },
    }
  }

  switch (message.type) {
    case "image":
      return build("image_placeholder", message.image)
    case "audio":
      // voice notes carry `voice: true`; both map to a voice placeholder so
      // the agent gets the audio (the render layer decides ptt vs audio).
      return build("voice_placeholder", message.audio, {
        voice: message.audio?.voice === true,
      })
    case "video":
      return build("video_placeholder", message.video)
    case "document":
      return build("file_placeholder", message.document, {
        filename: trimmed(message.document?.filename),
      })
    case "sticker":
      // Stickers are static/animated webp images; surface as image so the
      // agent sees them. Animated stickers still download as webp.
      return build("image_placeholder", message.sticker, {
        sticker: true,
        animated: message.sticker?.animated === true,
      })
    default:
      return null
  }
}

/**
 * Build the canonical parts for one inbound message. A media message may
 * also carry a caption (image/video/document) which we emit as a trailing
 * text part so the agent sees it even before media enrichment.
 */
function partsForMessage(message: WhatsappInboundMessage): CanonicalPart[] {
  const parts: CanonicalPart[] = []
  switch (message.type) {
    case "text": {
      const body = trimmed(message.text?.body)
      if (body) parts.push({ type: "text", text: body })
      return parts
    }
    case "reaction": {
      const targetId = trimmed(message.reaction?.message_id)
      const emoji = trimmed(message.reaction?.emoji) ?? ""
      if (targetId) {
        parts.push({
          type: "reaction",
          emoji,
          target: { externalMessageId: targetId },
        })
      }
      return parts
    }
    case "location": {
      const loc = message.location
      if (loc && typeof loc.latitude === "number") {
        const name = trimmed(loc.name)
        const addr = trimmed(loc.address)
        const suffix = [name, addr].filter(Boolean).join(", ")
        parts.push({
          type: "text",
          text: `📍 ${loc.latitude},${loc.longitude}${suffix ? ` (${suffix})` : ""}`,
        })
      }
      return parts
    }
    case "contacts": {
      // We don't project contact cards into media; surface a marker text so
      // the conversation isn't empty.
      parts.push({ type: "text", text: "[contact card]" })
      return parts
    }
    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker": {
      const placeholder = mediaPlaceholder(message)
      if (placeholder) parts.push(placeholder)
      // Caption (image/video/document) → trailing text part.
      const caption =
        trimmed(message.image?.caption) ??
        trimmed(message.video?.caption) ??
        trimmed(message.document?.caption)
      if (caption) parts.push({ type: "text", text: caption })
      return parts
    }
    default:
      // Unknown / unsupported (system, button, interactive, order…) — surface
      // an unknown marker so the message isn't silently dropped.
      parts.push({
        type: "system_marker",
        marker: "unknown_placeholder",
        original: { type: message.type },
      })
      return parts
  }
}

export interface NormalizeWhatsappMessageContext {
  /** display name from value.contacts[].profile.name, matched by wa_id. */
  contactName?: string
}

/**
 * Normalize one inbound `value.messages[]` object into an InboundEnvelope.
 * Returns null when required fields (wamid `id`, sender `from`) are missing.
 */
export function normalizeWhatsappMessage(
  message: WhatsappInboundMessage,
  ctx: NormalizeWhatsappMessageContext = {}
): InboundEnvelope | null {
  const wamid = trimmed(message.id)
  const from = trimmed(message.from)
  // A blank externalMessageId silently disables dedup — refuse it.
  if (!wamid || !from) return null

  const parts = partsForMessage(message)
  const canonical = buildCanonicalMessage(parts)

  const envelope: InboundEnvelope = {
    endpointType: "direct",
    endpointExternalId: from,
    externalMessageId: wamid,
    sender: {
      externalId: from,
      metadata: { waId: from },
    },
    receivedAt: whatsappMessageInstant(message.timestamp),
    message: canonical,
    raw: {
      type: message.type,
      ...(message.context ? { context: message.context } : {}),
    },
  }

  const displayName = trimmed(ctx.contactName)
  if (displayName) {
    envelope.endpointDisplayName = displayName
    envelope.sender.displayName = displayName
  }

  // Reply linkage: WhatsApp `context.id` is the wamid this message replies
  // to. Surface it so the ingest layer can thread it.
  const replyToId = trimmed(message.context?.id)
  if (replyToId) envelope.externalReplyToId = replyToId

  return envelope
}
