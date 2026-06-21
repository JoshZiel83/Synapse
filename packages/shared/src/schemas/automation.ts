import { z } from "zod"
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_EXECUTION_STATUSES,
  AUTOMATION_INTEGRATION_INGRESS_KINDS,
  AUTOMATION_INTEGRATION_PROVIDERS,
  AUTOMATION_INTEGRATION_TARGET_KINDS,
  AUTOMATION_RULE_CATEGORIES,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  AUTOMATION_WEBHOOK_ENDPOINT_STATUSES,
} from "../constants/enums.js"
import type { CanonicalContentBlockInput } from "../types/index.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"
import { WorkspaceResourceGrantViewSchema } from "./workspace-resources.js"

/**
 * App-facing contracts for the automation module's APP routes (master plan
 * §5.3). Every modeled route here is workspace-scoped + authenticated, so its
 * response value is wrapped through `appRoute` → `sendData` → `{ data: ... }`.
 * These schemas describe the value each handler returns (the helper wraps it).
 *
 * Top-level scalar/enum fields and canonical content blocks are modeled
 * explicitly. Genuinely-open nested values (matchers, metadata, payload/snapshot
 * blobs, capability access-target refs) are the shapes the presenter/service
 * already own, so they are modeled as open records / `z.unknown()` — the
 * boundary only round-trips them unchanged, not re-validates their interior.
 * Status enums are modeled through shared const tuples so the runtime schema,
 * exported TS types, and DB enum parity checks stay aligned.
 */

const openRecord = z.record(z.string(), z.unknown())

const eventSourceIntegrationSchema = z.object({
  bindingId: z.string().optional(),
  installationId: z.string(),
  provider: z.enum(AUTOMATION_INTEGRATION_PROVIDERS),
  ingressKind: z.enum(AUTOMATION_INTEGRATION_INGRESS_KINDS),
  targetKind: z.enum(AUTOMATION_INTEGRATION_TARGET_KINDS),
  targetId: z.string(),
  targetLabel: z.string(),
  endpointId: z.string().optional(),
  externalSubscriptionId: z.string().optional(),
})

/** AutomationEventSource view (GET/POST/PUT event-source). */
export const AutomationEventSourceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  providerKind: z.enum(AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS),
  providerRef: z.string().optional(),
  integration: eventSourceIntegrationSchema.optional(),
  sourceKey: z.string(),
  name: z.string(),
  description: z.string(),
  recommendedUsage: z.string().optional(),
  payloadSchema: openRecord,
  examplePayload: openRecord,
  status: z.enum(AUTOMATION_EVENT_SOURCE_STATUSES),
  createdByWorkspaceMemberId: z.string().optional(),
  lastTriggeredAt: IsoInstantStringSchema.optional(),
  metadata: openRecord,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type AutomationEventSourceSchemaType = z.infer<
  typeof AutomationEventSourceSchema
>

/** GET event-sources list. */
export const AutomationEventSourceListSchema = z.array(
  AutomationEventSourceSchema
)
export type AutomationEventSourceListSchemaType = z.infer<
  typeof AutomationEventSourceListSchema
>

const automationTriggerSchema = z.object({
  ruleId: z.string(),
  triggerKind: z.enum(AUTOMATION_TRIGGER_KINDS),
  sourceKind: z.enum(AUTOMATION_TRIGGER_SOURCE_KINDS),
  eventSourceId: z.string().optional(),
  eventSourceKey: z.string().optional(),
  eventSourceName: z.string().optional(),
  eventProviderKind: z.enum(AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS).optional(),
  eventProviderRef: z.string().optional(),
  eventSourceIntegration: eventSourceIntegrationSchema.optional(),
  eventSourceStatus: z.enum(AUTOMATION_EVENT_SOURCE_STATUSES).optional(),
  sourceLocator: z.string().optional(),
  matchKey: z.string().optional(),
  matcher: openRecord,
  scheduleKind: z.enum(AUTOMATION_SCHEDULE_KINDS).optional(),
  scheduleExpr: z.string().optional(),
  scheduleTimezone: z.string().optional(),
  intervalSeconds: z.number().optional(),
  startsAt: IsoInstantStringSchema.optional(),
  nextFireAt: IsoInstantStringSchema.optional(),
  lastFiredAt: IsoInstantStringSchema.optional(),
  metadata: openRecord,
})

const automationPolicySchema = z.object({
  ruleId: z.string(),
  activeFrom: IsoInstantStringSchema.optional(),
  activeUntil: IsoInstantStringSchema.optional(),
  maxTriggerCount: z.number().optional(),
  triggerCount: z.number(),
  completionStatus: z.enum(AUTOMATION_COMPLETION_STATUSES),
  completedAt: IsoInstantStringSchema.optional(),
  metadata: openRecord,
})

