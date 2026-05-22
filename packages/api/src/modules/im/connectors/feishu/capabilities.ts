import type { TransportConnectorCapability } from "@synapse/shared/types"
import type { MessageCapabilities } from "../../messaging/degradation.js"

export const FEISHU_CONNECTOR_CAPABILITY: TransportConnectorCapability = {
  transportKind: "feishu",
  supportedConnectionModes: ["webhook", "long_connection"],
  supportedEndpointTypes: ["direct", "group"],
  supportsDirectMessages: true,
  supportsGroupMessages: true,
}

export const FEISHU_MESSAGE_CAPABILITIES: MessageCapabilities = {
  canEdit: true,
  canReact: true,
  canTyping: false,
  canSendCard: true,
  canStream: true,
  supportsGroup: true,
  supportsMention: true,
  supportsReply: true,
  supportsImage: true,
  supportsFile: true,
  maxTextBytes: 30_000,
}
