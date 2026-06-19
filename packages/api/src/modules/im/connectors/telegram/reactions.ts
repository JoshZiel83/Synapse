/**
 * Telegram StatusReactionAdapter — REAL, single-slot.
 *
 * `setMessageReaction(chat_id, message_id, [{type:"emoji", emoji}])` replaces
 * the bot's reaction; `setMessageReaction(…, [])` clears it. Telegram allows
 * exactly one emoji from a FIXED standard set on a bot reaction — an
 * out-of-set emoji is rejected with HTTP 400 (REACTION_INVALID). The repo's
 * `DEFAULT_STATUS_EMOJIS` glyphs are NOT all in that set, so we map each
 * status glyph to its nearest allowed Telegram standard reaction. Anything we
 * can't map is skipped (logged) rather than sent — guarding the 400.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import { DEFAULT_STATUS_EMOJIS } from "../../messaging/status-emojis.js"
import type { StatusReactionAdapter } from "../../status-reaction/controller.js"
import type { MessageRef } from "../types.js"
import { callMethod, TelegramApiError } from "./client.js"
import { getTelegramCredentialsOrThrow } from "./credentials.js"

/**
 * Telegram's standard reaction emoji set (the subset the Bot API accepts on
 * `setMessageReaction`). Not exhaustive of the full ~80 glyphs — only the
 * ones we map status levels onto, so the table stays reviewable.
 */
export const TELEGRAM_ALLOWED_REACTIONS = new Set<string>([
  "👍",
  "👀",
  "🤔",
  "🤯",
  "🔥",
  "🎉",
  "👌",
  "🙏",
  "😢",
  "💯",
  "✍",
  "🤬",
])

/**
 * Map the repo's StatusLevel glyphs (DEFAULT_STATUS_EMOJIS) → an allowed
 * Telegram reaction. The keys are the repo glyphs; values are guaranteed to
 * be in TELEGRAM_ALLOWED_REACTIONS.
 *
 *   queued 👀 → 👀   thinking 🧠 → 🤔   tool 🛠️ → ✍   coding 💻 → ✍
 *   web 🌐 → 👀   done ✅ → 👍   error ❌ → 🤬   stall ⏳ → 🤔   stall_hard ⚠️ → 🤯
 */
export function defaultStatusGlyphToTelegramReaction(): Record<string, string> {
  return {
    [DEFAULT_STATUS_EMOJIS.queued]: "👀",
    [DEFAULT_STATUS_EMOJIS.thinking]: "🤔",
    [DEFAULT_STATUS_EMOJIS.tool]: "✍",
    [DEFAULT_STATUS_EMOJIS.coding]: "✍",
    [DEFAULT_STATUS_EMOJIS.web]: "👀",
    [DEFAULT_STATUS_EMOJIS.done]: "👍",
    [DEFAULT_STATUS_EMOJIS.error]: "🤬",
    [DEFAULT_STATUS_EMOJIS.stall]: "🤔",
    [DEFAULT_STATUS_EMOJIS.stall_hard]: "🤯",
  }
}

export interface TelegramReactionAdapterDeps {
  account: Pick<TransportAccountSummary, "credentials">
  messageRef: MessageRef
  /** Override the glyph→Telegram-reaction map. */
  glyphMap?: Record<string, string>
  logger?: {
    warn(msg: string, fields?: Record<string, unknown>): void
    error(msg: string, err?: unknown, fields?: Record<string, unknown>): void
  }
}

const NOOP_LOGGER = { warn: () => {}, error: () => {} }

/**
 * Resolve an incoming emoji (a status glyph OR an already-allowed emoji) to a
 * Telegram-accepted reaction, or undefined when it can't be mapped.
 */
function resolveReaction(
  emoji: string,
  glyphMap: Record<string, string>
): string | undefined {
  if (glyphMap[emoji]) return glyphMap[emoji]
  if (TELEGRAM_ALLOWED_REACTIONS.has(emoji)) return emoji
  return undefined
}

export function createTelegramReactionAdapter(
  deps: TelegramReactionAdapterDeps
): StatusReactionAdapter {
  const glyphMap = deps.glyphMap ?? defaultStatusGlyphToTelegramReaction()
  const logger = deps.logger ?? NOOP_LOGGER
  const chatId = deps.messageRef.endpointExternalId
  const messageId = Number.parseInt(deps.messageRef.externalMessageId, 10)
  let active: string | null = null

  async function setMessageReaction(
    reaction: Array<{ type: "emoji"; emoji: string }>
  ): Promise<void> {
    const creds = getTelegramCredentialsOrThrow(deps.account)
    await callMethod(creds, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction,
    })
  }

  return {
    async setReaction(emoji) {
      const mapped = resolveReaction(emoji, glyphMap)
      if (!mapped) {
        logger.warn("telegram: emoji not in allowed reaction set, skipping", {
          emoji,
        })
        return
      }
      if (active === mapped) return
      try {
        await setMessageReaction([{ type: "emoji", emoji: mapped }])
        active = mapped
      } catch (err) {
        if (err instanceof TelegramApiError) {
          logger.warn("telegram: setMessageReaction rejected", {
            emoji: mapped,
            code: err.errorCode,
            description: err.description,
          })
          return
        }
        logger.error("telegram: setReaction failed", err, { emoji: mapped })
        throw err
      }
    },

    async clearReaction() {
      if (!active) return
      try {
        await setMessageReaction([])
      } catch (err) {
        logger.warn("telegram: clearReaction failed", { err: String(err) })
      }
      active = null
    },
  }
}
