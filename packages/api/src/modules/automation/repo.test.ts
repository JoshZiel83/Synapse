import assert from "node:assert/strict"
import test from "node:test"
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_CREATOR_KIND,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_EXECUTION_STATUS,
  AUTOMATION_INTEGRATION_INGRESS_KINDS,
  AUTOMATION_INTEGRATION_PROVIDERS,
  AUTOMATION_INTEGRATION_TARGET_KINDS,
  AUTOMATION_RULE_CATEGORY,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  AUTOMATION_WEBHOOK_ENDPOINT_STATUS,
  CONVERSATION_KIND,
  INVITE_TRUST_LEVELS,
  SUBJECT_KIND,
  parseJsonObject,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  claimPendingAutomationExecutionRow,
  decodeAutomationEventSourceMetadata,
  decodeAutomationTriggerMatcher,
  expireAutomationRuleRows,
  getAutomationEventSourceRow,
  insertAutomationExecutionReturningRow,
  insertAutomationDeliveryRow,
  insertAutomationEventSourceRow,
  insertAutomationOccurrenceReturningRow,
  insertAutomationPolicyRow,
  insertAutomationRuleRow,
  insertAutomationTriggerRow,
  insertAutomationWebhookEndpointReturningRow,
  insertIntegrationBindingRow,
  listAutomationExecutionRows,
  listActiveEventSubscriptionRuleRowsByEventSource,
  listAutomationEventSourceRows,
  listAutomationOccurrenceRows,
  listAutomationRuleIds,
  listAutomationWebhookEndpointRows,
  listIntegrationAutomationEventSourceRowsByWebhookPathToken,
  loadAutomationRuleComponentRows,
  lockDueAutomationScheduleRows,
  normalizeIntegrationInstallationRow,
  normalizeAutomationDeliveryRow,
  normalizeAutomationEventSourceRow,
  normalizeAutomationExecutionWithOccurrenceRow,
  normalizeAutomationOccurrenceRow,
  normalizeAutomationPolicyRow,
  normalizeAutomationRuleRow,
  normalizeAutomationTriggerRow,
  normalizeAutomationWebhookEndpointRow,
  pauseAutomationRuleRowsForEventSource,
  pauseAutomationRuleRowsForInactiveCreators,
  persistAutomationDeliveryTargets,
  selectAutomationOccurrenceRow,
  selectAutomationExecutionRowByRuleOccurrence,
  selectAutomationIntegrationBindingRow,
  selectAutomationOccurrenceRowByDedupeKey,
  selectAutomationWebhookEndpointRow,
  selectExistingAutomationIntegrationBindingRow,
  selectWebhookAutomationEventSourceByPathToken,
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

