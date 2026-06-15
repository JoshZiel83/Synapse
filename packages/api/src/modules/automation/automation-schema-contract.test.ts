import assert from "node:assert/strict"
import test from "node:test"
import {
  ACCESS_BINDING_STATUS,
  AUTOMATION_ACCESS_TARGET_TYPE,
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
} from "@synapse/shared"
import {
  AutomationAccessGrantEnvelopeSchema,
  AutomationAccessGrantInputSchema,
  AutomationEventIngestResultSchema,
  AutomationEventSourceSchema,
  AutomationEventSourceCreateInputSchema,
  AutomationEventSourceListQuerySchema,
  AutomationRuleCreateInputSchema,
  AutomationRuleListQuerySchema,
  AutomationRuleSchema,
  AutomationRuleUpdateInputSchema,
  AutomationWebhookEndpointCreateResultSchema,
} from "@synapse/shared/schemas"

const conversationId = "00000000-0000-4000-8000-000000000001"
const workspaceMemberId = "00000000-0000-4000-8000-000000000002"
const installationId = "00000000-0000-4000-8000-000000000003"
const ruleId = "00000000-0000-4000-8000-000000000004"
const workspaceId = "00000000-0000-4000-8000-000000000005"
const authorityWorkspaceId = "00000000-0000-4000-8000-000000000006"
const participantId = "00000000-0000-4000-8000-000000000007"
const sessionId = "00000000-0000-4000-8000-000000000008"
const eventSourceId = "00000000-0000-4000-8000-000000000009"
const grantId = "00000000-0000-4000-8000-000000000010"
const occurrenceId = "00000000-0000-4000-8000-000000000011"
const executionId = "00000000-0000-4000-8000-000000000012"
const webhookEndpointId = "00000000-0000-4000-8000-000000000013"
const isoInstant = "2026-06-14T00:00:00.000Z"
const validMessageBlock = {
  type: "text",
  text: "Automation ping",
} as const

function automationEventSourceFixture() {
  return {
    id: eventSourceId,
    workspaceId,
    providerKind: "webhook",
    providerRef: "github",
    sourceKey: "github:repository:openai/synapse",
    name: "GitHub webhook",
    description: "Repository automation ingress",
    recommendedUsage: "Create repository event automations",
    payloadSchema: {},
    examplePayload: {},
    status: "active",
    createdByKind: AUTOMATION_CREATOR_KIND.WORKSPACE_MEMBER,
    createdByWorkspaceMemberId: workspaceMemberId,
    metadata: {},
    createdAt: isoInstant,
    updatedAt: isoInstant,
  }
}

function automationIntegrationFixture() {
  return {
    installationId,
    provider: AUTOMATION_INTEGRATION_PROVIDERS[0],
    ingressKind: AUTOMATION_INTEGRATION_INGRESS_KINDS[0],
    targetKind: AUTOMATION_INTEGRATION_TARGET_KINDS[0],
    targetId: "openai/synapse",
    targetLabel: "openai/synapse",
  }
}

function automationAccessGrantEnvelopeFixture() {
  return {
    grant: {
      id: grantId,
      resourceId: eventSourceId,
      workspaceId,
      target: { subject: { type: "workspace", id: workspaceId } },
      status: "active",
      grantedByWorkspaceMemberId: workspaceMemberId,
      reason: "Allow workspace automation",
      conversationTypeMaskOverride: null,
      effectiveConversationTypeMask: 15,
      createdAt: isoInstant,
    },
  }
}

function automationEventIngestResultFixture() {
  return {
    occurrence: {
      id: occurrenceId,
      workspaceId,
      sourceKind: "webhook",
      eventSourceId,
      eventSourceKey: "github:repository:openai/synapse",
      eventSourceName: "GitHub webhook",
      displayTitle: "Issue opened",
      displaySummary: "Repository issue opened",
      sourceSnapshot: {},
      payload: {},
      occurredAt: isoInstant,
      createdAt: isoInstant,
    },
    executions: [
      {
        id: executionId,
        workspaceId,
        ruleId,
        occurrenceId,
        occurrenceOccurredAt: isoInstant,
        occurrenceSourceKind: "webhook",
        occurrenceEventSourceName: "GitHub webhook",
        occurrenceTitle: "Issue opened",
        status: AUTOMATION_EXECUTION_STATUS.PENDING,
        createdAt: isoInstant,
        updatedAt: isoInstant,
      },
    ],
  }
}

function automationWebhookCreateResultFixture() {
  return {
    endpoint: {
      id: webhookEndpointId,
      workspaceId,
      name: "Inbound webhook",
      status: AUTOMATION_WEBHOOK_ENDPOINT_STATUS.ACTIVE,
      pathToken: "path-token",
      secretHint: "sec_1234",
      metadata: {},
      createdByWorkspaceMemberId: workspaceMemberId,
      createdAt: isoInstant,
      updatedAt: isoInstant,
    },
    secret: "secret-value",
  }
}

