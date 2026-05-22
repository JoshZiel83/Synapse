/**
 * Feishu StatusReactionAdapter implementation.
 *
 * Maps StatusLevel → Feishu emoji_type and calls messageReaction.create.
 * Tracks reaction_id per emoji so we can delete the previous reaction
 * before adding a new one (Feishu reactions accumulate; we want exactly
 * one "live" status reaction at a time).
 *
 * In-memory only for V1: reaction_ids are not persisted, so on process
 * restart we lose the ability to clean up old reactions. Commit 10 will
 * add a JSONB column for this.
 */

import type * as Lark from "@larksuiteoapi/node-sdk"
import {
  DEFAULT_FEISHU_EMOJI_TYPES,
  DEFAULT_STATUS_EMOJIS,
} from "../../messaging/status-emojis.js"
import type { StatusReactionAdapter } from "../../status-reaction/controller.js"
import type { MessageRef } from "../types.js"

export interface FeishuReactionAdapterDeps {
  client: Lark.Client
  messageRef: MessageRef
  /** Optional reverse lookup: emoji glyph → Feishu emoji_type. */
  emojiTypeMap?: Record<string, string>
  /** Optional callback to persist reactionIds for restart safety. */
  onReactionTracked?: (state: {
    activeEmoji: string | null
    reactionIdsByEmoji: Record<string, string>
  }) => void
  logger?: {
    warn(msg: string, fields?: Record<string, unknown>): void
    error(msg: string, err?: unknown, fields?: Record<string, unknown>): void
  }
}

const NOOP_LOGGER = {
  warn: () => {},
  error: () => {},
}

/**
 * Build the glyph → Feishu emoji_type lookup. Default uses the StatusLevel
 * mapping (DEFAULT_STATUS_EMOJIS ↔ DEFAULT_FEISHU_EMOJI_TYPES).
 */
export function defaultEmojiGlyphToFeishuType(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [level, glyph] of Object.entries(DEFAULT_STATUS_EMOJIS)) {
    const feishuType =
      DEFAULT_FEISHU_EMOJI_TYPES[
        level as keyof typeof DEFAULT_FEISHU_EMOJI_TYPES
      ]
    if (feishuType) out[glyph] = feishuType
  }
  return out
}

export function createFeishuReactionAdapter(
  deps: FeishuReactionAdapterDeps
): StatusReactionAdapter {
  const emojiTypeMap = deps.emojiTypeMap ?? defaultEmojiGlyphToFeishuType()
  const reactionIdsByEmoji = new Map<string, string>()
  let activeEmoji: string | null = null
  const logger = deps.logger ?? NOOP_LOGGER

  function notify(): void {
    if (deps.onReactionTracked) {
      deps.onReactionTracked({
        activeEmoji,
        reactionIdsByEmoji: Object.fromEntries(reactionIdsByEmoji),
      })
    }
  }

  return {
    async setReaction(emoji) {
      // Same emoji already set — nothing to do
      if (activeEmoji === emoji && reactionIdsByEmoji.has(emoji)) return

      const emojiType = emojiTypeMap[emoji]
      if (!emojiType) {
        logger.warn("feishu: unknown emoji glyph, skipping", { emoji })
        return
      }

      // Add new reaction first (so user never sees "no status" gap)
      try {
        const resp = await deps.client.im.messageReaction.create({
          path: { message_id: deps.messageRef.externalMessageId },
          data: { reaction_type: { emoji_type: emojiType } },
        })
        const rid = resp?.data?.reaction_id
        if (rid) {
          reactionIdsByEmoji.set(emoji, rid)
        }
        // Then remove previous reaction (if any and different)
        if (activeEmoji && activeEmoji !== emoji) {
          const prevRid = reactionIdsByEmoji.get(activeEmoji)
          if (prevRid) {
            try {
              await deps.client.im.messageReaction.delete({
                path: {
                  message_id: deps.messageRef.externalMessageId,
                  reaction_id: prevRid,
                },
              })
              reactionIdsByEmoji.delete(activeEmoji)
            } catch (err) {
              logger.warn("feishu: failed to delete prior reaction", {
                emoji: activeEmoji,
                err: String(err),
              })
            }
          }
        }
        activeEmoji = emoji
        notify()
      } catch (err) {
        logger.error("feishu: setReaction failed", err, { emoji, emojiType })
        throw err
      }
    },

    async clearReaction() {
      if (!activeEmoji) return
      const rid = reactionIdsByEmoji.get(activeEmoji)
      if (!rid) {
        activeEmoji = null
        notify()
        return
      }
      try {
        await deps.client.im.messageReaction.delete({
          path: {
            message_id: deps.messageRef.externalMessageId,
            reaction_id: rid,
          },
        })
      } catch (err) {
        logger.warn("feishu: clearReaction failed", { err: String(err) })
      }
      reactionIdsByEmoji.delete(activeEmoji)
      activeEmoji = null
      notify()
    },

    async removeReaction(emoji) {
      const rid = reactionIdsByEmoji.get(emoji)
      if (!rid) return
      try {
        await deps.client.im.messageReaction.delete({
          path: {
            message_id: deps.messageRef.externalMessageId,
            reaction_id: rid,
          },
        })
      } catch (err) {
        logger.warn("feishu: removeReaction failed", { err: String(err) })
      }
      reactionIdsByEmoji.delete(emoji)
      if (activeEmoji === emoji) activeEmoji = null
      notify()
    },
  }
}
