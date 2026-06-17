import {
  buildConversationMessageRef,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE,
  parseConversationMessageRef,
  type ConversationReplyRef,
} from "@synapse/shared"
import { type Executor } from "../../infrastructure/database/kysely.js"
import type { HydratedConversationItemRecord } from "./conversation-item-hydration.js"
import { normalizeConversationItemSubtype } from "./conversation-item-detail.js"
import { createChatError } from "./errors.js"
import { participantRowToEntityRef } from "./participant-projection.js"
import { presentInstant } from "./presenter.js"
import {
  chatRootExecutor,
  getVisibleConversationReplyRefRow,
  listNearbyVisibleConversationReplyRefRows,
  type ChatConversationItemRow,
  type ChatParticipantRow,
} from "./repo.js"

export type BuildConversationReplyRefsInput = {
  replyToIds: string[]
  replyRows: ChatConversationItemRow[]
  replyHydratedItems: HydratedConversationItemRecord[]
  participantById: Map<string, ChatParticipantRow>
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

export function unavailableConversationReplyRef(
  itemId: string
): ConversationReplyRef {
  return {
    itemId,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE,
    previewText: "",
    previewBlocks: [],
    isUnavailable: true,
  }
}

function rootQueryable(): Executor {
  return chatRootExecutor()
}

export async function resolveConversationReplyRef(params: {
  queryable?: Executor
  conversationId: string
  participantId?: string
  replyRef?: string
}) {
  if (!params.replyRef) {
    return null
  }

  const sequence = parseConversationMessageRef(params.replyRef)
  if (sequence === null || !Number.isFinite(sequence)) {
    throw createChatError(
      400,
      "invalid_reply_ref",
      'replyToRef must use the form "m_<sequence>"'
    )
  }

  const queryable = params.queryable ?? rootQueryable()
  const row = await getVisibleConversationReplyRefRow(queryable, {
    conversationId: params.conversationId,
    sequence,
    participantId: params.participantId,
  })
  if (row) {
    const rowSequence = toNumber(row.sequence)
    return {
      itemId: row.id,
      sequence: rowSequence,
      ref: buildConversationMessageRef(rowSequence),
    }
  }

  const nearby = await listNearbyVisibleConversationReplyRefRows(queryable, {
    conversationId: params.conversationId,
    sequence,
    participantId: params.participantId,
  })
  const suggestions = nearby
    .map((candidate) =>
      buildConversationMessageRef(toNumber(candidate.sequence))
    )
    .filter((value, index, all) => all.indexOf(value) === index)
  const suggestionText =
    suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : ""

  throw createChatError(
    400,
    "invalid_reply_ref",
    `Unknown replyToRef "${params.replyRef}".${suggestionText}`
  )
}

export function buildConversationReplyRefs({
  replyToIds,
  replyRows,
  replyHydratedItems,
  participantById,
}: BuildConversationReplyRefsInput): Map<string, ConversationReplyRef> {
  const replyRowById = new Map(replyRows.map((row) => [row.id, row]))
  const replyHydratedById = new Map(
    replyHydratedItems.map((item) => [item.id, item])
  )
  const replyRefById = new Map<string, ConversationReplyRef>()

  for (const replyToItemId of replyToIds) {
    const replyRow = replyRowById.get(replyToItemId)
    const replyItem = replyHydratedById.get(replyToItemId)
    if (
      !replyRow ||
      !replyItem ||
      replyRow.scope !== CONVERSATION_ITEM_SCOPE.SHARED ||
      replyRow.surface !== CONVERSATION_ITEM_SURFACE.VISIBLE
    ) {
      continue
    }

    const sequence = toNumber(replyRow.sequence)
    replyRefById.set(replyToItemId, {
      itemId: replyToItemId,
      ref: buildConversationMessageRef(sequence),
      sequence,
      itemType: replyItem.itemType,
      subtype: normalizeConversationItemSubtype(
        replyRow.itemType,
        replyRow.subtype,
        replyRow.id
      ),
      author: replyRow.authorParticipantId
        ? participantRowToEntityRef(
            participantById.get(replyRow.authorParticipantId)
          )
        : undefined,
      previewText: replyItem.content.trim(),
      previewBlocks: replyItem.contentBlocks,
      createdAt: presentInstant(replyRow.createdAt),
    })
  }

  return replyRefById
}
