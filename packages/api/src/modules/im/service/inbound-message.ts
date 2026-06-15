import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
} from "@synapse/shared"
import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
  TransportKind,
} from "@synapse/shared/types"
import type { InboundEnvelope } from "../connectors/types.js"
import { derivePlainText } from "../messaging/canonical-message.js"
import { mergeInboundMetadata } from "../ingest-metadata.js"

type TransportAddressForInbound = {
  id: string
  workspaceMemberId?: string | null
}

type ConversationParticipantForInbound = {
  id: string
}

type ConversationItemForInbound = {
  id: string
}

type TransportMessageLinkForInbound = {
  id: string
}

export type IngestInboundEnvelopeDeps = {
  ensureTransportConversationBinding: (params: {
    account: TransportAccountSummary
    envelope: InboundEnvelope
  }) => Promise<ConversationTransportBindingSummary | null>
  findTransportMessageLinkByExternalMessage: (params: {
    transportAccountId: string
    transportEndpointId: string
    externalMessageId: string
    direction: "inbound"
  }) => Promise<TransportMessageLinkForInbound | null | undefined>
  ensureTransportAddress: (params: {
    workspaceId: string
    transportAccountId: string
    transportKind: TransportKind
    addressType: "user"
    externalId: string
    displayName?: string
    metadata?: Record<string, unknown>
  }) => Promise<TransportAddressForInbound | null>
  getPendingTransportAccountAutoLinkWorkspaceMemberId: (
    account: TransportAccountSummary
  ) => string | null | undefined
  consumeTransportAccountAutoLink: (params: {
    account: TransportAccountSummary
    transportAddressId: string
    targetWorkspaceMemberId: string
    matchedExternalId: string
  }) => Promise<unknown>
  syncTransportAddressConversationParticipant: (params: {
    conversationId: string
    transportAddressId: string
    workspaceMemberId?: string
    displayName: string
  }) => Promise<ConversationParticipantForInbound>
  updateTransportAddressMetadata: (params: {
    transportAddressId: string
    metadata: Record<string, unknown>
  }) => Promise<unknown>
  updateTransportEndpointMetadata: (params: {
    endpointId: string
    metadata: Record<string, unknown>
  }) => Promise<unknown>
  attachDefaultWakeTarget: (
    binding: ConversationTransportBindingSummary
  ) => Promise<void>
  createConversationItem: (params: {
    workspaceId: string
    conversationId: string
    scope: typeof CONVERSATION_ITEM_SCOPE.SHARED
    surface: typeof CONVERSATION_ITEM_SURFACE.VISIBLE
    itemType: typeof CONVERSATION_ITEM_TYPE.MESSAGE
    subtype: typeof CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE
    role: "user"
    authorParticipantId: string
    metadata: Record<string, unknown>
    parts: Array<{ type: "text"; text: string }>
  }) => Promise<ConversationItemForInbound>
  queueConversationTransportProjection: (params: {
    workspaceId: string
    conversationId: string
    itemId: string
    direction: "inbound"
    externalMessageId: string
    externalReplyToId?: string
    externalThreadId?: string
    metadata: Record<string, unknown>
  }) => Promise<TransportMessageLinkForInbound | null | undefined>
  updateTransportMessageLinkStatus: (params: {
    linkId: string
    status: "sent"
    externalMessageId: string
  }) => Promise<unknown>
  enqueueActorWakeupsForConversationMessage: (params: {
    workspaceId: string
    conversationId: string
    itemId: string
  }) => Promise<unknown>
  notifyRemoteAgentDeliveriesForConversation: (
    conversationId: string
  ) => Promise<void>
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function clearConsumedAutoLinkMetadata(account: TransportAccountSummary) {
  if (!account.metadata || typeof account.metadata !== "object") return
  delete account.metadata.pendingAutoLinkWorkspaceMemberId
  delete account.metadata.pendingAutoLinkMode
  delete account.metadata.pendingAutoLinkConfiguredAt
}

function readTransportString(
  metadata: Record<string, unknown>,
  key: "externalReplyToId" | "externalThreadId"
) {
  const transport = metadata.transport
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    return undefined
  }
  const value = (transport as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

export async function ingestInboundEnvelopeUseCase(
  params: {
    account: TransportAccountSummary
    envelope: InboundEnvelope
  },
  deps: IngestInboundEnvelopeDeps
) {
  const { account, envelope } = params
  const binding = await deps.ensureTransportConversationBinding({
    account,
    envelope,
  })
  if (!binding) {
    throw new Error(
      "Unable to resolve conversation binding for inbound message"
    )
  }

  const existingLink = await deps.findTransportMessageLinkByExternalMessage({
    transportAccountId: account.id,
    transportEndpointId: binding.endpoint.id,
    externalMessageId: envelope.externalMessageId,
    direction: "inbound",
  })
  if (existingLink) {
    return existingLink
  }

  const senderAddress = await deps.ensureTransportAddress({
    workspaceId: binding.workspaceId,
    transportAccountId: account.id,
    transportKind: account.transportKind,
    addressType: "user",
    externalId: envelope.sender.externalId,
    displayName: envelope.sender.displayName,
    metadata: envelope.sender.metadata,
  })
  if (!senderAddress) {
    throw new Error("Failed to create sender transport address")
  }

  let linkedWorkspaceMemberId =
    typeof senderAddress.workspaceMemberId === "string" &&
    senderAddress.workspaceMemberId.trim()
      ? senderAddress.workspaceMemberId
      : undefined
  if (!linkedWorkspaceMemberId) {
    const pendingAutoLinkWorkspaceMemberId =
      deps.getPendingTransportAccountAutoLinkWorkspaceMemberId(account)
    if (pendingAutoLinkWorkspaceMemberId) {
      await deps.consumeTransportAccountAutoLink({
        account,
        transportAddressId: senderAddress.id,
        targetWorkspaceMemberId: pendingAutoLinkWorkspaceMemberId,
        matchedExternalId: envelope.sender.externalId,
      })
      clearConsumedAutoLinkMetadata(account)
      linkedWorkspaceMemberId = pendingAutoLinkWorkspaceMemberId
    }
  }

  const senderParticipant =
    await deps.syncTransportAddressConversationParticipant({
      conversationId: binding.conversationId,
      transportAddressId: senderAddress.id,
      workspaceMemberId: linkedWorkspaceMemberId,
      displayName:
        envelope.sender.displayName ||
        envelope.sender.externalId ||
        "External user",
    })

  if (envelope.sender.metadata) {
    await deps.updateTransportAddressMetadata({
      transportAddressId: senderAddress.id,
      metadata: envelope.sender.metadata,
    })
  }
  if (envelope.endpointMetadata) {
    await deps.updateTransportEndpointMetadata({
      endpointId: binding.endpoint.id,
      metadata: envelope.endpointMetadata,
    })
  }

  await deps.attachDefaultWakeTarget(binding)

  const plainText =
    envelope.message.plainText || derivePlainText(envelope.message.parts)
  const normalizedContent =
    nonEmptyString(plainText) || `[${account.transportKind} message]`

  const mergedMetadata = mergeInboundMetadata(
    {
      direction: "inbound",
      transportKind: account.transportKind,
      transportAccountId: account.id,
      endpointType: envelope.endpointType,
      endpointExternalId: envelope.endpointExternalId,
      externalMessageId: envelope.externalMessageId,
      transportAddressId: senderAddress.id,
      senderExternalId: envelope.sender.externalId,
    },
    {
      ...(envelope.raw || {}),
      transport: {
        canonicalParts: envelope.message.parts,
        externalReplyToId: envelope.externalReplyToId,
        externalThreadId: envelope.externalThreadId,
      },
    }
  )

  const item = await deps.createConversationItem({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: "user",
    authorParticipantId: senderParticipant.id,
    metadata: mergedMetadata,
    parts: [
      {
        type: "text",
        text: normalizedContent,
      },
    ],
  })

  const link = await deps.queueConversationTransportProjection({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
    direction: "inbound",
    externalMessageId: envelope.externalMessageId,
    externalReplyToId: readTransportString(mergedMetadata, "externalReplyToId"),
    externalThreadId: readTransportString(mergedMetadata, "externalThreadId"),
    metadata: {
      transportKind: account.transportKind,
      senderExternalId: envelope.sender.externalId,
      endpointExternalId: envelope.endpointExternalId,
    },
  })
  if (link?.id) {
    await deps.updateTransportMessageLinkStatus({
      linkId: link.id,
      status: "sent",
      externalMessageId: envelope.externalMessageId,
    })
  }

  await deps.enqueueActorWakeupsForConversationMessage({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
  })
  await deps.notifyRemoteAgentDeliveriesForConversation(binding.conversationId)

  return link
}
