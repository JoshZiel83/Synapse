/**
 * WhatsApp Cloud typing / read-receipt adapter.
 *
 * The Cloud "typing indicator" piggybacks on the MARK-AS-READ call: you
 * cannot send a bare presence update, you send a read receipt for the
 * inbound message and (since 2024) optionally attach a typing indicator:
 *   POST /<PHONE_NUMBER_ID>/messages
 *   { messaging_product:"whatsapp", status:"read",
 *     message_id:<inbound wamid>, typing_indicator:{ type:"text" } }
 *
 * Therefore typing REQUIRES the inbound message id. The factory returns null
 * when `lastInboundMessageRef` is absent (idle/proactive turns), which is the
 * contract's "no typing on this platform right now" signal. The indicator
 * auto-dismisses when the next outbound message is sent OR after ~25s, so
 * `stop()` is a no-op (sending a second read for an already-read message is
 * pointless and Meta may 400 it).
 *
 * Heartbeat: Meta dismisses the indicator after ~25s; we override the default
 * 3s heartbeat to ~20s so the typing state is refreshed before it expires.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { TypingAdapter } from "../../typing/controller.js"
import type { EndpointRef, MessageRef, TypingAdapterResult } from "../types.js"
import { sendGraphMessage, type FetchImpl } from "./client.js"
import { getWhatsappCredentialsOrThrow } from "./credentials.js"

export interface WhatsappTypingAdapterInput {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  lastInboundMessageRef?: MessageRef
  fetchImpl?: FetchImpl
  logger?: {
    warn(msg: string, fields?: Record<string, unknown>): void
  }
}

/**
 * ~20s heartbeat (Meta dismisses the indicator at ~25s). Returned alongside
 * the adapter so the typing controller refreshes before expiry.
 */
export const WHATSAPP_TYPING_HEARTBEAT_MS = 20_000

export function createWhatsappTypingAdapter(
  input: WhatsappTypingAdapterInput
): TypingAdapterResult | null {
  const inboundId = input.lastInboundMessageRef?.externalMessageId
  // No inbound anchor → cannot construct a valid typing/read request.
  if (!inboundId || !inboundId.trim()) return null

  const creds = getWhatsappCredentialsOrThrow(input.account)
  const fetchImpl = input.fetchImpl

  const sendReadWithTyping = async (): Promise<void> => {
    try {
      const res = await sendGraphMessage({
        creds,
        body: {
          status: "read",
          message_id: inboundId,
          typing_indicator: { type: "text" },
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      })
      if (!res.ok) {
        input.logger?.warn("whatsapp: typing/read indicator failed", {
          status: res.status,
        })
      }
    } catch (err) {
      input.logger?.warn("whatsapp: typing/read indicator threw", {
        err: String(err),
      })
    }
  }

  const adapter: TypingAdapter = {
    start: sendReadWithTyping,
    // No-op: the indicator auto-dismisses on the next outbound send / ~25s.
    stop: async () => {},
  }

  return { adapter, config: { heartbeatMs: WHATSAPP_TYPING_HEARTBEAT_MS } }
}
