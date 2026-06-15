import test from "node:test"
import assert from "node:assert/strict"
import {
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_MESSAGE_SUBTYPE,
} from "@synapse/shared"
import {
  assertConversationMessageSubtype,
  isConversationMessageSubtype,
  normalizeConversationItemSubtype,
} from "./conversation-item-detail.js"

test("isConversationMessageSubtype accepts shared message subtypes", () => {
  assert.equal(
    isConversationMessageSubtype(CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE),
    true
  )
  assert.equal(isConversationMessageSubtype("not_a_message"), false)
})

test("assertConversationMessageSubtype rejects unsupported message subtypes", () => {
  assert.doesNotThrow(() =>
    assertConversationMessageSubtype(CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE)
  )
  assert.throws(
    () => assertConversationMessageSubtype("not_a_message"),
    /Unsupported conversation message subtype/
  )
})

test("normalizeConversationItemSubtype validates message, summary, and event subtypes", () => {
  assert.equal(
    normalizeConversationItemSubtype(
      CONVERSATION_ITEM_TYPE.MESSAGE,
      CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
      "item-message"
    ),
    CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE
  )
  assert.equal(
    normalizeConversationItemSubtype(
      CONVERSATION_ITEM_TYPE.SUMMARY,
      CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY,
      "item-summary"
    ),
    CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY
  )
  assert.equal(
    normalizeConversationItemSubtype(
      CONVERSATION_ITEM_TYPE.EVENT,
      "participant_joined",
      "item-event"
    ),
    "participant_joined"
  )
})

test("normalizeConversationItemSubtype rejects invalid summary and event subtypes", () => {
  assert.throws(
    () =>
      normalizeConversationItemSubtype(
        CONVERSATION_ITEM_TYPE.SUMMARY,
        CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
        "item-summary"
      ),
    /Unsupported conversation summary subtype/
  )
  assert.throws(
    () =>
      normalizeConversationItemSubtype(
        CONVERSATION_ITEM_TYPE.EVENT,
        "not_an_event",
        "item-event"
      ),
    /Unsupported conversation event subtype/
  )
})
