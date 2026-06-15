/**
 * Inbound message ingest orchestrator. Every connector hands a
 * normalized InboundEnvelope to this function via the runtime's
 * `emitInbound` callback. From here it:
 *
 *   1. Resolves (or auto-creates) the conversation_transport_binding
 *   2. Dedupes against transport_message_links (by external_message_id)
 *   3. Ensures the sender's transport_address + workspace_member link
 *      (with optional auto-link consumption)
 *   4. Updates address/endpoint metadata if the envelope brought new
 *      bits
 *   5. Persists a conversation_item with the canonical content
 *   6. Records a transport_message_link in `sent` state (inbound is
 *      "sent" from the platform's POV, so the receive ack is implicit)
 *   7. Enqueues actor wake-ups + notifies remote agents
 *
 * Pulled out of runtime.ts so the runtime layer is purely about
 * lifecycle (lease + reconcile + per-account abort), not message
 * semantics. Adding new ingest behavior should happen here, not in
 * connectors and not in the runtime manager.
 */

import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
} from "@synapse/shared/types"
import { CONVERSATION_MESSAGE_SUBTYPE } from "@synapse/shared"
import { derivePlainText } from "../messaging/canonical-message.js"
import type { InboundEnvelope } from "../connectors/types.js"
import { mergeInboundMetadata } from "../ingest-metadata.js"
import { getWorkspaceOwnerId } from "./repo.js"
import {
  createConversation,
  createConversationItem,
  enqueueActorWakeupsForConversationMessage,
  ensureConversationParticipant,
} from "../../chat/service.js"
import { getWorkspaceChiefActorPreference } from "../../workspace/service.js"
import {
  consumeTransportAccountAutoLink,
  ensureTransportAddress,
  findConversationTransportBindingByEndpoint,
  findTransportMessageLinkByExternalMessage,
  getPendingTransportAccountAutoLinkWorkspaceMemberId,
  queueConversationTransportProjection,
  syncTransportAddressConversationParticipant,
  updateTransportAddressMetadata,
  updateTransportEndpointMetadata,
  updateTransportMessageLinkStatus,
  upsertConversationTransportBinding,
} from "../service.js"

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function ensureTransportConversationBinding(params: {
  account: TransportAccountSummary
  envelope: InboundEnvelope
}) {
  const { account, envelope } = params
  const existing = await findConversationTransportBindingByEndpoint({
    transportAccountId: account.id,
    endpointType: envelope.endpointType,
    endpointExternalId: envelope.endpointExternalId,
  })
  if (existing) {
    return existing
  }

  await getWorkspaceOwnerId(account.workspaceId)
  const created = await createConversation({
    workspaceId: account.workspaceId,
    kind: envelope.endpointType === "group" ? "group" : "direct",
    title:
      envelope.endpointDisplayName ||
      `${account.displayName} ${envelope.endpointType === "group" ? "群聊" : "私聊"}`,
  })

  try {
    return await upsertConversationTransportBinding({
      workspaceId: account.workspaceId,
      conversationId: created.id as string,
      transportAccountId: account.id,
      endpointType: envelope.endpointType,
      endpointExternalId: envelope.endpointExternalId,
      endpointDisplayName: envelope.endpointDisplayName,
      outboundEnabled: true,
      inboundActorMode: "inherit_account",
      metadata: {
        autoCreated: true,
      },
    })
  } catch (error: any) {
    if (error?.code === "23505") {
      return findConversationTransportBindingByEndpoint({
        transportAccountId: account.id,
        endpointType: envelope.endpointType,
        endpointExternalId: envelope.endpointExternalId,
      })
    }
    throw error
  }
}

async function attachDefaultWakeTarget(
  binding: ConversationTransportBindingSummary
) {
  let actorId: string | null = null

  if (binding.inboundActorMode === "specified_actor") {
    actorId = binding.inboundActorId || null
  } else if (binding.inboundActorMode === "inherit_account") {
    if (binding.account.inboundActorMode === "specified_actor") {
      actorId = binding.account.inboundActorId || null
    } else if (
      binding.account.inboundActorMode === "follow_owner_chief_actor" &&
      binding.account.ownerScope === "workspace_member" &&
      binding.account.ownerWorkspaceMemberId
    ) {
      const preference = await getWorkspaceChiefActorPreference(
        binding.workspaceId,
        binding.account.ownerWorkspaceMemberId
      )
      actorId = preference.chiefActorId || null
    }
  }

  if (!actorId) return

  // Called for side effect: makes sure the wake-target actor is
  // attached to the conversation_participants so subsequent wake-up
  // enqueue can find it. The returned participant is currently unused
  // by the caller.
  await ensureConversationParticipant({
    conversationId: binding.conversationId,
    participantType: "actor",
    actorId,
  })
}

