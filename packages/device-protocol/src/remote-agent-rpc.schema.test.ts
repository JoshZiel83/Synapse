// Lock the remote-agent daemon↔API machine RPC contracts (snake_case wire). These
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
  RemoteAgentMcpListConversationsToolInputSchema,
  RemoteAgentMcpCheckMessagesToolInputSchema,
  RemoteAgentMcpReadHistoryToolInputSchema,
  RemoteAgentMcpSendMessageToolInputSchema,
  RemoteAgentMcpSearchMessagesToolInputSchema,
} from "./schemas.js"

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010"
const DELIVERY_ID = "00000000-0000-4000-8000-000000000011"

test("RemoteAgentUserInputTaskBodySchema accepts the daemon's user-input body", () => {
  const parsed = RemoteAgentUserInputTaskBodySchema.parse({
    conversation_id: CONVERSATION_ID,
    run_key: "remote-agent:abc:user-input:xyz",
    title: "Need input",
    questions: [{ id: "q1", text: "Proceed?" }],
  })
  assert.equal(parsed.conversation_id, CONVERSATION_ID)
  assert.equal(parsed.questions.length, 1)
})

test("RemoteAgentUserInputTaskBodySchema rejects camelCase machine fields", () => {
  assert.throws(() =>
    RemoteAgentUserInputTaskBodySchema.parse({
      conversationId: CONVERSATION_ID,
      runKey: "remote-agent:abc:user-input:xyz",
      title: "Need input",
      questions: [{ id: "q1", text: "Proceed?" }],
    })
  )
})

test("RemoteAgentUserInputTaskBodySchema rejects an empty questions array", () => {
  assert.throws(() =>
    RemoteAgentUserInputTaskBodySchema.parse({
      conversation_id: CONVERSATION_ID,
      run_key: "rk",
      title: "t",
      questions: [],
    })
  )
})

test("RemoteAgentPlanApprovalTaskBodySchema accepts the daemon's plan body", () => {
  const parsed = RemoteAgentPlanApprovalTaskBodySchema.parse({
    conversation_id: CONVERSATION_ID,
    run_key: "rk",
    title: "Plan",
    summary: "do things",
    plan_markdown: "# Plan\n- step",
    checklist: [{ id: "c1", text: "step", done: false }],
  })
  assert.equal(parsed.plan_markdown.startsWith("# Plan"), true)
})

test("RemoteAgentPlanApprovalTaskBodySchema requires non-empty plan_markdown", () => {
  assert.throws(() =>
    RemoteAgentPlanApprovalTaskBodySchema.parse({
      conversation_id: CONVERSATION_ID,
      run_key: "rk",
      title: "t",
      plan_markdown: "",
    })
  )
})

test("RemoteAgentSendMessageBodySchema accepts a send body with content blocks", () => {
  const parsed = RemoteAgentSendMessageBodySchema.parse({
    conversation_id: CONVERSATION_ID,
    content_blocks: [{ type: "text", text: "hi" }],
  })
  assert.equal(parsed.content_blocks.length, 1)
})

test("RemoteAgentCompleteDeliveriesBodySchema requires at least one delivery id", () => {
  const parsed = RemoteAgentCompleteDeliveriesBodySchema.parse({
    delivery_ids: [DELIVERY_ID],
  })
  assert.equal(parsed.delivery_ids[0], DELIVERY_ID)
  assert.throws(() =>
    RemoteAgentCompleteDeliveriesBodySchema.parse({ delivery_ids: [] })
  )
})

test("RemoteAgentFailDeliveriesBodySchema accepts per-delivery carriers and an optional reason", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const parsed = RemoteAgentFailDeliveriesBodySchema.parse({
    deliveries: [
      { delivery_id: DELIVERY_ID, traceparent: TP, tracestate: "es=s:1.0" },
      { delivery_id: "00000000-0000-4000-8000-000000000012" },
    ],
    reason: "boom",
  })
  assert.equal(parsed.reason, "boom")
  assert.equal(parsed.deliveries[0]!.traceparent, TP)
  assert.equal(parsed.deliveries[0]!.tracestate, "es=s:1.0")
  assert.equal(parsed.deliveries[1]!.traceparent, undefined)
})

