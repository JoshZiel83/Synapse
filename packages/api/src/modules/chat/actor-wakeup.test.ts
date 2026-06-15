import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  enqueueActorWakeupsForConversationMessageUseCase,
  resolveActorWakeParticipants,
  type ActorWakeupDeps,
} from "./actor-wakeup.js"
import type { ChatConversationItemRow, ChatParticipantRow } from "./repo.js"

function participant(
  values: Pick<
    ChatParticipantRow,
    "id" | "conversationId" | "participantType" | "state"
  > &
    Partial<ChatParticipantRow>
): ChatParticipantRow {
  return {
    workspaceMemberId: null,
    actorId: null,
    remoteAgentId: null,
    actorJoinVersionId: null,
    displayName: null,
    roleKey: "member",
    metadata: {},
    joinedAt: new Date("2026-06-16T00:00:00.000Z"),
    leftAt: null,
    userId: null,
    userName: null,
    participantName: null,
    participantTitle: null,
    participantRole: null,
    actorDocs: null,
    actorCanRepresentUser: null,
    actorSpecialties: null,
    actorConfig: null,
    actorCurrentVersion: null,
    participantAvatarEmoji: null,
    participantAvatarFileId: null,
    userAvatarFileId: null,
    transportAddressId: null,
    transportKind: null,
    transportExternalId: null,
    transportDisplayName: null,
    linkedUserId: null,
    linkedUserName: null,
    linkedUserAvatarFileId: null,
    sessionId: null,
    sessionStatus: null,
    ...values,
  }
}

function itemRow(values: Partial<ChatConversationItemRow>) {
  return {
    id: randomUUID(),
    conversationId: randomUUID(),
    sessionId: null,
    turnId: null,
    clientMessageId: null,
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: CONVERSATION_ITEM_ROLE.USER,
    authorParticipantId: null,
    replyToItemId: null,
    causedByItemId: null,
    eventPayload: {},
    eventTimelinePolicy: null,
    eventContextPolicy: null,
    metadata: {},
    sequence: 1,
    createdAt: new Date("2026-06-16T00:00:00.000Z"),
    ...values,
  } as ChatConversationItemRow
}

function deps(params: {
  item: ChatConversationItemRow
  replyItem?: ChatConversationItemRow
  participants: ChatParticipantRow[]
  mentionedParticipantIds?: string[]
  sessionCalls: unknown[]
  wakeupCalls: unknown[]
}): ActorWakeupDeps {
  return {
    listItemRowsByIds: async (_queryable, itemIds) =>
      itemIds[0] === params.item.id
        ? [params.item]
        : params.replyItem && itemIds[0] === params.replyItem.id
          ? [params.replyItem]
          : [],
    conversationItemHasTargets: async () => false,
    getConversationKind: async () => "group",
    listConversationParticipants: async () => params.participants,
    listMentionedParticipantIdsForItem: async () =>
      params.mentionedParticipantIds ?? [],
    hydrateConversationItems: async () => {
      throw new Error("summary should be supplied by the caller")
    },
    ensureConversationActorSessionContext: async (input) => {
      params.sessionCalls.push(input)
      return { sessionId: `session-${input.actorId}` }
    },
    enqueueSessionWakeup: async (input) => {
      params.wakeupCalls.push(input)
    },
  }
}

test("resolveActorWakeParticipants wakes only explicit mentions in group conversations", () => {
  const conversationId = randomUUID()
  const authorId = randomUUID()
  const mentionedActor = participant({
    id: randomUUID(),
    conversationId,
    participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
    state: "active",
    actorId: randomUUID(),
  })
  const unmentionedActor = participant({
    id: randomUUID(),
    conversationId,
    participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
    state: "active",
    actorId: randomUUID(),
  })

  const result = resolveActorWakeParticipants({
    conversationKind: "group",
    activeParticipants: [
      participant({
        id: authorId,
        conversationId,
        participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
        state: "active",
        workspaceMemberId: randomUUID(),
      }),
      mentionedActor,
      unmentionedActor,
    ],
    authorParticipantId: authorId,
    mentionedParticipantIds: [mentionedActor.id],
  })

  assert.deepEqual(
    result.map((row) => row.id),
    [mentionedActor.id]
  )
})

test("resolveActorWakeParticipants wakes reply actor even without mentions", () => {
  const conversationId = randomUUID()
  const replyActor = participant({
    id: randomUUID(),
    conversationId,
    participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
    state: "active",
    actorId: randomUUID(),
  })

  const result = resolveActorWakeParticipants({
    conversationKind: "group",
    activeParticipants: [replyActor],
    mentionedParticipantIds: [],
    replyAuthorParticipantId: replyActor.id,
  })

  assert.deepEqual(
    result.map((row) => row.id),
    [replyActor.id]
  )
})

test("enqueueActorWakeupsForConversationMessageUseCase enqueues inferred user wakeup", async () => {
  const queryable = {} as Executor
  const workspaceId = randomUUID()
  const conversationId = randomUUID()
  const authorParticipantId = randomUUID()
  const authorWorkspaceMemberId = randomUUID()
  const actorId = randomUUID()
  const actorParticipantId = randomUUID()
  const item = itemRow({
    id: randomUUID(),
    conversationId,
    authorParticipantId,
  })
  const sessionCalls: unknown[] = []
  const wakeupCalls: unknown[] = []

  const pending = await enqueueActorWakeupsForConversationMessageUseCase(
    {
      workspaceId,
      conversationId,
      itemId: item.id,
      summary: " Hello\n   actor ",
      queryable,
    },
    deps({
      item,
      mentionedParticipantIds: [actorParticipantId],
      participants: [
        participant({
          id: authorParticipantId,
          conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
          state: "active",
          workspaceMemberId: authorWorkspaceMemberId,
          userName: "Alice",
        }),
        participant({
          id: actorParticipantId,
          conversationId,
          participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
          state: "active",
          actorId,
          participantName: "Helper",
        }),
      ],
      sessionCalls,
      wakeupCalls,
    })
  )

  assert.deepEqual(pending, [
    {
      actorId,
      sessionId: `session-${actorId}`,
      sourceType: "user_message",
    },
  ])
  assert.deepEqual(sessionCalls, [
    {
      workspaceId,
      actorId,
      conversationId,
      trigger: "user_message",
    },
  ])
  assert.equal(wakeupCalls.length, 1)
  assert.deepEqual(wakeupCalls[0], {
    sessionId: `session-${actorId}`,
    actorId,
    workspaceId,
    sourceType: "user_message",
    sourceItemId: item.id,
    sourceParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    sourceParticipantId: authorWorkspaceMemberId,
    sourceName: "Alice",
    summary: "Hello actor",
    metadata: {
      source: "chat.message_wakeup",
      conversationId,
    },
    trigger: "user_message",
  })
})
