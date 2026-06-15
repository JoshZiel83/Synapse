import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
  type ChatConversationEventItem,
  type ChatConversationItem,
} from "@synapse/shared"
import type {
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  createConversationEventUseCase,
  updateConversationItemEventPayloadUseCase,
  type CreateConversationEventDeps,
} from "./event-write.js"
import type { CreateConversationItemInput } from "./item-write.js"
import type { ChatParticipantRow } from "./repo.js"

function participant(
  values: Pick<ChatParticipantRow, "id" | "conversationId" | "state"> &
    Partial<ChatParticipantRow>
): ChatParticipantRow {
  return values as ChatParticipantRow
}

function eventItem<T extends ConversationFeedEventType>(
  params: CreateConversationItemInput
): ChatConversationEventItem<T> {
  return {
    id: randomUUID(),
    conversationId: params.conversationId,
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.EVENT,
    subtype: params.subtype,
    role: CONVERSATION_ITEM_ROLE.SYSTEM,
    scope: params.scope,
    surface: params.surface,
    content: "event",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "event" }],
    metadata: params.metadata ?? {},
    eventPayload: params.eventPayload,
    eventTimelinePolicy: params.eventTimelinePolicy,
    eventContextPolicy: params.eventContextPolicy,
    createdAt: "2026-06-16T00:00:00.000Z",
  } as ChatConversationEventItem<T>
}

function automationPayload(): ConversationFeedEventPayloadMap["automation_notice"] {
  return {
    automationId: randomUUID(),
    executionId: randomUUID(),
    occurrenceId: randomUUID(),
    category: "schedule",
    sourceKind: "clock",
    message: "Automation says hello",
  }
}

function deps(params: {
  participants: ChatParticipantRow[]
  created: CreateConversationItemInput[]
  returnedItem?: ChatConversationItem
}): CreateConversationEventDeps {
  return {
    listConversationParticipants: async () => params.participants,
    createConversationItem: async (input) => {
      params.created.push(input)
      return params.returnedItem ?? eventItem(input)
    },
  }
}

test("createConversationEventUseCase maps shared event context to active actor participants", async () => {
  const queryable = {} as Executor
  const conversationId = randomUUID()
  const activeActorId = randomUUID()
  const created: CreateConversationItemInput[] = []

  const result = await createConversationEventUseCase(
    {
      workspaceId: randomUUID(),
      conversationId,
      eventType: "automation_notice",
      eventPayload: automationPayload(),
      metadata: { source: "test" },
      queryable,
    },
    deps({
      created,
      participants: [
        participant({
          id: randomUUID(),
          conversationId,
          state: "active",
          workspaceMemberId: randomUUID(),
        }),
        participant({
          id: activeActorId,
          conversationId,
          state: "active",
          actorId: randomUUID(),
        }),
        participant({
          id: randomUUID(),
          conversationId,
          state: "removed",
          actorId: randomUUID(),
        }),
      ],
    })
  )

  assert.equal(result.timelinePolicy, "all_members")
  assert.equal(result.contextPolicy, "shared")
  assert.deepEqual(result.timelineTargetParticipantIds, [])
  assert.deepEqual(result.contextTargetParticipantIds, [activeActorId])
  assert.equal(result.timelineContent, "Automation says hello")
  assert.equal(created.length, 1)

  const call = created[0]!
  assert.equal(call.queryable, queryable)
  assert.equal(call.scope, CONVERSATION_ITEM_SCOPE.SHARED)
  assert.equal(call.surface, CONVERSATION_ITEM_SURFACE.VISIBLE)
  assert.equal(call.itemType, CONVERSATION_ITEM_TYPE.EVENT)
  assert.equal(call.subtype, "automation_notice")
  assert.equal(call.role, CONVERSATION_ITEM_ROLE.SYSTEM)
  assert.deepEqual(call.contextTargetParticipantIds, [activeActorId])
})

test("createConversationEventUseCase preserves explicit targeted event audiences", async () => {
  const conversationId = randomUUID()
  const targetA = randomUUID()
  const targetB = randomUUID()
  const contextTarget = randomUUID()
  const created: CreateConversationItemInput[] = []

  const result = await createConversationEventUseCase(
    {
      conversationId,
      eventType: "automation_notice",
      eventPayload: automationPayload(),
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [targetA, targetA, targetB],
      contextTargetParticipantIds: [contextTarget, contextTarget],
      queryable: {} as Executor,
    },
    deps({
      created,
      participants: [
        participant({
          id: targetA,
          conversationId,
          state: "active",
          workspaceMemberId: randomUUID(),
        }),
      ],
    })
  )

  assert.deepEqual(result.timelineTargetParticipantIds, [targetA, targetB])
  assert.deepEqual(result.contextTargetParticipantIds, [contextTarget])
  assert.deepEqual(created[0]!.restrictedAudienceParticipantIds, [
    targetA,
    targetB,
  ])
  assert.deepEqual(created[0]!.contextTargetParticipantIds, [contextTarget])
})

test("createConversationEventUseCase stores timeline-none events as internal items", async () => {
  const created: CreateConversationItemInput[] = []

  await createConversationEventUseCase(
    {
      conversationId: randomUUID(),
      eventType: "task_notice",
      eventPayload: {
        taskId: randomUUID(),
        summary: "Tool completed",
        toolName: "demo_tool",
        status: "completed",
      },
      contextTargetParticipantIds: [randomUUID()],
      queryable: {} as Executor,
    },
    deps({ created, participants: [] })
  )

  assert.equal(created[0]!.surface, CONVERSATION_ITEM_SURFACE.INTERNAL)
  assert.equal(created[0]!.eventTimelinePolicy, "none")
  assert.equal(created[0]!.eventContextPolicy, "actor_private")
})

test("createConversationEventUseCase rejects non-event item results", async () => {
  const returnedItem = {
    id: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
    subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    role: "user",
    scope: CONVERSATION_ITEM_SCOPE.SHARED,
    surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
    content: "not event",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "not event" }],
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
  } as ChatConversationItem

  await assert.rejects(
    () =>
      createConversationEventUseCase(
        {
          conversationId: randomUUID(),
          eventType: "automation_notice",
          eventPayload: automationPayload(),
          queryable: {} as Executor,
        },
        deps({ created: [], participants: [], returnedItem })
      ),
    /Expected event item/
  )
})

test("updateConversationItemEventPayloadUseCase delegates event payload mutation", async () => {
  const queryable = {} as Executor
  const itemId = randomUUID()
  const payload: ConversationFeedEventPayloadMap["task_notice"] = {
    taskId: randomUUID(),
    summary: "Tool completed",
    toolName: "demo_tool",
    status: "completed",
  }
  const calls: Array<{
    queryable: Executor
    itemId: string
    payload: unknown
  }> = []

  await updateConversationItemEventPayloadUseCase(
    {
      itemId,
      payload,
      queryable,
    },
    {
      updateConversationItemEventPayload: async (...args) => {
        calls.push({
          queryable: args[0],
          itemId: args[1],
          payload: args[2],
        })
      },
    }
  )

  assert.deepEqual(calls, [
    {
      queryable,
      itemId,
      payload,
    },
  ])
})
