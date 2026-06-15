import { extractText, type ChatConversationItem } from "@synapse/shared"
import type { ChatSyncEventPayloadMap } from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { parseInstantString } from "../../infrastructure/datetime.js"
import {
  countUnreadVisibleConversationMessages,
  upsertWorkspaceMemberConversationView,
  type ChatParticipantRow,
} from "./repo.js"
import { appendWorkspaceMemberSyncEvent } from "./sync-events.js"

type SyncConversationUpsert = (
  queryable: Executor,
  workspaceId: string,
  workspaceMemberIds: string[],
  conversationId: string
) => Promise<void>

type UpsertConversationViewInput = {
  workspaceMemberId: string
  conversationId: string
  lastVisibleItemId?: string | null
  lastVisibleSequence?: number
  lastVisibleAt?: string
  unreadCount: number
  summary?: Record<string, unknown>
}

export type SyncVisibleSharedItemInput = {
  queryable: Executor
  workspaceId?: string
  conversationId: string
  item: ChatConversationItem
  activeParticipants: ChatParticipantRow[]
  authorParticipantId?: string
  restrictedAudienceParticipantIds?: string[]
}

export type SyncVisibleSharedItemDeps = {
  syncConversationUpsert: SyncConversationUpsert
  countUnreadVisibleMessages?: (
    queryable: Executor,
    conversationId: string,
    participantId: string
  ) => Promise<number>
  upsertConversationView?: (
    queryable: Executor,
    params: UpsertConversationViewInput
  ) => Promise<void>
  appendWorkspaceMemberSyncEvent?: typeof appendWorkspaceMemberSyncEvent
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

async function defaultCountUnreadVisibleMessages(
  queryable: Executor,
  conversationId: string,
  participantId: string
) {
  return toNumber(
    await countUnreadVisibleConversationMessages(queryable, {
      conversationId,
      participantId,
    })
  )
}

async function defaultUpsertConversationView(
  queryable: Executor,
  params: UpsertConversationViewInput
) {
  await upsertWorkspaceMemberConversationView(queryable, {
    ...params,
    lastVisibleAt: params.lastVisibleAt
      ? parseInstantString(params.lastVisibleAt)
      : null,
  })
}

function previewTextFromItem(item: ChatConversationItem | undefined): string {
  if (!item) return ""
  const text = item.content.trim() || extractText(item.contentBlocks).trim()
  if (text) return text
  return item.itemType === "message" ? "Attachment" : `[${item.subtype}]`
}

export async function syncVisibleSharedItemUseCase(
  params: SyncVisibleSharedItemInput,
  deps: SyncVisibleSharedItemDeps
) {
  const countUnread =
    deps.countUnreadVisibleMessages ?? defaultCountUnreadVisibleMessages
  const upsertConversationView =
    deps.upsertConversationView ?? defaultUpsertConversationView
  const appendSyncEvent =
    deps.appendWorkspaceMemberSyncEvent ?? appendWorkspaceMemberSyncEvent
  const effectiveVisibleParticipantIds =
    params.restrictedAudienceParticipantIds &&
    params.restrictedAudienceParticipantIds.length > 0
      ? [
          ...new Set([
            ...params.restrictedAudienceParticipantIds,
            ...(params.authorParticipantId ? [params.authorParticipantId] : []),
          ]),
        ]
      : params.activeParticipants.map((participant) => participant.id)

  const visibleHumanParticipants = params.activeParticipants.filter(
    (participant) =>
      participant.workspaceMemberId &&
      effectiveVisibleParticipantIds.includes(participant.id)
  )

  for (const participant of visibleHumanParticipants) {
    const unreadCount = await countUnread(
      params.queryable,
      params.conversationId,
      participant.id
    )
    await upsertConversationView(params.queryable, {
      workspaceMemberId: participant.workspaceMemberId!,
      conversationId: params.conversationId,
      lastVisibleItemId: params.item.id,
      lastVisibleSequence: params.item.sequence,
      lastVisibleAt: params.item.createdAt,
      unreadCount,
      summary: {
        previewText: previewTextFromItem(params.item),
      },
    })
  }

  if (params.workspaceId) {
    for (const participant of visibleHumanParticipants) {
      await appendSyncEvent(params.queryable, {
        workspaceId: params.workspaceId,
        workspaceMemberId: participant.workspaceMemberId!,
        conversationId: params.conversationId,
        itemId: params.item.id,
        eventType: "conversation.item.created",
        payload: {
          conversationId: params.conversationId,
          item: params.item,
        } satisfies ChatSyncEventPayloadMap["conversation.item.created"],
      })
    }

    await deps.syncConversationUpsert(
      params.queryable,
      params.workspaceId,
      visibleHumanParticipants
        .map((participant) => participant.workspaceMemberId)
        .filter((value): value is string => Boolean(value)),
      params.conversationId
    )
  }
}
