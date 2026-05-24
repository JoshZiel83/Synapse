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
  // Native upload via Lark im.image.create / im.file.create — see
  // attachments.ts. Image/file parts in the CanonicalMessage now flow
  // through to the platform as actual attachments instead of degrading
  // to text placeholders.
  supportsImage: true,
  supportsFile: true,
  maxTextBytes: 30_000,
  // Feishu bot can only @ users it has previously seen in the conversation;
  // resolve mentions against the attached-address set even in 1:1 chats.
  directMentionPolicy: "attached_only",
}
