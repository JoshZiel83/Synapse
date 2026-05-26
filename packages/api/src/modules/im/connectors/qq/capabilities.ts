/**
 * QQ official bot connector — capabilities descriptor.
 *
 * v1 supports both transport modes the QQ open platform exposes:
 *   - "webhook"          — HTTPS callback with Ed25519 signatures
 *   - "long_connection"  — WebSocket /gateway with op-coded protocol
 *
 * Note that webhook-mode accounts also need `webhookInboundConfirmed`
 * set in account.config (OQ2) before any inbound messages are accepted;
 * the binding helper (`transportKindDefaultsForBindings`) keeps
 * outbound disabled by default for those accounts until the operator
 * has verified delivery in the sandbox.
 *
 * Endpoint types: only `direct` (C2C) and `group` (group @ bot) in v1;
 * frequency-channel / private-channel scenarios are deferred.
 *
 * Stage 1 caveat: capability flags below are conservative on purpose.
 * Subsequent stages flip individual flags as the supporting code lands:
 *   - Stage 4: text outbound (no capability flag change; the
 *     skeleton already supports text via the canonical path).
 *   - Stage 5: supportsImage/File/Voice/Video → true.
 *   - Stage 6: canTyping → true (per-account: only effective for
 *     long_connection accounts; see G2 + actor-status-hooks).
 *   - Stage 8: supportsInteractionPrompt → true.
 */

import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

export const QQ_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "qq",
  supportedConnectionModes: ["webhook", "long_connection"],
  supportedEndpointTypes: ["direct", "group"],
  supportsDirectMessages: true,
  supportsGroupMessages: true,
}

export const QQ_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  canReact: false,
  // Stage 6: typing.ts returns a per-call adapter+config. Only
  // effective for direct endpoints; group endpoints return null from
  // createTypingAdapter so the IM typing controller is a no-op there.
  canTyping: true,
  // QQ has Inline Keyboard which we render in Stage 8 via the new
  // interaction_prompt part (see G4 + G5). The classic "interactive
  // card" channel (Feishu-style) isn't supported.
  canSendCard: false,
  canStream: false,
  supportsGroup: true,
  // v1 deliberately false: mentions only make sense in group endpoints
  // (C2C is 1:1; QQ docs require `<@member_openid>` syntax), and the
  // mention renderer for groups is not yet wired. Stage 4.5 may flip
  // this once the group renderer + address-encoding decode lands.
  supportsMention: false,
  supportsReply: true,
  // Stage 5 outbound is wired: image/voice/video flow via
  // media-upload.ts → file_info → POST /messages with msg_type=7.
  // `supportsFile=true` is platform-true for C2C; group `file_type=4`
  // is explicitly rejected at upload time with code
  // qq_group_file_not_supported, surfacing in dashboards rather than
  // silently being dropped.
  supportsImage: true,
  supportsFile: true,
  supportsVoice: true,
  supportsVideo: true,
  // Stage 8 flips this true; degradation produces fallback text until then.
  supportsInteractionPrompt: false,
  // 5000 is QQ's per-message markdown character cap (per
  // openclaw-qqbot:src/channel.ts TEXT_CHUNK_LIMIT). Plain text is
  // softer but using the markdown ceiling keeps a single number.
  maxTextBytes: 5_000,
  // QQ bots can address any user in a group endpoint they've seen
  // before (the group member_openid is exposed in incoming events);
  // direct chats have a single peer, same as Weixin. Use
  // `attached_only` so the mention resolver consults the
  // transport_addresses set for both endpoint types.
  directMentionPolicy: "attached_only",
}