export async function ingestInboundEnvelope(params: {
  account: TransportAccountSummary
  envelope: InboundEnvelope
}) {
  const { account, envelope } = params
  const binding = await ensureTransportConversationBinding({
    account,
    envelope,
  })
  if (!binding) {
    throw new Error(
      "Unable to resolve conversation binding for inbound message"
    )
  }

  const existingLink = await findTransportMessageLinkByExternalMessage({
    transportAccountId: account.id,
    transportEndpointId: binding.endpoint.id,
    externalMessageId: envelope.externalMessageId,
    direction: "inbound",
  })
  if (existingLink) {
    return existingLink
  }

  const senderAddress = await ensureTransportAddress({
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
      getPendingTransportAccountAutoLinkWorkspaceMemberId(account)
    if (pendingAutoLinkWorkspaceMemberId) {
      await consumeTransportAccountAutoLink({
        account,
        transportAddressId: senderAddress.id,
        targetWorkspaceMemberId: pendingAutoLinkWorkspaceMemberId,
        matchedExternalId: envelope.sender.externalId,
      })
      // Local cache is now stale; future reads through the connector
      // path will refresh from DB. Clear the flags so a re-entry inside
      // the same envelope (defensive) doesn't try to consume twice.
      if (account.metadata && typeof account.metadata === "object") {
        delete (account.metadata as Record<string, unknown>)
          .pendingAutoLinkWorkspaceMemberId
        delete (account.metadata as Record<string, unknown>).pendingAutoLinkMode
        delete (account.metadata as Record<string, unknown>)
          .pendingAutoLinkConfiguredAt
      }
      linkedWorkspaceMemberId = pendingAutoLinkWorkspaceMemberId
    }
  }
  const senderParticipant = await syncTransportAddressConversationParticipant({
    conversationId: binding.conversationId,
    transportAddressId: senderAddress.id,
    workspaceMemberId: linkedWorkspaceMemberId,
    displayName:
      envelope.sender.displayName ||
      envelope.sender.externalId ||
      "External user",
  })
  if (envelope.sender.metadata) {
    await updateTransportAddressMetadata({
      transportAddressId: senderAddress.id,
      metadata: envelope.sender.metadata,
    })
  }
  if (envelope.endpointMetadata) {
    await updateTransportEndpointMetadata({
      endpointId: binding.endpoint.id,
      metadata: envelope.endpointMetadata,
    })
  }

  await attachDefaultWakeTarget(binding)

  const plainText =
    envelope.message.plainText || derivePlainText(envelope.message.parts)
  const normalizedContent =
    nonEmptyString(plainText) || `[${account.transportKind} message]`

  // Deep-merge metadata so connector-supplied transport fields (e.g.
  // canonicalParts, externalReplyToId, externalThreadId) extend rather than
  // overwrite the runtime-built transport descriptor below. Runtime-built
  // keys always win to prevent connector payloads from spoofing identity.
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

  const item = await createConversationItem({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    scope: "shared",
    surface: "visible",
    itemType: "message",
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

  const mergedTransport =
    (mergedMetadata.transport as Record<string, unknown> | undefined) || {}
  const externalReplyToId =
    typeof mergedTransport.externalReplyToId === "string"
      ? mergedTransport.externalReplyToId
      : undefined
  const externalThreadId =
    typeof mergedTransport.externalThreadId === "string"
      ? mergedTransport.externalThreadId
      : undefined

  const link = await queueConversationTransportProjection({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
    direction: "inbound",
    externalMessageId: envelope.externalMessageId,
    externalReplyToId,
    externalThreadId,
    metadata: {
      transportKind: account.transportKind,
      senderExternalId: envelope.sender.externalId,
      endpointExternalId: envelope.endpointExternalId,
    },
  })
  if (link?.id) {
    await updateTransportMessageLinkStatus({
      linkId: link.id,
      status: "sent",
      externalMessageId: envelope.externalMessageId,
    })
  }

  await enqueueActorWakeupsForConversationMessage({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
  })
  const { notifyRemoteAgentDeliveriesForConversation } =
    await import("../../remote-agents/service.js")
  await notifyRemoteAgentDeliveriesForConversation(binding.conversationId)

  return link
}
