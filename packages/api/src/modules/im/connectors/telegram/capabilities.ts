/**
 * Telegram Bot API connector — capabilities descriptor.
 *
 * Telegram supports BOTH inbound transport modes:
 *   - "long_connection" — getUpdates long-poll (default; runs behind NAT,
 *     the per-account Redis lease guarantees the single poller Telegram's
 *     getUpdates requires, avoiding the 409 "terminated by other
 *     getUpdates" conflict).
 *   - "webhook" — setWebhook + an `X-Telegram-Bot-Api-Secret-Token` header
 *     check on the inbound POST.
 *
 * Endpoint types: `direct` (private chats) and `group` (groups /
 * supergroups). Channels and forum-topic threading are out of v1 scope.
 *
 * `supportsVoice`/`supportsVideo` are true: the connector transcodes
 * arbitrary audio to OGG/Opus via `infrastructure/media/transcode.ts`. If
 * ffmpeg is not provisioned at runtime the connector flips voice → a
 * placeholder rather than failing the send (see docs plan §5.2 / OD-3).
 */

import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

export const TELEGRAM_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "telegram",
  displayName: "Telegram",
  supportedConnectionModes: ["long_connection", "webhook"],
  supportedEndpointTypes: ["direct", "group"],
  supportsDirectMessages: true,
  supportsGroupMessages: true,
}

export const TELEGRAM_MESSAGE_CAPABILITIES: MessageCapabilities = {
  // editMessageText is supported; status feedback can edit in place.
  canEdit: true,
  // setMessageReaction (single-slot from the fixed standard emoji set).
  canReact: true,
  // sendChatAction("typing"); indicator expires ~5s → typing.ts overrides
  // the controller heartbeat to ~4s.
  canTyping: true,
  canSendCard: false,
  canStream: false,
  supportsGroup: true,
  // text_mention entities / tg://user?id deep links.
  supportsMention: true,
  // reply_parameters / reply_to_message_id.
  supportsReply: true,
  supportsImage: true,
  supportsFile: true,
  supportsVoice: true,
  supportsVideo: true,
  // Inline keyboards (keyboard.ts + interaction-handler.ts) are deferred
  // to a later stage; flip to true when they land.
  supportsInteractionPrompt: false,
  // Telegram caps a text message at 4096 UTF-16 code units; render.ts
  // splits longer messages on newline boundaries.
  maxTextBytes: 4096,
  directMentionPolicy: "attached_only",
}
