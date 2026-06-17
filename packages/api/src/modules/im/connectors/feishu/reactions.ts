/**
 * Feishu StatusReactionAdapter implementation.
 *
 * Maps StatusLevel → Feishu emoji_type and calls messageReaction.create.
 * Tracks reaction_id per emoji so we can delete the previous reaction
 * before adding a new one (Feishu reactions accumulate; we want exactly
 * one "live" status reaction at a time).
 *
 * The id map is seeded from `initialReactionIdsByEmoji` on construction so
 * the orphan-recovery path (restart → load persisted ids → removeReaction
 * each glyph) can actually delete the previous process's leftovers.
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
  /**
   * Seed map of glyph → Feishu reaction_id loaded from durable storage on
   * process restart. Lets the orphan-recovery code delete reactions left
   * over by a previous process.
   */
  initialReactionIdsByEmoji?: Record<string, string>
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
  const reactionIdsByEmoji = new Map<string, string>(
    Object.entries(deps.initialReactionIdsByEmoji || {})
  )
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

      // Add the new reaction first (so the user never sees a "no status" gap),
      // but ONLY advance state / remove the prior reaction once Feishu actually
      // confirms the new one. Feishu returns business failures (invalid
      // emoji_type, bot not in chat, recalled message, expired token) as
      // HTTP 200 with a non-zero `code`; the SDK resolves those rather than
      // throwing, so a `code` check is mandatory. The old code only checked
      // `reaction_id`, then unconditionally ran `activeEmoji = emoji` — silently
      // recording a reaction the API rejected and, on a switch, deleting the
      // previously-live reaction (leaving the message with no status at all).
      try {
        const resp = await deps.client.im.messageReaction.create({
          path: { message_id: deps.messageRef.externalMessageId },
          data: { reaction_type: { emoji_type: emojiType } },
        })
        const rid = resp?.data?.reaction_id
        if ((resp?.code != null && resp.code !== 0) || !rid) {
          logger.error("feishu: messageReaction.create rejected", undefined, {
            emoji,
            emojiType,
            code: resp?.code,
            msg: resp?.msg,
          })
          // Leave the existing live status reaction intact: do not advance
          // activeEmoji, do not delete the prior reaction, do not notify().
          return
        }
        reactionIdsByEmoji.set(emoji, rid)
        // Only now that the new reaction is confirmed, remove the previous one.
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
