import test from "node:test"
import assert from "node:assert/strict"

import {
  buildAutomationRuleCreatePayloadFromDraft,
  createEmptyAutomationRuleDraft,
  parseAutomationJsonObjectText,
} from "./rule-contract.js"

test("parseAutomationJsonObjectText accepts object JSON and empty input", () => {
  assert.deepEqual(
    parseAutomationJsonObjectText('{"level":"info"}', "matcher"),
    {
      level: "info",
    }
  )
  assert.deepEqual(parseAutomationJsonObjectText("  ", "matcher"), {})
})

test("parseAutomationJsonObjectText rejects non-object JSON", () => {
  assert.throws(
    () => parseAutomationJsonObjectText("[1,2,3]", "matcher"),
    /matcher must be a JSON object/
  )
  assert.throws(
    () => parseAutomationJsonObjectText('"text"', "metadata"),
    /metadata must be a JSON object/
  )
  assert.throws(
    () => parseAutomationJsonObjectText("null", "matcher"),
    /matcher must be a JSON object/
  )
})

test("buildAutomationRuleCreatePayloadFromDraft fails closed on matcher array", () => {
  const draft = createEmptyAutomationRuleDraft()
  draft.name = "Event rule"
  draft.conversationId = "conversation-1"
  draft.triggerKind = "event"
  draft.eventSourceId = "source-1"
  draft.matcherText = "[]"
  draft.message = "Notify"

  const result = buildAutomationRuleCreatePayloadFromDraft(draft)

  assert.equal(result.ok, false)
  assert.equal(result.error, "matcher must be a JSON object")
  assert.deepEqual(result.issues, [
    { path: "draft", message: "matcher must be a JSON object" },
  ])
})
