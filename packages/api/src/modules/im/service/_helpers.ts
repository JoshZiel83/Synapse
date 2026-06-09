/**
 * Shared helpers for the IM service layer.
 *
 * Extracted from service.ts as part of the per-domain split. Service.ts
 * keeps imports stable by re-exporting any of these that the public API
 * touched; service/<domain>.ts files import them directly.
 *
 * No business logic — only:
 *   - JSON / string parsing
 *   - row normalizers (DB row → shared/types shape)
 *   - cross-cutting assertions used by multiple domain groups
 */

import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
  TransportAccountSummary,
  TransportConversationInboundActorMode,
  TransportDeliveryStatus,
  TransportEndpointSummary,
  TransportExternalUserSummary,
  TransportKind,
  TransportSessionSummary,
  ConversationTransportBindingSummary,
} from "@synapse/shared/types"

import { parseJsonObject } from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../../infrastructure/datetime.js"

export { parseJsonObject }

export function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as T[]) : []
}

export function readTrimmedString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim()
    }
  }
  return undefined
}

export function normalizeAccountRow(row: any): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    accountKey: row.account_key,
    displayName: row.display_name,
    ownerScope:
      (row.owner_scope as TransportAccountOwnerScope | undefined) ||
      "workspace",
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    inboundActorMode:
      (row.account_inbound_actor_mode as
        | TransportAccountInboundActorMode
        | undefined) ||
      (row.inbound_actor_mode as
        | TransportAccountInboundActorMode
        | undefined) ||
      "none",
    inboundActorId:
      row.account_inbound_actor_id || row.inbound_actor_id || undefined,
    connectionMode: row.connection_mode,
    status: row.status,
    credentials: parseJsonObject(row.credentials),
    config: parseJsonObject(row.config),
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

export function normalizeEndpointRow(
  row: any,
  transportKind: TransportKind
): TransportEndpointSummary {
  return {
    id: row.endpoint_id || row.id,
    transportAccountId: row.transport_account_id,
    transportKind,
    endpointType: row.endpoint_type,
    externalId: row.endpoint_external_id || row.external_id,
    parentExternalId: row.parent_external_id || undefined,
    displayName: row.endpoint_display_name || row.display_name || undefined,
    metadata: parseJsonObject(row.endpoint_metadata || row.metadata),
    createdAt: serializeOptionalInstant(
      row.endpoint_created_at || row.created_at
    )!,
    updatedAt: serializeOptionalInstant(
      row.endpoint_updated_at || row.updated_at
    )!,
  }
}

export function normalizeBindingRow(
  row: any
): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row)
  return {
    id: row.binding_id || row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    inboundActorMode:
      (row.inbound_actor_mode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inbound_actor_id || undefined,
    metadata: parseJsonObject(row.binding_metadata || row.metadata),
    createdAt: serializeOptionalInstant(
      row.binding_created_at || row.created_at
    )!,
    updatedAt: serializeOptionalInstant(
      row.binding_updated_at || row.updated_at
    )!,
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  }
}

export function normalizeTransportSessionRow(
  row: any
): TransportSessionSummary {
  const workspaceId = row.account_workspace_id || row.workspace_id
  const account = normalizeAccountRow({ ...row, workspace_id: workspaceId })
  return {
    id: row.endpoint_id || row.binding_id || row.id,
    workspaceId,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    inboundActorMode:
      (row.inbound_actor_mode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inbound_actor_id || undefined,
    metadata: parseJsonObject(
      row.binding_metadata || row.endpoint_metadata || row.metadata
    ),
    createdAt: serializeOptionalInstant(
      row.binding_created_at || row.endpoint_created_at || row.created_at
    )!,
    updatedAt: serializeOptionalInstant(
      row.binding_updated_at || row.endpoint_updated_at || row.updated_at
    )!,
    conversationId: row.conversation_id || undefined,
    conversationTitle: readTrimmedString(row, "conversation_title"),
    lastInboundAt: serializeOptionalInstant(row.last_inbound_at),
    lastOutboundAt: serializeOptionalInstant(row.last_outbound_at),
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  }
}

export function normalizeTransportExternalUserRow(
  row: any
): TransportExternalUserSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportAccountId: row.transport_account_id,
    transportKind: row.transport_kind,
    accountDisplayName: row.account_display_name || "Transport account",
    externalId: row.external_id,
    displayName: row.display_name || undefined,
    linkedWorkspaceMemberId: row.linked_workspace_member_id || undefined,
    linkedWorkspaceMemberName: row.linked_workspace_member_name || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
    sessions: parseJsonArray<any>(row.sessions),
  }
}

export function normalizeTransportMessageLinkRow(row: any) {
  const rawReactions = row.external_emoji_reactions
  const reactions: Record<string, string> = {}
  if (
    rawReactions &&
    typeof rawReactions === "object" &&
    !Array.isArray(rawReactions)
  ) {
    for (const [k, v] of Object.entries(
      rawReactions as Record<string, unknown>
    )) {
      if (typeof v === "string") reactions[k] = v
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.item_id,
    transportAccountId: row.transport_account_id,
    transportEndpointId: row.transport_endpoint_id,
    transportKind: row.transport_kind as TransportKind,
    direction: row.direction as "inbound" | "outbound",
    deliveryStatus: row.delivery_status as TransportDeliveryStatus,
    externalMessageId: row.external_message_id || undefined,
    externalReplyToId: row.external_reply_to_id || undefined,
    externalThreadId: row.external_thread_id || undefined,
    externalEmojiReactions: reactions,
    metadata: parseJsonObject(row.metadata),
    deliveredAt: serializeOptionalInstant(row.delivered_at),
    createdAt: serializeOptionalInstant(row.created_at),
    updatedAt: serializeOptionalInstant(row.updated_at),
  }
}
