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
  supportedConnectionModes: ["long_connection"],
  supportedEndpointTypes: ["direct"],
  supportsDirectMessages: true,
  supportsGroupMessages: false,
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
  supportsImage: false,
  supportsFile: false,
  maxTextBytes: 5_000,
  // Personal WeChat 1:1 chats contain exactly one human; the only
  // mention you can address is the peer themselves.
  directMentionPolicy: "self_only",
}
