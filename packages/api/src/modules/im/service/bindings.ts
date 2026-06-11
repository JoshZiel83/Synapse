/**
 * conversation_transport_bindings domain: per-conversation binding to an
 * (account, endpoint) pair + the settings that drive inbound/outbound
 * behavior. Includes endpoint upsert because every binding write also
 * writes a transport_endpoints row.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type KyselyDb,
} from "../../../infrastructure/database/kysely.js"
import type {
  TransportEndpointMetadataInsert,
  ConversationTransportBindingMetadataInsert,
} from "../repo.types.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportConversationInboundActorMode,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { assertSupportedEndpointType } from "../connectors/index.js"
import { tryGetConnector } from "../connectors/registry.js"
import { recoverSkippedProjectionsForRecoveryEvent } from "./recovery.js"
import {
  normalizeAccountRow,
  normalizeBindingRow,
  parseJsonObject,
} from "./_helpers.js"
import {
  assertConversationInboundActor,
  loadTransportAccountRow,
  listTransportSessions,
} from "./accounts.js"

export async function getConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .selectFrom("conversationTransportBindings as ctb")
    .innerJoin("transportAccounts as ta", "ta.id", "ctb.transportAccountId")
    .innerJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .select([
      "ctb.id as bindingId",
      "ctb.workspaceId as workspaceId",
      "ctb.conversationId as conversationId",
      "ctb.outboundEnabled as outboundEnabled",
      "ctb.inboundActorMode as inboundActorMode",
      "ctb.inboundActorId as inboundActorId",
      "ctb.metadata as bindingMetadata",
      "ctb.createdAt as bindingCreatedAt",
      "ctb.updatedAt as bindingUpdatedAt",
      "ta.id",
      "ta.accountKey as accountKey",
      "ta.displayName as displayName",
      "ta.transportKind as transportKind",
      "ta.ownerScope as ownerScope",
      "ta.ownerWorkspaceMemberId as ownerWorkspaceMemberId",
      "ta.inboundActorMode as accountInboundActorMode",
      "ta.inboundActorId as accountInboundActorId",
      "ta.connectionMode as connectionMode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.createdAt as createdAt",
      "ta.updatedAt as updatedAt",
      "te.id as endpointId",
      "te.transportAccountId as transportAccountId",
      "te.endpointType as endpointType",
      "te.externalId as endpointExternalId",
      "te.parentExternalId as parentExternalId",
      "te.displayName as endpointDisplayName",
      "te.metadata as endpointMetadata",
      "te.createdAt as endpointCreatedAt",
      "te.updatedAt as endpointUpdatedAt",
    ])
    .where("ctb.workspaceId", "=", params.workspaceId)
    .where("ctb.conversationId", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

/**
 * Lightweight existence probe used to derive a conversation's "IM-ness" (a
 * conversation is IM iff it has a transport binding). Far cheaper than
 * getConversationTransportBinding, which hydrates the full account+endpoint row.
 * Pass `workspaceId` to additionally scope the check to that workspace (the
 * binding table is workspace-scoped); omitting it checks by conversation alone
 * (conversation_id is UNIQUE on the binding table).
 *
 * Pass `queryable` (a Kysely transaction) to read inside an open transaction so
 * a binding created earlier in the SAME transaction is visible (fresh
 * derivation); omit it to read committed state via the module pool.
 */
