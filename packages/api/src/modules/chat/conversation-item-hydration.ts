import {
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPES,
  extractText,
  type CanonicalContentBlock,
  type Timestamp,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { itemPartsToCanonicalContentBlocks } from "./message-content.js"
import { presentInstant } from "./presenter.js"
import type {
  ChatConversationItemPartRow,
  ChatConversationItemRow,
  ChatConversationParticipantLinkRow,
} from "./repo.js"

type ItemScope = (typeof CONVERSATION_ITEM_SCOPES)[number]
type ItemSurface = (typeof CONVERSATION_ITEM_SURFACES)[number]
type ItemType = (typeof CONVERSATION_ITEM_TYPES)[number]
type ItemRole = (typeof CONVERSATION_ITEM_ROLES)[number]

export type HydratedConversationItemRecord = {
  id: string
  conversationId: string
  sequence: number
  clientMessageId?: string
  itemType: ItemType
  role: ItemRole
  subtype: string
  scope: ItemScope
  surface: ItemSurface
  authorParticipantId?: string
  replyToItemId?: string
  causedByItemId?: string
  content: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  restrictedAudienceParticipantIds: string[]
  createdAt: Timestamp
}

export type HydrateConversationItemsDeps = {
  listConversationItemParts: (
    queryable: Executor,
    itemIds: string[]
  ) => Promise<ChatConversationItemPartRow[]>
  listConversationItemTargets: (
    queryable: Executor,
    itemIds: string[]
  ) => Promise<ChatConversationParticipantLinkRow[]>
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

export async function hydrateConversationItemsUseCase(
  queryable: Executor,
  itemRows: ChatConversationItemRow[],
  deps: HydrateConversationItemsDeps
) {
  if (itemRows.length === 0) {
    return [] as HydratedConversationItemRecord[]
  }

  const itemIds = itemRows.map((row) => row.id)
  const [parts, restrictedAudience] = await Promise.all([
    deps.listConversationItemParts(queryable, itemIds),
    deps.listConversationItemTargets(queryable, itemIds),
  ])

  const partsByItem = new Map<string, ChatConversationItemPartRow[]>()
  for (const row of parts) {
    const current = partsByItem.get(row.itemId) ?? []
    current.push(row)
    partsByItem.set(row.itemId, current)
  }

  const restrictedAudienceByItem = new Map<string, string[]>()
  for (const row of restrictedAudience) {
    const current = restrictedAudienceByItem.get(row.itemId) ?? []
    current.push(row.targetParticipantId)
    restrictedAudienceByItem.set(row.itemId, current)
  }

  const itemMap = new Map<string, HydratedConversationItemRecord>()
  for (const row of itemRows) {
    const contentBlocks = itemPartsToCanonicalContentBlocks(
      partsByItem.get(row.id) ?? []
    )
    itemMap.set(row.id, {
      id: row.id,
      conversationId: row.conversationId,
      sequence: toNumber(row.sequence),
      clientMessageId: row.clientMessageId ?? undefined,
      itemType: row.itemType,
      role: row.role,
      subtype: row.subtype,
      scope: row.scope,
      surface: row.surface,
      authorParticipantId: row.authorParticipantId ?? undefined,
      replyToItemId: row.replyToItemId ?? undefined,
      causedByItemId: row.causedByItemId ?? undefined,
      content: extractText(contentBlocks),
      contentBlocks,
      metadata: row.metadata,
      restrictedAudienceParticipantIds:
        restrictedAudienceByItem.get(row.id) ?? [],
      createdAt: presentInstant(row.createdAt),
    })
  }

  return itemRows.map((row) => itemMap.get(row.id)!).filter(Boolean)
}
