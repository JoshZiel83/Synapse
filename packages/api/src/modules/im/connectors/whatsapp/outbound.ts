/**
 * WhatsApp Cloud outbound — sendMessage.
 *
 * Flow:
 *   1. degradeForCapabilities(message, WHATSAPP_MESSAGE_CAPABILITIES)
 *   2. planWhatsappSends(degraded) → ordered send items
 *   3. 24h-window gate: a free-form TEXT send is only allowed inside the
 *      open window. If the window is closed and there is no template
 *      available (there is none in v1 — see templates.ts / OD-1a), throw
 *      PermanentTransportError({ code:"whatsapp_24h_window_closed" }) mapped
 *      to 131047. (Media/reaction also require the window — reactions and
 *      media outside the window 131047 too; we gate on the first send item.)
 *   4. For each item: media → upload bytes → media_id → send-by-id; text →
 *      send text; reaction → send reaction. `replyTo` attaches
 *      `context.message_id` to the FIRST item only.
 *   5. Return { externalMessageId: messages[0].id } from the FIRST send.
 *      NOTE: "sent" here means "accepted by Meta" — the real terminal failure
 *      (131026/131047) arrives async on the status webhook
 *      (status-reconcile.ts).
 *
 * Error taxonomy (plan §4.4): retryable codes (130429/131056/80007/4) →
 * RetryableTransportError; permanent (131047/131026/131053/132xxx) +
 * empirical (368/131031) → PermanentTransportError. HTTP 5xx / network →
 * retryable. The IM worker only special-cases PermanentTransportError; a
 * bare throw / RetryableTransportError both retry.
 */

