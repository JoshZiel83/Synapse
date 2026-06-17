import {
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  extractText,
  type ChatConversationItem,
  type ChatParticipantSummary,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  type ChatConversationBaseRow,
  type ChatConversationItemRow,
  type ChatParticipantRow,
} from "./repo.js"
import type { ChatConversationRecord } from "./presenter.js"
import { normalizeConversationParticipantRoleKey } from "./roles.js"

export type LoadConversationViewsDeps = {
  getConversationBaseRow: (
    queryable: Executor,
    workspaceMemberId: string,
    conversationId: string
  ) => Promise<ChatConversationBaseRow | null>
  listConversationBaseRows: (
    queryable: Executor,
    workspaceMemberId: string
  ) => Promise<ChatConversationBaseRow[]>
  listConversationParticipants: (
    queryable: Executor,
    conversationIds: string[]
  ) => Promise<ChatParticipantRow[]>
  listItemRowsByIds: (
    queryable: Executor,
    itemIds: string[]
  ) => Promise<ChatConversationItemRow[]>
  buildChatConversationItems: (
    queryable: Executor,
    itemRows: ChatConversationItemRow[]
  ) => Promise<ChatConversationItem[]>
  participantToSummary: (
    participant: ChatParticipantRow
  ) => ChatParticipantSummary
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

function previewTextFromItem(item: ChatConversationItem | undefined): string {
  if (!item) return ""
  const text = item.content.trim() || extractText(item.contentBlocks).trim()
  if (text) return text
  return item.itemType === "message" ? "Attachment" : `[${item.subtype}]`
}

export async function loadConversationViewsUseCase(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationIds: string[] | undefined,
  deps: LoadConversationViewsDeps
) {
  const baseRows = conversationIds
    ? await Promise.all(
        conversationIds.map((conversationId) =>
          deps.getConversationBaseRow(
            queryable,
            workspaceMemberId,
            conversationId
          )
        )
      ).then((rows) => rows.filter(Boolean) as ChatConversationBaseRow[])
    : await deps.listConversationBaseRows(queryable, workspaceMemberId)

  if (baseRows.length === 0) {
    return [] as ChatConversationRecord[]
  }

  const ids = baseRows.map((row) => row.conversationId)
  const participants = await deps.listConversationParticipants(queryable, ids)
  const participantsByConversation = new Map<string, ChatParticipantRow[]>()
  for (const row of participants) {
    const current = participantsByConversation.get(row.conversationId) ?? []
    current.push(row)
    participantsByConversation.set(row.conversationId, current)
  }

  const lastItemIds = baseRows
    .map((row) => row.lastVisibleItemId)
    .filter((value): value is string => Boolean(value))
  const lastItemRows = await deps.listItemRowsByIds(queryable, [
    ...new Set(lastItemIds),
  ])
  const lastItems = await deps.buildChatConversationItems(
    queryable,
    lastItemRows
  )
  const lastItemById = new Map(lastItems.map((item) => [item.id, item]))

  return baseRows.map((row) => {
    const conversationParticipants =
      participantsByConversation.get(row.conversationId) ?? []
    const mappedParticipants = conversationParticipants.map(
      deps.participantToSummary
    )
    const viewerMembership = conversationParticipants.find(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE &&
        participant.participantType ===
          CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER &&
        participant.workspaceMemberId === workspaceMemberId
    )
    const viewerConversationRole = normalizeConversationParticipantRoleKey(
      viewerMembership?.roleKey
    )
    const lastItem = row.lastVisibleItemId
      ? lastItemById.get(row.lastVisibleItemId)
      : undefined
    return {
      conversationId: row.conversationId,
      workspaceId,
      baseTitle: row.title,
      kind: row.kind,
      isIm: row.isIm,
      unreadCount: toNumber(row.unreadCount),
      muted: Boolean(row.muted),
      archived: Boolean(row.archived),
      pinnedSortKey: row.pinnedSortKey ?? undefined,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      participants: mappedParticipants,
      viewerWorkspaceMemberId: workspaceMemberId,
      viewerParticipantId: viewerMembership?.id,
      viewerConversationRole,
      lastItem: lastItem
        ? {
            itemId: lastItem.id,
            sequence: lastItem.sequence,
            itemType: lastItem.itemType,
            subtype: lastItem.subtype,
            previewText: previewTextFromItem(lastItem),
            authorParticipantId: lastItem.authorParticipantId,
            author: lastItem.author,
            createdAt: lastItem.createdAt,
          }
        : undefined,
    } satisfies ChatConversationRecord
  })
}

export async function loadConversationViewUseCase(
  queryable: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  conversationId: string,
  deps: LoadConversationViewsDeps
) {
  const views = await loadConversationViewsUseCase(
    queryable,
    workspaceId,
    workspaceMemberId,
    [conversationId],
    deps
  )
  return views[0] ?? null
}
