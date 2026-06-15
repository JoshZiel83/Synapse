import assert from "node:assert/strict"
import test from "node:test"
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_CREATOR_KIND,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_RULE_CATEGORY,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  CONVERSATION_KIND,
  INVITE_TRUST_LEVELS,
  SUBJECT_KIND,
  parseJsonObject,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  decodeAutomationEventSourceMetadata,
  decodeAutomationTriggerMatcher,
  insertAutomationDeliveryRow,
  insertAutomationEventSourceRow,
  insertAutomationPolicyRow,
  insertAutomationRuleRow,
  insertAutomationTriggerRow,
  listActiveEventSubscriptionRuleRowsByEventSource,
  loadAutomationRuleComponentRows,
  lockDueAutomationScheduleRows,
  normalizeAutomationDeliveryRow,
  normalizeAutomationEventSourceRow,
  normalizeAutomationExecutionWithOccurrenceRow,
  normalizeAutomationOccurrenceRow,
  normalizeAutomationPolicyRow,
  normalizeAutomationRuleRow,
  normalizeAutomationTriggerRow,
  normalizeAutomationWebhookEndpointRow,
  pauseAutomationRuleRowsForEventSource,
  persistAutomationDeliveryTargets,
  updateAutomationTriggerRow,
} from "./repo.js"
import type {
  AutomationDeliveryDbRow,
  AutomationEventSourceDbRow,
  AutomationExecutionWithOccurrenceDbRow,
  AutomationOccurrenceDbRow,
  AutomationPolicyDbRow,
  AutomationRuleDbRow,
  AutomationTriggerDbRow,
  AutomationTriggerRow,
  AutomationWebhookEndpointDbRow,
} from "./repo.types.js"

type AnyDb = import("kysely").Kysely<any>

async function insertAutomationRuleFixture(db: AnyDb) {
  const user = await db
    .insertInto("users")
    .values({
      email: `automation-${crypto.randomUUID()}@example.test`,
      name: "automation repo test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const workspace = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id,
      slug: `automation-${crypto.randomUUID()}`,
      name: "automation repo test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspace.id,
      userId: user.id,
      trustLevel: INVITE_TRUST_LEVELS[1],
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const conversation = await db
    .insertInto("conversations")
    .values({
      workspaceId: workspace.id,
      kind: CONVERSATION_KIND.GROUP,
      title: "automation repo test conversation",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: member.id as string,
  })

  const participant = await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversation.id,
      subjectId,
      displayName: "automation repo test participant",
      roleKey: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    memberId: member.id as string,
    workspaceId: workspace.id as string,
    conversationId: conversation.id as string,
    participantId: participant.id as string,
  }
}

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

test(
  "automation repo helpers own rule trigger writes and delivery targets",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, conversationId, participantId } =
        await insertAutomationRuleFixture(db)
      const ruleId = crypto.randomUUID()
      const dueAt = new Date(Date.now() - 60_000)

      await insertAutomationRuleRow(db, {
        id: ruleId,
        workspaceId,
        conversationId,
        category: AUTOMATION_RULE_CATEGORY.SCHEDULE,
        status: AUTOMATION_RULE_STATUSES[0],
        name: "repo helper rule",
        description: "",
        createdByParticipantId: participantId,
        createdBySessionId: null,
        metadata: JSON.stringify({ rule: true }),
      })

      await insertAutomationPolicyRow(db, {
        ruleId,
        activeFrom: null,
        activeUntil: null,
        maxTriggerCount: null,
        triggerCount: 0,
        completionStatus: AUTOMATION_COMPLETION_STATUSES[0],
        completedAt: null,
        metadata: JSON.stringify({ policy: true }),
      })

      const trigger = {
        trigger_kind: AUTOMATION_TRIGGER_KINDS[0],
        source_kind: AUTOMATION_TRIGGER_SOURCE_KINDS[0],
        event_source_id: null,
        source_locator: null,
        match_key: null,
        matcher: { phase: "insert" },
        schedule_kind: AUTOMATION_SCHEDULE_KINDS[0],
        schedule_expr: "* * * * *",
        schedule_timezone: "UTC",
        interval_seconds: null,
        starts_at: null,
        next_fire_at: dueAt,
        last_fired_at: null,
        metadata: { trigger: true },
      } satisfies Omit<AutomationTriggerRow, "rule_id">

      await insertAutomationTriggerRow(db, ruleId, trigger)

      await updateAutomationTriggerRow(db, ruleId, {
        ...trigger,
        matcher: { phase: "update" },
        metadata: { trigger: "updated" },
        schedule_expr: "*/5 * * * *",
      })

      await insertAutomationDeliveryRow(db, {
        ruleId,
        messageText: "notify",
        wakeReasonText: null,
        messageBlocks: JSON.stringify([]),
        targetPolicy: AUTOMATION_TARGET_POLICIES[1],
        metadata: JSON.stringify({ delivery: true }),
      })

      await persistAutomationDeliveryTargets(db, ruleId, [participantId])

      const rule = await db
        .selectFrom("automationRules")
        .select(["createdAt"])
        .where("id", "=", ruleId)
        .executeTakeFirstOrThrow()
      assert.ok(rule.createdAt instanceof Date)

      const storedTrigger = await db
        .selectFrom("automationTriggers")
        .select([
          "matcher",
          "metadata",
          "scheduleExpr",
          "createdAt",
          "updatedAt",
        ])
        .where("ruleId", "=", ruleId)
        .executeTakeFirstOrThrow()

      assert.equal(storedTrigger.scheduleExpr, "*/5 * * * *")
      assert.deepEqual(parseJsonObject(storedTrigger.matcher), {
        phase: "update",
      })
      assert.deepEqual(parseJsonObject(storedTrigger.metadata), {
        trigger: "updated",
      })
      assert.ok(storedTrigger.createdAt instanceof Date)
      assert.ok(storedTrigger.updatedAt instanceof Date)

      const targets = await db
        .selectFrom("automationDeliveryTargets")
        .select(["targetParticipantId", "createdAt"])
        .where("ruleId", "=", ruleId)
        .execute()

      assert.equal(targets.length, 1)
      assert.equal(targets[0]?.targetParticipantId, participantId)
      assert.ok(targets[0]?.createdAt instanceof Date)

      const components = await loadAutomationRuleComponentRows(
        workspaceId,
        [ruleId],
        db
      )
      assert.equal(components.rules.length, 1)
      assert.equal(components.rules[0]?.workspace_id, workspaceId)
      assert.equal(components.triggers[0]?.rule_id, ruleId)
      assert.equal(components.triggers[0]?.schedule_expr, "*/5 * * * *")
      assert.equal(components.policies[0]?.rule_id, ruleId)
      assert.equal(components.deliveries[0]?.rule_id, ruleId)
      assert.deepEqual(components.targetsByRule.get(ruleId), [participantId])

      const dueRows = await lockDueAutomationScheduleRows(db, 10)
      assert.ok(dueRows.length > 0, JSON.stringify(dueRows))
      const dueRow = dueRows.find((row) => row.ruleId === ruleId)
      assert.ok(dueRow, JSON.stringify(dueRows))
      assert.equal(dueRow.ruleName, "repo helper rule")
      assert.equal(dueRow.workspaceId, workspaceId)
      assert.equal(dueRow.scheduleExpr, "*/5 * * * *")
      assert.ok(dueRow.nextFireAt instanceof Date)
    })
  }
)

