import { z } from "zod"
import {
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the automation module's APP routes (master plan
 * §5.3). Every modeled route here is workspace-scoped + authenticated, so its
 * response value is wrapped through `appRoute` → `sendData` → `{ data: ... }`.
 * These schemas describe the value each handler returns (the helper wraps it).
 *
 * Top-level scalar/enum fields are modeled explicitly. Genuinely-open nested
 * values (matchers, metadata, payload/snapshot blobs, message blocks, capability
 * access-target refs) are the shapes the presenter/service already own, so they
 * are modeled as open records / `z.unknown()` — the boundary only round-trips
 * them unchanged, not re-validates their interior. Status enums whose source of
 * truth is a TS union (no const array) are modeled as `z.string()` to avoid
 * drift while still asserting the field's presence/type.
 */

const openRecord = z.record(z.string(), z.unknown())

const eventSourceIntegrationSchema = z.object({
  bindingId: z.string().optional(),
  installationId: z.string(),
  provider: z.string(),
  ingressKind: z.string(),
  targetKind: z.string(),
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
  createdByKind: z.string(),
  createdByWorkspaceMemberId: z.string().optional(),
  createdByActorId: z.string().optional(),
  createdBySessionId: z.string().optional(),
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
  messageBlocks: z.array(z.unknown()),
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
  category: z.string(),
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
  status: z.string(),
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
  status: z.string(),
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

/**
 * AutomationEventSourceAccessGrant view. `target` is a CapabilityAccessTarget
 * (an open subject/scope ref the access layer owns) so it round-trips as an
 * open record; the mask fields are nullable scalars.
 */
export const AutomationEventSourceAccessGrantSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  workspaceId: z.string(),
  target: openRecord,
  status: z.string(),
  grantedByWorkspaceMemberId: z.string().optional(),
  reason: z.string().optional(),
  conversationTypeMaskOverride: z.number().nullable().optional(),
  effectiveConversationTypeMask: z.number().optional(),
  createdAt: IsoInstantStringSchema,
  revokedAt: IsoInstantStringSchema.optional(),
})
export type AutomationEventSourceAccessGrantSchemaType = z.infer<
  typeof AutomationEventSourceAccessGrantSchema
>

/** GET event-source access state: `{ grants, summary }`. */
export const AutomationEventSourceAccessStateSchema = z.object({
  grants: z.array(AutomationEventSourceAccessGrantSchema),
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

/**
 * POST grant / PUT update access grant: handler returns `{ grant }`. The grant
 * matches the access-grant view.
 */
export const AutomationAccessGrantEnvelopeSchema = z.object({
  grant: AutomationEventSourceAccessGrantSchema,
})
export type AutomationAccessGrantEnvelopeSchemaType = z.infer<
  typeof AutomationAccessGrantEnvelopeSchema
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