test("RemoteAgentFailDeliveriesBodySchema rejects the retired delivery_ids shape and empty batches", () => {
  assert.throws(() =>
    RemoteAgentFailDeliveriesBodySchema.parse({ delivery_ids: [DELIVERY_ID] })
  )
  assert.throws(() =>
    RemoteAgentFailDeliveriesBodySchema.parse({ deliveries: [] })
  )
})

test("RemoteAgentFailDeliveriesBodySchema degrades malformed trace fields without dropping the delivery", () => {
  const parsed = RemoteAgentFailDeliveriesBodySchema.parse({
    deliveries: [
      {
        delivery_id: DELIVERY_ID,
        traceparent: "not-a-traceparent",
        tracestate: "x".repeat(2000),
      },
    ],
  })
  assert.equal(parsed.deliveries.length, 1)
  assert.equal(parsed.deliveries[0]!.delivery_id, DELIVERY_ID)
  assert.equal(parsed.deliveries[0]!.traceparent, undefined)
  assert.equal(parsed.deliveries[0]!.tracestate, undefined)
})

test("RemoteAgentHistoryQuerySchema coerces numeric query strings", () => {
  const parsed = RemoteAgentHistoryQuerySchema.parse({
    after_sequence: "5",
    limit: "50",
  })
  assert.equal(parsed.after_sequence, 5)
  assert.equal(parsed.limit, 50)
})

test("RemoteAgentCheckMessagesQuerySchema caps the limit", () => {
  assert.throws(() =>
    RemoteAgentCheckMessagesQuerySchema.parse({ limit: "9999" })
  )
})

test("RemoteAgentSearchMessagesQuerySchema requires a query string", () => {
  const parsed = RemoteAgentSearchMessagesQuerySchema.parse({
    conversation_id: CONVERSATION_ID,
    q: "needle",
  })
  assert.equal(parsed.q, "needle")
  assert.throws(() =>
    RemoteAgentSearchMessagesQuerySchema.parse({
      conversation_id: CONVERSATION_ID,
      q: "",
    })
  )
})

test("RemoteAgentMcpListConversationsToolInputSchema is strict-empty", () => {
  assert.deepEqual(RemoteAgentMcpListConversationsToolInputSchema.parse({}), {})
  assert.throws(() =>
    RemoteAgentMcpListConversationsToolInputSchema.parse({ limit: 1 })
  )
})

test("RemoteAgentMcpCheckMessagesToolInputSchema caps limit", () => {
  const parsed = RemoteAgentMcpCheckMessagesToolInputSchema.parse({ limit: 50 })
  assert.equal(parsed.limit, 50)
  assert.throws(() =>
    RemoteAgentMcpCheckMessagesToolInputSchema.parse({ limit: 9999 })
  )
})

test("RemoteAgentMcpReadHistoryToolInputSchema accepts snake_case and rejects camelCase", () => {
  const parsed = RemoteAgentMcpReadHistoryToolInputSchema.parse({
    after_sequence: 5,
    before_sequence: 10,
    limit: 20,
  })
  assert.equal(parsed.after_sequence, 5)
  assert.equal(parsed.before_sequence, 10)
  assert.throws(() =>
    RemoteAgentMcpReadHistoryToolInputSchema.parse({
      afterSequence: 5,
      beforeSequence: 10,
    })
  )
})

test("RemoteAgentMcpSendMessageToolInputSchema accepts snake_case reply id and rejects camelCase", () => {
  const parsed = RemoteAgentMcpSendMessageToolInputSchema.parse({
    content: "hello",
    reply_to_item_id: DELIVERY_ID,
  })
  assert.equal(parsed.reply_to_item_id, DELIVERY_ID)
  assert.throws(() =>
    RemoteAgentMcpSendMessageToolInputSchema.parse({
      content: "hello",
      replyToItemId: DELIVERY_ID,
    })
  )
})

test("RemoteAgentMcpSearchMessagesToolInputSchema requires query", () => {
  const parsed = RemoteAgentMcpSearchMessagesToolInputSchema.parse({
    query: "needle",
    limit: 10,
  })
  assert.equal(parsed.query, "needle")
  assert.throws(() =>
    RemoteAgentMcpSearchMessagesToolInputSchema.parse({ query: "" })
  )
})