test(
  "automation repo helpers own event-source rule list and pause queries",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { memberId, workspaceId, conversationId, participantId } =
        await insertAutomationRuleFixture(db)
      const eventSourceId = crypto.randomUUID()
      const ruleId = crypto.randomUUID()
      const pauseReason = "repo helper pause"

      await insertAutomationEventSourceRow(
        {
          id: eventSourceId,
          workspaceId,
          providerKind: AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[2],
          providerRef: null,
          webhookEndpointId: null,
          integrationBindingId: null,
          sourceKey: `repo.${crypto.randomUUID()}`,
          name: "repo helper source",
          description: "",
          recommendedUsage: "",
          payloadSchema: JSON.stringify({}),
          examplePayload: JSON.stringify({}),
          status: AUTOMATION_EVENT_SOURCE_STATUSES[0],
          createdByKind: AUTOMATION_CREATOR_KIND.WORKSPACE_MEMBER,
          createdByWorkspaceMemberId: memberId,
          createdByActorId: null,
          createdBySessionId: null,
          metadata: JSON.stringify({ source: true }),
        },
        db
      )

      await insertAutomationRuleRow(db, {
        id: ruleId,
        workspaceId,
        conversationId,
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        status: AUTOMATION_RULE_STATUSES[0],
        name: "repo helper event rule",
        description: "",
        createdByParticipantId: participantId,
        createdBySessionId: null,
        metadata: JSON.stringify({ rule: true }),
      })

      await insertAutomationTriggerRow(db, ruleId, {
        trigger_kind: AUTOMATION_TRIGGER_KINDS[1],
        source_kind: AUTOMATION_TRIGGER_SOURCE_KINDS[3],
        event_source_id: eventSourceId,
        source_locator: null,
        match_key: "repo-helper",
        matcher: { event: true },
        schedule_kind: null,
        schedule_expr: null,
        schedule_timezone: null,
        interval_seconds: null,
        starts_at: null,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {},
      })

      const activeRows = await listActiveEventSubscriptionRuleRowsByEventSource(
        {
          eventSourceId,
          category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
          executor: db,
        }
      )
      assert.equal(activeRows.length, 1)
      assert.equal(activeRows[0]?.id, ruleId)
      assert.equal(activeRows[0]?.workspace_id, workspaceId)

      const pausedRows = await pauseAutomationRuleRowsForEventSource({
        eventSourceId,
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        reason: pauseReason,
        executor: db,
      })
      assert.deepEqual(pausedRows, [{ id: ruleId, workspaceId }])

      const pausedRule = await db
        .selectFrom("automationRules")
        .select(["status", "lastErrorMessage"])
        .where("id", "=", ruleId)
        .executeTakeFirstOrThrow()
      assert.equal(pausedRule.status, AUTOMATION_RULE_STATUSES[1])
      assert.equal(pausedRule.lastErrorMessage, pauseReason)
    })
  }
)