async function insertPluginInstallationFixture(
  db: AnyDb,
  params: { workspaceId: string; memberId: string }
) {
  const publisher = await db
    .insertInto("publishers")
    .values({
      slug: `automation-pub-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "automation publisher",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalogItems")
    .values({
      publisherId: publisher.id,
      itemKind: "plugin_package",
      slug: `automation-plugin-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "automation plugin",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const version = await db
    .insertInto("catalogVersions")
    .values({
      catalogItemId: item.id,
      version: "1.0.0",
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const installationId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: installationId,
      workspaceId: params.workspaceId,
      kind: "plugin_installation",
      displayName: "automation plugin",
      ownerWorkspaceMemberId: params.memberId,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("pluginInstallations")
    .values({
      id: installationId,
      catalogItemId: item.id,
      catalogVersionId: version.id,
    } as any)
    .execute()
  return installationId
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

test("integration installation rows decode config and spec metadata at repo exit", () => {
  const row = normalizeIntegrationInstallationRow({
    installationId: "installation-1",
    workspaceId: "workspace-1",
    installationStatus: "active",
    configData: JSON.stringify({
      apiKey: "secret",
      baseUrl: "https://gitlab.example.test",
    }),
    orgSlug: "gitlab",
    itemSlug: "gitlab-plugin",
    specMetadata: JSON.stringify({
      integrationProvider: "gitlab",
      setupSteps: ["connect"],
    }),
  })

  assert.deepEqual(row.configData, {
    apiKey: "secret",
    baseUrl: "https://gitlab.example.test",
  })
  assert.deepEqual(row.specMetadata, {
    integrationProvider: "gitlab",
    setupSteps: ["connect"],
  })
})

test("automation repo helpers own webhook endpoint create and list queries", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, memberId } = await insertAutomationRuleFixture(db)
    const endpointId = crypto.randomUUID()
    const row = await insertAutomationWebhookEndpointReturningRow(
      {
        id: endpointId,
        workspaceId,
        name: "repo webhook endpoint",
        status: "active",
        pathToken: `repo-${crypto.randomUUID()}`,
        secretCiphertext: "encrypted-secret",
        secretHint: "hint",
        metadata: { channel: "alerts" },
        createdByWorkspaceMemberId: memberId,
      },
      db
    )

    assert.equal(row.id, endpointId)
    assert.equal(row.workspace_id, workspaceId)
    assert.deepEqual(parseJsonObject(row.metadata), { channel: "alerts" })

    const loaded = await selectAutomationWebhookEndpointRow(endpointId, db)
    assert.equal(loaded?.id, endpointId)
    assert.equal(loaded?.secret_ciphertext, "encrypted-secret")

    const listed = await listAutomationWebhookEndpointRows(workspaceId, db)
    assert.deepEqual(
      listed.map((endpoint) => endpoint.id),
      [endpointId]
    )
  })
})

test("automation repo helpers own integration binding read queries", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, memberId } = await insertAutomationRuleFixture(db)
    const installationId = await insertPluginInstallationFixture(db, {
      workspaceId,
      memberId,
    })
    const bindingId = crypto.randomUUID()
    await insertIntegrationBindingRow(db, {
      id: bindingId,
      workspaceId,
      installationId,
      provider: "github",
      ingressKind: "polling",
      targetKind: "repository",
      targetId: "synapse/test",
      targetLabel: "synapse/test",
      webhookEndpointId: null,
      externalSubscriptionId: "sub-1",
      metadata: JSON.stringify({ source: "repo-test" }),
    })

    const loaded = await selectAutomationIntegrationBindingRow(bindingId, db)
    assert.equal(loaded?.id, bindingId)
    assert.equal(loaded?.workspace_id, workspaceId)
    assert.equal(loaded?.installation_id, installationId)
    assert.equal(loaded?.ingress_kind, "polling")
    assert.equal(loaded?.target_id, "synapse/test")

    const existing = await selectExistingAutomationIntegrationBindingRow({
      workspaceId,
      installationId,
      provider: "github",
      ingressKind: "polling",
      targetKind: "repository",
      targetId: "synapse/test",
      executor: db,
    })
    assert.equal(existing?.id, bindingId)
    assert.equal(existing?.external_subscription_id, "sub-1")
  })
})

