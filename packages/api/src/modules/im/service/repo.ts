/**
 * IM service repo — DB-row types + row normalizers.
 *
 * Houses the `normalize*Row` functions (DB row → shared/types shape) that the
 * IM service/domain files consume. Lives in a repo file so it may legitimately
 * define `normalize*Row` and shape DB rows. `_helpers.ts` re-exports these so
 * existing importers keep working unchanged.
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
import { parseJsonArray, readTrimmedString } from "./_helpers.js"

type TransportAccountRow = {
  id: string
  workspaceId: string | null
  transportKind: TransportKind
  accountKey: string
  displayName: string | null
  ownerScope?: TransportAccountOwnerScope | null
  ownerWorkspaceMemberId?: string | null
  accountInboundActorMode?: TransportAccountInboundActorMode | null
  inboundActorMode?:
    | TransportAccountInboundActorMode
    | TransportConversationInboundActorMode
    | null
  accountInboundActorId?: string | null
  inboundActorId?: string | null
  connectionMode: TransportConnectionMode
  status: TransportAccountStatus
  credentials: unknown
  config: unknown
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

type TransportEndpointRow = {
  endpointId?: string | null
  id?: string | null
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId?: string | null
  externalId?: string | null
  parentExternalId?: string | null
  endpointDisplayName?: string | null
  displayName?: string | null
  endpointMetadata?: unknown
  metadata?: unknown
  endpointCreatedAt?: Date | null
  createdAt?: Date | null
  endpointUpdatedAt?: Date | null
  updatedAt?: Date | null
}

type ConversationTransportBindingRow = TransportAccountRow &
  TransportEndpointRow & {
    bindingId?: string | null
    conversationId: string | null
    outboundEnabled: boolean | null
    bindingMetadata?: unknown
    bindingCreatedAt?: Date | null
    bindingUpdatedAt?: Date | null
  }

type TransportSessionRow = ConversationTransportBindingRow & {
  accountWorkspaceId?: string | null
  conversationTitle?: string | null
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
}

type TransportExternalUserRow = {
  id: string
  workspaceId: string
  transportAccountId: string
  transportKind: TransportKind
  accountDisplayName?: string | null
  externalId: string
  displayName?: string | null
  linkedWorkspaceMemberId?: string | null
  linkedWorkspaceMemberName?: string | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
  sessions?: unknown
}

type TransportMessageLinkRow = {
  id: string
  workspaceId: string
  conversationId: string
  itemId: string
  transportAccountId: string
  transportEndpointId: string
  transportKind: TransportKind
  direction: "inbound" | "outbound"
  deliveryStatus: TransportDeliveryStatus
  externalMessageId?: string | null
  externalReplyToId?: string | null
  externalThreadId?: string | null
  externalEmojiReactions?: unknown
  metadata: unknown
  deliveredAt?: Date | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

export function normalizeAccountRow(
  row: TransportAccountRow
): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId || "",
    transportKind: row.transportKind,
    accountKey: row.accountKey,
    displayName: row.displayName || row.accountKey,
    ownerScope:
      (row.ownerScope as TransportAccountOwnerScope | undefined) || "workspace",
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId || undefined,
    inboundActorMode:
      (row.accountInboundActorMode as
        | TransportAccountInboundActorMode
        | undefined) ||
      (row.inboundActorMode as TransportAccountInboundActorMode | undefined) ||
      "none",
    inboundActorId:
      row.accountInboundActorId || row.inboundActorId || undefined,
    connectionMode: row.connectionMode,
    status: row.status,
    credentials: parseJsonObject(row.credentials),
    config: parseJsonObject(row.config),
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

export function normalizeEndpointRow(
  row: TransportEndpointRow,
  transportKind: TransportKind
): TransportEndpointSummary {
  return {
    id: row.endpointId || row.id || "",
    transportAccountId: row.transportAccountId,
    transportKind,
    endpointType: row.endpointType,
    externalId: row.endpointExternalId || row.externalId || "",
    parentExternalId: row.parentExternalId || undefined,
    displayName: row.endpointDisplayName || row.displayName || undefined,
    metadata: parseJsonObject(row.endpointMetadata || row.metadata),
    createdAt: serializeOptionalInstant(
      row.endpointCreatedAt || row.createdAt
    )!,
    updatedAt: serializeOptionalInstant(
      row.endpointUpdatedAt || row.updatedAt
    )!,
  }
}

export function normalizeBindingRow(
  row: ConversationTransportBindingRow
): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row)
  return {
    id: row.bindingId || row.id,
    conversationId: row.conversationId || "",
    workspaceId: row.workspaceId || account.workspaceId,
    transportKind: row.transportKind,
    outboundEnabled: Boolean(row.outboundEnabled),
    inboundActorMode:
      (row.inboundActorMode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inboundActorId || undefined,
    metadata: parseJsonObject(row.bindingMetadata || row.metadata),
    createdAt: serializeOptionalInstant(row.bindingCreatedAt || row.createdAt)!,
    updatedAt: serializeOptionalInstant(row.bindingUpdatedAt || row.updatedAt)!,
    account,
    endpoint: normalizeEndpointRow(row, row.transportKind),
  }
}

export function normalizeTransportSessionRow(
  row: TransportSessionRow
): TransportSessionSummary {
  const workspaceId = row.accountWorkspaceId || row.workspaceId || ""
  const account = normalizeAccountRow({ ...row, workspaceId })
  return {
    id: row.endpointId || row.bindingId || row.id,
    workspaceId,
    transportKind: row.transportKind,
    outboundEnabled: Boolean(row.outboundEnabled),
    inboundActorMode:
      (row.inboundActorMode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inboundActorId || undefined,
    metadata: parseJsonObject(
      row.bindingMetadata || row.endpointMetadata || row.metadata
    ),
    createdAt: serializeOptionalInstant(
      row.bindingCreatedAt || row.endpointCreatedAt || row.createdAt
    )!,
    updatedAt: serializeOptionalInstant(
      row.bindingUpdatedAt || row.endpointUpdatedAt || row.updatedAt
    )!,
    conversationId: row.conversationId || undefined,
    conversationTitle: readTrimmedString(row, "conversationTitle"),
    lastInboundAt: serializeOptionalInstant(row.lastInboundAt),
    lastOutboundAt: serializeOptionalInstant(row.lastOutboundAt),
    account,
    endpoint: normalizeEndpointRow(row, row.transportKind),
  }
}

export function normalizeTransportExternalUserRow(
  row: TransportExternalUserRow
): TransportExternalUserSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    transportAccountId: row.transportAccountId,
    transportKind: row.transportKind,
    accountDisplayName: row.accountDisplayName || "Transport account",
    externalId: row.externalId,
    displayName: row.displayName || undefined,
    linkedWorkspaceMemberId: row.linkedWorkspaceMemberId || undefined,
    linkedWorkspaceMemberName: row.linkedWorkspaceMemberName || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
    sessions: parseJsonArray<any>(row.sessions),
  }
}

export function normalizeTransportMessageLinkRow(row: TransportMessageLinkRow) {
  const rawReactions = row.externalEmojiReactions
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
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    itemId: row.itemId,
    transportAccountId: row.transportAccountId,
    transportEndpointId: row.transportEndpointId,
    transportKind: row.transportKind as TransportKind,
    direction: row.direction as "inbound" | "outbound",
    deliveryStatus: row.deliveryStatus as TransportDeliveryStatus,
    externalMessageId: row.externalMessageId || undefined,
    externalReplyToId: row.externalReplyToId || undefined,
    externalThreadId: row.externalThreadId || undefined,
    externalEmojiReactions: reactions,
    metadata: parseJsonObject(row.metadata),
    deliveredAt: serializeOptionalInstant(row.deliveredAt),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}