function automationRuleFixture(messageBlocks: unknown[] = [validMessageBlock]) {
  return {
    id: ruleId,
    workspaceId,
    authorityWorkspaceId,
    conversationId,
    category: AUTOMATION_RULE_CATEGORY.SCHEDULE,
    status: "active",
    name: "Daily standup reminder",
    description: "",
    createdByParticipantId: participantId,
    createdBySessionId: sessionId,
    trigger: {
      ruleId,
      triggerKind: "schedule",
      sourceKind: "clock",
      matcher: {},
      scheduleKind: "at",
      metadata: {},
    },
    policy: {
      ruleId,
      triggerCount: 0,
      completionStatus: "completed",
      metadata: {},
    },
    delivery: {
      ruleId,
      messageText: "Automation ping",
      messageBlocks,
      targetPolicy: "all_members",
      targetParticipantIds: [],
      metadata: {},
    },
    metadata: {},
    createdAt: isoInstant,
    updatedAt: isoInstant,
  }
}

test("AutomationRuleCreateInputSchema preserves create defaults", () => {
  const parsed = AutomationRuleCreateInputSchema.safeParse({
    name: "Daily standup reminder",
    conversationId,
    trigger: {
      triggerKind: "schedule",
    },
    delivery: {},
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.equal(parsed.data.description, "")
  assert.equal(parsed.data.delivery.message, "")
})

test("AutomationEventSourceCreateInputSchema validates integration requirements", () => {
  assert.equal(
    AutomationEventSourceCreateInputSchema.safeParse({
      providerKind: "integration",
    }).success,
    false
  )

  const parsed = AutomationEventSourceCreateInputSchema.safeParse({
    providerKind: "integration",
    sourceKey: "github:repo:openai/synapse",
    integration: {
      installationId,
      provider: "github",
      targetKind: "repository",
      targetId: "openai/synapse",
    },
  })

  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("AutomationAccessGrantInputSchema rejects snake_case access target fields", () => {
  assert.equal(
    AutomationAccessGrantInputSchema.safeParse({
      accessTarget: {
        type: "workspace_member",
        workspace_member_id: workspaceMemberId,
      },
    }).success,
    false
  )

  assert.ok(
    AutomationAccessGrantInputSchema.safeParse({
      accessTarget: {
        type: AUTOMATION_ACCESS_TARGET_TYPE.WORKSPACE_MEMBER,
        workspaceMemberId,
      },
      conversationTypeMaskOverride: null,
    }).success
  )
})

test("AutomationAccessGrantInputSchema validates finite access target type set", () => {
  assert.ok(
    AutomationAccessGrantInputSchema.safeParse({
      accessTarget: {
        type: AUTOMATION_ACCESS_TARGET_TYPE.WORKSPACE,
      },
    }).success
  )

  assert.equal(
    AutomationAccessGrantInputSchema.safeParse({
      accessTarget: {
        type: "remote_agent",
        remoteAgentId: "00000000-0000-4000-8000-000000000014",
      },
    }).success,
    false
  )
})

test("automation app query schemas validate shared enum values", () => {
  assert.ok(
    AutomationEventSourceListQuerySchema.safeParse({
      providerKind: "webhook",
      status: "active",
    }).success
  )
  assert.equal(
    AutomationRuleListQuerySchema.safeParse({
      category: "manual",
    }).success,
    false
  )
})

test("automation delivery input schemas validate canonical message blocks", () => {
  const create = AutomationRuleCreateInputSchema.safeParse({
    name: "Daily standup reminder",
    conversationId,
    trigger: {
      triggerKind: "schedule",
    },
    delivery: {
      messageBlocks: [validMessageBlock],
    },
  })

  assert.ok(create.success, JSON.stringify(create.error?.issues))
  assert.deepEqual(create.data.delivery.messageBlocks, [validMessageBlock])

  const update = AutomationRuleUpdateInputSchema.safeParse({
    delivery: {
      messageBlocks: [validMessageBlock],
    },
  })

  assert.ok(update.success, JSON.stringify(update.error?.issues))

  assert.equal(
    AutomationRuleCreateInputSchema.safeParse({
      name: "Daily standup reminder",
      conversationId,
      trigger: {
        triggerKind: "schedule",
      },
      delivery: {
        messageBlocks: [{ type: "text" }],
      },
    }).success,
    false
  )
})

test("automation rule response schema validates canonical delivery message blocks", () => {
  assert.ok(
    AutomationRuleSchema.safeParse(automationRuleFixture()).success,
    "valid canonical message blocks should parse"
  )

  assert.equal(
    AutomationRuleSchema.safeParse(automationRuleFixture([{ type: "text" }]))
      .success,
    false
  )
})

test("automation rule response schema validates finite rule categories", () => {
  assert.ok(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
    }).success
  )

  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      category: "manual",
    }).success,
    false
  )
})

