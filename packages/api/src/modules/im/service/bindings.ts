/**
 * conversation_transport_bindings domain: per-conversation binding to an
 * (account, endpoint) pair + the settings that drive inbound/outbound
 * behavior. Includes endpoint upsert because every binding write also
 * writes a transport_endpoints row.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 *
 * Note: this file imports `loadTransportAccountRow`,
 * `assertConversationInboundActor`, and `listTransportSessions` from
 * service.ts. They'll move out as accounts.ts is extracted next; the
 * temporary circular import is safe because each side only reads the
 * other's exports inside function bodies (no top-level evaluation race).
 */

import { sql } from "kysely"
import { transaction } from "../../../infrastructure/database/index.js"
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportConversationInboundActorMode,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import { assertSupportedEndpointType } from "../connectors/index.js"
import { normalizeBindingRow, parseJsonObject } from "./_helpers.js"
import {
  assertConversationInboundActor,
  loadTransportAccountRow,
  listTransportSessions,
} from "../service.js"

export async function getConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "ta.id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
    ])
    .where("ctb.workspace_id", "=", params.workspaceId)
    .where("ctb.conversation_id", "=", params.conversationId)
    .limit(1)
    .executeTakeFirst()

  return row ? normalizeBindingRow(row) : null
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}) {
  const row = await db
    .selectFrom("conversation_transport_bindings as ctb")
    .innerJoin("transport_accounts as ta", "ta.id", "ctb.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "ctb.transport_endpoint_id"
    )
    .select([
      "ctb.id as binding_id",
      "ctb.workspace_id",
      "ctb.conversation_id",
      "ctb.outbound_enabled",
      "ctb.inbound_actor_mode",
      "ctb.inbound_actor_id",
      "ctb.metadata as binding_metadata",
      "ctb.created_at as binding_created_at",
      "ctb.updated_at as binding_updated_at",
      "ta.id",
      "ta.account_key",
      "ta.display_name",
      "ta.transport_kind",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.inbound_actor_mode as account_inbound_actor_mode",
      "ta.inbound_actor_id as account_inbound_actor_id",
      "ta.connection_mode",
      "ta.status",
      "ta.credentials",
      "ta.config",
      "ta.metadata",
      "ta.created_at",
      "ta.updated_at",
      "te.id as endpoint_id",
      "te.transport_account_id",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
    ])
    .where("ctb.transport_account_id", "=", params.transportAccountId)
    .where("te.endpoint_type", "=", params.endpointType)
    .where("te.external_id", "=", params.endpointExternalId.trim())
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

  assertSupportedEndpointType(
    account.transport_kind as TransportKind,
    params.endpointType
  )
  const inboundActorMode = params.inboundActorMode || "inherit_account"
  const inboundActorId = await assertConversationInboundActor({
    workspaceId: params.workspaceId,
    inboundActorMode,
    inboundActorId: params.inboundActorId,
  })

  await transaction(async (client) => {
    const endpointRow = await executeTakeFirst<{ id: string }>(
      client,
      db
        .insertInto("transport_endpoints")
        .values({
          id: uuidv4(),
          transport_account_id: params.transportAccountId,
          endpoint_type: params.endpointType,
          external_id: params.endpointExternalId.trim(),
          parent_external_id: params.parentExternalId?.trim() || null,
          display_name: params.endpointDisplayName?.trim() || null,
          metadata: (params.metadata ||
            {}) as TableInsert<"transport_endpoints">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc
            .columns(["transport_account_id", "endpoint_type", "external_id"])
            .doUpdateSet({
              parent_external_id: sql`excluded.parent_external_id`,
              display_name: sql`COALESCE(excluded.display_name, transport_endpoints.display_name)`,
              metadata: sql`transport_endpoints.metadata || excluded.metadata`,
              updated_at: sql`NOW()`,
            })
        )
        .returning("id")
    )
    const endpointId = endpointRow?.id
    if (!endpointId) {
      throw new Error("Failed to upsert transport endpoint")
    }

    await executeCompiledQuery(
      client,
      db
        .insertInto("conversation_transport_bindings")
        .values({
          id: uuidv4(),
          workspace_id: params.workspaceId,
          conversation_id: params.conversationId,
          transport_account_id: params.transportAccountId,
          transport_endpoint_id: endpointId,
          outbound_enabled: params.outboundEnabled ?? true,
          inbound_actor_mode: inboundActorMode,
          inbound_actor_id: inboundActorId,
          metadata: (params.metadata ||
            {}) as TableInsert<"conversation_transport_bindings">["metadata"],
          created_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.column("conversation_id").doUpdateSet({
            transport_account_id: sql`excluded.transport_account_id`,
            transport_endpoint_id: sql`excluded.transport_endpoint_id`,
            outbound_enabled: sql`excluded.outbound_enabled`,
            inbound_actor_mode: sql`excluded.inbound_actor_mode`,
            inbound_actor_id: sql`excluded.inbound_actor_id`,
            metadata: sql`excluded.metadata`,
            updated_at: sql`NOW()`,
          })
        )
    )
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

  const updates: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  }
  if (params.outboundEnabled !== undefined) {
    updates.outbound_enabled = params.outboundEnabled
  }
  if (
    params.inboundActorMode !== undefined ||
    params.inboundActorId !== undefined
  ) {
    updates.inbound_actor_mode = nextInboundActorMode
    updates.inbound_actor_id = resolvedInboundActorId
  }
  if (params.metadata !== undefined) {
    updates.metadata = {
      ...parseJsonObject(existing.metadata),
      ...(params.metadata || {}),
    } as TableInsert<"conversation_transport_bindings">["metadata"]
  }

  await db
    .updateTable("conversation_transport_bindings")
    .set(updates)
    .where("workspace_id", "=", params.workspaceId)
    .where("conversation_id", "=", params.conversationId)
    .execute()

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
    .selectFrom("conversation_transport_bindings")
    .select("conversation_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("transport_endpoint_id", "=", params.transportEndpointId)
    .limit(1)
    .executeTakeFirst()
  const conversationId = row?.conversation_id as string | undefined
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

export async function deleteConversationTransportBinding(params: {
  workspaceId: string
  conversationId: string
}) {
  const row = await db
    .deleteFrom("conversation_transport_bindings")
    .where("workspace_id", "=", params.workspaceId)
    .where("conversation_id", "=", params.conversationId)
    .returning("id")
    .executeTakeFirst()
  return Boolean(row)
}
