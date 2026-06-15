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
import type { InboundEnvelope } from "../connectors/types.js"
import { getWorkspaceOwnerId } from "./repo.js"
import {
  createConversation,
  createConversationItem,
  enqueueActorWakeupsForConversationMessage,
  ensureConversationParticipant,
} from "../../chat/service.js"
import { getWorkspaceChiefActorPreference } from "../../workspace/service.js"
import {
  ingestInboundEnvelopeUseCase,
  type IngestInboundEnvelopeDeps,
} from "./inbound-message.js"
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

function inboundMessageDeps(): IngestInboundEnvelopeDeps {
  return {
    ensureTransportConversationBinding,
    findTransportMessageLinkByExternalMessage,
    ensureTransportAddress,
    getPendingTransportAccountAutoLinkWorkspaceMemberId,
    consumeTransportAccountAutoLink,
    syncTransportAddressConversationParticipant,
    updateTransportAddressMetadata,
    updateTransportEndpointMetadata,
    attachDefaultWakeTarget,
    createConversationItem,
    queueConversationTransportProjection,
    updateTransportMessageLinkStatus,
    enqueueActorWakeupsForConversationMessage,
    notifyRemoteAgentDeliveriesForConversation: async (conversationId) => {
      const { notifyRemoteAgentDeliveriesForConversation } =
        await import("../../remote-agents/service.js")
      await notifyRemoteAgentDeliveriesForConversation(conversationId)
    },
  }
}

export async function ingestInboundEnvelope(params: {
  account: TransportAccountSummary
  envelope: InboundEnvelope
}) {
  return ingestInboundEnvelopeUseCase(params, inboundMessageDeps())
}