test(
  "automation repo helpers own webhook source and execution list queries",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { memberId, workspaceId, conversationId, participantId } =
        await insertAutomationRuleFixture(db)
      const directEndpointId = crypto.randomUUID()
      const directPathToken = `direct-${crypto.randomUUID()}`
      const directSourceId = crypto.randomUUID()
      const directSourceKey = `direct.${crypto.randomUUID()}`

      await insertAutomationWebhookEndpointReturningRow(
        {
          id: directEndpointId,
          workspaceId,
          name: "direct webhook",
          status: AUTOMATION_WEBHOOK_ENDPOINT_STATUS.ACTIVE,
          pathToken: directPathToken,
          secretCiphertext: "direct-secret",
          secretHint: "hint",
          metadata: { endpoint: "direct" },
          createdByWorkspaceMemberId: memberId,
        },
        db
      )

      await insertAutomationEventSourceRow(
        {
          id: directSourceId,
          workspaceId,
          providerKind: AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[1],
          providerRef: null,
          webhookEndpointId: directEndpointId,
          integrationBindingId: null,
          sourceKey: directSourceKey,
          name: "direct source",
          description: "",
          recommendedUsage: "",
          payloadSchema: JSON.stringify({ direct: true }),
          examplePayload: JSON.stringify({ direct: "event" }),
          status: AUTOMATION_EVENT_SOURCE_STATUSES[0],
          createdByKind: AUTOMATION_CREATOR_KIND.WORKSPACE_MEMBER,
          createdByWorkspaceMemberId: memberId,
          createdByActorId: null,
          createdBySessionId: null,
          metadata: JSON.stringify({ source: "direct" }),
        },
        db
      )

      const directSource = await selectWebhookAutomationEventSourceByPathToken({
        pathToken: directPathToken,
        sourceKey: directSourceKey,
        executor: db,
      })
      assert.equal(directSource?.id, directSourceId)
      assert.equal(directSource?.workspace_id, workspaceId)
      assert.equal(directSource?.endpoint_id, directEndpointId)
      assert.equal(directSource?.endpoint_secret_ciphertext, "direct-secret")
      assert.deepEqual(directSource?.payload_schema, { direct: true })

      const integrationEndpointId = crypto.randomUUID()
      const integrationPathToken = `integration-${crypto.randomUUID()}`
      const bindingId = crypto.randomUUID()
      const integrationSourceId = crypto.randomUUID()
      const integrationSourceKey = `integration.${crypto.randomUUID()}`
      const installationId = await insertPluginInstallationFixture(db, {
        workspaceId,
        memberId,
      })

      await insertAutomationWebhookEndpointReturningRow(
        {
          id: integrationEndpointId,
          workspaceId,
          name: "integration webhook",
          status: AUTOMATION_WEBHOOK_ENDPOINT_STATUS.ACTIVE,
          pathToken: integrationPathToken,
          secretCiphertext: "integration-secret",
          secretHint: "hint",
          metadata: { endpoint: "integration" },
          createdByWorkspaceMemberId: memberId,
        },
        db
      )
      await insertIntegrationBindingRow(db, {
        id: bindingId,
        workspaceId,
        installationId,
        provider: AUTOMATION_INTEGRATION_PROVIDERS[0],
        ingressKind: AUTOMATION_INTEGRATION_INGRESS_KINDS[0],
        targetKind: AUTOMATION_INTEGRATION_TARGET_KINDS[0],
        targetId: "synapse/test",
        targetLabel: "synapse/test",
        webhookEndpointId: integrationEndpointId,
        externalSubscriptionId: "sub-2",
        metadata: JSON.stringify({ binding: "integration" }),
      })
      await insertAutomationEventSourceRow(
        {
          id: integrationSourceId,
          workspaceId,
          providerKind: AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[3],
          providerRef: AUTOMATION_INTEGRATION_PROVIDERS[0],
          webhookEndpointId: null,
          integrationBindingId: bindingId,
          sourceKey: integrationSourceKey,
          name: "integration source",
          description: "",
          recommendedUsage: "",
          payloadSchema: JSON.stringify({ integration: true }),
          examplePayload: JSON.stringify({ integration: "event" }),
          status: AUTOMATION_EVENT_SOURCE_STATUSES[0],
          createdByKind: AUTOMATION_CREATOR_KIND.WORKSPACE_MEMBER,
          createdByWorkspaceMemberId: memberId,
          createdByActorId: null,
          createdBySessionId: null,
          metadata: JSON.stringify({ source: "integration" }),
        },
        db
      )

      const integrationSources =
        await listIntegrationAutomationEventSourceRowsByWebhookPathToken({
          pathToken: integrationPathToken,
          executor: db,
        })
      assert.deepEqual(
        integrationSources.map((source) => source.id),
        [integrationSourceId]
      )
      assert.equal(
        integrationSources[0]?.integration_installation_id,
        installationId
      )
      assert.equal(integrationSources[0]?.endpoint_id, integrationEndpointId)
      assert.deepEqual(integrationSources[0]?.metadata, {
        source: "integration",
      })

      const ruleId = crypto.randomUUID()
      await insertAutomationRuleRow(db, {
        id: ruleId,
        workspaceId,
        conversationId,
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        status: AUTOMATION_RULE_STATUSES[0],
        name: "repo event rule",
        description: "",
        createdByParticipantId: participantId,
        createdBySessionId: null,
        metadata: JSON.stringify({ rule: true }),
      })

      const listedRuleIds = await listAutomationRuleIds({
        workspaceId,
        filters: {
          category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
          status: AUTOMATION_RULE_STATUSES[0],
          conversationId,
        },
        executor: db,
      })
      assert.deepEqual(listedRuleIds, [ruleId])

      const occurrenceId = crypto.randomUUID()
      await db
        .insertInto("automationOccurrences")
        .values({
          id: occurrenceId,
          workspaceId,
          sourceKind: AUTOMATION_TRIGGER_SOURCE_KINDS[2],
          eventSourceId: directSourceId,
          sourceLocator: "webhook/direct",
          matchKey: "direct-match",
          dedupeKey: `dedupe-${crypto.randomUUID()}`,
          sourceSnapshot: JSON.stringify({ ruleName: "repo event rule" }),
          payload: JSON.stringify({ severity: "critical" }),
          occurredAt: new Date(),
        } as any)
        .execute()

      const occurrenceRows = await listAutomationOccurrenceRows({
        workspaceId,
        filters: { eventSourceId: directSourceId, limit: 10 },
        executor: db,
      })
      assert.deepEqual(
        occurrenceRows.map((row) => row.id),
        [occurrenceId]
      )
      const occurrence = normalizeAutomationOccurrenceRow(occurrenceRows[0]!)
      assert.equal(occurrence.event_source_key, directSourceKey)
      assert.deepEqual(occurrence.payload, { severity: "critical" })

      const selectedOccurrence = await selectAutomationOccurrenceRow(
        occurrenceId,
        db
      )
      assert.equal(selectedOccurrence?.id, occurrenceId)
      assert.equal(selectedOccurrence?.event_source_name, "direct source")

      const executionId = crypto.randomUUID()
      await db
        .insertInto("automationExecutions")
        .values({
          id: executionId,
          workspaceId,
          ruleId,
          occurrenceId,
          status: AUTOMATION_EXECUTION_STATUS.PENDING,
          attemptCount: 0,
        } as any)
        .execute()

      const claimed = await claimPendingAutomationExecutionRow(executionId, db)
      assert.equal(claimed?.id, executionId)
      assert.equal(claimed?.status, AUTOMATION_EXECUTION_STATUS.RUNNING)
      assert.equal(claimed?.attempt_count, 1)
      assert.ok(claimed?.started_at instanceof Date)

      const executionRows = await listAutomationExecutionRows({
        workspaceId,
        ruleId,
        limit: 10,
        executor: db,
      })
      assert.deepEqual(
        executionRows.map((row) => row.id),
        [executionId]
      )
      const execution = normalizeAutomationExecutionWithOccurrenceRow(
        executionRows[0]!
      )
      assert.equal(execution.event_source_key, directSourceKey)
      assert.equal(execution.occurrence_event_source_name, "direct source")
      assert.deepEqual(execution.source_snapshot, {
        ruleName: "repo event rule",
      })
      assert.deepEqual(execution.payload, { severity: "critical" })
    })
  }
)

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
  "automation repo helpers own rule liveness expiry and inactive-creator pause",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, conversationId, participantId } =
        await insertAutomationRuleFixture(db)
      const referenceTime = dateToIsoInstant(new Date())
      const expiredRuleId = crypto.randomUUID()
      const futureRuleId = crypto.randomUUID()

      async function insertRuleWithPolicy(
        ruleId: string,
        name: string,
        activeUntil: Date
      ) {
        await insertAutomationRuleRow(db, {
          id: ruleId,
          workspaceId,
          conversationId,
          category: AUTOMATION_RULE_CATEGORY.SCHEDULE,
          status: AUTOMATION_RULE_STATUSES[0],
          name,
          description: "",
          createdByParticipantId: participantId,
          createdBySessionId: null,
          metadata: JSON.stringify({ rule: name }),
        })
        await insertAutomationPolicyRow(db, {
          ruleId,
          activeFrom: null,
          activeUntil,
          maxTriggerCount: null,
          triggerCount: 0,
          completionStatus: AUTOMATION_COMPLETION_STATUSES[0],
          completedAt: null,
          metadata: JSON.stringify({ policy: name }),
        })
      }

      await insertRuleWithPolicy(
        expiredRuleId,
        "expired rule",
        new Date(Date.now() - 60_000)
      )
      await insertRuleWithPolicy(
        futureRuleId,
        "future rule",
        new Date(Date.now() + 60_000)
      )

      const expiredRows = await expireAutomationRuleRows({
        referenceTime,
        workspaceId,
        executor: db,
      })
      assert.deepEqual(
        expiredRows.map((row) => row.id),
        [expiredRuleId]
      )
      assert.equal(expiredRows[0]?.workspaceId, workspaceId)

      const expiredRule = await db
        .selectFrom("automationRules")
        .select(["status"])
        .where("id", "=", expiredRuleId)
        .executeTakeFirstOrThrow()
      assert.equal(expiredRule.status, AUTOMATION_RULE_STATUSES[5])

      const expiredPolicy = await db
        .selectFrom("automationPolicies")
        .select(["completedAt"])
        .where("ruleId", "=", expiredRuleId)
        .executeTakeFirstOrThrow()
      assert.ok(expiredPolicy.completedAt instanceof Date)

      const futureRule = await db
        .selectFrom("automationRules")
        .select(["status"])
        .where("id", "=", futureRuleId)
        .executeTakeFirstOrThrow()
      assert.equal(futureRule.status, AUTOMATION_RULE_STATUSES[0])

      const expireAudit = await db
        .selectFrom("auditLogs")
        .select(["action", "resourceId", "details"])
        .where("resourceId", "=", expiredRuleId)
        .executeTakeFirstOrThrow()
      assert.equal(expireAudit.action, "automation_rule.expire")
      assert.deepEqual(parseJsonObject(expireAudit.details), { referenceTime })

      const {
        workspaceId: pauseWorkspaceId,
        conversationId: pauseConversationId,
        participantId: pauseParticipantId,
      } = await insertAutomationRuleFixture(db)
      const pauseRuleId = crypto.randomUUID()
      await insertAutomationRuleRow(db, {
        id: pauseRuleId,
        workspaceId: pauseWorkspaceId,
        conversationId: pauseConversationId,
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        status: AUTOMATION_RULE_STATUSES[0],
        name: "inactive creator rule",
        description: "",
        createdByParticipantId: pauseParticipantId,
        createdBySessionId: null,
        metadata: JSON.stringify({ rule: "inactive creator" }),
      })
      await db
        .updateTable("conversationParticipants")
        .set({ state: "removed" })
        .where("id", "=", pauseParticipantId)
        .execute()

      const pausedRows = await pauseAutomationRuleRowsForInactiveCreators({
        workspaceId: pauseWorkspaceId,
        executor: db,
      })
      assert.deepEqual(
        pausedRows.map((row) => row.id),
        [pauseRuleId]
      )
      assert.equal(pausedRows[0]?.workspaceId, pauseWorkspaceId)

      const pausedRule = await db
        .selectFrom("automationRules")
        .select(["status", "lastErrorAt", "lastErrorMessage"])
        .where("id", "=", pauseRuleId)
        .executeTakeFirstOrThrow()
      assert.equal(pausedRule.status, AUTOMATION_RULE_STATUSES[1])
      assert.ok(pausedRule.lastErrorAt instanceof Date)
      assert.equal(
        pausedRule.lastErrorMessage,
        "Creator participant is no longer active"
      )

      const pauseAudit = await db
        .selectFrom("auditLogs")
        .select(["action", "resourceId", "details"])
        .where("resourceId", "=", pauseRuleId)
        .executeTakeFirstOrThrow()
      assert.equal(pauseAudit.action, "automation_rule.pause")
      assert.deepEqual(parseJsonObject(pauseAudit.details), {
        reason: "Creator participant is no longer active",
      })
    })
  }
)

