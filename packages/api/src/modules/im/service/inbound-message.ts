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
import type { DatabaseTransaction } from "../../../infrastructure/database/kysely.js"
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
  runInTransaction: <T>(
    callback: (queryable: DatabaseTransaction) => Promise<T>
  ) => Promise<T>
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
    parts: Array<
      | { type: "text"; text: string }
      | {
          type: "file_ref"
          refSha256: string
          refPath?: string | null
          mimeType?: string
          name?: string
          metadata?: Record<string, unknown>
        }
    >
    queryable?: DatabaseTransaction
  }) => Promise<ConversationItemForInbound>
  queueConversationTransportProjection: (params: {
    tx?: DatabaseTransaction
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
    tx?: DatabaseTransaction
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

const INBOUND_EXTERNAL_MESSAGE_UNIQUE_INDEX =
  "uq_transport_message_links_inbound_external_message"

function isInboundExternalMessageUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    (error as { constraint?: unknown }).constraint ===
      INBOUND_EXTERNAL_MESSAGE_UNIQUE_INDEX
  )
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

  // Persist media as content-addressed file_ref parts so the agent actually
  // sees attachments (image/voice/video/file) instead of only the "[图片]"
  // placeholder text. The connector has already downloaded the bytes into our
  // CAS and stamped the sha256 on the part; here we just project each media
  // part to a file_ref conversation-item part keyed by that sha256.
  const itemParts: Array<
    | { type: "text"; text: string }
    | {
        type: "file_ref"
        refSha256: string
        refPath?: string | null
        mimeType?: string
        name?: string
        metadata?: Record<string, unknown>
      }
  > = [{ type: "text", text: normalizedContent }]
  for (const part of envelope.message.parts) {
    if (
      part.type === "image" ||
      part.type === "voice" ||
      part.type === "video" ||
      part.type === "file"
    ) {
      const fileRef = part.fileRef
      if (fileRef.sha256) {
        itemParts.push({
          type: "file_ref",
          refSha256: fileRef.sha256,
          refPath: fileRef.path ?? null,
          mimeType: fileRef.mimeType,
          name: fileRef.name,
          metadata:
            fileRef.sizeBytes != null
              ? { sizeBytes: fileRef.sizeBytes }
              : undefined,
        })
      }
    }
  }

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

  let writeResult:
    | {
        item: ConversationItemForInbound
        link: TransportMessageLinkForInbound | null | undefined
      }
    | undefined
  try {
    writeResult = await deps.runInTransaction(async (queryable) => {
      const createdItem = await deps.createConversationItem({
        workspaceId: binding.workspaceId,
        conversationId: binding.conversationId,
        scope: CONVERSATION_ITEM_SCOPE.SHARED,
        surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
        itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
        subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
        role: "user",
        authorParticipantId: senderParticipant.id,
        metadata: mergedMetadata,
        parts: itemParts,
        queryable,
      })

      const projectedLink = await deps.queueConversationTransportProjection({
        tx: queryable,
        workspaceId: binding.workspaceId,
        conversationId: binding.conversationId,
        itemId: createdItem.id,
        direction: "inbound",
        externalMessageId: envelope.externalMessageId,
        externalReplyToId: readTransportString(
          mergedMetadata,
          "externalReplyToId"
        ),
        externalThreadId: readTransportString(
          mergedMetadata,
          "externalThreadId"
        ),
        metadata: {
          transportKind: account.transportKind,
          senderExternalId: envelope.sender.externalId,
          endpointExternalId: envelope.endpointExternalId,
        },
      })
      if (projectedLink?.id) {
        await deps.updateTransportMessageLinkStatus({
          tx: queryable,
          linkId: projectedLink.id,
          status: "sent",
          externalMessageId: envelope.externalMessageId,
        })
      }
      return { item: createdItem, link: projectedLink }
    })
  } catch (error) {
    if (isInboundExternalMessageUniqueViolation(error)) {
      const racedLink = await deps.findTransportMessageLinkByExternalMessage({
        transportAccountId: account.id,
        transportEndpointId: binding.endpoint.id,
        externalMessageId: envelope.externalMessageId,
        direction: "inbound",
      })
      if (racedLink) return racedLink
    }
    throw error
  }

  if (!writeResult) {
    throw new Error("Failed to create inbound conversation item")
  }

  await deps.enqueueActorWakeupsForConversationMessage({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: writeResult.item.id,
  })
  await deps.notifyRemoteAgentDeliveriesForConversation(binding.conversationId)

  return writeResult.link
}
