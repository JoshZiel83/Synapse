import type {
  AutomationDelivery,
  AutomationEventSource,
  AutomationEventSourceIntegration,
  AutomationEventProviderKind,
  AutomationExecution,
  AutomationIntegrationIngressKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
  AutomationOccurrence,
  AutomationPolicy,
  AutomationRule,
  AutomationTrigger,
  AutomationWebhookEndpoint,
  CanonicalContentBlock,
} from "@synapse/shared"
import {
  normalizeCanonicalContentBlocks,
  parseJsonObject,
  resolveAutomationOccurrenceDisplay,
} from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
  type IsoInstantString,
} from "../../infrastructure/datetime.js"
import type {
  AutomationDeliveryRow,
  AutomationEventSourceRow,
  AutomationExecutionRow,
  AutomationOccurrenceRow,
  AutomationPolicyRow,
  AutomationRuleRow,
  AutomationTriggerRow as AutomationTriggerDbRow,
  AutomationWebhookEndpointRow,
} from "./repo.types.js"

/**
 * Automation presentation layer: DB row → app-facing view. Owns the outward
 * semantic transforms (Date → IsoInstantString via serializeInstant) so the
 * service/controller never call serializeInstant (guard-layering r3) and the
 * row→view mappers live outside service.ts (guard-layering r4). See §5.1.
 */

function normalizeContentBlocks(value: unknown): CanonicalContentBlock[] {
  if (!Array.isArray(value)) return []
  return normalizeCanonicalContentBlocks(value as any[])
}

export function presentEventSourceIntegration(row: {
  integration_binding_id?: string | null
  integration_webhook_endpoint_id?: string | null
  integration_installation_id?: string | null
  integration_provider?: AutomationIntegrationProvider | null
  integration_ingress_kind?: AutomationIntegrationIngressKind | null
  integration_target_kind?: AutomationIntegrationTargetKind | null
  integration_target_id?: string | null
  integration_target_label?: string | null
  integration_external_subscription_id?: string | null
}): AutomationEventSourceIntegration | undefined {
  if (
    !row.integration_installation_id ||
    !row.integration_provider ||
    !row.integration_ingress_kind ||
    !row.integration_target_kind ||
    !row.integration_target_id ||
    !row.integration_target_label
  ) {
    return undefined
  }

  return {
    bindingId: row.integration_binding_id || undefined,
    installationId: row.integration_installation_id,
    provider: row.integration_provider,
    ingressKind: row.integration_ingress_kind,
    targetKind: row.integration_target_kind,
    targetId: row.integration_target_id,
    targetLabel: row.integration_target_label,
    endpointId: row.integration_webhook_endpoint_id || undefined,
    externalSubscriptionId:
      row.integration_external_subscription_id || undefined,
  }
}

export function presentRule(
  row: AutomationRuleRow,
  trigger: AutomationTrigger,
  policy: AutomationPolicy,
  delivery: AutomationDelivery
): AutomationRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    authorityWorkspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    category: row.category,
    status: row.status,
    name: row.name,
    description: row.description,
    createdByParticipantId: row.created_by_participant_id,
    createdBySessionId: row.created_by_session_id || undefined,
    trigger,
    policy,
    delivery,
    lastTriggeredAt: serializeOptionalInstant(row.last_triggered_at),
    lastErrorAt: serializeOptionalInstant(row.last_error_at),
    lastErrorMessage: row.last_error_message || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