test("automation rule schemas validate finite trigger and delivery enums", () => {
  assert.ok(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      status: AUTOMATION_RULE_STATUSES[0],
      trigger: {
        ...automationRuleFixture().trigger,
        triggerKind: AUTOMATION_TRIGGER_KINDS[0],
        sourceKind: AUTOMATION_TRIGGER_SOURCE_KINDS[0],
        scheduleKind: AUTOMATION_SCHEDULE_KINDS[0],
        eventProviderKind: AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS[0],
        eventSourceStatus: AUTOMATION_EVENT_SOURCE_STATUSES[0],
      },
      policy: {
        ...automationRuleFixture().policy,
        completionStatus: AUTOMATION_COMPLETION_STATUSES[0],
      },
      delivery: {
        ...automationRuleFixture().delivery,
        targetPolicy: AUTOMATION_TARGET_POLICIES[0],
      },
    }).success
  )

  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      status: "deleted",
    }).success,
    false
  )
  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      trigger: {
        ...automationRuleFixture().trigger,
        triggerKind: "timer",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      trigger: {
        ...automationRuleFixture().trigger,
        sourceKind: "email",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      trigger: {
        ...automationRuleFixture().trigger,
        scheduleKind: "calendar",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      policy: {
        ...automationRuleFixture().policy,
        completionStatus: "done",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationRuleSchema.safeParse({
      ...automationRuleFixture(),
      delivery: {
        ...automationRuleFixture().delivery,
        targetPolicy: "everyone",
      },
    }).success,
    false
  )

  assert.equal(
    AutomationRuleCreateInputSchema.safeParse({
      name: "Daily standup reminder",
      conversationId,
      trigger: {
        triggerKind: "timer",
      },
      delivery: {},
    }).success,
    false
  )
  assert.equal(
    AutomationRuleCreateInputSchema.safeParse({
      name: "Daily standup reminder",
      conversationId,
      trigger: {
        triggerKind: AUTOMATION_TRIGGER_KINDS[0],
        scheduleKind: "calendar",
      },
      policy: {
        completionStatus: "done",
      },
      delivery: {
        targetPolicy: "everyone",
      },
    }).success,
    false
  )
})

test("automation response schemas validate finite integration enums", () => {
  assert.ok(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      providerKind: "integration",
      integration: automationIntegrationFixture(),
    }).success
  )

  assert.equal(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      providerKind: "integration",
      integration: {
        ...automationIntegrationFixture(),
        provider: "jira",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      providerKind: "integration",
      integration: {
        ...automationIntegrationFixture(),
        ingressKind: "queue",
      },
    }).success,
    false
  )
  assert.equal(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      providerKind: "integration",
      integration: {
        ...automationIntegrationFixture(),
        targetKind: "repo",
      },
    }).success,
    false
  )
})

test("automation event-source response schema validates finite creator kinds", () => {
  assert.ok(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      createdByKind: AUTOMATION_CREATOR_KIND.SYSTEM,
    }).success
  )

  assert.equal(
    AutomationEventSourceSchema.safeParse({
      ...automationEventSourceFixture(),
      createdByKind: "robot",
    }).success,
    false
  )
})

test("automation app create response schemas validate concrete shared payloads", () => {
  assert.ok(
    AutomationEventSourceSchema.safeParse(automationEventSourceFixture())
      .success
  )
  assert.ok(
    AutomationRuleSchema.safeParse(automationRuleFixture()).success,
    "automation create response should use the shared rule view"
  )
  assert.ok(
    AutomationAccessGrantEnvelopeSchema.safeParse(
      automationAccessGrantEnvelopeFixture()
    ).success
  )
  assert.ok(
    AutomationWebhookEndpointCreateResultSchema.safeParse(
      automationWebhookCreateResultFixture()
    ).success
  )
})

test("automation event ingest response schema validates occurrence and executions", () => {
  assert.ok(
    AutomationEventIngestResultSchema.safeParse(
      automationEventIngestResultFixture()
    ).success
  )

  const malformed = automationEventIngestResultFixture()
  malformed.executions[0] = {
    ...malformed.executions[0],
    occurrenceId: undefined as unknown as string,
  }
  assert.equal(
    AutomationEventIngestResultSchema.safeParse(malformed).success,
    false
  )
})

test("automation response schemas reject unknown app statuses", () => {
  const executionFixture = automationEventIngestResultFixture()
  const invalidExecution = {
    ...executionFixture,
    executions: [
      {
        ...executionFixture.executions[0],
        status: "queued" as never,
      },
    ],
  }
  assert.equal(
    AutomationEventIngestResultSchema.safeParse(invalidExecution).success,
    false
  )

  const webhookFixture = automationWebhookCreateResultFixture()
  const invalidWebhook = {
    ...webhookFixture,
    endpoint: {
      ...webhookFixture.endpoint,
      status: "deleted" as never,
    },
  }
  assert.equal(
    AutomationWebhookEndpointCreateResultSchema.safeParse(invalidWebhook)
      .success,
    false
  )

  const grantFixture = automationAccessGrantEnvelopeFixture()
  const invalidGrant = {
    ...grantFixture,
    grant: {
      ...grantFixture.grant,
      status: "disabled" as never,
    },
  }
  assert.equal(
    AutomationAccessGrantEnvelopeSchema.safeParse(invalidGrant).success,
    false
  )

  const validGrant = automationAccessGrantEnvelopeFixture()
  validGrant.grant.status = ACCESS_BINDING_STATUS.ACTIVE
  assert.ok(AutomationAccessGrantEnvelopeSchema.safeParse(validGrant).success)
})