export async function hasConversationTransportBinding(params: {
  conversationId: string
  workspaceId?: string
  queryable?: KyselyDb
}): Promise<boolean> {
  const executor = params.queryable ?? db
  let query = executor
    .selectFrom("conversationTransportBindings")
    .select(sql<number>`1`.as("one"))
    .where("conversationId", "=", params.conversationId)
    .limit(1)
  if (params.workspaceId !== undefined) {
    query = query.where("workspaceId", "=", params.workspaceId)
  }
  const row = await query.executeTakeFirst()
  return Boolean(row)
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  const row = await db
    .selectFrom("conversationTransportBindings as ctb")
    .innerJoin("transportAccounts as ta", "ta.id", "ctb.transportAccountId")
    .innerJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .select([
      "ctb.id as bindingId",
      "ctb.workspaceId as workspaceId",
      "ctb.conversationId as conversationId",
      "ctb.outboundEnabled as outboundEnabled",
      "ctb.inboundActorMode as inboundActorMode",
      "ctb.inboundActorId as inboundActorId",
      "ctb.metadata as bindingMetadata",
      "ctb.createdAt as bindingCreatedAt",
      "ctb.updatedAt as bindingUpdatedAt",
      "ta.id",
      "ta.accountKey as accountKey",
      "ta.displayName as displayName",
      "ta.transportKind as transportKind",
      "ta.ownerScope as ownerScope",
      "ta.ownerWorkspaceMemberId as ownerWorkspaceMemberId",
      "ta.inboundActorMode as accountInboundActorMode",
      "ta.inboundActorId as accountInboundActorId",
      "ta.connectionMode as connectionMode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.createdAt as createdAt",
      "ta.updatedAt as updatedAt",
      "te.id as endpointId",
      "te.transportAccountId as transportAccountId",
      "te.endpointType as endpointType",
      "te.externalId as endpointExternalId",
      "te.parentExternalId as parentExternalId",
      "te.displayName as endpointDisplayName",
      "te.metadata as endpointMetadata",
      "te.createdAt as endpointCreatedAt",
      "te.updatedAt as endpointUpdatedAt",
    ])
    .where("ctb.transportAccountId", "=", params.transportAccountId)
    .where("te.endpointType", "=", params.endpointType)
    .where("te.externalId", "=", params.endpointExternalId.trim())
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function upsertConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
  parentExternalId?: string
  endpointDisplayName?: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const account = await loadTransportAccountRow(
    params.workspaceId,
    params.transportAccountId
  )
  if (!account) {
    throw new Error("Transport account not found")
  }

  // The conversation must belong to the same workspace as the binding/account.
  // The DB enforces this via composite FKs, but check here for a friendly error
  // rather than a raw FK violation (and to fail before the endpoint upsert).
  const conversationRow = await db
    .selectFrom("conversations")
    .select("workspaceId")
    .where("id", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()
  if (!conversationRow) {
    throw new Error("Conversation not found")
  }
  if (conversationRow.workspaceId !== params.workspaceId) {
    throw new Error("Conversation does not belong to the binding's workspace")
  }

  // Friendly guard mirroring the DB trigger tg_binding_account_consistency:
  // re-binding a conversation to a different transport account is forbidden
  // while external participants from another account remain (they would become
  // account-mismatched). The trigger is the hard enforcement; this surfaces a
  // clean error instead of a raw trigger exception.
  const conflictingExternal = await db
    .selectFrom("conversationParticipants as cp")
    .innerJoin("accessSubjects as asx", "asx.id", "cp.subjectId")
    .innerJoin("transportAddresses as ta", "ta.id", "asx.transportAddressId")
    .select("cp.id")
    .where("cp.conversationId", "=", params.conversationId)
    .where("asx.kind", "=", "external")
    .where("ta.transportAccountId", "!=", params.transportAccountId)
    .limit(1)
    .executeTakeFirst()
  if (conflictingExternal) {
    throw new Error(
      "Cannot re-bind conversation to a different transport account while external participants from another account remain"
    )
  }

  assertSupportedEndpointType(
    account.transportKind as TransportKind,
    params.endpointType
  )
  const inboundActorMode = params.inboundActorMode || "inherit_account"
  const inboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  // Connector-supplied binding defaults — currently used by transports
  // (e.g. QQ) that need to default `outbound_enabled = false` plus a
  // stable `metadata.autoDisabledReason` marker until a precondition
  // (webhook confirmation, etc) is satisfied. Generic helper only
  // applies the override when the caller did NOT pass an explicit
  // `outboundEnabled`, so manual UI flips stay authoritative.
  const connector = tryGetConnector(account.transportKind as TransportKind)
  const defaults = connector?.getBindingDefaults?.({
    account: normalizeAccountRow(account),
    endpoint: {
      endpointType: params.endpointType,
      externalId: params.endpointExternalId.trim(),
    },
  })
  const effectiveOutboundEnabled =
    params.outboundEnabled !== undefined
      ? params.outboundEnabled
      : (defaults?.outboundEnabled ?? true)
  const baseMetadata = params.metadata || {}
  const effectiveMetadata =
    params.outboundEnabled === undefined &&
    defaults?.outboundEnabled === false &&
    defaults.metadata
      ? { ...baseMetadata, ...defaults.metadata }
      : baseMetadata

  await withDbTransaction(async (trx) => {
    const endpointRow = await trx
      .insertInto("transportEndpoints")
      .values({
        id: uuidv4(),
        transportAccountId: params.transportAccountId,
        endpointType: params.endpointType,
        externalId: params.endpointExternalId.trim(),
        parentExternalId: params.parentExternalId?.trim() || null,
        displayName: params.endpointDisplayName?.trim() || null,
        metadata: (params.metadata || {}) as TransportEndpointMetadataInsert,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc
          .columns(["transportAccountId", "endpointType", "externalId"])
          .doUpdateSet({
            parentExternalId: sql`excluded.parent_external_id`,
            displayName: sql`COALESCE(excluded.display_name, transport_endpoints.display_name)`,
            metadata: sql`transport_endpoints.metadata || excluded.metadata`,
          })
      )
      .returning("id")
      .executeTakeFirst()
    const endpointId = endpointRow?.id
    if (!endpointId) {
      throw new Error("Failed to upsert transport endpoint")
    }

    await trx
      .insertInto("conversationTransportBindings")
      .values({
        id: uuidv4(),
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        transportAccountId: params.transportAccountId,
        transportEndpointId: endpointId,
        outboundEnabled: effectiveOutboundEnabled,
        inboundActorMode: inboundActorMode,
        inboundActorId: inboundActorId,
        metadata:
          effectiveMetadata as ConversationTransportBindingMetadataInsert,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.column("conversationId").doUpdateSet({
          transportAccountId: sql`excluded.transport_account_id`,
          transportEndpointId: sql`excluded.transport_endpoint_id`,
          outboundEnabled: sql`excluded.outbound_enabled`,
          inboundActorMode: sql`excluded.inbound_actor_mode`,
          inboundActorId: sql`excluded.inbound_actor_id`,
          metadata: sql`excluded.metadata`,
        })
      )
      .execute()

    // Recovery: a fresh / replaced binding may resolve projections that
    // were previously skipped for any of the recoverable reasons
    // (no_binding / not_supported_in_v1 / outbound_disabled /
    // webhook_inbound_unavailable). Fire in the same tx so the create +
    // re-arm commit together.
    await recoverSkippedProjectionsForRecoveryEvent(trx, {
      kind: "binding_created_or_replaced",
      conversationId: params.conversationId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: endpointId,
    })
  })

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateConversationTransportSettings(params: {
  workspaceId: string
  conversationId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const existing = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!existing) {
    throw new Error("Transport session not found for this conversation")
  }

  const nextInboundActorMode =
    params.inboundActorMode || existing.inboundActorMode
  const nextInboundActorId =
    nextInboundActorMode === "specified_actor"
      ? params.inboundActorId !== undefined
        ? params.inboundActorId
        : existing.inboundActorId || null
      : null
  const resolvedInboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode: nextInboundActorMode,
    inboundActorId: nextInboundActorId,
  })

  const updates: Record<string, unknown> = {}
  if (params.outboundEnabled !== undefined) {
    updates.outboundEnabled = params.outboundEnabled
  }
  if (
    params.inboundActorMode !== undefined ||
    params.inboundActorId !== undefined
  ) {
    updates.inboundActorMode = nextInboundActorMode
    updates.inboundActorId = resolvedInboundActorId
  }
  if (params.metadata !== undefined) {
    updates.metadata = {
      ...parseJsonObject(existing.metadata),
      ...(params.metadata || {}),
    } as ConversationTransportBindingMetadataInsert
  }

  // Wrap in a tx so the outbound_enabled change + projection recovery
  // land atomically. Without this a crash between the binding UPDATE
  // and the recovery SQL would leave skipped projections stranded even
  // though the operator just re-enabled outbound.
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("conversationTransportBindings")
      .set(updates)
      .where("workspaceId", "=", params.workspaceId)
      .where("conversationId", "=", params.conversationId)
      .execute()

    // Recovery: if outbound just flipped false → true, re-arm any
    // `outbound_disabled` projections pinned to this conversation's
    // (account, endpoint). The endpoint id is taken from the original
    // existing row — outbound toggling never replaces the endpoint.
    if (params.outboundEnabled === true && existing.outboundEnabled === false) {
      await recoverSkippedProjectionsForRecoveryEvent(tx, {
        kind: "outbound_re_enabled",
        transportAccountId: existing.account.id,
        transportEndpointId: existing.endpoint.id,
      })
    }
  })

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
}

export async function updateTransportSessionSettings(params: {
  workspaceId: string
  transportEndpointId: string
  outboundEnabled?: boolean
  inboundActorMode?: TransportConversationInboundActorMode
  inboundActorId?: string | null
  metadata?: Record<string, unknown>
}) {
  const row = await db
    .selectFrom("conversationTransportBindings")
    .select("conversationId")
    .where("workspaceId", "=", params.workspaceId)
    .where("transportEndpointId", "=", params.transportEndpointId)
    .limit(1)
    .executeTakeFirst()
  const conversationId = row?.conversationId as string | undefined
  if (!conversationId) {
    throw new Error("Transport session not found")
  }

  await updateConversationTransportSettings({
    workspaceId: params.workspaceId,
    conversationId,
    outboundEnabled: params.outboundEnabled,
    inboundActorMode: params.inboundActorMode,
    inboundActorId: params.inboundActorId,
    metadata: params.metadata,
  })

  const updatedSessions = await listTransportSessions(params.workspaceId)
  return (
    updatedSessions.find(
      (session) => session.id === params.transportEndpointId
    ) || null
  )
}
