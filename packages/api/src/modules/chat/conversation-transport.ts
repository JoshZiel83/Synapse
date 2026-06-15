import {
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTION,
  isTransportKind,
} from "@synapse/shared"
import type {
  ConversationMessageTransportContext,
  ConversationMessageTransportDelivery,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { presentOptionalInstant } from "./presenter.js"
import type { ChatTransportDeliveryRow } from "./repo.js"

export type LoadConversationTransportDeliveriesDeps = {
  listTransportDeliveryRowsForItems: (
    queryable: Executor,
    itemIds: string[]
  ) => Promise<ChatTransportDeliveryRow[]>
}

export function mapConversationTransportContext(
  metadata: Record<string, unknown>
): ConversationMessageTransportContext | undefined {
  const raw = metadata.transport
  if (!raw || typeof raw !== "object") {
    return undefined
  }
  const value = raw as Record<string, unknown>
  const direction =
    value.direction === CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND ||
    value.direction === CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND
      ? value.direction
      : undefined
  const transportKind = isTransportKind(value.transportKind)
    ? value.transportKind
    : undefined
  if (!direction || !transportKind) {
    return undefined
  }
  return {
    direction,
    transportKind,
    transportAccountId:
      typeof value.transportAccountId === "string"
        ? value.transportAccountId
        : undefined,
    endpointType:
      value.endpointType === "direct" || value.endpointType === "group"
        ? value.endpointType
        : undefined,
    endpointExternalId:
      typeof value.endpointExternalId === "string"
        ? value.endpointExternalId
        : undefined,
    externalMessageId:
      typeof value.externalMessageId === "string"
        ? value.externalMessageId
        : undefined,
    transportAddressId:
      typeof value.transportAddressId === "string"
        ? value.transportAddressId
        : undefined,
    senderExternalId:
      typeof value.senderExternalId === "string"
        ? value.senderExternalId
        : undefined,
  }
}

export async function loadConversationTransportDeliveriesUseCase(
  queryable: Executor,
  itemIds: string[],
  deps: LoadConversationTransportDeliveriesDeps
) {
  if (itemIds.length === 0) {
    return new Map<string, ConversationMessageTransportDelivery[]>()
  }
  const rows = await deps.listTransportDeliveryRowsForItems(queryable, itemIds)
  const byItem = new Map<string, ConversationMessageTransportDelivery[]>()
  for (const row of rows) {
    const current = byItem.get(row.itemId) ?? []
    current.push({
      linkId: row.linkId,
      transportKind: row.transportKind,
      direction: row.direction,
      deliveryStatus: row.deliveryStatus,
      endpointType: row.endpointType,
      endpointExternalId: row.endpointExternalId ?? undefined,
      endpointDisplayName: row.endpointDisplayName ?? undefined,
      externalMessageId: row.externalMessageId ?? undefined,
      deliveredAt: presentOptionalInstant(row.deliveredAt),
      metadata: row.metadata,
    })
    byItem.set(row.itemId, current)
  }
  return byItem
}
