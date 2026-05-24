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
    .insertInto("transport_addresses")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      transport_account_id: params.transportAccountId,
      transport_kind: params.transportKind,
      address_type: params.addressType || "user",
      external_id: params.externalId.trim(),
      display_name: params.displayName?.trim() || null,
      workspace_member_id: params.workspaceMemberId || null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transport_addresses">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["transport_account_id", "address_type", "external_id"])
        .doUpdateSet({
          display_name: sql`COALESCE(excluded.display_name, transport_addresses.display_name)`,
          workspace_member_id: sql`COALESCE(excluded.workspace_member_id, transport_addresses.workspace_member_id)`,
          metadata: sql`transport_addresses.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
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
    .selectFrom("transport_addresses")
    .selectAll()
    .where("transport_account_id", "=", params.transportAccountId)
    .where("address_type", "=", params.addressType || "user")
    .where("external_id", "=", params.externalId.trim())
    .limit(1)
    .executeTakeFirst()
}

export async function getTransportAddressById(transportAddressId: string) {
  return db
    .selectFrom("transport_addresses")
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
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin("transport_addresses as ta", "ta.id", "cpa.transport_address_id")
    .selectAll("ta")
    .where(
      "cpa.conversation_participant_id",
      "=",
      params.conversationParticipantId
    )

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transport_account_id",
      "=",
      params.transportAccountId
    )
  }

  return builder
    .orderBy("cpa.is_primary", "desc")
    .orderBy("cpa.created_at", "asc")
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
  await db
    .deleteFrom("conversation_participant_addresses")
    .where("conversation_participant_id", "=", params.conversationParticipantId)
    .where("transport_address_id", "=", params.transportAddressId)
    .execute()
}

async function archiveConversationParticipantIfOrphaned(
  conversationParticipantId: string
) {
  const row = await db
    .selectFrom("conversation_participants as cm")
    .select([
      "cm.participant_type",
      "cm.state",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM conversation_participant_addresses cpa
        WHERE cpa.conversation_participant_id = cm.id
      )`.as("has_addresses"),
    ])
    .where("cm.id", "=", conversationParticipantId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return
  if (
    row.participant_type !== "external" ||
    row.state !== "active" ||
    row.has_addresses
  ) {
    return
  }

  await db
    .updateTable("conversation_participants")
    .set({
      state: "left",
      left_at: sql`COALESCE(left_at, NOW())`,
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

  const desiredMember = params.workspaceMemberId
    ? (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          participantType: "workspace_member",
          workspaceMemberId: params.workspaceMemberId,
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member
    : (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          participantType: "external",
          displayName:
            params.displayName ||
            address.display_name ||
            address.external_id ||
            "External user",
          metadata: {
            externalUserKey: `${address.transport_kind}:${address.external_id}`,
          },
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member

  await ensureConversationParticipantTransportAddress({
    conversationParticipantId: desiredMember.id,
    transportAddressId: address.id,
    isPrimary: true,
  })

  const attachedMembers = await db
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .select(["cm.id", "cm.participant_type"])
    .where("cpa.transport_address_id", "=", address.id)
    .where("cm.conversation_id", "=", params.conversationId)
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
    .selectFrom("conversation_participant_addresses as cpa")
    .innerJoin(
      "conversation_participants as cm",
      "cm.id",
      "cpa.conversation_participant_id"
    )
    .select("cm.conversation_id")
    .distinct()
    .where("cpa.transport_address_id", "=", transportAddressId)
    .execute()
  return rows.map((row) => row.conversation_id as string).filter(Boolean)
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
    .selectFrom("conversation_participants as cm")
    .leftJoin(
      "conversation_participant_addresses as cpa",
      "cpa.conversation_participant_id",
      "cm.id"
    )
    .leftJoin("transport_addresses as ta", "ta.id", "cpa.transport_address_id")
    .select([
      "cm.id as conversation_participant_id",
      "ta.id as transport_address_id",
    ])
    .where("cm.conversation_id", "=", params.conversationId)
    .where("cm.id", "=", params.conversationParticipantId)
    .where("cm.participant_type", "=", "external")
    .where("ta.workspace_id", "=", params.workspaceId)
    .orderBy("cpa.is_primary", "desc")
    .orderBy("cpa.created_at", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function assertWorkspaceMember(params: {
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await db
    .selectFrom("workspace_members")
    .select("workspace_id")
    .where("workspace_id", "=", params.workspaceId)
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
  if (!participantAddress.transport_address_id) {
    throw new Error("External participant does not have a transport address")
  }

  return setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: participantAddress.transport_address_id as string,
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
    .updateTable("transport_addresses")
    .set({
      workspace_member_id: nextWorkspaceMemberId,
      updated_at: sql`NOW()`,
    })
    .where("workspace_id", "=", params.workspaceId)
    .where("id", "=", params.transportAddressId)
    .where("address_type", "=", "user")
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
      .updateTable("conversation_participant_addresses")
      .set({
        is_primary: false,
        updated_at: sql`NOW()`,
      })
      .where(
        "conversation_participant_id",
        "=",
        params.conversationParticipantId
      )
      .execute()
  }

  return db
    .insertInto("conversation_participant_addresses")
    .values({
      conversation_participant_id: params.conversationParticipantId,
      transport_address_id: params.transportAddressId,
      is_primary: params.isPrimary ?? false,
      metadata: (params.metadata ||
        {}) as TableInsert<"conversation_participant_addresses">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["conversation_participant_id", "transport_address_id"])
        .doUpdateSet({
          is_primary: sql`CASE
            WHEN excluded.is_primary THEN TRUE
            ELSE conversation_participant_addresses.is_primary
          END`,
          metadata: sql`conversation_participant_addresses.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
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
    .updateTable("transport_addresses")
    .set({
      metadata: sql`transport_addresses.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
      updated_at: sql`NOW()`,
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
    .updateTable("transport_endpoints")
    .set({
      metadata: sql`transport_endpoints.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", params.endpointId)
    .returningAll()
    .executeTakeFirst()
}