test(
  "automation repo helpers own occurrence and execution creation queries",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, conversationId, participantId } =
        await insertAutomationRuleFixture(db)
      const ruleId = crypto.randomUUID()
      await insertAutomationRuleRow(db, {
        id: ruleId,
        workspaceId,
        conversationId,
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        status: AUTOMATION_RULE_STATUSES[0],
        name: "repo execution rule",
        description: "",
        createdByParticipantId: participantId,
        createdBySessionId: null,
        metadata: JSON.stringify({ rule: "execution" }),
      })

      const occurrenceId = crypto.randomUUID()
      const dedupeKey = `dedupe-${crypto.randomUUID()}`
      const sourceKind = AUTOMATION_TRIGGER_SOURCE_KINDS[3]
      const occurredAt = dateToIsoInstant(new Date())
      const insertedOccurrence = await insertAutomationOccurrenceReturningRow({
        id: occurrenceId,
        workspaceId,
        sourceKind,
        sourceLocator: "internal/test",
        matchKey: "match-1",
        dedupeKey,
        sourceSnapshot: { source: "repo-test" },
        payload: { severity: "critical" },
        occurredAt,
        executor: db,
      })
      assert.equal(insertedOccurrence.id, occurrenceId)
      assert.equal(insertedOccurrence.workspace_id, workspaceId)

      const selectedOccurrence = await selectAutomationOccurrenceRowByDedupeKey(
        {
          workspaceId,
          sourceKind,
          dedupeKey,
          executor: db,
        }
      )
      assert.equal(selectedOccurrence?.id, occurrenceId)
      assert.deepEqual(
        normalizeAutomationOccurrenceRow(selectedOccurrence!).payload,
        { severity: "critical" }
      )

      const executionId = crypto.randomUUID()
      const insertedExecution = await insertAutomationExecutionReturningRow({
        id: executionId,
        workspaceId,
        ruleId,
        occurrenceId,
        executor: db,
      })
      assert.equal(insertedExecution.id, executionId)
      assert.equal(
        insertedExecution.status,
        AUTOMATION_EXECUTION_STATUS.PENDING
      )
      assert.equal(insertedExecution.attempt_count, 0)

      const selectedExecution =
        await selectAutomationExecutionRowByRuleOccurrence({
          ruleId,
          occurrenceId,
          executor: db,
        })
      assert.equal(selectedExecution?.id, executionId)
      assert.equal(selectedExecution?.workspace_id, workspaceId)
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

      const loadedSource = await getAutomationEventSourceRow({
        workspaceId,
        eventSourceId,
        executor: db,
      })
      assert.equal(loadedSource?.id, eventSourceId)
      assert.equal(loadedSource?.workspace_id, workspaceId)
      assert.equal(
        loadedSource?.provider_kind,
        AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[2]
      )
      assert.deepEqual(parseJsonObject(loadedSource?.payload_schema), {})

      const listedSources = await listAutomationEventSourceRows({
        workspaceId,
        filters: {
          providerKind: AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[2],
          sourceKey: loadedSource?.source_key,
        },
        executor: db,
      })
      assert.deepEqual(
        listedSources.map((source) => source.id),
        [eventSourceId]
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
