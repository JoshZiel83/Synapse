import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

/**
 * Placeholder capabilities for the v2 Enterprise WeChat (WeCom) connector.
 *
 * Lists no supported connection modes so the existing account-create UI
 * naturally rejects attempts to provision a WeCom account until the v2
 * connector implementation lands.
 */
export const WECOM_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "wecom",
  displayName: "WeCom",
  iconAssetPath: "/icon/wecom.svg",
  supportedConnectionModes: [],
  supportedEndpointTypes: [],
  supportsDirectMessages: false,
  supportsGroupMessages: false,
}

export const WECOM_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  canReact: false,
  canTyping: false,
  canSendCard: false,
  canStream: false,
  supportsGroup: false,
  supportsMention: false,
  supportsReply: false,
  supportsImage: false,
  supportsFile: false,
  supportsVoice: false,
  supportsVideo: false,
  supportsInteractionPrompt: false,
  maxTextBytes: 0,
  directMentionPolicy: "attached_only",
}
