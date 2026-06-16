import test from "node:test"
import assert from "node:assert/strict"
import {
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { ConversationFeedItem } from "@synapse/shared/types"
import type { EnqueueSessionWakeupParams } from "../session/runtime.js"
import { isChatServiceError } from "./errors.js"
import { retryAssistantMessageUseCase } from "./retry-message.js"

const conversationId = "00000000-0000-0000-0000-000000000001"
const itemId = "00000000-0000-0000-0000-000000000002"
const actorId = "00000000-0000-0000-0000-000000000003"
const sessionId = "00000000-0000-0000-0000-000000000004"
const workspaceId = "00000000-0000-0000-0000-000000000005"
const workspaceMemberId = "00000000-0000-0000-0000-000000000006"
const participantId = "00000000-0000-0000-0000-000000000007"

type ConversationFeedMessageItem = Extract<
  ConversationFeedItem,
  { kind: "message" }
>

function retryableItem(
  values: Partial<ConversationFeedMessageItem> = {}
): ConversationFeedMessageItem {
  return {
    kind: "message",
    conversationId,
    itemId,
    sequence: 1,
    role: "assistant",
    messageType: CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE,
    metadata: { retrySessionId: sessionId },
    author: {
      participantType: CONVERSATION_PARTICIPANT_TYPE.ACTOR,
      actorId,
    },
    content: "",
    contentBlocks: [],
    createdAt: "2026-06-15T00:00:00.000Z",
    ...values,
  } satisfies ConversationFeedMessageItem
}

test("retryAssistantMessageUseCase enqueues retry wakeup from workspace member identity", async () => {
  const wakeups: EnqueueSessionWakeupParams[] = []

  const result = await retryAssistantMessageUseCase(
    {
      workspaceId,
      workspaceMemberId,
      conversationId,
      itemId,
    },
    {
      requireConversationAccess: async () => ({
        participant: { id: participantId, userName: "Retry User" },
      }),
      getConversationFeedItemById: async () => retryableItem(),
      enqueueSessionWakeup: async (params) => {
        wakeups.push(params)
      },
    }
  )

  assert.deepEqual(result, {
    retryEnqueued: true,
    sessionId,
    actorId,
  })
  assert.equal(wakeups.length, 1)
  assert.deepEqual(wakeups[0], {
    sessionId,
    actorId,
    workspaceId,
    sourceType: "user_message",
    sourceItemId: itemId,
    sourceParticipantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    sourceParticipantId: workspaceMemberId,
    sourceName: "Retry User",
    summary: "user requested retry of failed assistant turn",
    metadata: {
      source: "chat.message_retry",
      retryItemId: itemId,
      conversationId,
      retryByParticipantId: participantId,
    },
    trigger: "user_message",
  })
})

test("retryAssistantMessageUseCase stops before item lookup when access fails", async () => {
  const calls: string[] = []

  await assert.rejects(
    () =>
      retryAssistantMessageUseCase(
        {
          workspaceId,
          workspaceMemberId,
          conversationId,
          itemId,
        },
        {
          requireConversationAccess: async () => {
            calls.push("access")
            throw new Error("access denied")
          },
          getConversationFeedItemById: async () => {
            calls.push("item")
            return retryableItem()
          },
          enqueueSessionWakeup: async () => {
            calls.push("wakeup")
          },
        }
      ),
    /access denied/
  )

  assert.deepEqual(calls, ["access"])
})

test("retryAssistantMessageUseCase does not enqueue wakeup for non-retryable items", async () => {
  const wakeups: EnqueueSessionWakeupParams[] = []

  await assert.rejects(
    () =>
      retryAssistantMessageUseCase(
        {
          workspaceId,
          workspaceMemberId,
          conversationId,
          itemId,
        },
        {
          requireConversationAccess: async () => ({
            participant: { id: participantId, userName: "Retry User" },
          }),
          getConversationFeedItemById: async () =>
            retryableItem({
              messageType: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
            }),
          enqueueSessionWakeup: async (params) => {
            wakeups.push(params)
          },
        }
      ),
    (error) =>
      isChatServiceError(error) &&
      error.statusCode === 400 &&
      error.code === "item_not_retryable"
  )

  assert.deepEqual(wakeups, [])
})
