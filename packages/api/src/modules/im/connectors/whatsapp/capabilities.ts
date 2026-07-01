/**
 * WhatsApp Business Platform — CLOUD API connector capabilities descriptor.
 *
 * The official, Meta-hosted path. WEBHOOK-only (no socket): inbound events
 * arrive as POSTs verified by `X-Hub-Signature-256`, and the subscription
 * is established via an HTTP GET `hub.challenge` handshake
 * (`handleWebhookVerification`).
 *
 * Endpoint types: `direct` only in v1 — Cloud API group messaging is
 * template-centric and out of scope (see docs plan OD-5).
 *
 * PRODUCT CONSTRAINT (see docs plan §4.5 / OD-1a): outside the 24-hour
 * customer-service window the Cloud API only permits pre-approved TEMPLATE
 * messages, so an agent cannot send arbitrary free-form text to initiate a
 * conversation. The capability descriptor cannot express this; the window
 * gate lives in the connector's outbound path.
 */

import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

export const WHATSAPP_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "whatsapp",
  displayName: "WhatsApp",
  supportedConnectionModes: ["webhook"],
  supportedEndpointTypes: ["direct"],
  supportsDirectMessages: true,
  supportsGroupMessages: false,
}

export const WHATSAPP_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  // reaction messages (type:"reaction"); single-slot, empty emoji removes.
  canReact: true,
  // Typing/read indicators require the inbound message id
  // (lastInboundMessageRef); createTypingAdapter returns null without it.
  canTyping: true,
  canSendCard: false,
  canStream: false,
  supportsGroup: false,
  supportsMention: false,
  // context.message_id reply.
  supportsReply: true,
  supportsImage: true,
  supportsFile: true,
  supportsVoice: true,
  supportsVideo: true,
  supportsInteractionPrompt: false,
  maxTextBytes: 4096,
  // 1:1 only; the single peer is the endpoint's externalId.
  directMentionPolicy: "self_only",
}
