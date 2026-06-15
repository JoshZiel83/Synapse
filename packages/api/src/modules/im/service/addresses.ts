/**
 * transport_addresses domain: ensure/lookup external addresses, link them
 * to conversation_participants, and propagate workspace_member ownership
 * changes across every conversation the address is attached to.
 *
 * The raw queries live in repo.ts (the module's repo file, which may
 * import the db client + sql); this file keeps the orchestration
 * (validation, membership-sync loop, the cross-module
 * activateConversationParticipant call) and is re-exported by service.ts
 * for back-compat.
 */

import type { TransportKind } from "@synapse/shared/types"
import { activateConversationParticipant } from "../../chat/participant-activation.js"
import {
  detachParticipantAddress,
  existsWorkspaceMember,
  insertTransportAddress,
  listTransportExternalUsers,
  selectAttachedParticipantsForAddress,
  selectConversationExternalParticipantPrimaryAddress,
  selectConversationIdsForTransportAddress,
  selectConversationParticipantOrphanState,
  selectConversationTransportBindingForAddressSync,
  selectPrimaryTransportAddressForParticipant,
  selectReachableTransportAddressForParticipant,
  selectTransportAddressByExternalId,
  selectTransportAddressById,
  updateConversationParticipantToLeft,
  updateTransportAddressLinkedMember,
  updateTransportAddressMetadataJsonb,
  updateTransportEndpointMetadataJsonb,
  upsertConversationParticipantAddress,
} from "./repo.js"

export async function ensureTransportAddress(params: {
  workspaceId: string
  transportAccountId: string
  transportKind: TransportKind
  addressType?: "user" | "bot" | "system"
  externalId: string
  displayName?: string
  workspaceMemberId?: string
  metadata?: Record<string, unknown>
}) {
  return insertTransportAddress(params)
}

export async function getTransportAddressByExternalId(params: {
  transportAccountId: string
  externalId: string
  addressType?: "user" | "bot" | "system"
}) {
  return selectTransportAddressByExternalId(params)
}

export async function getTransportAddressById(transportAddressId: string) {
  return selectTransportAddressById(transportAddressId)
}

export async function getPrimaryTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId?: string
}) {
  return selectPrimaryTransportAddressForParticipant(params)
}

export async function getReachableTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId: string
}) {
  return selectReachableTransportAddressForParticipant(params)
}

/**
 * Decide (business rule) whether a conversation participant has been
 * orphaned by a detach and, if so, archive it. The orphan inputs +
 * the state='left' write live in the repo; the decision stays here.
 */
async function archiveConversationParticipantIfOrphaned(
  conversationParticipantId: string
) {
  const row = await selectConversationParticipantOrphanState(
    conversationParticipantId
  )
  if (!row) return
  if (
    row.subjectKind !== "external" ||
    row.state !== "active" ||
    row.hasAddresses
  ) {
    return
  }

  await updateConversationParticipantToLeft(conversationParticipantId)
}