import { readContentBuffer } from "../../../../infrastructure/storage/content-store.js"
import { transcodeToOpusVoiceNote } from "../../../../infrastructure/media/transcode.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import {
  PermanentTransportError,
  RetryableTransportError,
  type OutboundSendInput,
  type OutboundSendResult,
} from "../types.js"
import { WHATSAPP_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { sendGraphMessage, type FetchImpl } from "./client.js"
import {
  getWhatsappCredentialsOrThrow,
  type WhatsappCredentials,
} from "./credentials.js"
import { uploadWhatsappMediaBytes } from "./media.js"
import { planWhatsappSends, type WhatsappSendPlanItem } from "./render.js"
import {
  WHATSAPP_PERMANENT_EMPIRICAL_ERROR_CODES,
  WHATSAPP_PERMANENT_ERROR_CODES,
  WHATSAPP_RETRYABLE_ERROR_CODES,
  isWhatsappTemplateErrorCode,
  type WhatsappGraphError,
  type WhatsappSendResponse,
} from "./types.js"
import {
  whatsappWindowStore,
  type WhatsappWindowStore,
} from "./window-store.js"

export interface SendWhatsappDeps {
  fetchImpl?: FetchImpl
  windowStore?: WhatsappWindowStore
  /** Test seam — read outbound bytes from CAS by sha256. */
  readBytes?: (sha256: string) => Promise<Buffer>
  /** Test seam — transcode arbitrary audio → ogg/opus voice note. */
  transcodeVoice?: (input: Buffer) => Promise<Buffer>
  nowMs?: number
}

export async function sendWhatsappMessage(
  input: OutboundSendInput,
  deps: SendWhatsappDeps = {}
): Promise<OutboundSendResult> {
  const creds = getWhatsappCredentialsOrThrow(input.account)
  const to = input.endpoint.externalId
  const windowStore = deps.windowStore ?? whatsappWindowStore
  const readBytes = deps.readBytes ?? readContentBuffer
  const transcode = deps.transcodeVoice ?? transcodeToOpusVoiceNote

  const degraded = degradeForCapabilities(
    input.message,
    WHATSAPP_MESSAGE_CAPABILITIES
  )
  const items = planWhatsappSends(degraded)
  if (items.length === 0) {
    // Nothing renderable (e.g. an all-unsupported message). Treat as a
    // permanent no-op rather than burning retries.
    throw new PermanentTransportError("whatsapp: nothing to send", {
      code: "whatsapp_empty_message",
    })
  }

  // ── 24h-window gate ──
  // Any free-form (non-template) send requires an open window. v1 has no
  // template registry, so a closed window is terminal: 131047. A pure
  // reaction also requires the window (reactions outside it 131047 too).
  //
  // WC-2: distinguish a GENUINELY-closed window from "we have no positive
  // evidence the window is open" so a transient Redis blip can't turn a valid
  // reply into a PERMANENT drop. recordInbound is best-effort (.catch), so a
  // lost/expired window-key reads back as "absent". If we mapped absent →
  // permanent-131047, BullMQ would never retry and a legitimate in-window
  // reply would be dropped forever, never reaching Meta.
  //   • key present + window elapsed → genuinely closed → permanent 131047
  //     (Meta would reject it too; no point retrying).
  //   • key ABSENT → no evidence → RetryableTransportError, so BullMQ retries
  //     and lets Meta's REAL 131047 (via classifyAndThrow / status-reconcile)
  //     be the authoritative window verdict.
  // (A Redis READ outage already throws a bare Error from getLastInboundMs /
  // isWithin24h, which the worker treats as retryable — that path is left as-is.)
  const lastInboundMs = await windowStore.getLastInboundMs({
    accountId: input.account.id,
    waId: to,
  })
  if (lastInboundMs == null) {
    throw new RetryableTransportError(
      "whatsapp: no recorded inbound window for recipient (window-store key absent — possibly a lost/expired write); retrying so Meta's real 131047 is authoritative"
    )
  }
  const within24h = await windowStore.isWithin24h({
    accountId: input.account.id,
    waId: to,
    ...(deps.nowMs != null ? { nowMs: deps.nowMs } : {}),
  })
  if (!within24h) {
    throw new PermanentTransportError(
      "whatsapp: 24h customer-service window is closed; only pre-approved templates can be sent (none configured — see OD-1a)",
      { code: "whatsapp_24h_window_closed" }
    )
  }

  // ── Send each item in order; replyTo on the first only ──
  //
  // WC-1: idempotency across BullMQ retries. planWhatsappSends commonly yields
  // 2+ items (coalesced text + one per media part + one per reaction). Without
  // checkpointing, a mid-batch retryable failure (e.g. 130429 / 5xx on item N)
  // throws, BullMQ re-runs sendWhatsappMessage FROM SCRATCH, and items 1..N-1
  // are re-POSTed → duplicate text/media to the recipient.
  //
  // Mirror qq/outbound.ts: checkpoint each sent item's wamid into
  // metadata.whatsapp.items.<index> via patchLinkMetadata, and on retry skip
  // items already recorded as sent (the plan is deterministic for a given
  // message, so the item INDEX is a stable key across attempts). The first
  // item's wamid is returned whether freshly sent or recovered from metadata.
  const sentItems = readSentItems(input.linkMetadata)
  let firstExternalId: string | undefined
  const replyToId = input.replyTo?.externalMessageId
  for (let i = 0; i < items.length; i += 1) {
    const prior = sentItems[i]
    if (prior) {
      // Already sent on a previous attempt — do NOT re-POST. Recover the id.
      if (i === 0) firstExternalId = prior.wamid ?? firstExternalId
      continue
    }
    const item = items[i]!
    const attachReply = i === 0 && replyToId ? replyToId : undefined
    const externalId = await sendOneItem({
      creds,
      to,
      item,
      replyToExternalId: attachReply,
      readBytes,
      transcode,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    })
    // Checkpoint BEFORE moving to the next item so a failure on item i+1 (or a
    // crash) never re-sends item i on the retry. patchLinkMetadata deep-merges,
    // so each index accumulates independently.
    await input.patchLinkMetadata({
      whatsapp: {
        items: {
          [String(i)]: {
            sent: true,
            ...(externalId ? { wamid: externalId } : {}),
            attempt: input.attemptNumber,
          },
        },
      },
    })
    if (i === 0) firstExternalId = externalId
  }

  return firstExternalId
    ? { externalMessageId: firstExternalId }
    : // The first item produced no id (only happens if a send unexpectedly
      // omits messages[0].id, or was recovered from metadata without one);
      // surface ambiguity rather than a bug-throw.
      { deliveryAmbiguous: true }
}

/** A per-item send checkpoint persisted under metadata.whatsapp.items.<index>. */
interface WhatsappSentItem {
  wamid?: string
}

/**
 * Read the per-item send checkpoints written by a prior attempt. Indexed by
 * the item's position in the (deterministic) send plan. Tolerant of partial /
 * malformed metadata — anything unrecognized is treated as "not yet sent".
 */
function readSentItems(
  linkMetadata: Record<string, unknown>
): Record<number, WhatsappSentItem> {
  const out: Record<number, WhatsappSentItem> = {}
  const wa = linkMetadata.whatsapp
  if (!wa || typeof wa !== "object" || Array.isArray(wa)) return out
  const items = (wa as Record<string, unknown>).items
  if (!items || typeof items !== "object" || Array.isArray(items)) return out
  for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
    const idx = Number(k)
    if (!Number.isInteger(idx) || idx < 0) continue
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const rec = v as Record<string, unknown>
    if (rec.sent !== true) continue
    out[idx] = {
      ...(typeof rec.wamid === "string" && rec.wamid
        ? { wamid: rec.wamid }
        : {}),
    }
  }
  return out
}

