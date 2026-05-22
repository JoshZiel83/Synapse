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
  // V1: image/file outbound is not implemented in render.ts (would need
  // Lark im.image.create / im.file.create upload flow first). Setting
  // these to false makes degradation.ts replace image with system_marker
  // and file with [文件 name] text instead of silently dropping the part.
  // Flip to true once the upload path lands.
  supportsImage: false,
  supportsFile: false,
  maxTextBytes: 30_000,
}
