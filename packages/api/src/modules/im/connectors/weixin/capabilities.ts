import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

/**
 * Personal-WeChat connector via the ilinkai bot protocol.
 * Personal WeChat has NO group support, NO reactions, NO message edit,
 * but does have a native typing indicator (sendtyping endpoint).
 *
 * Future Enterprise WeChat (wecom) lives under connectors/wecom/.
 */
export const WEIXIN_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "weixin",
  displayName: "WeChat",
  supportedConnectionModes: ["long_connection"],
  supportedEndpointTypes: ["direct"],
  supportsDirectMessages: true,
  supportsGroupMessages: false,
  // Weixin v1 routes traffic through a configurable ilinkai gateway —
  // the dashboard exposes a `baseWsUrl` panel. Other connectors don't
  // need this and leave the flag undefined.
  showsBaseUrlConfig: true,
}

export const WEIXIN_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: false,
  canReact: false,
  canTyping: true,
  canSendCard: false,
  canStream: false,
  supportsGroup: false,
  supportsMention: false,
  supportsReply: false,
  // Outbound media is uploaded to the WeChat CDN (AES-128-ECB) and sent as
  // image/video/file items (see outbound.ts + media-cdn.ts). Voice send stays
  // off — it would require SILK encoding we don't ship.
  supportsImage: true,
  supportsFile: true,
  supportsVoice: false,
  supportsVideo: true,
  supportsInteractionPrompt: false,
  maxTextBytes: 5_000,
  // Personal WeChat 1:1 chats contain exactly one human; the only
  // mention you can address is the peer themselves.
  directMentionPolicy: "self_only",
}
