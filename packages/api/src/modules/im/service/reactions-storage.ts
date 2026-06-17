/**
 * Persistence helpers for the `external_emoji_reactions` JSONB column on
 * transport_message_links. The StatusReactionAdapter calls into these on
 * every add/delete so a process restart can recover the glyph→reaction_id
 * map and clean up orphan reactions instead of leaking them.
 *
 * Also re-exports a lookup for the inbound link of a given item, used by
 * the delivery worker to resolve replyTo.
 *
 * The queries live in repo.ts (the module's repo file, which may import
 * the db client + sql); this file re-exports them to preserve the
 * existing import paths (service.ts barrel, actor-status-hooks, the
 * delivery worker's deps injection).
 */

export {
  findExternalMessageIdForItem,
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
} from "./repo.js"
