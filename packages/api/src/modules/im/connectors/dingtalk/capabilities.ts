import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

/**
 * DingTalk capability descriptors.
 *
 * v1 scope: Stream long-connection only, text + markdown send/receive in
 * group and direct chats. No image/file/voice/video upload (these degrade
 * to system_marker placeholders inbound), no reactions, no AI card streaming.
 *
 * `supportsMention: true` is best-effort: only the sessionWebhook reply
 * path will produce real @-highlight UI in DingTalk via `at.atUserIds`.
 * The OpenAPI fallback (groupMessages/send, oToMessages/batchSend) does
 * NOT write a top-level `at` field in v1, so group @s through that path
 * render as plain "@<name>" text without highlight.
 */
export const DINGTALK_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "dingtalk",
  displayName: "DingTalk",
  iconAssetPath: "/icon/dingtalk.svg",
  supportedConnectionModes: ["long_connection"],
  supportedEndpointTypes: ["direct", "group"],
  supportsDirectMessages: true,
  supportsGroupMessages: true,
}

export const DINGTALK_MESSAGE_CAPABILITIES: MessageCapabilities = {
  // Bot reply messages cannot be edited via the gateway.
  canEdit: false,
  // No reaction API exposed to bots in v1.
  canReact: false,
  // No native typing indicator.
  canTyping: false,
  // Cards (AI cards in particular) are deferred to v1.1 — needs runtime
  // stream-chunk hook to be useful, otherwise just regular markdown.
  canSendCard: false,
  canStream: false,
  supportsGroup: true,
  // best-effort: see file header for sessionWebhook vs OpenAPI nuance.
  supportsMention: true,
  // sessionWebhook is a temporary callback URL, not a platform-level
  // reply/thread anchor. Leaving false so the degradation layer flattens
  // quote parts to "> preview" text instead of attempting threading.
  supportsReply: false,
  supportsImage: false,
  supportsFile: false,
  // v1 DingTalk: no audio/video upload, no interaction-prompt
  // projection (no inline-button equivalent on the Stream API).
  supportsVoice: false,
  supportsVideo: false,
  supportsInteractionPrompt: false,
  // DingTalk markdown body roughly 4kB safe ceiling per OpenClaw refs.
  maxTextBytes: 4000,
  // Direct endpoint externalId is data.conversationId, NOT staffId, so
  // self_only (which would compare externalId to the mention's staffId)
  // would drop every direct mention. attached_only matches Feishu/WeCom.
  directMentionPolicy: "attached_only",
}
