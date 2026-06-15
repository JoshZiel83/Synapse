import test from "node:test"
import assert from "node:assert/strict"
import {
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type { ConversationFeedItem } from "@synapse/shared/types"
import type { EnqueueSessionWakeupParams } from "../session/runtime.js"
import { retryAssistantMessageUseCase } from "./retry-message.js"

test("retryAssistantMessageUseCase enqueues retry wakeup from workspace member identity", async () => {
  const conversationId = "00000000-0000-0000-0000-000000000001"
  const itemId = "00000000-0000-0000-0000-000000000002"
  const actorId = "00000000-0000-0000-0000-000000000003"
  const sessionId = "00000000-0000-0000-0000-000000000004"
  const workspaceId = "00000000-0000-0000-0000-000000000005"
  const workspaceMemberId = "00000000-0000-0000-0000-000000000006"
  const participantId = "00000000-0000-0000-0000-000000000007"
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
      getConversationFeedItemById: async () =>
        ({
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
        }) satisfies ConversationFeedItem,
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
