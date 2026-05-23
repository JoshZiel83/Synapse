/**
 * Persistence helpers for the `external_emoji_reactions` JSONB column on
 * transport_message_links. The StatusReactionAdapter calls into these on
 * every add/delete so a process restart can recover the glyph→reaction_id
 * map and clean up orphan reactions instead of leaking them.
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
    .selectFrom("transport_message_links")
    .select("external_emoji_reactions")
    .where("transport_account_id", "=", input.transportAccountId)
    .where("external_message_id", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  const raw = row?.external_emoji_reactions
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
    .updateTable("transport_message_links")
    .set({
      external_emoji_reactions: sql`${JSON.stringify(input.reactionIdsByEmoji)}::jsonb`,
      updated_at: sql`NOW()`,
    })
    .where("transport_account_id", "=", input.transportAccountId)
    .where("external_message_id", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .execute()
}
