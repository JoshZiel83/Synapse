/**
 * transport_addresses domain: ensure/lookup external addresses, link them
 * to conversation_participants, and propagate workspace_member ownership
 * changes across every conversation the address is attached to.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import {
  db,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type { TransportKind } from "@synapse/shared/types"
import { activateConversationParticipant } from "../../chat/participant-activation.js"

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
  return db
    .insertInto("transportAddresses")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      transportAccountId: params.transportAccountId,
      transportKind: params.transportKind,
      addressType: params.addressType || "user",
      externalId: params.externalId.trim(),
      displayName: params.displayName?.trim() || null,
      workspaceMemberId: params.workspaceMemberId || null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transportAddresses">["metadata"],
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["transportAccountId", "addressType", "externalId"])
        .doUpdateSet({
          displayName: sql`COALESCE(excluded.display_name, transport_addresses.display_name)`,
          workspaceMemberId: sql`COALESCE(excluded.workspace_member_id, transport_addresses.workspace_member_id)`,
          metadata: sql`transport_addresses.metadata || excluded.metadata`,
        })
    )
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function getTransportAddressByExternalId(params: {
  transportAccountId: string
  externalId: string
  addressType?: "user" | "bot" | "system"
}) {
  return db
    .selectFrom("transportAddresses")
    .selectAll()
    .where("transportAccountId", "=", params.transportAccountId)
    .where("addressType", "=", params.addressType || "user")
    .where("externalId", "=", params.externalId.trim())
    .limit(1)
    .executeTakeFirst()
}

export async function getTransportAddressById(transportAddressId: string) {
  return db
    .selectFrom("transportAddresses")
    .selectAll()
    .where("id", "=", transportAddressId)
    .limit(1)
    .executeTakeFirst()
}

export async function getPrimaryTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId?: string
}) {
  let builder = db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin("transportAddresses as ta", "ta.id", "cpa.transportAddressId")
    .selectAll("ta")
    .where(
      "cpa.conversationParticipantId",
      "=",
      params.conversationParticipantId
    )

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transportAccountId",
      "=",
      params.transportAccountId
    )
  }

  return builder
    .orderBy("cpa.isPrimary", "desc")
    .orderBy("cpa.createdAt", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function getReachableTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId: string
}) {
  const result = await db.executeQuery(
    sql<any>`SELECT candidate.*
      FROM (
        SELECT ta.*,
               TRUE AS is_attached,
               cpa.is_primary,
               cpa.created_at AS binding_created_at
        FROM conversation_participant_addresses cpa
        JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
        WHERE cpa.conversation_participant_id = ${params.conversationParticipantId}
          AND ta.transport_account_id = ${params.transportAccountId}

        UNION ALL

        SELECT ta.*,
               FALSE AS is_attached,
               FALSE AS is_primary,
               ta.created_at AS binding_created_at
        FROM conversation_participants cm
        JOIN access_subjects cm_subj ON cm_subj.id = cm.subject_id
        JOIN transport_addresses ta
          ON ta.workspace_member_id = cm_subj.workspace_member_id
         AND ta.address_type = 'user'
        WHERE cm.id = ${params.conversationParticipantId}
          AND cm_subj.workspace_member_id IS NOT NULL
          AND ta.transport_account_id = ${params.transportAccountId}
      ) candidate
      ORDER BY candidate.is_attached DESC,
               candidate.is_primary DESC,
               candidate.binding_created_at ASC
      LIMIT 1`.compile(db)
  )
  return result.rows[0] ?? null
}

async function removeConversationParticipantTransportAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
}) {
  // conversation_participant_addresses is a persistent child guarded by
  // sd_reject_delete; the detach goes through the SECURITY DEFINER fn (§7.5/§11).
  await sql`SELECT sd_detach_participant_address(${params.conversationParticipantId}::uuid, ${params.transportAddressId}::uuid)`.execute(
    db
  )
}

async function archiveConversationParticipantIfOrphaned(
  conversationParticipantId: string
) {
  const row = await db
    .selectFrom("conversationParticipants as cm")
    .leftJoin("accessSubjects as cmsubj", "cmsubj.id", "cm.subjectId")
    .select([
      "cmsubj.kind as subjectKind",
      "cm.state",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM conversation_participant_addresses cpa
        WHERE cpa.conversation_participant_id = cm.id
      )`.as("hasAddresses"),
    ])
    .where("cm.id", "=", conversationParticipantId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return
  if (
    row.subjectKind !== "external" ||
    row.state !== "active" ||
    row.hasAddresses
  ) {
    return
  }

  await db
    .updateTable("conversationParticipants")
    .set({
      state: "left",
      leftAt: sql`COALESCE(left_at, NOW())`,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ retiredByTransportLink: true })}::jsonb`,
    })
    .where("id", "=", conversationParticipantId)
    .execute()
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
  const binding = await db
    .selectFrom("conversationTransportBindings")
    .select(["workspaceId", "transportAccountId"])
    .where("conversationId", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()
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

  const attachedMembers = await db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .select(["cm.id"])
    .where("cpa.transportAddressId", "=", address.id)
    .where("cm.conversationId", "=", params.conversationId)
    .where("cm.id", "<>", desiredMember.id)
    .execute()

  for (const row of attachedMembers) {
    await removeConversationParticipantTransportAddress({
      conversationParticipantId: row.id,
      transportAddressId: address.id,
    })
    await archiveConversationParticipantIfOrphaned(row.id)
  }

  return desiredMember
}

async function listConversationIdsForTransportAddress(
  transportAddressId: string
) {
  const rows = await db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .select("cm.conversationId")
    .distinct()
    .where("cpa.transportAddressId", "=", transportAddressId)
    .execute()
  return rows.map((row) => row.conversationId as string).filter(Boolean)
}

async function syncTransportAddressLinkedUserMemberships(params: {
  transportAddressId: string
  workspaceMemberId?: string | null
}) {
  const conversationIds = await listConversationIdsForTransportAddress(
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

async function loadConversationExternalParticipantPrimaryAddress(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
}) {
  return db
    .selectFrom("conversationParticipants as cm")
    .leftJoin(
      "conversationParticipantAddresses as cpa",
      "cpa.conversationParticipantId",
      "cm.id"
    )
    .leftJoin("transportAddresses as ta", "ta.id", "cpa.transportAddressId")
    .leftJoin("accessSubjects as cmsubj", "cmsubj.id", "cm.subjectId")
    .select([
      "cm.id as conversationParticipantId",
      "ta.id as transportAddressId",
    ])
    .where("cm.conversationId", "=", params.conversationId)
    .where("cm.id", "=", params.conversationParticipantId)
    .where("cmsubj.kind", "=", "external")
    .where("ta.workspaceId", "=", params.workspaceId)
    .orderBy("cpa.isPrimary", "desc")
    .orderBy("cpa.createdAt", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function assertWorkspaceMember(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await db
    .selectFrom("workspaceMembers")
    .select("workspaceId")
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function setConversationExternalParticipantLinkedUser(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
  workspaceMemberId?: string | null
}) {
  const participantAddress =
    await loadConversationExternalParticipantPrimaryAddress({
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

  const row = await db
    .updateTable("transportAddresses")
    .set({
      workspaceMemberId: nextWorkspaceMemberId,
    })
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.transportAddressId)
    .where("addressType", "=", "user")
    .returningAll()
    .executeTakeFirst()
  if (!row) {
    throw new Error("Transport external user not found")
  }

  await syncTransportAddressLinkedUserMemberships({
    transportAddressId: params.transportAddressId,
    workspaceMemberId: nextWorkspaceMemberId,
  })

  return row
}

export async function ensureConversationParticipantTransportAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
  isPrimary?: boolean
  metadata?: Record<string, unknown>
}) {
  if (params.isPrimary) {
    await db
      .updateTable("conversationParticipantAddresses")
      .set({
        isPrimary: false,
      })
      .where("conversationParticipantId", "=", params.conversationParticipantId)
      .execute()
  }

  return db
    .insertInto("conversationParticipantAddresses")
    .values({
      conversationParticipantId: params.conversationParticipantId,
      transportAddressId: params.transportAddressId,
      isPrimary: params.isPrimary ?? false,
      metadata: (params.metadata ||
        {}) as TableInsert<"conversationParticipantAddresses">["metadata"],
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["conversationParticipantId", "transportAddressId"])
        .doUpdateSet({
          isPrimary: sql`CASE
            WHEN excluded.is_primary THEN TRUE
            ELSE conversation_participant_addresses.is_primary
          END`,
          metadata: sql`conversation_participant_addresses.metadata || excluded.metadata`,
        })
    )
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportAddressMetadata(params: {
  transportAddressId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transportAddresses")
    .set({
      metadata: sql`transport_addresses.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
    })
    .where("id", "=", params.transportAddressId)
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportEndpointMetadata(params: {
  endpointId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transportEndpoints")
    .set({
      metadata: sql`transport_endpoints.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
    })
    .where("id", "=", params.endpointId)
    .returningAll()
    .executeTakeFirst()
}