interface SendOneItemInput {
  creds: WhatsappCredentials
  to: string
  item: WhatsappSendPlanItem
  replyToExternalId?: string
  readBytes: (sha256: string) => Promise<Buffer>
  transcode: (input: Buffer) => Promise<Buffer>
  fetchImpl?: FetchImpl
}

async function sendOneItem(
  input: SendOneItemInput
): Promise<string | undefined> {
  const body = await buildItemBody(input)
  const res = await sendGraphMessage({
    creds: input.creds,
    body,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })
  if (!res.ok) {
    await classifyAndThrow(res)
  }
  const json = (await res.json().catch(() => ({}))) as WhatsappSendResponse
  const id = json.messages?.[0]?.id
  return typeof id === "string" && id.trim() ? id : undefined
}

async function buildItemBody(
  input: SendOneItemInput
): Promise<Record<string, unknown>> {
  const { item, to, replyToExternalId } = input
  const context = replyToExternalId
    ? { context: { message_id: replyToExternalId } }
    : {}

  if (item.kind === "text") {
    return { to, type: "text", text: { body: item.text }, ...context }
  }

  if (item.kind === "reaction") {
    // type:"reaction" — empty emoji removes the reaction. No context.
    return {
      to,
      type: "reaction",
      reaction: {
        message_id: item.targetExternalMessageId,
        emoji: item.emoji,
      },
    }
  }

  // media: read bytes → (voice transcode) → upload → media_id → send-by-id.
  const sha256 = item.fileRef.sha256
  if (!sha256) {
    throw new PermanentTransportError("whatsapp: media part missing sha256", {
      code: "whatsapp_media_missing_sha",
    })
  }
  let buffer = await input.readBytes(sha256)
  let mimeType = item.fileRef.mimeType || defaultMimeForCategory(item.category)

  if (item.kind === "media" && item.voice) {
    // Voice notes MUST be audio/ogg; codecs=opus. Transcode arbitrary audio.
    try {
      buffer = await input.transcode(buffer)
    } catch (err) {
      throw new PermanentTransportError(
        `whatsapp: voice transcode failed: ${(err as Error).message}`,
        { code: "whatsapp_voice_transcode_failed", cause: err }
      )
    }
    mimeType = "audio/ogg; codecs=opus"
  }

  const { mediaId } = await uploadWhatsappMediaBytes({
    creds: input.creds,
    buffer,
    mimeType,
    category: item.category,
    ...(item.filename ? { filename: item.filename } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  })

  const mediaObj: Record<string, unknown> = { id: mediaId }
  if (item.messageType === "audio" && item.voice) mediaObj.voice = true
  if (item.messageType === "document" && item.filename) {
    mediaObj.filename = item.filename
  }
  return {
    to,
    type: item.messageType,
    [item.messageType]: mediaObj,
    ...context,
  }
}

function defaultMimeForCategory(category: string): string {
  switch (category) {
    case "image":
      return "image/jpeg"
    case "audio":
      return "audio/ogg"
    case "video":
      return "video/mp4"
    default:
      return "application/octet-stream"
  }
}

/**
 * Classify a non-2xx Graph response and throw the right error type. 5xx /
 * unparseable → retryable. Known business codes map per the taxonomy.
 */
async function classifyAndThrow(res: Response): Promise<never> {
  const text = await res.text().catch(() => "")
  let code: number | undefined
  try {
    const parsed = JSON.parse(text) as WhatsappGraphError
    code = parsed.error?.code
  } catch {
    // non-JSON body
  }

  if (typeof code === "number") {
    if (WHATSAPP_RETRYABLE_ERROR_CODES.has(code)) {
      throw new RetryableTransportError(
        `whatsapp send retryable (${code}): ${text.slice(0, 200)}`
      )
    }
    if (
      WHATSAPP_PERMANENT_ERROR_CODES.has(code) ||
      isWhatsappTemplateErrorCode(code) ||
      // 368/131031 are empirical — treated permanent. // verify in live sandbox
      WHATSAPP_PERMANENT_EMPIRICAL_ERROR_CODES.has(code)
    ) {
      throw new PermanentTransportError(
        `whatsapp send permanent (${code}): ${text.slice(0, 200)}`,
        { code: `whatsapp_${code}` }
      )
    }
  }

  // 5xx or network-ish → retry.
  if (res.status >= 500) {
    throw new RetryableTransportError(
      `whatsapp send retryable HTTP ${res.status}: ${text.slice(0, 200)}`
    )
  }
  // Unknown 4xx with no recognized code: treat permanent so we don't burn
  // retries on a stable client error (auth, bad recipient, etc.). The
  // operator sees the exact body in lastError.
  throw new PermanentTransportError(
    `whatsapp send failed HTTP ${res.status}${code ? ` code ${code}` : ""}: ${text.slice(0, 200)}`,
    { code: code ? `whatsapp_${code}` : `whatsapp_http_${res.status}` }
  )
}
