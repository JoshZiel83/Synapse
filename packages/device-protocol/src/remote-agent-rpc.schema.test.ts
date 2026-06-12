// Lock the remote-agent daemon↔API machine RPC contracts (camelCase). These
// schemas are the single source for the API /api/v1/internal/* route parsers
// (packages/api/src/modules/remote-agents/controller.ts) and the daemon's
// outbound request bodies (packages/remote-agent-daemon/src/index.ts uses the
// inferred *Body types via `satisfies`). Round-6 P1-5 consolidated what used to
// be API-local zod schemas + daemon hand-built JSON literals into this file.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  RemoteAgentUserInputTaskBodySchema,
  RemoteAgentPlanApprovalTaskBodySchema,
  RemoteAgentSendMessageBodySchema,
  RemoteAgentCompleteDeliveriesBodySchema,
  RemoteAgentFailDeliveriesBodySchema,
  RemoteAgentHistoryQuerySchema,
  RemoteAgentCheckMessagesQuerySchema,
  RemoteAgentSearchMessagesQuerySchema,
} from "./schemas.js"

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010"
const DELIVERY_ID = "00000000-0000-4000-8000-000000000011"

test("RemoteAgentUserInputTaskBodySchema accepts the daemon's user-input body", () => {
  const parsed = RemoteAgentUserInputTaskBodySchema.parse({
    conversationId: CONVERSATION_ID,
    runKey: "remote-agent:abc:user-input:xyz",
    title: "Need input",
    questions: [{ id: "q1", text: "Proceed?" }],
  })
  assert.equal(parsed.conversationId, CONVERSATION_ID)
  assert.equal(parsed.questions.length, 1)
})

test("RemoteAgentUserInputTaskBodySchema rejects an empty questions array", () => {
  assert.throws(() =>
    RemoteAgentUserInputTaskBodySchema.parse({
      conversationId: CONVERSATION_ID,
      runKey: "rk",
      title: "t",
      questions: [],
    })
  )
})

test("RemoteAgentPlanApprovalTaskBodySchema accepts the daemon's plan body", () => {
  const parsed = RemoteAgentPlanApprovalTaskBodySchema.parse({
    conversationId: CONVERSATION_ID,
    runKey: "rk",
    title: "Plan",
    summary: "do things",
    planMarkdown: "# Plan\n- step",
    checklist: [{ id: "c1", text: "step", done: false }],
  })
  assert.equal(parsed.planMarkdown.startsWith("# Plan"), true)
})

test("RemoteAgentPlanApprovalTaskBodySchema requires non-empty planMarkdown", () => {
  assert.throws(() =>
    RemoteAgentPlanApprovalTaskBodySchema.parse({
      conversationId: CONVERSATION_ID,
      runKey: "rk",
      title: "t",
      planMarkdown: "",
    })
  )
})

test("RemoteAgentSendMessageBodySchema accepts a send body with content blocks", () => {
  const parsed = RemoteAgentSendMessageBodySchema.parse({
    conversationId: CONVERSATION_ID,
    contentBlocks: [{ type: "text", text: "hi" }],
  })
  assert.equal(parsed.contentBlocks.length, 1)
})

test("RemoteAgentCompleteDeliveriesBodySchema requires at least one delivery id", () => {
  const parsed = RemoteAgentCompleteDeliveriesBodySchema.parse({
    deliveryIds: [DELIVERY_ID],
  })
  assert.equal(parsed.deliveryIds[0], DELIVERY_ID)
  assert.throws(() =>
    RemoteAgentCompleteDeliveriesBodySchema.parse({ deliveryIds: [] })
  )
})

test("RemoteAgentFailDeliveriesBodySchema accepts an optional reason", () => {
  const parsed = RemoteAgentFailDeliveriesBodySchema.parse({
    deliveryIds: [DELIVERY_ID],
    reason: "boom",
  })
  assert.equal(parsed.reason, "boom")
})

test("RemoteAgentHistoryQuerySchema coerces numeric query strings", () => {
  const parsed = RemoteAgentHistoryQuerySchema.parse({
    afterSequence: "5",
    limit: "50",
  })
  assert.equal(parsed.afterSequence, 5)
  assert.equal(parsed.limit, 50)
})

test("RemoteAgentCheckMessagesQuerySchema caps the limit", () => {
  assert.throws(() =>
    RemoteAgentCheckMessagesQuerySchema.parse({ limit: "9999" })
  )
})

test("RemoteAgentSearchMessagesQuerySchema requires a query string", () => {
  const parsed = RemoteAgentSearchMessagesQuerySchema.parse({
    conversationId: CONVERSATION_ID,
    q: "needle",
  })
  assert.equal(parsed.q, "needle")
  assert.throws(() =>
    RemoteAgentSearchMessagesQuerySchema.parse({
      conversationId: CONVERSATION_ID,
      q: "",
    })
  )
})