export function presentTrigger(row: AutomationTriggerDbRow): AutomationTrigger {
  return {
    ruleId: row.rule_id,
    triggerKind: row.trigger_kind,
    sourceKind: row.source_kind,
    eventSourceId: row.event_source_id || undefined,
    eventSourceKey:
      (row as AutomationTriggerDbRow & { event_source_key?: string | null })
        .event_source_key || undefined,
    eventSourceName:
      (row as AutomationTriggerDbRow & { event_source_name?: string | null })
        .event_source_name || undefined,
    eventProviderKind:
      (
        row as AutomationTriggerDbRow & {
          event_provider_kind?: AutomationEventProviderKind | null
        }
      ).event_provider_kind || undefined,
    eventProviderRef:
      (row as AutomationTriggerDbRow & { event_provider_ref?: string | null })
        .event_provider_ref || undefined,
    eventSourceIntegration: presentEventSourceIntegration({
      integration_binding_id: row.event_integration_binding_id,
      integration_webhook_endpoint_id:
        row.event_integration_webhook_endpoint_id,
      integration_installation_id: row.event_integration_installation_id,
      integration_provider: row.event_integration_provider,
      integration_ingress_kind: row.event_integration_ingress_kind,
      integration_target_kind: row.event_integration_target_kind,
      integration_target_id: row.event_integration_target_id,
      integration_target_label: row.event_integration_target_label,
      integration_external_subscription_id: row.event_external_subscription_id,
    }),
    eventSourceStatus:
      (
        row as AutomationTriggerDbRow & {
          event_source_status?: AutomationTrigger["eventSourceStatus"]
        }
      ).event_source_status || undefined,
    sourceLocator: row.source_locator || undefined,
    matchKey: row.match_key || undefined,
    matcher: parseJsonObject(row.matcher),
    scheduleKind:
      (row.schedule_kind as AutomationTrigger["scheduleKind"]) || undefined,
    scheduleExpr: row.schedule_expr || undefined,
    scheduleTimezone: row.schedule_timezone || undefined,
    intervalSeconds: row.interval_seconds || undefined,
    startsAt: serializeOptionalInstant(row.starts_at),
    nextFireAt: serializeOptionalInstant(row.next_fire_at),
    lastFiredAt: serializeOptionalInstant(row.last_fired_at),
    metadata: parseJsonObject(row.metadata),
  }
}

export function presentPolicy(row: AutomationPolicyRow): AutomationPolicy {
  return {
    ruleId: row.rule_id,
    activeFrom: serializeOptionalInstant(row.active_from),
    activeUntil: serializeOptionalInstant(row.active_until),
    maxTriggerCount: row.max_trigger_count || undefined,
    triggerCount: row.trigger_count,
    completionStatus: row.completion_status,
    completedAt: serializeOptionalInstant(row.completed_at),
    metadata: parseJsonObject(row.metadata),
  }
}

export function presentDelivery(
  row: AutomationDeliveryRow,
  targetParticipantIds: string[]
): AutomationDelivery {
  return {
    ruleId: row.rule_id,
    messageText: row.message_text || "",
    wakeReasonText: row.wake_reason_text || undefined,
    messageBlocks: normalizeContentBlocks(row.message_blocks),
    targetPolicy: row.target_policy,
    targetParticipantIds,
    metadata: parseJsonObject(row.metadata),
  }
}

export function presentEventSource(
  row: AutomationEventSourceRow
): AutomationEventSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    providerKind: row.provider_kind,
    providerRef: row.provider_ref || undefined,
    integration: presentEventSourceIntegration(row),
    sourceKey: row.source_key,
    name: row.name,
    description: row.description,
    recommendedUsage: row.recommended_usage || undefined,
    payloadSchema: parseJsonObject(row.payload_schema),
    examplePayload: parseJsonObject(row.example_payload),
    status: row.status,
    createdByKind: row.created_by_kind,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    createdByActorId: row.created_by_actor_id || undefined,
    createdBySessionId: row.created_by_session_id || undefined,
    lastTriggeredAt: serializeOptionalInstant(row.last_triggered_at),
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

function defaultOccurrenceTitle(
  occurrence: Pick<
    AutomationOccurrence,
    "eventSourceName" | "matchKey" | "sourceLocator" | "sourceKind"
  >
) {
  return (
    occurrence.eventSourceName ||
    occurrence.matchKey ||
    occurrence.sourceLocator ||
    occurrence.sourceKind
  )
}

function defaultOccurrenceSummary(payload: Record<string, unknown>) {
  const payloadKeys = Object.keys(payload || {})
  if (payloadKeys.length === 0) {
    return "No payload fields"
  }
  return payloadKeys.slice(0, 6).join(", ")
}