const automationDeliverySchema = z.object({
  ruleId: z.string(),
  messageText: z.string(),
  wakeReasonText: z.string().optional(),
  messageBlocks: z.array(CanonicalContentBlockSchema),
  targetPolicy: z.enum(AUTOMATION_TARGET_POLICIES),
  targetParticipantIds: z.array(z.string()),
  metadata: openRecord,
})

/** AutomationRule view (GET/POST/PUT automation). */
export const AutomationRuleSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  authorityWorkspaceId: z.string(),
  conversationId: z.string(),
  category: z.enum(AUTOMATION_RULE_CATEGORIES),
  status: z.enum(AUTOMATION_RULE_STATUSES),
  name: z.string(),
  description: z.string(),
  createdByParticipantId: z.string(),
  createdBySessionId: z.string().optional(),
  trigger: automationTriggerSchema,
  policy: automationPolicySchema,
  delivery: automationDeliverySchema,
  lastTriggeredAt: IsoInstantStringSchema.optional(),
  lastErrorAt: IsoInstantStringSchema.optional(),
  lastErrorMessage: z.string().optional(),
  metadata: openRecord,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type AutomationRuleSchemaType = z.infer<typeof AutomationRuleSchema>

/** GET automations list. */
export const AutomationRuleListSchema = z.array(AutomationRuleSchema)
export type AutomationRuleListSchemaType = z.infer<
  typeof AutomationRuleListSchema
>

/** AutomationOccurrence view (event-source occurrences list entries). */
export const AutomationOccurrenceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sourceKind: z.enum(AUTOMATION_TRIGGER_SOURCE_KINDS),
  eventSourceId: z.string().optional(),
  eventSourceKey: z.string().optional(),
  eventSourceName: z.string().optional(),
  eventSourceIntegration: eventSourceIntegrationSchema.optional(),
  displayTitle: z.string().optional(),
  displaySummary: z.string().optional(),
  displayDescription: z.string().optional(),
  sourceLocator: z.string().optional(),
  matchKey: z.string().optional(),
  dedupeKey: z.string().optional(),
  sourceSnapshot: openRecord,
  payload: openRecord,
  occurredAt: IsoInstantStringSchema,
  createdAt: IsoInstantStringSchema,
})
export type AutomationOccurrenceSchemaType = z.infer<
  typeof AutomationOccurrenceSchema
>

/** GET occurrences list. */
export const AutomationOccurrenceListSchema = z.array(
  AutomationOccurrenceSchema
)
export type AutomationOccurrenceListSchemaType = z.infer<
  typeof AutomationOccurrenceListSchema
>

/** AutomationExecution view (executions list entries). */
export const AutomationExecutionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  ruleId: z.string(),
  occurrenceId: z.string(),
  occurrenceOccurredAt: IsoInstantStringSchema.optional(),
  occurrenceSourceKind: z.enum(AUTOMATION_TRIGGER_SOURCE_KINDS).optional(),
  occurrenceEventSourceName: z.string().optional(),
  occurrenceTitle: z.string().optional(),
  occurrenceSummary: z.string().optional(),
  occurrenceDescription: z.string().optional(),
  status: z.enum(AUTOMATION_EXECUTION_STATUSES),
  errorMessage: z.string().optional(),
  startedAt: IsoInstantStringSchema.optional(),
  completedAt: IsoInstantStringSchema.optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type AutomationExecutionSchemaType = z.infer<
  typeof AutomationExecutionSchema
>

/** GET executions list. */
export const AutomationExecutionListSchema = z.array(AutomationExecutionSchema)
export type AutomationExecutionListSchemaType = z.infer<
  typeof AutomationExecutionListSchema
>

/** AutomationWebhookEndpoint view (GET list / POST create). */
export const AutomationWebhookEndpointSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  status: z.enum(AUTOMATION_WEBHOOK_ENDPOINT_STATUSES),
  pathToken: z.string(),
  secretHint: z.string(),
  metadata: openRecord,
  createdByWorkspaceMemberId: z.string().optional(),
  lastReceivedAt: IsoInstantStringSchema.optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type AutomationWebhookEndpointSchemaType = z.infer<
  typeof AutomationWebhookEndpointSchema
>

/** GET webhooks list. */
export const AutomationWebhookEndpointListSchema = z.array(
  AutomationWebhookEndpointSchema
)
export type AutomationWebhookEndpointListSchemaType = z.infer<
  typeof AutomationWebhookEndpointListSchema
>

/**
 * POST webhooks create result: `{ endpoint, secret }`. The plaintext secret is
 * surfaced once at creation; the endpoint is the standard endpoint view.
 */
