/**
 * Telegram typing indicator — REAL adapter.
 *
 * `sendChatAction(chat_id, "typing")` shows "typing…" for ~5s, so we override
 * the controller heartbeat to 4s (`{ adapter, config: { heartbeatMs: 4000 } }`)
 * to keep it alive across a turn. `stop` is a no-op — Telegram has no
 * "stop typing" call; the indicator just expires.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { EndpointRef, MessageRef, TypingAdapterResult } from "../types.js"
import type { TypingAdapter } from "../../typing/controller.js"
import { callMethod } from "./client.js"
import { getTelegramCredentialsOrThrow } from "./credentials.js"

export interface TelegramTypingAdapterDeps {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  lastInboundMessageRef?: MessageRef
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void }
}

export function createTelegramTypingAdapter(
  deps: TelegramTypingAdapterDeps
): TypingAdapterResult | null {
  const chatId = deps.endpointRef.externalId
  if (!chatId) return null

  const send = async (): Promise<void> => {
    try {
      const creds = getTelegramCredentialsOrThrow(deps.account)
      await callMethod(creds, "sendChatAction", {
        chat_id: chatId,
        action: "typing",
      })
    } catch (err) {
      deps.logger?.warn("telegram: sendChatAction failed", {
        err: String(err),
      })
    }
  }

  const adapter: TypingAdapter = {
    start: send,
    stop: async () => {
      // Telegram has no explicit stop; the indicator expires on its own.
    },
  }
  return { adapter, config: { heartbeatMs: 4_000 } }
}
