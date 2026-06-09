/**
 * QQ refIdx cache for quote backfill (Stage 7).
 *
 * QQ's `message_scene.ext` carries "ref_msg_idx=…" / "msg_idx=…" tokens
 * that identify quoted messages by an opaque index local to the bot's
 * recent traffic. The platform doesn't expose a "fetch message by
 * refIdx" API; the only way to recover the original content is to
 * cache it ourselves on inbound + cross-reference on the next event.
 *
 * Redis key: im:qq:ref-index:{accountId}:{refIdx}
 * TTL: 7 days. QQ's published validity is longer, but anything older
 * than a week is unlikely to be referenced and the cache size grows
 * unbounded otherwise.
 *
 * Stored entry includes both the original text and the bot-side flag
 * (`isBot`) so the AI can distinguish "user quoted their own earlier
 * message" from "user quoted the bot's reply".
 */

import type { Timestamp } from "@synapse/shared/types"
import type { Redis } from "ioredis"

const TTL_SECONDS = 7 * 24 * 60 * 60

export interface QqRefIndexEntry {
  /** Plain text of the quoted message. */
  content: string
  /** External id of the sender (c2c:.../gm:...). */
  senderId: string
  senderName?: string
  /** ISO-8601 of when the original message was received/sent. */
  timestamp: Timestamp
  /** True if the bot itself sent this message (vs. a user). Helpful
   *  context for the AI to disambiguate "user quoted their own
   *  earlier message" from "user quoted bot's reply". */
  isBot?: boolean
  /** Short summary of attachments on the original (e.g. "[图片] image.png"). */
  attachments?: string[]
}

function key(accountId: string, refIdx: string): string {
  return `im:qq:ref-index:${accountId}:${refIdx}`
}

export async function setRefIndexEntry(
  redis: Redis,
  params: {
    accountId: string
    refIdx: string
    entry: QqRefIndexEntry
  }
): Promise<void> {
  await redis.set(
    key(params.accountId, params.refIdx),
    JSON.stringify(params.entry),
    "EX",
    TTL_SECONDS
  )
}

export async function getRefIndexEntry(
  redis: Redis,
  params: { accountId: string; refIdx: string }
): Promise<QqRefIndexEntry | null> {
  const raw = await redis.get(key(params.accountId, params.refIdx))
  if (!raw) return null
  try {
    return JSON.parse(raw) as QqRefIndexEntry
  } catch {
    return null
  }
}

/**
 * Parse QQ's `message_scene.ext` array into the `(msgIdx, refMsgIdx)`
 * pair used by Stage 7.
 *
 * `ext` is an array of "key=value" strings. We tolerate either string
 * or array shapes since the platform has produced both at different
 * times.
 *
 *   msg_idx     = REFIDX assigned to THIS message (used by setRefIndex on emit)
 *   ref_msg_idx = REFIDX of the message this one quotes (used by getRefIndex)
 */
export function parseRefIndices(input: { ext?: unknown }): {
  msgIdx?: string
  refMsgIdx?: string
} {
  const ext = input.ext
  if (!ext) return {}
  const items = Array.isArray(ext) ? ext : typeof ext === "string" ? [ext] : []
  const out: { msgIdx?: string; refMsgIdx?: string } = {}
  for (const raw of items) {
    if (typeof raw !== "string") continue
    const eqAt = raw.indexOf("=")
    if (eqAt < 0) continue
    const k = raw.slice(0, eqAt).trim()
    const v = raw.slice(eqAt + 1).trim()
    if (!v) continue
    if (k === "msg_idx" && !out.msgIdx) out.msgIdx = v
    else if (k === "ref_msg_idx" && !out.refMsgIdx) out.refMsgIdx = v
  }
  return out
}
