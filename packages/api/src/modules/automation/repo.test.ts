import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeAutomationEventSourceMetadata,
  decodeAutomationTriggerMatcher,
  normalizeAutomationDeliveryRow,
  normalizeAutomationEventSourceRow,
  normalizeAutomationExecutionWithOccurrenceRow,
  normalizeAutomationOccurrenceRow,
  normalizeAutomationPolicyRow,
  normalizeAutomationRuleRow,
  normalizeAutomationTriggerRow,
  normalizeAutomationWebhookEndpointRow,
} from "./repo.js"
import type {
  AutomationDeliveryDbRow,
  AutomationEventSourceDbRow,
  AutomationExecutionWithOccurrenceDbRow,
  AutomationOccurrenceDbRow,
  AutomationPolicyDbRow,
  AutomationRuleDbRow,
  AutomationTriggerDbRow,
  AutomationWebhookEndpointDbRow,
} from "./repo.types.js"

test("decodeAutomationEventSourceMetadata decodes JSONB metadata at repo exit", () => {
  const metadata = decodeAutomationEventSourceMetadata({
    metadata: JSON.stringify({
      provider: "github",
      labels: ["incident"],
    }),
  })

  assert.deepEqual(metadata, {
    provider: "github",
    labels: ["incident"],
  })
})

test("decodeAutomationEventSourceMetadata accepts object metadata without shape loss", () => {
  const metadata = decodeAutomationEventSourceMetadata({
    metadata: {
      targetKind: "repository",
      targetId: "synapse",
    },
  })

  assert.deepEqual(metadata, {
    targetKind: "repository",
    targetId: "synapse",
  })
})

test("decodeAutomationTriggerMatcher normalizes non-object matcher JSON", () => {
  assert.deepEqual(
    decodeAutomationTriggerMatcher({
      matcher: JSON.stringify(["not", "an", "object"]),
    }),
    {}
  )
})

test("automation rule/policy/delivery rows decode metadata at repo exit", () => {
  assert.deepEqual(
    normalizeAutomationRuleRow({
      metadata: JSON.stringify({ rule: true }),
    } as AutomationRuleDbRow).metadata,
    { rule: true }
  )
  assert.deepEqual(
    normalizeAutomationPolicyRow({
      metadata: JSON.stringify({ policy: "active" }),
    } as AutomationPolicyDbRow).metadata,
    { policy: "active" }
  )
  assert.deepEqual(
    normalizeAutomationDeliveryRow({
      metadata: JSON.stringify({ delivery: "chat" }),
    } as AutomationDeliveryDbRow).metadata,
    { delivery: "chat" }
  )
})

test("automation trigger rows decode matcher and metadata at repo exit", () => {
  const row = normalizeAutomationTriggerRow({
    matcher: JSON.stringify({ labels: ["incident"] }),
    metadata: JSON.stringify({ source: "github" }),
  } as AutomationTriggerDbRow)

  assert.deepEqual(row.matcher, { labels: ["incident"] })
  assert.deepEqual(row.metadata, { source: "github" })
})

test("automation event-source rows decode payload records at repo exit", () => {
  const row = normalizeAutomationEventSourceRow({
    payload_schema: JSON.stringify({ type: "object" }),
    example_payload: JSON.stringify({ issue: 123 }),
    metadata: JSON.stringify({ provider: "github" }),
  } as AutomationEventSourceDbRow)

  assert.deepEqual(row.payload_schema, { type: "object" })
  assert.deepEqual(row.example_payload, { issue: 123 })
  assert.deepEqual(row.metadata, { provider: "github" })
})

test("automation occurrence rows decode source snapshot and payload at repo exit", () => {
  const row = normalizeAutomationOccurrenceRow({
    source_snapshot: JSON.stringify({ ruleName: "Escalate" }),
    payload: JSON.stringify({ severity: "critical" }),
  } as AutomationOccurrenceDbRow)

  assert.deepEqual(row.source_snapshot, { ruleName: "Escalate" })
  assert.deepEqual(row.payload, { severity: "critical" })
})

test("automation execution joined occurrence rows decode occurrence JSON at repo exit", () => {
  const row = normalizeAutomationExecutionWithOccurrenceRow({
    source_snapshot: JSON.stringify({ source: "cron" }),
    payload: JSON.stringify({ count: 1 }),
  } as AutomationExecutionWithOccurrenceDbRow)

  assert.deepEqual(row.source_snapshot, { source: "cron" })
  assert.deepEqual(row.payload, { count: 1 })
})

test("automation webhook endpoint rows decode metadata at repo exit", () => {
  assert.deepEqual(
    normalizeAutomationWebhookEndpointRow({
      metadata: JSON.stringify({ channel: "alerts" }),
    } as AutomationWebhookEndpointDbRow).metadata,
    { channel: "alerts" }
  )
})
