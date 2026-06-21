/**
 * WhatsApp (unofficial) connector capabilities descriptor.
 *
 * Logs in a real WhatsApp number through the multi-device web protocol via
 * Baileys (QR / pairing-code), like a phone — mirroring the existing
 * personal-WeChat (weixin) connector. `long_connection` only: a persistent
 * WebSocket held in `startAccount`, driven by the runtime reconcile loop +
 * per-account Redis lease (the lease guarantees one socket per number,
 * avoiding `connectionReplaced` fights).
 *
 * RISK (see docs plan §4.5 / OD-1): this violates WhatsApp's ToS, carries
 * unrecoverable account-level ban risk, and Meta can break the private
 * protocol without notice. Ship only with the documented kill-switch +
 * encrypted session blob + on-call owner.
 */

import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

export const WHATSAPP_UNOFFICIAL_CONNECTOR_CAPABILITY: TransportConnectorCapability =
  {
    transportKind: "whatsapp_unofficial",
    displayName: "WhatsApp (unofficial)",
    iconAssetPath: "/icon/whatsapp_unofficial.svg",
    supportedConnectionModes: ["long_connection"],
    supportedEndpointTypes: ["direct", "group"],
    supportsDirectMessages: true,
    supportsGroupMessages: true,
  }

export const WHATSAPP_UNOFFICIAL_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  // reaction messages (single-slot).
  canReact: true,
  // sendPresenceUpdate("composing"); expires ~10s → typing config override.
  canTyping: true,
  canSendCard: false,
  canStream: false,
  supportsGroup: true,
  // group @ via contextInfo.mentionedJid.
  supportsMention: true,
  // quoted message reply.
  supportsReply: true,
  supportsImage: true,
  supportsFile: true,
  supportsVoice: true,
  supportsVideo: true,
  supportsInteractionPrompt: false,
  maxTextBytes: 4096,
  directMentionPolicy: "attached_only",
}
