/**
 * WhatsApp (unofficial / Baileys) TransportConnector assembly + registration.
 *
 * `long_connection` only. The durable socket is owned by the runtime reconcile
 * loop (one per number, Redis-lease-guarded) via `startAccount` →
 * connection-controller. Login (QR / pairing) is a separate, controller-driven
 * transient flow (login-qr.ts) that persists the encrypted session blob and
 * then refreshes the runtime.
 *
 * NO top-level IO: only object construction + registerConnector. All sockets,
 * Redis, and timers live inside startAccount / sendMessage / the login flow.
 */

import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { registerConnector } from "../registry.js"
import {
  type CredentialValidationInput,
  type CredentialValidationResult,
  type TransportConnector,
} from "../types.js"
import {
  WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY,
  WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES,
} from "./capabilities.js"
import { startWhatsappAccount } from "./connection-controller.js"
import { sendWhatsappMessage } from "./outbound.js"
import { parseWhatsappMentions, renderWhatsappMention } from "./normalize.js"
import { createWhatsappTypingAdapter } from "./typing.js"

/**
 * SYNC credential validation. There are no user-supplied secrets to validate
 * for an unofficial account — the credential blob is the encrypted session,
 * written by the login flow, not by the create-account form. An optional
 * `phoneNumberE164` (for pairing-code login) is shape-checked only.
 *
 * An account is creatable in a `disabled` state with no auth blob (the login
 * flow fills it in), so we accept absent credentials.
 */
function validateCredentials(
  input: CredentialValidationInput
): CredentialValidationResult {
  const errors: string[] = []
  const phone = input.credentials.phoneNumberE164
  if (phone !== undefined && typeof phone !== "string") {
    errors.push("phoneNumberE164 must be a string")
  }
  if (
    typeof phone === "string" &&
    phone.trim() &&
    !/^\+?[0-9]{6,15}$/.test(phone.trim())
  ) {
    errors.push("phoneNumberE164 must be a valid E.164 number")
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

export const whatsappUnofficialConnector: TransportConnector = {
  transportKind: "whatsapp_unofficial",
  capability: WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY,
  messageCapabilities: WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES,
  // requiresRecipientAddressMetadata stays UNSET — a JID is self-contained.

  validateCredentials,

  async startAccount(ctx) {
    return startWhatsappAccount(ctx)
  },

  async sendMessage(input) {
    return sendWhatsappMessage({
      account: input.account,
      endpoint: input.endpoint,
      message: input.message as CanonicalMessage,
      replyTo: input.replyTo,
    })
  },

  // Reactions are single-slot but sent through `sendMessage` as a reaction
  // canonical part (handled in outbound.ts), so no separate adapter is needed.
  createStatusReactionAdapter() {
    return null
  },

  createTypingAdapter(input) {
    try {
      return createWhatsappTypingAdapter({
        account: input.account,
        endpointRef: input.endpointRef,
      })
    } catch {
      return null
    }
  },

  parseInboundMentions(input) {
    return parseWhatsappMentions(input.rawMentions)
  },

  renderOutboundMention(input) {
    return renderWhatsappMention(input)
  },
}

registerConnector(whatsappUnofficialConnector)
