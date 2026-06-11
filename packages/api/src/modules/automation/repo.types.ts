import type {
  AutomationCategory,
  AutomationCompletionStatus,
  AutomationCreatorKind,
  AutomationEventProviderKind,
  AutomationEventSourceStatus,
  AutomationExecutionStatus,
  AutomationIntegrationIngressKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
  AutomationSourceKind,
  AutomationStatus,
  AutomationTargetPolicy,
  AutomationTriggerKind,
  AutomationWebhookEndpoint,
} from "@synapse/shared"

/**
 * Automation repo layer record/projection shapes. These describe the raw SQL
 * row projections read by the service and mapped by the presenter. They live
 * here (the repo layer) so the repo owns the record shapes — both service.ts
 * and presenter.ts import them from this module. This file is a "repo" file: it
 * may reference generated/db row types, but must never import from ./service.js
 * or ./presenter.js (that would create an import cycle).
 */

export type AutomationRuleRow = {
  id: string
  workspace_id: string
  conversation_id: string
  category: AutomationCategory
  status: AutomationStatus
  name: string
  description: string
  created_by_participant_id: string
  created_by_session_id: string | null
  last_triggered_at: Date | null
  last_error_at: Date | null
  last_error_message: string | null
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
}

export type AutomationTriggerRow = {
  rule_id: string
  trigger_kind: AutomationTriggerKind
  source_kind: AutomationSourceKind
  event_source_id: string | null
  event_source_key?: string | null
  event_source_name?: string | null
  event_provider_kind?: AutomationEventProviderKind | null
  event_provider_ref?: string | null
  event_webhook_endpoint_id?: string | null
  event_integration_binding_id?: string | null
  event_integration_installation_id?: string | null
  event_integration_provider?: AutomationIntegrationProvider | null
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null
  event_integration_target_kind?: AutomationIntegrationTargetKind | null
  event_integration_target_id?: string | null
  event_integration_target_label?: string | null
  event_integration_webhook_endpoint_id?: string | null
  event_external_subscription_id?: string | null
  event_source_status?: AutomationEventSourceStatus | null
  source_locator: string | null
  match_key: string | null
  matcher: Record<string, unknown> | string | null
  schedule_kind: string | null
  schedule_expr: string | null
  schedule_timezone: string | null
  interval_seconds: number | null
  starts_at: Date | null
  next_fire_at: Date | null
  last_fired_at: Date | null
  metadata: Record<string, unknown> | string | null
}

export type AutomationPolicyRow = {
  rule_id: string
  active_from: Date | null
  active_until: Date | null
  max_trigger_count: number | null
  trigger_count: number
  completion_status: AutomationCompletionStatus
  completed_at: Date | null
  metadata: Record<string, unknown> | string | null
}

export type AutomationDeliveryRow = {
  rule_id: string
  message_text: string
  wake_reason_text: string | null
  message_blocks: unknown
  target_policy: AutomationTargetPolicy
  metadata: Record<string, unknown> | string | null
}

export type AutomationEventSourceRow = {
  id: string
  workspace_id: string
  provider_kind: AutomationEventProviderKind
  provider_ref: string | null
  webhook_endpoint_id: string | null
  integration_binding_id: string | null
  integration_installation_id?: string | null
  integration_provider?: AutomationIntegrationProvider | null
  integration_ingress_kind?: AutomationIntegrationIngressKind | null
  integration_target_kind?: AutomationIntegrationTargetKind | null
  integration_target_id?: string | null
  integration_target_label?: string | null
  integration_webhook_endpoint_id?: string | null
  integration_external_subscription_id?: string | null
  source_key: string
  name: string
  description: string
  recommended_usage: string
  payload_schema: Record<string, unknown> | string | null
  example_payload: Record<string, unknown> | string | null
  status: AutomationEventSourceStatus
  created_by_kind: AutomationCreatorKind
  created_by_workspace_member_id: string | null
  created_by_actor_id: string | null
  created_by_session_id: string | null
  last_triggered_at: Date | null
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
}

export type AutomationOccurrenceRow = {
  id: string
  workspace_id: string
  source_kind: AutomationSourceKind
  event_source_id: string | null
  event_source_key?: string | null
  event_source_name?: string | null
  event_provider_ref?: string | null
  event_webhook_endpoint_id?: string | null
  event_integration_binding_id?: string | null
  event_integration_installation_id?: string | null
  event_integration_provider?: AutomationIntegrationProvider | null
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null
  event_integration_target_kind?: AutomationIntegrationTargetKind | null
  event_integration_target_id?: string | null
  event_integration_target_label?: string | null
  event_integration_webhook_endpoint_id?: string | null
  event_external_subscription_id?: string | null
  source_locator: string | null
  match_key: string | null
  dedupe_key: string | null
  source_snapshot: Record<string, unknown> | string | null
  payload: Record<string, unknown> | string | null
  occurred_at: Date
  created_at: Date
}

export type AutomationExecutionRow = {
  id: string
  workspace_id: string
  rule_id: string
  execution_rule_name?: string | null
  occurrence_id: string
  occurrence_occurred_at?: Date | null
  occurrence_source_kind?: AutomationSourceKind | null
  occurrence_event_source_name?: string | null
  occurrence_display_title?: string | null
  occurrence_display_summary?: string | null
  occurrence_display_description?: string | null
  status: AutomationExecutionStatus
  attempt_count: number
  error_message: string | null
  started_at: Date | null
  completed_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * AutomationExecutionRow joined with the occurrence columns selected by the
 * executions-list query (LEFT JOIN automation_occurrences/event_sources). The
 * service reads these rows; the presenter merges the occurrence projection onto
 * the execution view.
 */
export type AutomationExecutionWithOccurrenceRow = AutomationExecutionRow & {
  occurrence_source_kind?: AutomationSourceKind | null
  event_source_key?: string | null
  event_provider_ref?: string | null
  source_snapshot?: Record<string, unknown> | string | null
  payload?: Record<string, unknown> | string | null
  source_locator?: string | null
  match_key?: string | null
  dedupe_key?: string | null
  occurrence_created_at?: Date | null
}

export type AutomationWebhookEndpointRow = {
  id: string
  workspace_id: string
  name: string
  status: AutomationWebhookEndpoint["status"]
  path_token: string
  secret_ciphertext?: string
  secret_hint: string
  metadata: Record<string, unknown> | string | null
  created_by_workspace_member_id: string | null
  last_received_at: Date | null
  created_at: Date
  updated_at: Date
}
