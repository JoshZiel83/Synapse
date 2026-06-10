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
  TransportAccountStatus,
  TransportAccountOwnerScope,
  TransportAccountSummary,
  TransportConnectionMode,
  TransportConversationInboundActorMode,
  TransportDeliveryStatus,
  TransportEndpointType,
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

type TransportAccountRow = {
  id: string
  workspace_id: string | null
  transport_kind: TransportKind
  account_key: string
  display_name: string | null
  owner_scope?: TransportAccountOwnerScope | null
  owner_workspace_member_id?: string | null
  account_inbound_actor_mode?: TransportAccountInboundActorMode | null
  inbound_actor_mode?:
    | TransportAccountInboundActorMode
    | TransportConversationInboundActorMode
    | null
  account_inbound_actor_id?: string | null
  inbound_actor_id?: string | null
  connection_mode: TransportConnectionMode
  status: TransportAccountStatus
  credentials: unknown
  config: unknown
  metadata: unknown
  created_at: Date
  updated_at: Date
}

type TransportEndpointRow = {
  endpoint_id?: string | null
  id?: string | null
  transport_account_id: string
  endpoint_type: TransportEndpointType
  endpoint_external_id?: string | null
  external_id?: string | null
  parent_external_id?: string | null
  endpoint_display_name?: string | null
  display_name?: string | null
  endpoint_metadata?: unknown
  metadata?: unknown
  endpoint_created_at?: Date | null
  created_at?: Date | null
  endpoint_updated_at?: Date | null
  updated_at?: Date | null
}

type ConversationTransportBindingRow = TransportAccountRow &
  TransportEndpointRow & {
    binding_id?: string | null
    conversation_id: string | null
    outbound_enabled: boolean | null
    binding_metadata?: unknown
    binding_created_at?: Date | null
    binding_updated_at?: Date | null
  }

type TransportSessionRow = ConversationTransportBindingRow & {
  account_workspace_id?: string | null
  conversation_title?: string | null
  last_inbound_at?: Date | null
  last_outbound_at?: Date | null
}

type TransportExternalUserRow = {
  id: string
  workspace_id: string
  transport_account_id: string
  transport_kind: TransportKind
  account_display_name?: string | null
  external_id: string
  display_name?: string | null
  linked_workspace_member_id?: string | null
  linked_workspace_member_name?: string | null
  metadata: unknown
  created_at: Date
  updated_at: Date
  sessions?: unknown
}

type TransportMessageLinkRow = {
  id: string
  workspace_id: string
  conversation_id: string
  item_id: string
  transport_account_id: string
  transport_endpoint_id: string
  transport_kind: TransportKind
  direction: "inbound" | "outbound"
  delivery_status: TransportDeliveryStatus
  external_message_id?: string | null
  external_reply_to_id?: string | null
  external_thread_id?: string | null
  external_emoji_reactions?: unknown
  metadata: unknown
  delivered_at?: Date | null
  created_at?: Date | null
  updated_at?: Date | null
}

export function normalizeAccountRow(
  row: TransportAccountRow
): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id || "",
    transportKind: row.transport_kind,
    accountKey: row.account_key,
    displayName: row.display_name || row.account_key,
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
  row: TransportEndpointRow,
  transportKind: TransportKind
): TransportEndpointSummary {
  return {
    id: row.endpoint_id || row.id || "",
    transportAccountId: row.transport_account_id,
    transportKind,
    endpointType: row.endpoint_type,
    externalId: row.endpoint_external_id || row.external_id || "",
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
  row: ConversationTransportBindingRow
): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row)
  return {
    id: row.binding_id || row.id,
    conversationId: row.conversation_id || "",
    workspaceId: row.workspace_id || account.workspaceId,
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
  row: TransportSessionRow
): TransportSessionSummary {
  const workspaceId = row.account_workspace_id || row.workspace_id || ""
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
  row: TransportExternalUserRow
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

export function normalizeTransportMessageLinkRow(row: TransportMessageLinkRow) {
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
