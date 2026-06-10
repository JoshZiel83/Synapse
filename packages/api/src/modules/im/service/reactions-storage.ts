/**
 * Persistence helpers for the `external_emoji_reactions` JSONB column on
 * transport_message_links. The StatusReactionAdapter calls into these on
 * every add/delete so a process restart can recover the glyph→reaction_id
 * map and clean up orphan reactions instead of leaking them.
 *
 * Also re-exports a lookup for the inbound link of a given item, used by
 * the delivery worker to resolve replyTo.
 *
 * Extracted from service.ts as the first piece of a per-domain split.
 * service.ts re-exports these to preserve the existing import paths.
 */

import { sql } from "kysely"
import { db } from "../../../infrastructure/database/kysely.js"

/**
 * Read the persisted glyph → reaction_id map for an inbound message.
 * Returns {} when the column is empty / malformed / row missing.
 */
export async function loadTransportEmojiReactions(input: {
  transportAccountId: string
  externalMessageId: string
}): Promise<Record<string, string>> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .select("externalEmojiReactions")
    .where("transportAccountId", "=", input.transportAccountId)
    .where("externalMessageId", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  const raw = row?.externalEmojiReactions
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/**
 * Replace the persisted glyph → reaction_id map for an inbound message.
 * Called by the Feishu reaction adapter's onReactionTracked callback on
 * every successful add/delete.
 */
export async function saveTransportEmojiReactions(input: {
  transportAccountId: string
  externalMessageId: string
  reactionIdsByEmoji: Record<string, string>
}): Promise<void> {
  await db
    .updateTable("transportMessageLinks")
    .set({
      externalEmojiReactions: sql`${JSON.stringify(input.reactionIdsByEmoji)}::jsonb`,
    })
    .where("transportAccountId", "=", input.transportAccountId)
    .where("externalMessageId", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .execute()
}

/**
 * Resolve the external_message_id of the inbound link that recorded the
 * given conversation_item. Used by the delivery worker to translate
 * `conversation_items.reply_to_item_id` (internal id) into the platform
 * message_id that connector.sendMessage(replyTo) expects.
 */
export async function findExternalMessageIdForItem(input: {
  itemId: string
  transportEndpointId: string
}): Promise<string | null> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .select(["externalMessageId"])
    .where("itemId", "=", input.itemId)
    .where("transportEndpointId", "=", input.transportEndpointId)
    .where("direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  return row?.externalMessageId || null
}
