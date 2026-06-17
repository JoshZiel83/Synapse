import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import type {
  ConversationEntityRef,
  ConversationFeedEventItem,
  ConversationFeedMessageItem,
} from "@synapse/shared/types"
import { isFeedItemVisibleToWorkspaceMember } from "./conversation-feed-visibility.js"

function entity(workspaceMemberId: string): ConversationEntityRef {
  return {
    participantId: randomUUID(),
    participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
    workspaceMemberId,
    name: "member",
  }
}

function message(
  values: Partial<ConversationFeedMessageItem> = {}
): ConversationFeedMessageItem {
  return {
    kind: "message",
    itemId: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    role: "assistant",
    messageType: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    content: "hello",
    contentBlocks: [{ id: randomUUID(), type: "text", text: "hello" }],
    metadata: {},
    createdAt: "2026-06-16T00:00:00.000Z",
    ...values,
  }
}

function event(
  values: Partial<ConversationFeedEventItem> = {}
): ConversationFeedEventItem {
  return {
    kind: "event",
    itemId: randomUUID(),
    conversationId: randomUUID(),
    sequence: 1,
    eventType: "participant_joined",
    payload: {
      participantId: randomUUID(),
      participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
      name: "member",
      roleKey: "member",
    },
    createdAt: "2026-06-16T00:00:00.000Z",
    ...values,
  } as ConversationFeedEventItem
}

test("isFeedItemVisibleToWorkspaceMember keeps normal messages visible", () => {
  assert.equal(
    isFeedItemVisibleToWorkspaceMember(message(), randomUUID()),
    true
  )
})

test("isFeedItemVisibleToWorkspaceMember restricts model error messages", () => {
  const visibleMemberId = randomUUID()
  const hiddenMemberId = randomUUID()
  const item = message({
    messageType: CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE,
    restrictedAudience: [entity(visibleMemberId)],
  })

  assert.equal(isFeedItemVisibleToWorkspaceMember(item, visibleMemberId), true)
  assert.equal(isFeedItemVisibleToWorkspaceMember(item, hiddenMemberId), false)
})

test("isFeedItemVisibleToWorkspaceMember keeps authors visible for restricted items", () => {
  const authorMemberId = randomUUID()
  assert.equal(
    isFeedItemVisibleToWorkspaceMember(
      message({
        messageType: CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE,
        author: entity(authorMemberId),
        restrictedAudience: [entity(randomUUID())],
      }),
      authorMemberId
    ),
    true
  )
  assert.equal(
    isFeedItemVisibleToWorkspaceMember(
      event({
        author: entity(authorMemberId),
        restrictedAudience: [entity(randomUUID())],
      }),
      authorMemberId
    ),
    true
  )
})

test("isFeedItemVisibleToWorkspaceMember restricts event audience", () => {
  const visibleMemberId = randomUUID()
  const hiddenMemberId = randomUUID()
  const item = event({ restrictedAudience: [entity(visibleMemberId)] })

  assert.equal(isFeedItemVisibleToWorkspaceMember(item, visibleMemberId), true)
  assert.equal(isFeedItemVisibleToWorkspaceMember(item, hiddenMemberId), false)
})