export const AutomationWebhookEndpointCreateResultSchema = z.object({
  endpoint: AutomationWebhookEndpointSchema,
  secret: z.string(),
})
export type AutomationWebhookEndpointCreateResultSchemaType = z.infer<
  typeof AutomationWebhookEndpointCreateResultSchema
>

/** GET event-source access state: `{ grants, summary }`. Automation event-source
 * access is a `use`-permission grant set on the source's workspace_resources root, so
 * grants are the unified workspace-resource grant view (no parallel grant DTO). */
export const AutomationEventSourceAccessStateSchema = z.object({
  grants: z.array(WorkspaceResourceGrantViewSchema),
  summary: z
    .object({
      requiredPermissions: z.array(z.string()),
      suggestedAccessTargetType: z.string(),
      reason: z.string(),
      conversationTypeMaskOverride: z.number().nullable(),
      effectiveConversationTypeMask: z.number().optional(),
      effectivePermissions: z.array(z.string()),
      isVisible: z.boolean(),
      isAuthorized: z.boolean(),
      matchingGrantIds: z.array(z.string()),
      eventSourceId: z.string(),
    })
    .loose(),
})
export type AutomationEventSourceAccessStateSchemaType = z.infer<
  typeof AutomationEventSourceAccessStateSchema
>

/** DELETE access grant / DELETE event-source / DELETE automation: `{ success }`. */
export const AutomationSuccessSchema = z.object({
  success: z.boolean(),
})
export type AutomationSuccessSchemaType = z.infer<
  typeof AutomationSuccessSchema
>

/**
 * POST event-source events (ingest, 202): `{ occurrence, executions }`. The
 * occurrence is the standard occurrence view; executions are execution views.
 */
export const AutomationEventIngestResultSchema = z.object({
  occurrence: AutomationOccurrenceSchema,
  executions: z.array(AutomationExecutionSchema),
})
export type AutomationEventIngestResultSchemaType = z.infer<
  typeof AutomationEventIngestResultSchema
>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies / queries for automation APP routes. Machine/webhook
// ingress routes stay in API wire adapters because they are not app contracts.

const automationContentBlockInputSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlockInput>

const automationContentBlocksInputSchema = z
  .array(automationContentBlockInputSchema)
  .optional()

export const AutomationRuleTriggerInputSchema = z.object({
  triggerKind: z.enum(AUTOMATION_TRIGGER_KINDS),
  eventSourceId: z.uuid().optional(),
  sourceKind: z.enum(AUTOMATION_TRIGGER_SOURCE_KINDS).optional(),
  sourceLocator: z.string().trim().min(1).max(255).optional(),
  matchKey: z.string().trim().min(1).max(255).optional(),
  matcher: openRecord.optional(),
  scheduleKind: z.enum(AUTOMATION_SCHEDULE_KINDS).optional(),
  scheduleExpr: z.string().trim().min(1).max(255).optional(),
  scheduleTimezone: z.string().trim().min(1).max(64).optional(),
  intervalSeconds: z.number().int().positive().optional(),
  startsAt: IsoInstantStringSchema.optional(),
})
export type AutomationRuleTriggerInput = z.input<
  typeof AutomationRuleTriggerInputSchema
>

export const AutomationRulePolicyInputSchema = z.object({
  activeFrom: IsoInstantStringSchema.optional(),
  activeUntil: IsoInstantStringSchema.optional(),
  maxTriggerCount: z.number().int().positive().optional(),
  completionStatus: z.enum(AUTOMATION_COMPLETION_STATUSES).optional(),
})
export type AutomationRulePolicyInput = z.input<
  typeof AutomationRulePolicyInputSchema
>

export const AutomationRuleDeliveryInputSchema = z.object({
  message: z.string().default(""),
  wakeReason: z.string().optional(),
  messageBlocks: automationContentBlocksInputSchema,
  targetPolicy: z.enum(AUTOMATION_TARGET_POLICIES).optional(),
  targetParticipantIds: z.array(z.uuid()).optional(),
})
export type AutomationRuleDeliveryInput = z.input<
  typeof AutomationRuleDeliveryInputSchema
>

export const AutomationRuleDeliveryUpdateInputSchema = z.object({
  message: z.string().optional(),
  wakeReason: z.string().optional(),
  messageBlocks: automationContentBlocksInputSchema,
  targetPolicy: z.enum(AUTOMATION_TARGET_POLICIES).optional(),
  targetParticipantIds: z.array(z.uuid()).optional(),
})
export type AutomationRuleDeliveryUpdateInput = z.input<
  typeof AutomationRuleDeliveryUpdateInputSchema
>