export function decorateOccurrenceDisplay(
  occurrence: AutomationOccurrence,
  options?: { eventProviderRef?: string }
): AutomationOccurrence {
  const display = resolveAutomationOccurrenceDisplay({
    sourceKind: occurrence.sourceKind,
    eventDefinitionKey: occurrence.eventSourceKey,
    sourceName: occurrence.eventSourceName,
    providerRef: options?.eventProviderRef,
    sourceSnapshot: occurrence.sourceSnapshot,
    payload: occurrence.payload,
    occurredAt: occurrence.occurredAt,
  })

  return {
    ...occurrence,
    displayTitle: display?.title || defaultOccurrenceTitle(occurrence),
    displaySummary:
      display?.summary || defaultOccurrenceSummary(occurrence.payload),
    displayDescription: display?.description || undefined,
  }
}

export function presentOccurrence(
  row: AutomationOccurrenceRow
): AutomationOccurrence {
  return decorateOccurrenceDisplay(
    {
      id: row.id,
      workspaceId: row.workspace_id,
      sourceKind: row.source_kind,
      eventSourceId: row.event_source_id || undefined,
      eventSourceKey:
        (row as AutomationOccurrenceRow & { event_source_key?: string | null })
          .event_source_key || undefined,
      eventSourceName:
        (row as AutomationOccurrenceRow & { event_source_name?: string | null })
          .event_source_name || undefined,
      eventSourceIntegration: presentEventSourceIntegration({
        integration_binding_id: row.event_integration_binding_id,
        integration_webhook_endpoint_id:
          row.event_integration_webhook_endpoint_id,
        integration_installation_id: row.event_integration_installation_id,
        integration_provider: row.event_integration_provider,
        integration_ingress_kind: row.event_integration_ingress_kind,
        integration_target_kind: row.event_integration_target_kind,
        integration_target_id: row.event_integration_target_id,
        integration_target_label: row.event_integration_target_label,
        integration_external_subscription_id:
          row.event_external_subscription_id,
      }),
      sourceLocator: row.source_locator || undefined,
      matchKey: row.match_key || undefined,
      dedupeKey: row.dedupe_key || undefined,
      sourceSnapshot: parseJsonObject(row.source_snapshot),
      payload: parseJsonObject(row.payload),
      occurredAt: serializeInstant(row.occurred_at),
      createdAt: serializeInstant(row.created_at),
    },
    {
      eventProviderRef:
        (
          row as AutomationOccurrenceRow & {
            event_provider_ref?: string | null
          }
        ).event_provider_ref || undefined,
    }
  )
}

export function presentExecution(
  row: AutomationExecutionRow
): AutomationExecution {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    occurrenceId: row.occurrence_id,
    occurrenceOccurredAt: serializeOptionalInstant(row.occurrence_occurred_at),
    occurrenceSourceKind: row.occurrence_source_kind || undefined,
    occurrenceEventSourceName: row.occurrence_event_source_name || undefined,
    occurrenceTitle: row.occurrence_display_title || undefined,
    occurrenceSummary: row.occurrence_display_summary || undefined,
    occurrenceDescription: row.occurrence_display_description || undefined,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: serializeOptionalInstant(row.started_at),
    completedAt: serializeOptionalInstant(row.completed_at),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

export function presentWebhookEndpoint(
  row: AutomationWebhookEndpointRow
): AutomationWebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    pathToken: row.path_token,
    secretHint: row.secret_hint,
    metadata: parseJsonObject(row.metadata),
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    lastReceivedAt: serializeOptionalInstant(row.last_received_at),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

/**
 * Serialize the date columns selected for due-schedule processing into ISO
 * instant strings. Kept here so service.ts never calls serializeInstant
 * directly (guard-layering r3). Behavior preserved exactly: same fields, same
 * serializer functions.
 */
export function presentDueScheduleRowDates(row: {
  starts_at: Date | null
  active_from: Date | null
  active_until: Date | null
  next_fire_at: Date
}): {
  startsAt: IsoInstantString | undefined
  activeFrom: IsoInstantString | undefined
  activeUntil: IsoInstantString | undefined
  nextFireAt: IsoInstantString
} {
  return {
    startsAt: serializeOptionalInstant(row.starts_at),
    activeFrom: serializeOptionalInstant(row.active_from),
    activeUntil: serializeOptionalInstant(row.active_until),
    nextFireAt: serializeInstant(row.next_fire_at),
  }
}
