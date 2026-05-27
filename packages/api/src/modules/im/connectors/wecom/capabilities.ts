import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

/**
 * Capabilities for the v1 WeCom (Enterprise WeChat) AI-Bot connector.
 *
 * v1 ships only the long-connection AI-Bot API mode
 * (`wss://openws.work.weixin.qq.com`). Webhook callback, group-robot
 * single-direction webhook, and self-built app `message/send` are
 * deliberately out of scope; see docs/wecom-connector.md.
 *
 * Text + markdown only in v1. No image/file/voice/card. Active reply only,
 * no @-mention rendering, no reply quoting (groups quote source automatically).
 */
export const WECOM_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "wecom",
  supportedConnectionModes: ["long_connection"],
  supportedEndpointTypes: ["direct", "group"],
  supportsDirectMessages: true,
  supportsGroupMessages: true,
}

export const WECOM_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  canReact: false,
  canTyping: false,
  canSendCard: false,
  canStream: false,
  supportsGroup: true,
  supportsMention: false,
  supportsReply: false,
  supportsImage: false,
  supportsFile: false,
  maxTextBytes: 4096,
  directMentionPolicy: "attached_only",
}
