/**
 * transport_message_links domain: outbound projection enqueue + inbound
 * dedupe lookup + status updates + the joined-row loader the delivery
 * worker uses to send.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import {
  db,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportDeliveryStatus,
  TransportKind,
} from "@synapse/shared/types"
import { enqueueTransportDeliveryJobs } from "../../../workers/queues.js"
import {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeTransportMessageLinkRow,
  parseJsonObject,
} from "./_helpers.js"
import { getConversationTransportBinding } from "../service.js"

export async function queueConversationTransportProjection(params: {
  workspaceId: string
  conversationId: string
  itemId: string
  direction?: "inbound" | "outbound"
  externalMessageId?: string
  externalReplyToId?: string
  externalThreadId?: string
  metadata?: Record<string, unknown>
}) {
  const direction = params.direction || "outbound"
  const binding = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!binding) {
    return null
  }
  if (direction === "outbound" && binding.account.status !== "active") {
    return null
  }
  if (direction === "outbound" && !binding.outboundEnabled) {
    return null
  }

  const link = await db
    .insertInto("transport_message_links")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      item_id: params.itemId,
      transport_account_id: binding.account.id,
      transport_endpoint_id: binding.endpoint.id,
      transport_kind: binding.transportKind,
      direction,
      delivery_status: "pending",
      external_message_id: params.externalMessageId || null,
      external_reply_to_id: params.externalReplyToId || null,
      external_thread_id: params.externalThreadId || null,
      metadata: {
        bindingId: binding.id,
        endpointType: binding.endpoint.endpointType,
        endpointExternalId: binding.endpoint.externalId,
        ...(params.metadata || {}),
      } as TableInsert<"transport_message_links">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["item_id", "transport_endpoint_id", "direction"])
        .doUpdateSet({
          external_message_id: sql`COALESCE(excluded.external_message_id, transport_message_links.external_message_id)`,
          external_reply_to_id: sql`COALESCE(excluded.external_reply_to_id, transport_message_links.external_reply_to_id)`,
          external_thread_id: sql`COALESCE(excluded.external_thread_id, transport_message_links.external_thread_id)`,
          metadata: sql`transport_message_links.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
        })
    )
    .returningAll()
    .executeTakeFirst()
  if (link && direction === "outbound") {
    await enqueueTransportDeliveryJobs([link.id]).catch((error) => {
      console.error(
        `[im] Failed to enqueue transport delivery job for link ${link.id}:`,
        error
      )
    })
  }

  return link
}

export async function findTransportMessageLinkByExternalMessage(params: {
  transportAccountId: string
  transportEndpointId?: string
  externalMessageId: string
  direction: "inbound" | "outbound"
}) {
  let builder = db
    .selectFrom("transport_message_links")
    .selectAll()
    .where("transport_account_id", "=", params.transportAccountId)
    .where("external_message_id", "=", params.externalMessageId.trim())
    .where("direction", "=", params.direction)

  if (params.transportEndpointId) {
    builder = builder.where(
      "transport_endpoint_id",
      "=",
      params.transportEndpointId
    )
  }

  const row = await builder.limit(1).executeTakeFirst()
  return row ? normalizeTransportMessageLinkRow(row) : null
}

export async function updateTransportMessageLinkStatus(params: {
  linkId: string
  status: TransportDeliveryStatus
  externalMessageId?: string
  metadata?: Record<string, unknown>
  error?: string
}) {
  const extraMetadata = {
    ...(params.metadata || {}),
    ...(params.error ? { lastError: params.error } : {}),
  }
  const row = await db
    .updateTable("transport_message_links")
    .set({
      delivery_status: params.status,
      ...(params.externalMessageId
        ? { external_message_id: params.externalMessageId }
        : {}),
      metadata: sql`transport_message_links.metadata || ${JSON.stringify(extraMetadata)}::jsonb`,
      ...(params.status === "sent"
        ? { delivered_at: sql`COALESCE(delivered_at, NOW())` }
        : {}),
      updated_at: sql`NOW()`,
    })
    .where("id", "=", params.linkId)
    .returningAll()
    .executeTakeFirst()
  return row ? normalizeTransportMessageLinkRow(row) : null
}

export async function loadTransportMessageLinkForDelivery(linkId: string) {
  const row = await db
    .selectFrom("transport_message_links as tml")
    .innerJoin("transport_accounts as ta", "ta.id", "tml.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "tml.transport_endpoint_id"
    )
    .innerJoin("conversation_items as ci", "ci.id", "tml.item_id")
    .select([
      "tml.id",
      "tml.workspace_id",
      "tml.conversation_id",
      "tml.item_id",
      "tml.transport_account_id",
      "tml.transport_endpoint_id",
      "tml.transport_kind",
      "tml.direction",
      "tml.delivery_status",
      "tml.external_message_id",
      "tml.metadata",
      "tml.delivered_at",
      "tml.created_at",
      "tml.updated_at",
      "ta.workspace_id as account_workspace_id",
      "ta.account_key",
      "ta.display_name as account_display_name",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.connection_mode",
      "ta.status as account_status",
      "ta.credentials",
      "ta.config",
      "ta.metadata as account_metadata",
      "ta.created_at as account_created_at",
      "ta.updated_at as account_updated_at",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
      "ci.metadata as item_metadata",
    ])
    .where("tml.id", "=", linkId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  return {
    ...normalizeTransportMessageLinkRow(row),
    account: normalizeAccountRow({
      id: row.transport_account_id,
      workspace_id: row.account_workspace_id,
      transport_kind: row.transport_kind,
      account_key: row.account_key,
      display_name: row.account_display_name,
      owner_scope: row.owner_scope,
      owner_workspace_member_id: row.owner_workspace_member_id,
      connection_mode: row.connection_mode,
      status: row.account_status,
      credentials: row.credentials,
      config: row.config,
      metadata: row.account_metadata,
      created_at: row.account_created_at,
      updated_at: row.account_updated_at,
    }),
    endpoint: normalizeEndpointRow(
      {
        endpoint_id: row.transport_endpoint_id,
        transport_account_id: row.transport_account_id,
        endpoint_type: row.endpoint_type,
        endpoint_external_id: row.endpoint_external_id,
        parent_external_id: row.parent_external_id,
        endpoint_display_name: row.endpoint_display_name,
        endpoint_metadata: row.endpoint_metadata,
        endpoint_created_at: row.endpoint_created_at,
        endpoint_updated_at: row.endpoint_updated_at,
      },
      row.transport_kind as TransportKind
    ),
    itemMetadata: parseJsonObject(row.item_metadata),
  }
}
