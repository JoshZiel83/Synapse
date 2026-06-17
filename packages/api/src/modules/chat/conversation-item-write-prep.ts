import {
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_PARTICIPANT_STATE,
  normalizeCanonicalContentBlocks,
} from "@synapse/shared"
import type { ConversationEntityRef } from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import { createChatError } from "./errors.js"
import type {
  ConversationItemPartInput,
  CreateConversationItemInput,
  MentionedParticipantRef,
  PreparedConversationItemWrite,
} from "./item-write.js"
import { participantRowToEntityRef } from "./participant-projection.js"
import {
  getVisibleConversationReplyTargetRow,
  listChatConversationParticipantRows,
  type ChatParticipantRow,
} from "./repo.js"

type ParticipantRow = ChatParticipantRow

function parseMentionBlockFromPart(part: ConversationItemPartInput) {
  if (part.type !== "json" || !part.json) {
    return null
  }
  const normalized = normalizeCanonicalContentBlocks([part.json as any])
  const block = normalized[0]
  return block?.type === "mention" ? block : null
}

function resolveMentionedConversationParticipant(
  participants: ParticipantRow[],
  mention: ConversationEntityRef
) {
  const activeParticipants = participants.filter(
    (participant) => participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
  )
  if (mention.participantId) {
    return activeParticipants.find(
      (participant) => participant.id === mention.participantId
    )
  }
  if (mention.workspaceMemberId) {
    return activeParticipants.find(
      (participant) =>
        participant.workspaceMemberId === mention.workspaceMemberId
    )
  }
  if (mention.actorId) {
    return activeParticipants.find(
      (participant) => participant.actorId === mention.actorId
    )
  }
  if (mention.externalUserKey) {
    return activeParticipants.find(
      (participant) =>
        participantRowToEntityRef(participant)?.externalUserKey ===
        mention.externalUserKey
    )
  }
  return null
}

async function canonicalizeConversationItemParts(
  queryable: Executor,
  params: {
    conversationId: string
    parts?: ConversationItemPartInput[]
    activeParticipants?: ParticipantRow[]
  }
): Promise<{
  parts: ConversationItemPartInput[]
  mentionedParticipants: MentionedParticipantRef[]
}> {
  const originalParts = params.parts ?? []
  if (originalParts.length === 0) {
    return {
      parts: [],
      mentionedParticipants: [],
    }
  }
  const participants =
    params.activeParticipants ??
    (
      await listChatConversationParticipantRows(
        queryable,
        [params.conversationId],
        {
          useProfileSnapshot: true,
        }
      )
    ).filter(
      (participant) =>
        participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
    )
  const parts: ConversationItemPartInput[] = []
  const mentionedParticipants: MentionedParticipantRef[] = []

  for (const [ordinal, part] of originalParts.entries()) {
    const mentionBlock = parseMentionBlockFromPart(part)
    if (!mentionBlock) {
      parts.push(part)
      continue
    }

    const participant = resolveMentionedConversationParticipant(
      participants,
      mentionBlock.mention
    )
    if (!participant) {
      throw createChatError(
        400,
        "invalid_mention",
        "One or more mentions are invalid for this conversation"
      )
    }
    const canonicalMention = {
      ...mentionBlock,
      mention: participantRowToEntityRef(participant)!,
    }
    mentionedParticipants.push({
      participantId: participant.id,
      ordinal,
    })
    parts.push({
      ...part,
      json: canonicalMention,
      metadata: {
        ...(part.metadata ?? {}),
        mention: canonicalMention.mention,
      },
    })
  }

  return {
    parts,
    mentionedParticipants,
  }
}

async function validateConversationReplyTarget(
  queryable: Executor,
  conversationId: string,
  replyToItemId?: string,
  authorParticipantId?: string
) {
  if (!replyToItemId) {
    return null
  }
  const row = await getVisibleConversationReplyTargetRow(queryable, {
    conversationId,
    replyToItemId,
    authorParticipantId,
  })
  if (!row) {
    throw createChatError(
      400,
      "invalid_reply_to_item",
      "replyToItemId must reference a visible item in the same conversation"
    )
  }
  return row
}

export async function prepareConversationItemWrite(
  queryable: Executor,
  params: {
    conversationId: string
    scope: CreateConversationItemInput["scope"]
    surface: CreateConversationItemInput["surface"]
    parts?: ConversationItemPartInput[]
    restrictedAudienceParticipantIds?: string[]
    contextTargetParticipantIds?: string[]
    replyToItemId?: string
    authorParticipantId?: string
    activeParticipants?: ParticipantRow[]
  }
): Promise<PreparedConversationItemWrite> {
  let activeParticipants: ParticipantRow[] = []
  if (
    params.scope === CONVERSATION_ITEM_SCOPE.SHARED &&
    params.surface === CONVERSATION_ITEM_SURFACE.VISIBLE
  ) {
    activeParticipants =
      params.activeParticipants ??
      (await listChatConversationParticipantRows(
        queryable,
        [params.conversationId],
        {
          useProfileSnapshot: true,
        }
      ).then((participants) =>
        participants.filter(
          (participant) =>
            participant.state === CONVERSATION_PARTICIPANT_STATE.ACTIVE
        )
      ))
  }
  const validParticipantIds = new Set(
    activeParticipants.map((participant) => participant.id)
  )

  for (const participantId of params.restrictedAudienceParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(
        `Invalid restricted audience participant ${participantId}`
      )
    }
  }
  for (const participantId of params.contextTargetParticipantIds ?? []) {
    if (!validParticipantIds.has(participantId)) {
      throw new Error(`Invalid context target participant ${participantId}`)
    }
  }

  const normalizedParts = await canonicalizeConversationItemParts(queryable, {
    conversationId: params.conversationId,
    parts: params.parts,
    activeParticipants,
  })

  return {
    activeParticipants,
    parts: normalizedParts.parts,
    mentionedParticipants: normalizedParts.mentionedParticipants,
    replyToItem: await validateConversationReplyTarget(
      queryable,
      params.conversationId,
      params.replyToItemId,
      params.authorParticipantId
    ),
  }
}