export async function syncTransportAddressConversationParticipant(params: {
  conversationId: string
  transportAddressId: string
  workspaceMemberId?: string | null
  displayName?: string
  recordJoinEvent?: boolean
}) {
  const address = await getTransportAddressById(params.transportAddressId)
  if (!address) {
    throw new Error("Transport external user not found")
  }

  // Preflight (RF3): the DB triggers (tg_conversation_participant_validate /
  // tg_participant_address_consistency) are the hard backstop, but they fire
  // mid-write — a rejection AFTER we have already activated the participant (and
  // possibly cleared an existing primary address) would leave a half-applied
  // state, since this helper is not wrapped in a single transaction. Validate
  // the binding + account + workspace up front so a mismatch throws before any
  // write. participant addresses are IM-only: the conversation MUST be bound,
  // and the address MUST belong to the binding's account in the same workspace.
  const binding = await selectConversationTransportBindingForAddressSync(
    params.conversationId
  )
  if (!binding) {
    throw new Error(
      `syncTransportAddressConversationParticipant: conversation ${params.conversationId} has no transport binding (participant addresses are IM-only)`
    )
  }
  if (binding.workspaceId !== address.workspaceId) {
    throw new Error(
      `syncTransportAddressConversationParticipant: address ${address.id} workspace ${address.workspaceId} does not match conversation binding workspace ${binding.workspaceId}`
    )
  }
  if (binding.transportAccountId !== address.transportAccountId) {
    throw new Error(
      `syncTransportAddressConversationParticipant: address ${address.id} account ${address.transportAccountId} does not match conversation binding account ${binding.transportAccountId}`
    )
  }

  // F6 defence-in-depth (both branches): only a 'user' transport address ever
  // becomes a conversation participant — never a bot/system endpoint. Asserted
  // here so future callers of this exported helper can't bypass it.
  if (address.addressType !== "user") {
    throw new Error(
      `syncTransportAddressConversationParticipant: address ${address.id} is not a user address (${address.addressType})`
    )
  }

  const linkedMemberId = params.workspaceMemberId
  const desiredMember = linkedMemberId
    ? await (async () => {
        // The address must already be linked to exactly this member. We never
        // silently attach an unlinked (or differently-linked) address to a
        // member participant — the link must be established first (via
        // setTransportAddressLinkedUser / the ingest auto-link path, which
        // updates transport_addresses.workspace_member_id before we re-read it
        // here). This keeps transport_addresses.workspace_member_id the single
        // source of truth for member↔address binding.
        if (address.workspaceMemberId !== linkedMemberId) {
          throw new Error(
            address.workspaceMemberId
              ? `syncTransportAddressConversationParticipant: address ${address.id} is linked to a different workspace member`
              : `syncTransportAddressConversationParticipant: address ${address.id} is not linked to workspace member ${linkedMemberId}; link it first`
          )
        }
        return (
          await activateConversationParticipant({
            workspaceId: address.workspaceId,
            conversationId: params.conversationId,
            participantType: "workspace_member",
            workspaceMemberId: linkedMemberId,
            recordJoinEvent: params.recordJoinEvent,
          })
        ).member
      })()
    : await (async () => {
        // An external participant must be an UNLINKED user address. A linked
        // address belongs to an internal member (caller should have passed
        // workspaceMemberId).
        if (address.workspaceMemberId) {
          throw new Error(
            `syncTransportAddressConversationParticipant: address ${address.id} is linked to a workspace member; pass workspaceMemberId to add as a member`
          )
        }
        return (
          await activateConversationParticipant({
            workspaceId: address.workspaceId,
            conversationId: params.conversationId,
            participantType: "external",
            displayName:
              params.displayName ||
              address.displayName ||
              address.externalId ||
              "External user",
            metadata: {
              externalUserKey: `${address.transportKind}:${address.externalId}`,
            },
            // First-class external subject is keyed by this transport address.
            transportAddressId: address.id,
            recordJoinEvent: params.recordJoinEvent,
          })
        ).member
      })()

  await ensureConversationParticipantTransportAddress({
    conversationParticipantId: desiredMember.id,
    transportAddressId: address.id,
    isPrimary: true,
  })

  const attachedMembers = await selectAttachedParticipantsForAddress({
    conversationId: params.conversationId,
    transportAddressId: address.id,
    excludeParticipantId: desiredMember.id,
  })

  for (const row of attachedMembers) {
    await detachParticipantAddress({
      conversationParticipantId: row.id,
      transportAddressId: address.id,
    })
    await archiveConversationParticipantIfOrphaned(row.id)
  }

  return desiredMember
}

async function syncTransportAddressLinkedUserMemberships(params: {
  transportAddressId: string
  workspaceMemberId?: string | null
}) {
  const conversationIds = await selectConversationIdsForTransportAddress(
    params.transportAddressId
  )
  for (const conversationId of conversationIds) {
    await syncTransportAddressConversationParticipant({
      conversationId,
      transportAddressId: params.transportAddressId,
      workspaceMemberId: params.workspaceMemberId || null,
      recordJoinEvent: false,
    })
  }
}

export async function assertWorkspaceMember(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  return existsWorkspaceMember(params)
}

export async function setConversationExternalParticipantLinkedUser(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
  workspaceMemberId?: string | null
}) {
  const participantAddress =
    await selectConversationExternalParticipantPrimaryAddress({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      conversationParticipantId: params.conversationParticipantId,
    })
  if (!participantAddress) {
    throw new Error("External participant not found in this conversation")
  }
  if (!participantAddress.transportAddressId) {
    throw new Error("External participant does not have a transport address")
  }

  return setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: participantAddress.transportAddressId as string,
    workspaceMemberId: params.workspaceMemberId,
  })
}

export async function setTransportAddressLinkedUser(params: {
  workspaceId: string
  transportAddressId: string
  workspaceMemberId?: string | null
}) {
  const nextWorkspaceMemberId = params.workspaceMemberId || null
  if (nextWorkspaceMemberId) {
    const isWorkspaceMember = await assertWorkspaceMember({
      workspaceId: params.workspaceId,
      workspaceMemberId: nextWorkspaceMemberId,
    })
    if (!isWorkspaceMember) {
      throw new Error("Workspace member not found")
    }
  }

  const row = await updateTransportAddressLinkedMember({
    workspaceId: params.workspaceId,
    transportAddressId: params.transportAddressId,
    workspaceMemberId: nextWorkspaceMemberId,
  })
  if (!row) {
    throw new Error("Transport external user not found")
  }

  await syncTransportAddressLinkedUserMemberships({
    transportAddressId: params.transportAddressId,
    workspaceMemberId: nextWorkspaceMemberId,
  })

  const [externalUser] = await listTransportExternalUsers({
    workspaceId: params.workspaceId,
    transportAddressId: row.id,
  })
  if (!externalUser) {
    throw new Error("Transport external user not found")
  }
  return externalUser
}

export async function ensureConversationParticipantTransportAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
  isPrimary?: boolean
  metadata?: Record<string, unknown>
}) {
  return upsertConversationParticipantAddress(params)
}

export async function updateTransportAddressMetadata(params: {
  transportAddressId: string
  metadata: Record<string, unknown>
}) {
  return updateTransportAddressMetadataJsonb(params)
}

export async function updateTransportEndpointMetadata(params: {
  endpointId: string
  metadata: Record<string, unknown>
}) {
  return updateTransportEndpointMetadataJsonb(params)
}