export const AutomationRuleCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().default(""),
  status: z.enum(AUTOMATION_RULE_STATUSES).optional(),
  conversationId: z.uuid(),
  trigger: AutomationRuleTriggerInputSchema,
  policy: AutomationRulePolicyInputSchema.optional(),
  delivery: AutomationRuleDeliveryInputSchema,
  metadata: openRecord.optional(),
})
export type AutomationRuleCreateInput = z.input<
  typeof AutomationRuleCreateInputSchema
>

export const AutomationRuleUpdateInputSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(AUTOMATION_RULE_STATUSES).optional(),
  conversationId: z.uuid().optional(),
  trigger: AutomationRuleTriggerInputSchema.partial().optional(),
  policy: AutomationRulePolicyInputSchema.partial().optional(),
  delivery: AutomationRuleDeliveryUpdateInputSchema.optional(),
  metadata: openRecord.optional(),
})
export type AutomationRuleUpdateInput = z.input<
  typeof AutomationRuleUpdateInputSchema
>

export const AutomationWebhookEndpointCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(255),
  metadata: openRecord.optional(),
})
export type AutomationWebhookEndpointCreateInput = z.input<
  typeof AutomationWebhookEndpointCreateInputSchema
>

export const AutomationEventSourceIntegrationInputSchema = z.object({
  installationId: z.uuid(),
  provider: z.enum(AUTOMATION_INTEGRATION_PROVIDERS),
  ingressKind: z.enum(AUTOMATION_INTEGRATION_INGRESS_KINDS).optional(),
  targetKind: z.enum(AUTOMATION_INTEGRATION_TARGET_KINDS),
  targetId: z.string().trim().min(1).max(255),
  targetLabel: z.string().trim().min(1).max(255).optional(),
})
export type AutomationEventSourceIntegrationInput = z.input<
  typeof AutomationEventSourceIntegrationInputSchema
>

export const AutomationEventSourceCreateInputSchema = z
  .object({
    providerKind: z.enum(AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS),
    providerRef: z.string().trim().min(1).max(255).optional(),
    integration: AutomationEventSourceIntegrationInputSchema.optional(),
    sourceKey: z.string().trim().min(1).max(255).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().min(1).optional(),
    recommendedUsage: z.string().trim().min(1).optional(),
    payloadSchema: openRecord.optional(),
    examplePayload: openRecord.optional(),
    status: z.enum(AUTOMATION_EVENT_SOURCE_STATUSES).optional(),
    metadata: openRecord.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.providerKind === "integration") {
      if (!value.integration) {
        ctx.addIssue({
          code: "custom",
          path: ["integration"],
          message: "integration is required",
        })
      }
      if (!value.sourceKey) {
        ctx.addIssue({
          code: "custom",
          path: ["sourceKey"],
          message: "sourceKey is required",
        })
      }
      return
    }

    if (!value.name?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "name is required",
      })
    }
    if (!value.description?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: "description is required",
      })
    }
    if (value.providerKind === "webhook" && !value.providerRef?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["providerRef"],
        message: "providerRef is required",
      })
    }
  })
export type AutomationEventSourceCreateInput = z.input<
  typeof AutomationEventSourceCreateInputSchema
>

export const AutomationEventSourceUpdateInputSchema = z.object({
  providerRef: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().min(1).optional(),
  recommendedUsage: z.string().trim().min(1).optional(),
  payloadSchema: openRecord.optional(),
  examplePayload: openRecord.optional(),
  status: z.enum(AUTOMATION_EVENT_SOURCE_STATUSES).optional(),
  metadata: openRecord.optional(),
})
export type AutomationEventSourceUpdateInput = z.input<
  typeof AutomationEventSourceUpdateInputSchema
>

export const AutomationEventIngestInputSchema = z.object({
  payload: openRecord.optional(),
  sourceSnapshot: openRecord.optional(),
  dedupeKey: z.string().trim().min(1).max(255).optional(),
  occurredAt: IsoInstantStringSchema.optional(),
})
export type AutomationEventIngestInput = z.input<
  typeof AutomationEventIngestInputSchema
>

export const AutomationEventSourceListQuerySchema = z.object({
  status: z.enum(AUTOMATION_EVENT_SOURCE_STATUSES).optional(),
  providerKind: z.enum(AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS).optional(),
  providerRef: z.string().optional(),
  sourceKey: z.string().optional(),
})
export type AutomationEventSourceListQuery = z.input<
  typeof AutomationEventSourceListQuerySchema
>

export const AutomationRuleListQuerySchema = z.object({
  status: z.enum(AUTOMATION_RULE_STATUSES).optional(),
  category: z.enum(AUTOMATION_RULE_CATEGORIES).optional(),
  conversationId: z.uuid().optional(),
})
export type AutomationRuleListQuery = z.input<
  typeof AutomationRuleListQuerySchema
>
