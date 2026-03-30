import crypto from 'node:crypto';
import cronParser from 'cron-parser';
import { v4 as uuidv4 } from 'uuid';
import type {
  AutomationCategory,
  AutomationCompletionStatus,
  AutomationCreatorKind,
  AutomationDelivery,
  AutomationDeliveryMode,
  AutomationExecution,
  AutomationEventProviderKind,
  AutomationPolicy,
  AutomationEventSource,
  AutomationEventSourceIntegration,
  AutomationEventSourceStatus,
  AutomationExecutionStatus,
  AutomationIntegrationIngressKind,
  AutomationIntegrationProvider,
  AutomationIntegrationTargetKind,
  AutomationOccurrence,
  AutomationRule,
  AutomationSourceKind,
  AutomationStatus,
  AutomationTargetEntityKind,
  AutomationTargetEntityRef,
  AutomationTargetPolicy,
  AutomationTrigger,
  AutomationTriggerKind,
  AutomationWebhookEndpoint,
  AutomationWebhookEndpointCreateResult,
  CanonicalContentBlock,
} from '@synapse/shared';
import { extractText, nowISO, resolveAutomationOccurrenceDisplay } from '@synapse/shared';
import {
  mergeAutomationRuleUpdatePayload,
  validateAutomationRuleCreatePayload,
} from '@synapse/shared/automation';
import { decrypt, encrypt } from '../../infrastructure/crypto/index.js';
import { transaction } from '../../infrastructure/database/index.js';
import { executeSql, executeSqlOn } from '../../infrastructure/database/kysely.js';
import { createConversationEvent, getConversation, listConversationMembers } from '../conversation/service.js';
import { buildNormalizedMessageContent } from '../conversation/message-content.js';
import {
  buildIntegrationEventSourceTemplate,
  getIntegrationInstallation,
  integrationWebhookCallbackUrl,
  listIntegrationSourceKeysForWebhookIngress,
  normalizeIntegrationWebhookIngress,
  registerIntegrationWebhook,
  updateIntegrationWebhook,
  unregisterIntegrationWebhook,
} from './integrations.js';
import { enqueueSessionWakeup } from '../session/runtime.js';
import { getSession } from '../session/service.js';
import {
  addMembersToConversation,
  createThread,
  getConversationMembers,
} from '../conversation/chat-service.js';

type AutomationRuleRow = {
  id: string;
  workspace_id: string;
  category: AutomationCategory;
  status: AutomationStatus;
  name: string;
  description: string;
  created_by_kind: AutomationCreatorKind;
  created_by_user_id: string | null;
  created_by_actor_id: string | null;
  created_by_session_id: string | null;
  owner_conversation_id: string | null;
  owner_session_id: string | null;
  last_triggered_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
};

type AutomationTriggerRow = {
  rule_id: string;
  trigger_kind: AutomationTriggerKind;
  source_kind: AutomationSourceKind;
  event_source_id: string | null;
  event_source_key?: string | null;
  event_source_name?: string | null;
  event_provider_kind?: AutomationEventProviderKind | null;
  event_provider_ref?: string | null;
  event_webhook_endpoint_id?: string | null;
  event_integration_binding_id?: string | null;
  event_integration_installation_id?: string | null;
  event_integration_provider?: AutomationIntegrationProvider | null;
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null;
  event_integration_target_kind?: AutomationIntegrationTargetKind | null;
  event_integration_target_id?: string | null;
  event_integration_target_label?: string | null;
  event_integration_webhook_endpoint_id?: string | null;
  event_external_subscription_id?: string | null;
  event_source_status?: AutomationEventSourceStatus | null;
  source_locator: string | null;
  match_key: string | null;
  matcher: Record<string, unknown> | string | null;
  schedule_kind: string | null;
  schedule_expr: string | null;
  schedule_timezone: string | null;
  interval_seconds: number | null;
  starts_at: string | null;
  next_fire_at: string | null;
  last_fired_at: string | null;
  metadata: Record<string, unknown> | string | null;
};

type AutomationPolicyRow = {
  rule_id: string;
  active_from: string | null;
  active_until: string | null;
  max_trigger_count: number | null;
  trigger_count: number;
  completion_status: AutomationCompletionStatus;
  completed_at: string | null;
  metadata: Record<string, unknown> | string | null;
};

type AutomationDeliveryRow = {
  rule_id: string;
  delivery_mode: AutomationDeliveryMode;
  conversation_id: string | null;
  session_id: string | null;
  reused_conversation_id: string | null;
  conversation_title: string | null;
  message_text: string;
  wake_reason_text: string | null;
  message_blocks: unknown;
  target_policy: AutomationTargetPolicy;
  metadata: Record<string, unknown> | string | null;
};

type AutomationEventSourceRow = {
  id: string;
  workspace_id: string;
  provider_kind: AutomationEventProviderKind;
  provider_ref: string | null;
  webhook_endpoint_id: string | null;
  integration_binding_id: string | null;
  integration_installation_id?: string | null;
  integration_provider?: AutomationIntegrationProvider | null;
  integration_ingress_kind?: AutomationIntegrationIngressKind | null;
  integration_target_kind?: AutomationIntegrationTargetKind | null;
  integration_target_id?: string | null;
  integration_target_label?: string | null;
  integration_webhook_endpoint_id?: string | null;
  integration_external_subscription_id?: string | null;
  source_key: string;
  name: string;
  description: string;
  recommended_usage: string;
  payload_schema: Record<string, unknown> | string | null;
  example_payload: Record<string, unknown> | string | null;
  status: AutomationEventSourceStatus;
  created_by_kind: AutomationCreatorKind;
  created_by_user_id: string | null;
  created_by_actor_id: string | null;
  created_by_session_id: string | null;
  last_triggered_at: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
};

type AutomationOccurrenceRow = {
  id: string;
  workspace_id: string;
  source_kind: AutomationSourceKind;
  event_source_id: string | null;
  event_source_key?: string | null;
  event_source_name?: string | null;
  event_provider_ref?: string | null;
  event_webhook_endpoint_id?: string | null;
  event_integration_binding_id?: string | null;
  event_integration_installation_id?: string | null;
  event_integration_provider?: AutomationIntegrationProvider | null;
  event_integration_ingress_kind?: AutomationIntegrationIngressKind | null;
  event_integration_target_kind?: AutomationIntegrationTargetKind | null;
  event_integration_target_id?: string | null;
  event_integration_target_label?: string | null;
  event_integration_webhook_endpoint_id?: string | null;
  event_external_subscription_id?: string | null;
  source_locator: string | null;
  match_key: string | null;
  dedupe_key: string | null;
  source_snapshot: Record<string, unknown> | string | null;
  payload: Record<string, unknown> | string | null;
  occurred_at: string;
  created_at: string;
};

type AutomationExecutionRow = {
  id: string;
  workspace_id: string;
  rule_id: string;
  execution_rule_name?: string | null;
  occurrence_id: string;
  occurrence_occurred_at?: string | null;
  occurrence_source_kind?: AutomationSourceKind | null;
  occurrence_event_source_name?: string | null;
  occurrence_display_title?: string | null;
  occurrence_display_summary?: string | null;
  occurrence_display_description?: string | null;
  status: AutomationExecutionStatus;
  attempt_count: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type AutomationTargetRow = {
  id: string;
  execution_id: string;
  conversation_id: string | null;
  session_id: string | null;
  target_actor_id: string | null;
  target_user_id: string | null;
  created_item_id: string | null;
  wakeup_id: string | null;
  status: AutomationExecutionStatus;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
};

type TargetEntityRow = {
  rule_id: string;
  entity_kind: AutomationTargetEntityKind;
  entity_id: string;
};

type AutomationWebhookEndpointRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: AutomationWebhookEndpoint['status'];
  path_token: string;
  secret_ciphertext?: string;
  secret_hint: string;
  metadata: Record<string, unknown> | string | null;
  created_by: string | null;
  last_received_at: string | null;
  created_at: string;
  updated_at: string;
};

type AutomationIntegrationBindingRow = {
  id: string;
  workspace_id: string;
  installation_id: string;
  provider: AutomationIntegrationProvider;
  ingress_kind: AutomationIntegrationIngressKind;
  target_kind: AutomationIntegrationTargetKind;
  target_id: string;
  target_label: string;
  webhook_endpoint_id: string | null;
  external_subscription_id: string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string;
  updated_at: string;
};

type AutomationValidationError = Error & {
  issues: { path: string; message: string }[];
  statusCode: 400;
};

type SqlRunner = <T = any>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>;

type QueryRunner = {
  run: SqlRunner;
};

type QueryClient = { query: (text: string, params?: any[]) => Promise<any> };
type QueryRunnerLike = QueryRunner | QueryClient;

function resolveQueryRunner(
  client?: QueryRunnerLike,
): QueryRunner {
  if (client && 'run' in client) {
    return client;
  }
  return client
    ? {
        run: <T = any>(text: string, params?: unknown[]) =>
          executeSqlOn<T>(client, text, params),
      }
    : {
        run: executeSql,
      };
}

function createAutomationValidationError(
  issues: { path: string; message: string }[],
): AutomationValidationError {
  const error = new Error(issues[0]?.message || 'Invalid automation configuration') as AutomationValidationError;
  error.name = 'AutomationValidationError';
  error.issues = issues;
  error.statusCode = 400;
  return error;
}

export interface AutomationCreatorInput {
  kind: AutomationCreatorKind;
  userId?: string;
  actorId?: string;
  sessionId?: string;
}

export interface AutomationTriggerInput {
  triggerKind: AutomationTriggerKind;
  eventSourceId?: string;
  sourceKind?: AutomationSourceKind;
  sourceLocator?: string;
  matchKey?: string;
  matcher?: Record<string, unknown>;
  scheduleKind?: 'cron' | 'at' | 'interval';
  scheduleExpr?: string;
  scheduleTimezone?: string;
  intervalSeconds?: number;
  startsAt?: string;
}

export interface AutomationPolicyInput {
  activeFrom?: string;
  activeUntil?: string;
  maxTriggerCount?: number;
  completionStatus?: AutomationCompletionStatus;
}

export interface AutomationDeliveryInput {
  deliveryMode: AutomationDeliveryMode;
  conversationId?: string;
  sessionId?: string;
  conversationTitle?: string;
  message?: string;
  wakeReason?: string;
  messageBlocks?: CanonicalContentBlock[];
  targetPolicy?: AutomationTargetPolicy;
  participantActorIds?: string[];
  participantUserIds?: string[];
  recipientActorIds?: string[];
  recipientUserIds?: string[];
}

export interface CreateAutomationRuleInput {
  name: string;
  description?: string;
  status?: AutomationStatus;
  ownerConversationId?: string;
  ownerSessionId?: string;
  trigger: AutomationTriggerInput;
  policy?: AutomationPolicyInput;
  delivery: AutomationDeliveryInput;
  metadata?: Record<string, unknown>;
}

export interface UpdateAutomationRuleInput extends Partial<Omit<CreateAutomationRuleInput, 'trigger' | 'delivery'>> {
  trigger?: Partial<AutomationTriggerInput>;
  delivery?: Partial<AutomationDeliveryInput>;
}

export interface AutomationEventEnvelope {
  workspaceId: string;
  eventSourceId: string;
  payload?: Record<string, unknown>;
  sourceSnapshot?: Record<string, unknown>;
  occurredAt?: string;
  dedupeKey?: string;
}

export interface AutomationEventSourceIntegrationInput {
  installationId: string;
  provider: AutomationIntegrationProvider;
  ingressKind?: AutomationIntegrationIngressKind;
  targetKind: AutomationIntegrationTargetKind;
  targetId: string;
  targetLabel?: string;
}

export interface CreateAutomationEventSourceInput {
  providerKind: AutomationEventProviderKind;
  providerRef?: string;
  integration?: AutomationEventSourceIntegrationInput;
  sourceKey?: string;
  name?: string;
  description?: string;
  recommendedUsage?: string;
  payloadSchema?: Record<string, unknown>;
  examplePayload?: Record<string, unknown>;
  status?: AutomationEventSourceStatus;
  metadata?: Record<string, unknown>;
}

export interface UpdateAutomationEventSourceInput {
  providerRef?: string;
  name?: string;
  description?: string;
  recommendedUsage?: string;
  payloadSchema?: Record<string, unknown>;
  examplePayload?: Record<string, unknown>;
  status?: AutomationEventSourceStatus;
  metadata?: Record<string, unknown>;
}

export interface ScheduleDueRulesResult {
  scheduledExecutions: string[];
}

export interface ProcessAutomationExecutionResult {
  executionId: string;
  createdConversationId?: string;
  createdItemId?: string;
  wakeupCount: number;
}

const AUTOMATION_SCHEDULER_INTERVAL_MS = 15_000;
const MAX_SCHEDULER_BATCH_SIZE = 50;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeContentBlocks(value: unknown): CanonicalContentBlock[] {
  return Array.isArray(value)
    ? value.filter((block): block is CanonicalContentBlock => Boolean(block) && typeof block === 'object')
    : [];
}

function mapEventSourceIntegration(row: {
  integration_binding_id?: string | null;
  integration_webhook_endpoint_id?: string | null;
  integration_installation_id?: string | null;
  integration_provider?: AutomationIntegrationProvider | null;
  integration_ingress_kind?: AutomationIntegrationIngressKind | null;
  integration_target_kind?: AutomationIntegrationTargetKind | null;
  integration_target_id?: string | null;
  integration_target_label?: string | null;
  integration_external_subscription_id?: string | null;
}): AutomationEventSourceIntegration | undefined {
  if (
    !row.integration_installation_id ||
    !row.integration_provider ||
    !row.integration_ingress_kind ||
    !row.integration_target_kind ||
    !row.integration_target_id ||
    !row.integration_target_label
  ) {
    return undefined;
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
    externalSubscriptionId: row.integration_external_subscription_id || undefined,
  };
}

function mapRuleRow(
  row: AutomationRuleRow,
  trigger: AutomationTrigger,
  policy: AutomationPolicy,
  delivery: AutomationDelivery,
): AutomationRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    category: row.category,
    status: row.status,
    name: row.name,
    description: row.description,
    createdByKind: row.created_by_kind,
    createdByUserId: row.created_by_user_id || undefined,
    createdByActorId: row.created_by_actor_id || undefined,
    createdBySessionId: row.created_by_session_id || undefined,
    ownerConversationId: row.owner_conversation_id || undefined,
    ownerSessionId: row.owner_session_id || undefined,
    trigger,
    policy,
    delivery,
    lastTriggeredAt: row.last_triggered_at || undefined,
    lastErrorAt: row.last_error_at || undefined,
    lastErrorMessage: row.last_error_message || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTriggerRow(row: AutomationTriggerRow): AutomationTrigger {
  return {
    ruleId: row.rule_id,
    triggerKind: row.trigger_kind,
    sourceKind: row.source_kind,
    eventSourceId: row.event_source_id || undefined,
    eventSourceKey: (row as AutomationTriggerRow & { event_source_key?: string | null }).event_source_key || undefined,
    eventSourceName: (row as AutomationTriggerRow & { event_source_name?: string | null }).event_source_name || undefined,
    eventProviderKind:
      ((row as AutomationTriggerRow & { event_provider_kind?: AutomationEventProviderKind | null }).event_provider_kind ||
        undefined),
    eventProviderRef:
      (row as AutomationTriggerRow & { event_provider_ref?: string | null }).event_provider_ref || undefined,
    eventSourceIntegration: mapEventSourceIntegration({
      integration_binding_id: row.event_integration_binding_id,
      integration_webhook_endpoint_id: row.event_integration_webhook_endpoint_id,
      integration_installation_id: row.event_integration_installation_id,
      integration_provider: row.event_integration_provider,
      integration_ingress_kind: row.event_integration_ingress_kind,
      integration_target_kind: row.event_integration_target_kind,
      integration_target_id: row.event_integration_target_id,
      integration_target_label: row.event_integration_target_label,
      integration_external_subscription_id: row.event_external_subscription_id,
    }),
    eventSourceStatus:
      ((row as AutomationTriggerRow & { event_source_status?: AutomationEventSourceStatus | null }).event_source_status ||
        undefined),
    sourceLocator: row.source_locator || undefined,
    matchKey: row.match_key || undefined,
    matcher: parseJsonObject(row.matcher),
    scheduleKind: (row.schedule_kind as AutomationTrigger['scheduleKind']) || undefined,
    scheduleExpr: row.schedule_expr || undefined,
    scheduleTimezone: row.schedule_timezone || undefined,
    intervalSeconds: row.interval_seconds || undefined,
    startsAt: row.starts_at || undefined,
    nextFireAt: row.next_fire_at || undefined,
    lastFiredAt: row.last_fired_at || undefined,
    metadata: parseJsonObject(row.metadata),
  };
}

function mapPolicyRow(row: AutomationPolicyRow): AutomationPolicy {
  return {
    ruleId: row.rule_id,
    activeFrom: row.active_from || undefined,
    activeUntil: row.active_until || undefined,
    maxTriggerCount: row.max_trigger_count || undefined,
    triggerCount: row.trigger_count,
    completionStatus: row.completion_status,
    completedAt: row.completed_at || undefined,
    metadata: parseJsonObject(row.metadata),
  };
}

function mapDeliveryRow(
  row: AutomationDeliveryRow,
  participants: AutomationTargetEntityRef[],
  recipients: AutomationTargetEntityRef[],
): AutomationDelivery {
  return {
    ruleId: row.rule_id,
    deliveryMode: row.delivery_mode,
    conversationId: row.conversation_id || undefined,
    sessionId: row.session_id || undefined,
    reusedConversationId: row.reused_conversation_id || undefined,
    conversationTitle: row.conversation_title || undefined,
    messageText: row.message_text || '',
    wakeReasonText: row.wake_reason_text || undefined,
    messageBlocks: normalizeContentBlocks(row.message_blocks),
    targetPolicy: row.target_policy,
    participants,
    recipients,
    metadata: parseJsonObject(row.metadata),
  };
}

function mapEventSourceRow(row: AutomationEventSourceRow): AutomationEventSource {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    providerKind: row.provider_kind,
    providerRef: row.provider_ref || undefined,
    integration: mapEventSourceIntegration(row),
    sourceKey: row.source_key,
    name: row.name,
    description: row.description,
    recommendedUsage: row.recommended_usage || undefined,
    payloadSchema: parseJsonObject(row.payload_schema),
    examplePayload: parseJsonObject(row.example_payload),
    status: row.status,
    createdByKind: row.created_by_kind,
    createdByUserId: row.created_by_user_id || undefined,
    createdByActorId: row.created_by_actor_id || undefined,
    createdBySessionId: row.created_by_session_id || undefined,
    lastTriggeredAt: row.last_triggered_at || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultOccurrenceTitle(occurrence: Pick<AutomationOccurrence, 'eventSourceName' | 'matchKey' | 'sourceLocator' | 'sourceKind'>) {
  return (
    occurrence.eventSourceName ||
    occurrence.matchKey ||
    occurrence.sourceLocator ||
    occurrence.sourceKind
  );
}

function defaultOccurrenceSummary(payload: Record<string, unknown>) {
  const payloadKeys = Object.keys(payload || {});
  if (payloadKeys.length === 0) {
    return 'No payload fields';
  }
  return payloadKeys.slice(0, 6).join(', ');
}

function decorateOccurrenceDisplay(
  occurrence: AutomationOccurrence,
  options?: { eventProviderRef?: string },
): AutomationOccurrence {
  const display = resolveAutomationOccurrenceDisplay({
    sourceKind: occurrence.sourceKind,
    eventDefinitionKey: occurrence.eventSourceKey,
    sourceName: occurrence.eventSourceName,
    providerRef: options?.eventProviderRef,
    sourceSnapshot: occurrence.sourceSnapshot,
    payload: occurrence.payload,
    occurredAt: occurrence.occurredAt,
  });

  return {
    ...occurrence,
    displayTitle: display?.title || defaultOccurrenceTitle(occurrence),
    displaySummary: display?.summary || defaultOccurrenceSummary(occurrence.payload),
    displayDescription: display?.description || undefined,
  };
}

function mapOccurrenceRow(row: AutomationOccurrenceRow): AutomationOccurrence {
  return decorateOccurrenceDisplay({
    id: row.id,
    workspaceId: row.workspace_id,
    sourceKind: row.source_kind,
    eventSourceId: row.event_source_id || undefined,
    eventSourceKey: (row as AutomationOccurrenceRow & { event_source_key?: string | null }).event_source_key || undefined,
    eventSourceName:
      (row as AutomationOccurrenceRow & { event_source_name?: string | null }).event_source_name || undefined,
    eventSourceIntegration: mapEventSourceIntegration({
      integration_binding_id: row.event_integration_binding_id,
      integration_webhook_endpoint_id: row.event_integration_webhook_endpoint_id,
      integration_installation_id: row.event_integration_installation_id,
      integration_provider: row.event_integration_provider,
      integration_ingress_kind: row.event_integration_ingress_kind,
      integration_target_kind: row.event_integration_target_kind,
      integration_target_id: row.event_integration_target_id,
      integration_target_label: row.event_integration_target_label,
      integration_external_subscription_id: row.event_external_subscription_id,
    }),
    sourceLocator: row.source_locator || undefined,
    matchKey: row.match_key || undefined,
    dedupeKey: row.dedupe_key || undefined,
    sourceSnapshot: parseJsonObject(row.source_snapshot),
    payload: parseJsonObject(row.payload),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  }, {
    eventProviderRef:
      (row as AutomationOccurrenceRow & { event_provider_ref?: string | null }).event_provider_ref || undefined,
  });
}

function mapExecutionRow(row: AutomationExecutionRow): AutomationExecution {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ruleId: row.rule_id,
    occurrenceId: row.occurrence_id,
    occurrenceOccurredAt: row.occurrence_occurred_at || undefined,
    occurrenceSourceKind: row.occurrence_source_kind || undefined,
    occurrenceEventSourceName: row.occurrence_event_source_name || undefined,
    occurrenceTitle: row.occurrence_display_title || undefined,
    occurrenceSummary: row.occurrence_display_summary || undefined,
    occurrenceDescription: row.occurrence_display_description || undefined,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWebhookEndpointRow(row: AutomationWebhookEndpointRow): AutomationWebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    status: row.status,
    pathToken: row.path_token,
    secretHint: row.secret_hint,
    metadata: parseJsonObject(row.metadata),
    createdBy: row.created_by || undefined,
    lastReceivedAt: row.last_received_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function automationEventSourceJoinClause(eventSourceAlias = 'aes', bindingAlias = 'aib') {
  return `LEFT JOIN automation_integration_bindings ${bindingAlias} ON ${bindingAlias}.id = ${eventSourceAlias}.integration_binding_id`;
}

function automationEventSourceSelectClause(eventSourceAlias = 'aes', bindingAlias = 'aib') {
  return `${eventSourceAlias}.*,
          ${bindingAlias}.installation_id AS integration_installation_id,
          ${bindingAlias}.provider AS integration_provider,
          ${bindingAlias}.ingress_kind AS integration_ingress_kind,
          ${bindingAlias}.target_kind AS integration_target_kind,
          ${bindingAlias}.target_id AS integration_target_id,
          ${bindingAlias}.target_label AS integration_target_label,
          ${bindingAlias}.webhook_endpoint_id AS integration_webhook_endpoint_id,
          ${bindingAlias}.external_subscription_id AS integration_external_subscription_id`;
}

function targetEntityRef(entityKind: AutomationTargetEntityKind, entityId: string): AutomationTargetEntityRef {
  return { entityKind, entityId };
}

function mergeUniqueIds(values: string[] | undefined) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function generateSecret(length = 48) {
  return crypto.randomBytes(length).toString('base64url');
}

function secretHint(secret: string) {
  return secret.slice(0, 8);
}

function verifyPresentedSecret(secret: string, expectedSecret: string) {
  const provided = Buffer.from(secret, 'utf8');
  const expected = Buffer.from(expectedSecret, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}

function buildWebhookSourceLocator(endpointId: string) {
  return `webhook:${endpointId}`;
}

function buildEventSourceLocator(
  source: Pick<AutomationEventSource, 'providerKind' | 'providerRef' | 'id' | 'integration'>,
) {
  if (source.providerKind === 'integration' && source.integration) {
    return `integration:${source.integration.provider}:${source.integration.targetKind}:${source.integration.targetId}`;
  }
  if (source.providerKind === 'webhook' && source.providerRef) {
    return buildWebhookSourceLocator(source.providerRef);
  }
  if (source.providerRef) {
    return `${source.providerKind}:${source.providerRef}`;
  }
  return `${source.providerKind}:${source.id}`;
}

function eventSourceMatchKey(source: Pick<AutomationEventSource, 'sourceKey'>) {
  return source.sourceKey;
}

function ensureEventSourceIsSubscribable(source: AutomationEventSource) {
  if (source.status !== 'active') {
    throw new Error(`Event source ${source.id} is not active`);
  }
}

function ensureEventSourceIsEmittable(source: AutomationEventSource) {
  if (source.status === 'disabled' || source.status === 'archived') {
    throw new Error(`Event source ${source.id} is not available for emission`);
  }
}

function subsetMatch(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const actualValue = actual[key];
      if (!actualValue || typeof actualValue !== 'object' || Array.isArray(actualValue)) {
        return false;
      }
      return subsetMatch(value as Record<string, unknown>, actualValue as Record<string, unknown>);
    }
    return actual[key] === value;
  });
}

function normalizePolicyInput(
  input?: AutomationPolicyInput,
): Omit<AutomationPolicyRow, 'rule_id'> {
  return {
    active_from: input?.activeFrom || null,
    active_until: input?.activeUntil || null,
    max_trigger_count: input?.maxTriggerCount || null,
    trigger_count: 0,
    completion_status: input?.completionStatus || 'completed',
    completed_at: null,
    metadata: {},
  };
}

function computeNextFireAt(input: {
  scheduleKind: 'cron' | 'at' | 'interval';
  scheduleExpr?: string;
  scheduleTimezone?: string;
  intervalSeconds?: number;
  startsAt?: string | null;
  activeFrom?: string | null;
  activeUntil?: string | null;
  baseTime?: Date;
  lastFiredAt?: string | null;
}): string | null {
  const baseTime = input.baseTime || new Date();
  const startsAt = input.startsAt ? new Date(input.startsAt) : null;
  const activeFrom = input.activeFrom ? new Date(input.activeFrom) : null;
  const activeUntil = input.activeUntil ? new Date(input.activeUntil) : null;
  const currentBase = activeFrom && activeFrom.getTime() > baseTime.getTime() ? activeFrom : baseTime;

  if (input.scheduleKind === 'at') {
    const candidate = startsAt || (input.scheduleExpr ? new Date(input.scheduleExpr) : null);
    if (!candidate) return null;
    if (candidate.getTime() <= baseTime.getTime()) return null;
    if (activeFrom && candidate.getTime() < activeFrom.getTime()) return null;
    if (activeUntil && candidate.getTime() > activeUntil.getTime()) return null;
    return candidate.toISOString();
  }

  if (input.scheduleKind === 'interval') {
    const intervalSeconds = input.intervalSeconds || 0;
    if (intervalSeconds <= 0) {
      throw new Error('intervalSeconds must be greater than 0');
    }
    const anchor = input.lastFiredAt
      ? new Date(input.lastFiredAt)
      : startsAt || (activeFrom && activeFrom.getTime() > baseTime.getTime()
          ? activeFrom
          : new Date(baseTime.getTime() + intervalSeconds * 1000));
    const next = input.lastFiredAt
      ? new Date(anchor.getTime() + intervalSeconds * 1000)
      : anchor;
    if (activeUntil && next.getTime() > activeUntil.getTime()) return null;
    return next.toISOString();
  }

  if (!input.scheduleExpr) {
    throw new Error('scheduleExpr is required for cron triggers');
  }

  const parsed = cronParser.parseExpression(input.scheduleExpr, {
    currentDate: currentBase,
    tz: input.scheduleTimezone || 'UTC',
  });
  const next = parsed.next().toDate();
  if (activeUntil && next.getTime() > activeUntil.getTime()) return null;
  return next.toISOString();
}

async function normalizeTriggerInput(
  workspaceId: string,
  input: AutomationTriggerInput,
  policy?: AutomationPolicyInput,
): Promise<Omit<AutomationTriggerRow, 'rule_id'>> {
  if (input.triggerKind === 'schedule') {
    const scheduleKind = input.scheduleKind || (input.startsAt ? 'at' : input.intervalSeconds ? 'interval' : 'cron');
    const nextFireAt = computeNextFireAt({
      scheduleKind,
      scheduleExpr: input.scheduleExpr,
      scheduleTimezone: input.scheduleTimezone,
      intervalSeconds: input.intervalSeconds,
      startsAt: input.startsAt || null,
      activeFrom: policy?.activeFrom || null,
      activeUntil: policy?.activeUntil || null,
    });
    return {
      trigger_kind: 'schedule',
      source_kind: 'clock',
      event_source_id: null,
      source_locator: input.sourceLocator || null,
      match_key: null,
      matcher: input.matcher || {},
      schedule_kind: scheduleKind,
      schedule_expr: input.scheduleExpr || null,
      schedule_timezone: input.scheduleTimezone || 'UTC',
      interval_seconds: scheduleKind === 'interval' ? (input.intervalSeconds || null) : null,
      starts_at: input.startsAt || null,
      next_fire_at: nextFireAt,
      last_fired_at: null,
      metadata: {},
    };
  }

  if (!input.eventSourceId?.trim()) {
    throw new Error('event trigger requires eventSourceId');
  }
  const eventSource = await getAutomationEventSource(workspaceId, input.eventSourceId.trim());
  if (!eventSource) {
    throw new Error(`Event source ${input.eventSourceId} not found`);
  }
  ensureEventSourceIsSubscribable(eventSource);

  return {
    trigger_kind: 'event',
    source_kind: eventSource.providerKind,
    event_source_id: eventSource.id,
    source_locator: buildEventSourceLocator(eventSource),
    match_key: eventSourceMatchKey(eventSource),
    matcher: input.matcher || {},
    schedule_kind: null,
    schedule_expr: null,
    schedule_timezone: null,
    interval_seconds: null,
    starts_at: null,
    next_fire_at: null,
    last_fired_at: null,
    metadata: {},
  };
}

async function normalizeDeliveryInput(
  input: AutomationDeliveryInput,
): Promise<Omit<AutomationDeliveryRow, 'rule_id'> & {
  participants: AutomationTargetEntityRef[];
  recipients: AutomationTargetEntityRef[];
}> {
  const normalizedMessage = await buildNormalizedMessageContent({
    content: input.message || '',
    contentBlocks: input.messageBlocks || [],
  });
  const participants = [
    ...mergeUniqueIds(input.participantActorIds).map((entityId) => targetEntityRef('actor', entityId)),
    ...mergeUniqueIds(input.participantUserIds).map((entityId) => targetEntityRef('user', entityId)),
  ];
  const recipients = [
    ...mergeUniqueIds(input.recipientActorIds).map((entityId) => targetEntityRef('actor', entityId)),
    ...mergeUniqueIds(input.recipientUserIds).map((entityId) => targetEntityRef('user', entityId)),
  ];

  const targetPolicy = input.targetPolicy || (recipients.length > 0 ? 'specified_members' : 'all_members');
  if (targetPolicy === 'specified_members' && recipients.length === 0) {
    throw new Error('specified_members requires at least one recipient');
  }
  if (input.deliveryMode === 'conversation_notice' && !input.conversationId) {
    throw new Error('conversation_notice requires conversationId');
  }
  if (input.deliveryMode === 'wake_session' && !input.sessionId) {
    throw new Error('wake_session requires sessionId');
  }

  return {
    delivery_mode: input.deliveryMode,
    conversation_id: input.conversationId || null,
    session_id: input.sessionId || null,
    reused_conversation_id: null,
    conversation_title: input.conversationTitle?.trim() || null,
    message_text: normalizedMessage.normalizedContent,
    wake_reason_text: input.wakeReason?.trim() || normalizedMessage.normalizedContent || null,
    message_blocks: normalizedMessage.contentBlocks,
    target_policy: targetPolicy,
    metadata: normalizedMessage.normalizedMetadata,
    participants,
    recipients,
  };
}

async function loadAutomationTargets(
  tableName: 'automation_delivery_participants' | 'automation_delivery_recipients',
  ruleIds: string[],
) {
  if (ruleIds.length === 0) {
    return new Map<string, AutomationTargetEntityRef[]>();
  }
  const result = await executeSql<TargetEntityRow>(
    `SELECT rule_id, entity_kind, entity_id
     FROM ${tableName}
     WHERE rule_id = ANY($1)
     ORDER BY created_at ASC`,
    [ruleIds],
  );
  const mapped = new Map<string, AutomationTargetEntityRef[]>();
  for (const row of result.rows) {
    const existing = mapped.get(row.rule_id) || [];
    existing.push(targetEntityRef(row.entity_kind, row.entity_id));
    mapped.set(row.rule_id, existing);
  }
  return mapped;
}

async function loadAutomationRulesByIds(workspaceId: string, ruleIds: string[]) {
  if (ruleIds.length === 0) return [] as AutomationRule[];
  const [rulesResult, triggersResult, policiesResult, deliveriesResult, participantsByRule, recipientsByRule] = await Promise.all([
    executeSql<AutomationRuleRow>(
      `SELECT *
       FROM automation_rules
       WHERE workspace_id = $1
         AND id = ANY($2)
       ORDER BY created_at DESC`,
      [workspaceId, ruleIds],
    ),
    executeSql<AutomationTriggerRow>(
      `SELECT at.*,
              aes.source_key AS event_source_key,
              aes.name AS event_source_name,
              aes.provider_kind AS event_provider_kind,
              aes.provider_ref AS event_provider_ref,
              aes.webhook_endpoint_id AS event_webhook_endpoint_id,
              aes.integration_binding_id AS event_integration_binding_id,
              aib.installation_id AS event_integration_installation_id,
              aib.provider AS event_integration_provider,
              aib.ingress_kind AS event_integration_ingress_kind,
              aib.target_kind AS event_integration_target_kind,
              aib.target_id AS event_integration_target_id,
              aib.target_label AS event_integration_target_label,
              aib.webhook_endpoint_id AS event_integration_webhook_endpoint_id,
              aib.external_subscription_id AS event_external_subscription_id,
              aes.status AS event_source_status
       FROM automation_triggers
       at
       LEFT JOIN automation_event_sources aes ON aes.id = at.event_source_id
       LEFT JOIN automation_integration_bindings aib ON aib.id = aes.integration_binding_id
       WHERE at.rule_id = ANY($1)`,
      [ruleIds],
    ),
    executeSql<AutomationPolicyRow>(
      `SELECT *
       FROM automation_policies
       WHERE rule_id = ANY($1)`,
      [ruleIds],
    ),
    executeSql<AutomationDeliveryRow>(
      `SELECT *
       FROM automation_deliveries
       WHERE rule_id = ANY($1)`,
      [ruleIds],
    ),
    loadAutomationTargets('automation_delivery_participants', ruleIds),
    loadAutomationTargets('automation_delivery_recipients', ruleIds),
  ]);

  const triggerByRule = new Map(triggersResult.rows.map((row) => [row.rule_id, mapTriggerRow(row)]));
  const policyByRule = new Map(policiesResult.rows.map((row) => [row.rule_id, mapPolicyRow(row)]));
  const deliveryByRule = new Map(
    deliveriesResult.rows.map((row) => [
      row.rule_id,
      mapDeliveryRow(
        row,
        participantsByRule.get(row.rule_id) || [],
        recipientsByRule.get(row.rule_id) || [],
      ),
    ]),
  );

  return rulesResult.rows
    .map((row) => {
      const trigger = triggerByRule.get(row.id);
      const policy = policyByRule.get(row.id);
      const delivery = deliveryByRule.get(row.id);
      if (!trigger || !policy || !delivery) return null;
      return mapRuleRow(row, trigger, policy, delivery);
    })
    .filter((rule): rule is AutomationRule => Boolean(rule));
}

async function validateAutomationEventSourceProvider(
  workspaceId: string,
  providerKind: AutomationEventProviderKind,
  providerRef?: string,
) {
  if (providerKind === 'webhook') {
    const normalizedRef = providerRef?.trim();
    if (!normalizedRef) {
      throw new Error('webhook event sources require providerRef');
    }
    const endpointResult = await executeSql<{ id: string }>(
      `SELECT id
       FROM automation_webhook_endpoints
       WHERE id = $1
         AND workspace_id = $2
         AND status = 'active'
       LIMIT 1`,
      [normalizedRef, workspaceId],
    );
    if (!endpointResult.rows[0]) {
      throw new Error(`Webhook endpoint ${normalizedRef} not found or inactive`);
    }
    return {
      providerRef: normalizedRef,
      webhookEndpointId: normalizedRef,
    };
  }

  if (providerKind === 'relay') {
    const normalizedRef = providerRef?.trim();
    if (!normalizedRef) {
      throw new Error('relay event sources require providerRef');
    }
    return {
      providerRef: normalizedRef,
      webhookEndpointId: null,
    };
  }

  return {
    providerRef: providerRef?.trim() || null,
    webhookEndpointId: null,
  };
}

function slugifyAutomationEventSourceKey(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 96);
  return slug || 'source';
}

async function allocateAutomationEventSourceKey(params: {
  workspaceId: string;
  providerKind: AutomationEventProviderKind;
  providerRef?: string | null;
  name: string;
  explicitKey?: string;
}) {
  const requestedKey = params.explicitKey?.trim();
  if (requestedKey) {
    return requestedKey;
  }

  const baseKey = slugifyAutomationEventSourceKey(params.name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = attempt === 0
      ? baseKey
      : `${baseKey}.${crypto.randomBytes(2).toString('hex')}`;
    const existing = await executeSql<{ id: string }>(
      `SELECT id
       FROM automation_event_sources
       WHERE workspace_id = $1
         AND provider_kind = $2
         AND COALESCE(provider_ref, '') = COALESCE($3, '')
         AND source_key = $4
       LIMIT 1`,
      [params.workspaceId, params.providerKind, params.providerRef || null, candidate],
    );
    if (!existing.rows[0]) {
      return candidate;
    }
  }

  return `${baseKey}.${crypto.randomBytes(4).toString('hex')}`;
}

async function pauseAutomationRulesForEventSource(
  eventSourceId: string,
  actorOrUser: { userId?: string; actorId?: string },
  reason: string,
) {
  const affected = await executeSql<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'paused',
         last_error_at = NOW(),
         last_error_message = $2,
         updated_at = NOW()
     FROM automation_triggers at
     WHERE at.rule_id = ar.id
       AND at.event_source_id = $1
       AND ar.category = 'event_subscription'
       AND ar.status = 'active'
     RETURNING ar.id, ar.workspace_id`,
    [eventSourceId, reason],
  );

  for (const row of affected.rows) {
    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.pause', 'automation_rule', $4, $5)`,
      [
        row.workspace_id,
        actorOrUser.userId || null,
        actorOrUser.actorId || null,
        row.id,
        JSON.stringify({
          reason,
          eventSourceId,
        }),
      ],
    );
  }
}

export async function getAutomationEventSource(workspaceId: string, eventSourceId: string) {
  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT ${automationEventSourceSelectClause('aes', 'aib')}
     FROM automation_event_sources aes
     ${automationEventSourceJoinClause('aes', 'aib')}
     WHERE aes.workspace_id = $1
       AND aes.id = $2
     LIMIT 1`,
    [workspaceId, eventSourceId],
  );
  return result.rows[0] ? mapEventSourceRow(result.rows[0]) : null;
}

export async function listAutomationEventSources(
  workspaceId: string,
  filters?: {
    status?: AutomationEventSourceStatus;
    providerKind?: AutomationEventProviderKind;
    providerRef?: string;
    sourceKey?: string;
  },
) {
  const values: unknown[] = [workspaceId];
  let where = 'aes.workspace_id = $1';

  if (filters?.status) {
    values.push(filters.status);
    where += ` AND aes.status = $${values.length}`;
  }
  if (filters?.providerKind) {
    values.push(filters.providerKind);
    where += ` AND aes.provider_kind = $${values.length}`;
  }
  if (filters?.providerRef !== undefined) {
    values.push(filters.providerRef);
    where += ` AND COALESCE(aes.provider_ref, '') = COALESCE($${values.length}, '')`;
  }
  if (filters?.sourceKey) {
    values.push(filters.sourceKey);
    where += ` AND aes.source_key = $${values.length}`;
  }

  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT ${automationEventSourceSelectClause('aes', 'aib')}
     FROM automation_event_sources aes
     ${automationEventSourceJoinClause('aes', 'aib')}
     WHERE ${where}
     ORDER BY aes.created_at DESC`,
    values,
  );
  return result.rows.map(mapEventSourceRow);
}

async function loadAutomationWebhookEndpointSecret(endpointId: string) {
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `SELECT *
     FROM automation_webhook_endpoints
     WHERE id = $1
     LIMIT 1`,
    [endpointId],
  );
  const row = result.rows[0];
  if (!row?.secret_ciphertext) {
    throw new Error(`Webhook endpoint ${endpointId} secret was not found`);
  }
  return {
    endpoint: mapWebhookEndpointRow(row),
    secret: decrypt(row.secret_ciphertext),
  };
}

async function updateWebhookEndpointStatus(endpointId: string, status: AutomationWebhookEndpoint['status']) {
  await executeSql(
    `UPDATE automation_webhook_endpoints
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [endpointId, status],
  );
}

async function getAutomationIntegrationBinding(bindingId: string) {
  const result = await executeSql<AutomationIntegrationBindingRow>(
    `SELECT *
     FROM automation_integration_bindings
     WHERE id = $1
     LIMIT 1`,
    [bindingId],
  );
  return result.rows[0] || null;
}

function integrationEndpointName(
  provider: AutomationIntegrationProvider,
  targetLabel: string,
) {
  return `${provider === 'github' ? 'GitHub' : 'GitLab'} ${targetLabel} Endpoint`;
}

function integrationWebhookName(
  provider: AutomationIntegrationProvider,
  targetLabel: string,
) {
  return `${provider === 'github' ? 'GitHub' : 'GitLab'} Events: ${targetLabel}`;
}

function mapIntegrationBindingToSourceIntegration(
  binding: AutomationIntegrationBindingRow,
): AutomationEventSourceIntegration {
  return {
    bindingId: binding.id,
    installationId: binding.installation_id,
    provider: binding.provider,
    ingressKind: binding.ingress_kind,
    targetKind: binding.target_kind,
    targetId: binding.target_id,
    targetLabel: binding.target_label,
    endpointId: binding.webhook_endpoint_id || undefined,
    externalSubscriptionId: binding.external_subscription_id || undefined,
  };
}

async function ensureAutomationIntegrationBinding(params: {
  workspaceId: string;
  creator: AutomationCreatorInput;
  installation: Awaited<ReturnType<typeof getIntegrationInstallation>>;
  integration: AutomationEventSourceIntegrationInput;
}) {
  const ingressKind = params.integration.ingressKind || 'webhook';
  const targetId = params.integration.targetId.trim();
  const targetLabel = params.integration.targetLabel?.trim() || targetId;
  const existingResult = await executeSql<AutomationIntegrationBindingRow>(
    `SELECT *
     FROM automation_integration_bindings
     WHERE workspace_id = $1
       AND installation_id = $2
       AND provider = $3
       AND ingress_kind = $4
       AND target_kind = $5
       AND target_id = $6
     LIMIT 1`,
    [
      params.workspaceId,
      params.installation.id,
      params.integration.provider,
      ingressKind,
      params.integration.targetKind,
      targetId,
    ],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (existing.target_label !== targetLabel) {
      await executeSql(
        `UPDATE automation_integration_bindings
         SET target_label = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, targetLabel],
      );
      return getAutomationIntegrationBinding(existing.id);
    }
    return existing;
  }

  const bindingId = uuidv4();
  const endpointId = ingressKind === 'webhook' ? uuidv4() : null;
  const pathToken = ingressKind === 'webhook' ? crypto.randomBytes(18).toString('hex') : null;
  const secret = ingressKind === 'webhook' ? generateSecret() : null;

  await transaction(async (client) => {
    if (endpointId && pathToken && secret) {
      await executeSqlOn(client, 
        `INSERT INTO automation_webhook_endpoints
           (id, workspace_id, name, status, path_token, secret_ciphertext, secret_hint, metadata, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'disabled', $4, $5, $6, $7, $8, NOW(), NOW())`,
        [
          endpointId,
          params.workspaceId,
          integrationEndpointName(params.integration.provider, targetLabel),
          pathToken,
          encrypt(secret),
          secretHint(secret),
          JSON.stringify({
            managedBy: 'integration_binding',
            integrationProvider: params.integration.provider,
            integrationTargetKind: params.integration.targetKind,
            integrationTargetId: targetId,
            integrationTargetLabel: targetLabel,
          }),
          params.creator.userId || null,
        ],
      );
    }

    await executeSqlOn(client, 
      `INSERT INTO automation_integration_bindings
         (id, workspace_id, installation_id, provider, ingress_kind, target_kind, target_id, target_label,
          webhook_endpoint_id, external_subscription_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, NOW(), NOW())`,
      [
        bindingId,
        params.workspaceId,
        params.installation.id,
        params.integration.provider,
        ingressKind,
        params.integration.targetKind,
        targetId,
        targetLabel,
        endpointId,
        JSON.stringify({
          integrationProvider: params.integration.provider,
          integrationTargetKind: params.integration.targetKind,
        }),
      ],
    );
  });

  return getAutomationIntegrationBinding(bindingId);
}

async function listActiveIntegrationSourceKeysForBinding(bindingId: string) {
  const result = await executeSql<{ source_key: string }>(
    `SELECT source_key
     FROM automation_event_sources
     WHERE provider_kind = 'integration'
       AND integration_binding_id = $1
       AND status IN ('active', 'deprecated')
     ORDER BY source_key ASC`,
    [bindingId],
  );
  return Array.from(new Set(result.rows.map((row) => row.source_key).filter(Boolean)));
}

async function reconcileIntegrationBindingWebhook(
  bindingId: string,
): Promise<AutomationIntegrationBindingRow | null> {
  const binding = await getAutomationIntegrationBinding(bindingId);
  if (!binding) {
    return null;
  }
  if (binding.ingress_kind !== 'webhook' || !binding.webhook_endpoint_id) {
    return binding;
  }

  const sourceKeys = await listActiveIntegrationSourceKeysForBinding(binding.id);
  const { endpoint, secret } = await loadAutomationWebhookEndpointSecret(binding.webhook_endpoint_id);
  const integration = mapIntegrationBindingToSourceIntegration(binding);

  if (sourceKeys.length === 0) {
    if (binding.external_subscription_id) {
      const installation = await getIntegrationInstallation(
        binding.workspace_id,
        binding.installation_id,
        binding.provider,
        { allowInactive: true },
      );
      await unregisterIntegrationWebhook({
        installation,
        integration,
      });
    }
    await executeSql(
      `UPDATE automation_integration_bindings
       SET external_subscription_id = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [binding.id],
    );
    await updateWebhookEndpointStatus(endpoint.id, 'disabled');
    return getAutomationIntegrationBinding(binding.id);
  }

  const installation = await getIntegrationInstallation(
    binding.workspace_id,
    binding.installation_id,
    binding.provider,
    { allowInactive: true },
  );
  const callbackUrl = integrationWebhookCallbackUrl(endpoint.pathToken);
  const name = integrationWebhookName(binding.provider, binding.target_label);
  const description = `Managed ${binding.provider} automation webhook for ${binding.target_label}.`;
  let externalSubscriptionId = binding.external_subscription_id || null;

  if (externalSubscriptionId) {
    try {
      await updateIntegrationWebhook({
        installation,
        integration,
        sourceKeys,
        callbackUrl,
        secret,
        name,
        description,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        throw error;
      }
      externalSubscriptionId = await registerIntegrationWebhook({
        installation,
        sourceKeys,
        targetKind: binding.target_kind,
        targetId: binding.target_id,
        targetLabel: binding.target_label,
        callbackUrl,
        secret,
        name,
        description,
      });
    }
  } else {
    externalSubscriptionId = await registerIntegrationWebhook({
      installation,
      sourceKeys,
      targetKind: binding.target_kind,
      targetId: binding.target_id,
      targetLabel: binding.target_label,
      callbackUrl,
      secret,
      name,
      description,
    });
  }

  await executeSql(
    `UPDATE automation_integration_bindings
     SET external_subscription_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [binding.id, externalSubscriptionId],
  );
  await updateWebhookEndpointStatus(endpoint.id, 'active');
  return getAutomationIntegrationBinding(binding.id);
}

async function createIntegrationAutomationEventSource(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationEventSourceInput,
) {
  if (!input.integration) {
    throw new Error('integration event sources require integration configuration');
  }
  const integration = input.integration;

  const ingressKind = integration.ingressKind || 'webhook';
  const installation = await getIntegrationInstallation(
    workspaceId,
    integration.installationId,
    integration.provider,
  );
  const normalizedSourceKey = input.sourceKey?.trim();
  if (!normalizedSourceKey) {
    throw new Error('integration event sources require sourceKey');
  }

  const binding = await ensureAutomationIntegrationBinding({
    workspaceId,
    creator,
    installation,
    integration,
  });
  if (!binding) {
    throw new Error('Failed to resolve automation integration binding');
  }

  const targetId = binding.target_id;
  const targetLabel = binding.target_label;
  const initialStatus = input.status || 'active';
  const template = buildIntegrationEventSourceTemplate({
    provider: integration.provider,
    sourceKey: normalizedSourceKey,
    targetKind: integration.targetKind,
    targetId,
    targetLabel,
  });

  const existingResult = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = 'integration'
       AND integration_binding_id = $2
       AND source_key = $3
     LIMIT 1`,
    [
      workspaceId,
      binding.id,
      normalizedSourceKey,
    ],
  );
  const existing = existingResult.rows[0];

  if (existing) {
    const nextStatus = input.status || 'active';
    await executeSql(
      `UPDATE automation_event_sources
       SET name = $3,
           description = $4,
           recommended_usage = $5,
           payload_schema = $6,
           example_payload = $7,
           status = $8,
           metadata = $9,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2`,
      [
        workspaceId,
        existing.id,
        input.name?.trim() || template.name,
        input.description?.trim() || template.description,
        input.recommendedUsage?.trim() || template.recommendedUsage || '',
        JSON.stringify(input.payloadSchema || template.payloadSchema || {}),
        JSON.stringify(input.examplePayload || template.examplePayload || {}),
        input.status || 'active',
        JSON.stringify({
          ...(parseJsonObject(existing.metadata)),
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      ],
    );

    if (
      binding.ingress_kind === 'webhook' &&
      (
        ((existing.status === 'disabled' || existing.status === 'archived') &&
          (nextStatus === 'active' || nextStatus === 'deprecated')) ||
        ((existing.status === 'active' || existing.status === 'deprecated') &&
          (nextStatus === 'disabled' || nextStatus === 'archived'))
      )
    ) {
      await reconcileIntegrationBindingWebhook(binding.id);
    }

    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        creator.userId || null,
        creator.actorId || null,
        existing.id,
        JSON.stringify({
          providerKind: 'integration',
          sourceKey: normalizedSourceKey,
          integration: {
            bindingId: binding.id,
            installationId: installation.id,
            provider: integration.provider,
            ingressKind,
            targetKind: integration.targetKind,
            targetId,
            targetLabel,
          },
          reusedExisting: true,
          status: nextStatus,
        }),
      ],
    );
    const updated = await getAutomationEventSource(workspaceId, existing.id);
    if (!updated) {
      throw new Error(`Automation event source ${existing.id} was not found after reuse`);
    }
    return updated;
  }

  const sourceId = uuidv4();
  await transaction(async (client) => {
    await executeSqlOn(client, 
      `INSERT INTO automation_event_sources
         (id, workspace_id, provider_kind, provider_ref, webhook_endpoint_id, integration_binding_id, source_key,
          name, description, recommended_usage, payload_schema, example_payload, status, created_by_kind,
          created_by_user_id, created_by_actor_id, created_by_session_id, metadata, created_at, updated_at)
       VALUES ($1, $2, 'integration', NULL, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        sourceId,
        workspaceId,
        binding.id,
        normalizedSourceKey,
        input.name?.trim() || template.name,
        input.description?.trim() || template.description,
        input.recommendedUsage?.trim() || template.recommendedUsage || '',
        JSON.stringify(input.payloadSchema || template.payloadSchema || {}),
        JSON.stringify(input.examplePayload || template.examplePayload || {}),
        initialStatus,
        creator.kind,
        creator.userId || null,
        creator.actorId || null,
        creator.sessionId || null,
        JSON.stringify({
          ...(template.metadata || {}),
          ...(input.metadata || {}),
        }),
      ],
    );

    await executeSqlOn(client, 
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.create', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        creator.userId || null,
        creator.actorId || null,
        sourceId,
        JSON.stringify({
          providerKind: 'integration',
          sourceKey: normalizedSourceKey,
          integration: {
            bindingId: binding.id,
            installationId: installation.id,
            provider: integration.provider,
            ingressKind,
            targetKind: integration.targetKind,
            targetId,
            targetLabel,
          },
          status: initialStatus,
        }),
      ],
    );
  });

  try {
    if (
      binding.ingress_kind === 'webhook' &&
      initialStatus !== 'disabled' &&
      initialStatus !== 'archived'
    ) {
      await reconcileIntegrationBindingWebhook(binding.id);
    }
  } catch (error) {
    await executeSql(
      `DELETE FROM automation_event_sources
       WHERE workspace_id = $1
         AND id = $2`,
      [workspaceId, sourceId],
    ).catch(() => undefined);
    throw error;
  }

  const created = await getAutomationEventSource(workspaceId, sourceId);
  if (!created) {
    throw new Error(`Automation event source ${sourceId} was not persisted`);
  }
  return created;
}

export async function createAutomationEventSource(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationEventSourceInput,
) {
  if (input.providerKind === 'integration') {
    return createIntegrationAutomationEventSource(workspaceId, creator, input);
  }

  if (!input.name?.trim() || !input.description?.trim()) {
    throw new Error('name and description are required');
  }

  const providerBinding = await validateAutomationEventSourceProvider(
    workspaceId,
    input.providerKind,
    input.providerRef,
  );
  const normalizedSourceKey = await allocateAutomationEventSourceKey({
    workspaceId,
    providerKind: input.providerKind,
    providerRef: providerBinding.providerRef,
    name: input.name,
    explicitKey: input.sourceKey,
  });
  const existingResult = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = $2
       AND COALESCE(provider_ref, '') = COALESCE($3, '')
       AND source_key = $4
     LIMIT 1`,
    [workspaceId, input.providerKind, providerBinding.providerRef, normalizedSourceKey],
  );
  const existing = existingResult.rows[0];

  if (existing) {
    await executeSql(
      `UPDATE automation_event_sources
       SET provider_ref = $3,
           webhook_endpoint_id = $4,
           name = $5,
           description = $6,
           recommended_usage = $7,
           payload_schema = $8,
           example_payload = $9,
           status = $10,
           metadata = $11,
           updated_at = NOW()
       WHERE workspace_id = $1
         AND id = $2`,
      [
        workspaceId,
        existing.id,
        providerBinding.providerRef,
        providerBinding.webhookEndpointId,
        input.name.trim(),
        input.description.trim(),
        input.recommendedUsage?.trim() || '',
        JSON.stringify(input.payloadSchema || {}),
        JSON.stringify(input.examplePayload || {}),
        input.status || 'active',
        JSON.stringify(input.metadata || existing.metadata || {}),
      ],
    );

    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
      [
        workspaceId,
        creator.userId || null,
        creator.actorId || null,
        existing.id,
        JSON.stringify({
          providerKind: input.providerKind,
          providerRef: providerBinding.providerRef,
          sourceKey: normalizedSourceKey,
          recommendedUsage: input.recommendedUsage?.trim() || '',
          status: input.status || 'active',
          reusedExisting: true,
        }),
      ],
    );

    const updated = await getAutomationEventSource(workspaceId, existing.id);
    if (!updated) {
      throw new Error(`Automation event source ${existing.id} was not found after reuse`);
    }
    return updated;
  }

  const sourceId = uuidv4();

  await executeSql(
    `INSERT INTO automation_event_sources
       (id, workspace_id, provider_kind, provider_ref, webhook_endpoint_id, source_key, name, description, recommended_usage,
        payload_schema, example_payload, status, created_by_kind, created_by_user_id, created_by_actor_id,
        created_by_session_id, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())`,
    [
      sourceId,
      workspaceId,
      input.providerKind,
      providerBinding.providerRef,
      providerBinding.webhookEndpointId,
      normalizedSourceKey,
      input.name.trim(),
      input.description.trim(),
      input.recommendedUsage?.trim() || '',
      JSON.stringify(input.payloadSchema || {}),
      JSON.stringify(input.examplePayload || {}),
      input.status || 'active',
      creator.kind,
      creator.userId || null,
      creator.actorId || null,
      creator.sessionId || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.create', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      creator.userId || null,
      creator.actorId || null,
      sourceId,
      JSON.stringify({
        providerKind: input.providerKind,
        providerRef: providerBinding.providerRef,
        sourceKey: normalizedSourceKey,
        recommendedUsage: input.recommendedUsage?.trim() || '',
        status: input.status || 'active',
      }),
    ],
  );

  const created = await getAutomationEventSource(workspaceId, sourceId);
  if (!created) {
    throw new Error(`Automation event source ${sourceId} was not persisted`);
  }
  return created;
}

export async function updateAutomationEventSource(
  workspaceId: string,
  eventSourceId: string,
  actorOrUser: { userId?: string; actorId?: string },
  input: UpdateAutomationEventSourceInput,
) {
  const existing = await getAutomationEventSource(workspaceId, eventSourceId);
  if (!existing) {
    throw new Error('Automation event source not found');
  }

  if (existing.providerKind === 'integration' && input.providerRef !== undefined) {
    throw new Error('integration event sources do not support providerRef updates');
  }

  const providerBinding = existing.providerKind === 'integration'
    ? {
        providerRef: existing.providerRef || null,
        webhookEndpointId: null,
      }
    : await validateAutomationEventSourceProvider(
        workspaceId,
        existing.providerKind,
        input.providerRef !== undefined ? input.providerRef : existing.providerRef,
      );
  const nextStatus = input.status || existing.status;

  await executeSql(
    `UPDATE automation_event_sources
     SET provider_ref = $3,
         webhook_endpoint_id = $4,
         integration_binding_id = $5,
         source_key = $6,
         name = $7,
         description = $8,
         recommended_usage = $9,
         payload_schema = $10,
         example_payload = $11,
         status = $12,
         metadata = $13,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2`,
    [
      workspaceId,
      eventSourceId,
      providerBinding.providerRef,
      providerBinding.webhookEndpointId,
      existing.integration?.bindingId || null,
      existing.sourceKey,
      input.name?.trim() || existing.name,
      input.description !== undefined ? input.description.trim() : existing.description,
      input.recommendedUsage !== undefined ? input.recommendedUsage.trim() : existing.recommendedUsage || '',
      JSON.stringify(input.payloadSchema !== undefined ? input.payloadSchema : existing.payloadSchema),
      JSON.stringify(input.examplePayload !== undefined ? input.examplePayload : existing.examplePayload),
      nextStatus,
      JSON.stringify(input.metadata !== undefined ? input.metadata : existing.metadata),
    ],
  );

  const integrationStatusChanged =
    existing.providerKind === 'integration' &&
    existing.integration?.bindingId &&
    existing.integration.ingressKind === 'webhook' &&
    existing.status !== nextStatus &&
    (
      ((existing.status === 'active' || existing.status === 'deprecated') &&
        (nextStatus === 'disabled' || nextStatus === 'archived')) ||
      ((existing.status === 'disabled' || existing.status === 'archived') &&
        (nextStatus === 'active' || nextStatus === 'deprecated'))
    );

  if (integrationStatusChanged) {
    await reconcileIntegrationBindingWebhook(existing.integration!.bindingId!);
  }

  if ((nextStatus === 'disabled' || nextStatus === 'archived') && existing.status !== nextStatus) {
    await pauseAutomationRulesForEventSource(
      eventSourceId,
      actorOrUser,
      `Event source ${eventSourceId} is ${nextStatus}`,
    );
  }

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.update', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      actorOrUser.userId || null,
      actorOrUser.actorId || null,
      eventSourceId,
      JSON.stringify({
        status: nextStatus,
        providerRef: providerBinding.providerRef,
        sourceKey: existing.sourceKey,
        recommendedUsage:
          input.recommendedUsage !== undefined ? input.recommendedUsage.trim() : existing.recommendedUsage || '',
      }),
    ],
  );

  let updated = await getAutomationEventSource(workspaceId, eventSourceId);
  if (!updated) {
    throw new Error(`Automation event source ${eventSourceId} was not found after update`);
  }
  return updated;
}

export async function archiveAutomationEventSource(
  workspaceId: string,
  eventSourceId: string,
  actorOrUser: { userId?: string; actorId?: string },
) {
  const existing = await getAutomationEventSource(workspaceId, eventSourceId);
  if (!existing) {
    throw new Error('Automation event source not found');
  }

  await executeSql(
    `UPDATE automation_event_sources
     SET status = 'archived',
         updated_at = NOW()
    WHERE workspace_id = $1
      AND id = $2`,
    [workspaceId, eventSourceId],
  );

  if (
    existing.providerKind === 'integration' &&
    existing.integration?.ingressKind === 'webhook' &&
    existing.integration.bindingId
  ) {
    await reconcileIntegrationBindingWebhook(existing.integration.bindingId);
  }

  await pauseAutomationRulesForEventSource(
    eventSourceId,
    actorOrUser,
    `Event source ${eventSourceId} was archived`,
  );

  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_event_source.archive', 'automation_event_source', $4, $5)`,
    [
      workspaceId,
      actorOrUser.userId || null,
      actorOrUser.actorId || null,
      eventSourceId,
      JSON.stringify({ archived: true }),
    ],
  );
}

async function getAutomationEventSourceByWebhookPathToken(pathToken: string, sourceKey: string) {
  const result = await executeSql<AutomationEventSourceRow & { endpoint_secret_ciphertext: string; endpoint_name: string; endpoint_id: string }>(
    `SELECT aes.*,
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_event_sources aes
     JOIN automation_webhook_endpoints awe
       ON awe.id = aes.webhook_endpoint_id
     WHERE awe.path_token = $1
       AND awe.status = 'active'
       AND aes.provider_kind = 'webhook'
       AND aes.source_key = $2
       AND aes.status IN ('active', 'deprecated')
     LIMIT 1`,
    [pathToken, sourceKey],
  );
  return result.rows[0] || null;
}

async function listIntegrationEventSourcesByWebhookPathToken(pathToken: string) {
  const result = await executeSql<
    AutomationEventSourceRow & {
      endpoint_secret_ciphertext: string;
      endpoint_name: string;
      endpoint_id: string;
    }
  >(
    `SELECT ${automationEventSourceSelectClause('aes', 'aib')},
            awe.secret_ciphertext AS endpoint_secret_ciphertext,
            awe.name AS endpoint_name,
            awe.id AS endpoint_id
     FROM automation_integration_bindings aib
     JOIN automation_webhook_endpoints awe
       ON awe.id = aib.webhook_endpoint_id
     JOIN automation_event_sources aes
       ON aes.integration_binding_id = aib.id
     WHERE awe.path_token = $1
       AND awe.status = 'active'
       AND aib.ingress_kind = 'webhook'
       AND aes.provider_kind = 'integration'
       AND aes.status IN ('active', 'deprecated')
     ORDER BY aes.created_at ASC`,
    [pathToken],
  );
  return result.rows;
}

async function persistAutomationTargets(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  tableName: 'automation_delivery_participants' | 'automation_delivery_recipients',
  ruleId: string,
  values: AutomationTargetEntityRef[],
) {
  await executeSqlOn(client, `DELETE FROM ${tableName} WHERE rule_id = $1`, [ruleId]);
  for (const value of values) {
    await executeSqlOn(client, 
      `INSERT INTO ${tableName} (id, rule_id, entity_kind, entity_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [uuidv4(), ruleId, value.entityKind, value.entityId],
    );
  }
}

async function updateRuleError(ruleId: string, errorMessage: string | null) {
  await executeSql(
    `UPDATE automation_rules
     SET last_error_at = $2,
         last_error_message = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [ruleId, errorMessage ? nowISO() : null, errorMessage],
  );
}

async function expireAutomationRules(params: {
  referenceTime?: string;
  workspaceId?: string;
  client?: QueryRunnerLike;
}) {
  const runner = resolveQueryRunner(params.client);
  const referenceTime = params.referenceTime || nowISO();
  const result = await runner.run<{ id: string; workspace_id: string }>(
    `UPDATE automation_rules ar
     SET status = 'expired',
         updated_at = NOW()
     FROM automation_policies ap
     WHERE ap.rule_id = ar.id
       AND ar.status = 'active'
       AND ap.active_until IS NOT NULL
       AND ap.active_until < $1
       ${params.workspaceId ? 'AND ar.workspace_id = $2' : ''}
     RETURNING ar.id, ar.workspace_id`,
    params.workspaceId ? [referenceTime, params.workspaceId] : [referenceTime],
  );

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `UPDATE automation_policies
         SET completed_at = COALESCE(completed_at, $2),
             updated_at = NOW()
         WHERE rule_id = $1`,
        [row.id, referenceTime],
      ),
    ),
  );

  await Promise.all(
    result.rows.map((row) =>
      runner.run(
        `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
         VALUES ($1, 'automation_rule.expire', 'automation_rule', $2, $3)`,
        [
          row.workspace_id,
          row.id,
          JSON.stringify({
            referenceTime,
          }),
        ],
      ),
    ),
  );
}

async function applyAutomationPolicyAfterTrigger(params: {
  ruleId: string;
  workspaceId: string;
  occurrenceId: string;
  executionId: string;
  completeNow?: boolean;
  completionReason: 'max_trigger_count' | 'schedule_exhausted';
  client?: QueryRunnerLike;
}) {
  const runner = resolveQueryRunner(params.client);
  const policyResult = await runner.run<AutomationPolicyRow>(
    `UPDATE automation_policies
     SET trigger_count = trigger_count + 1,
         updated_at = NOW()
     WHERE rule_id = $1
     RETURNING *`,
    [params.ruleId],
  );
  const policy = policyResult.rows[0];
  if (!policy) {
    throw new Error(`Automation policy for ${params.ruleId} not found`);
  }

  const reachedMax =
    policy.max_trigger_count !== null &&
    policy.trigger_count >= policy.max_trigger_count;
  const shouldComplete = Boolean(params.completeNow || reachedMax);
  if (!shouldComplete) {
    return;
  }

  await runner.run(
    `UPDATE automation_rules
     SET status = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [params.ruleId, policy.completion_status],
  );
  await runner.run(
    `UPDATE automation_policies
     SET completed_at = COALESCE(completed_at, NOW()),
         updated_at = NOW()
     WHERE rule_id = $1`,
    [params.ruleId],
  );
  await runner.run(
    `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
     VALUES ($1, 'automation_rule.complete', 'automation_rule', $2, $3)`,
    [
      params.workspaceId,
      params.ruleId,
      JSON.stringify({
        executionId: params.executionId,
        occurrenceId: params.occurrenceId,
        triggerCount: policy.trigger_count,
        maxTriggerCount: policy.max_trigger_count,
        completionStatus: policy.completion_status,
        completionReason: reachedMax ? 'max_trigger_count' : params.completionReason,
      }),
    ],
  );
}

async function touchWebhookReceived(endpointId: string) {
  await executeSql(
    `UPDATE automation_webhook_endpoints
     SET last_received_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [endpointId],
  );
}

async function touchAutomationEventSourceTriggered(eventSourceId: string) {
  await executeSql(
    `UPDATE automation_event_sources
     SET last_triggered_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [eventSourceId],
  );
}

async function resolveAutomationRulesForEvent(params: {
  workspaceId: string;
  eventSourceId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}) {
  const result = await executeSql<AutomationRuleRow & AutomationTriggerRow>(
    `SELECT ar.*, at.rule_id, at.trigger_kind, at.source_kind, at.event_source_id, at.source_locator, at.match_key, at.matcher,
            at.schedule_kind, at.schedule_expr, at.schedule_timezone, at.interval_seconds, at.starts_at,
            at.next_fire_at, at.last_fired_at, at.metadata AS trigger_metadata
     FROM automation_rules ar
     JOIN automation_triggers at ON at.rule_id = ar.id
     JOIN automation_policies ap ON ap.rule_id = ar.id
     WHERE ar.workspace_id = $1
       AND ar.status = 'active'
       AND at.trigger_kind = 'event'
       AND at.event_source_id = $2
       AND (ap.active_from IS NULL OR ap.active_from <= $3)
       AND (ap.active_until IS NULL OR ap.active_until >= $3)
       AND (ap.max_trigger_count IS NULL OR ap.trigger_count < ap.max_trigger_count)`,
    [params.workspaceId, params.eventSourceId, params.occurredAt],
  );

  return result.rows
    .map((row) => ({
      ruleId: row.id,
      matcher: parseJsonObject(row.matcher),
    }))
    .filter((entry) => subsetMatch(entry.matcher, params.payload));
}

async function createAutomationOccurrence(params: {
  workspaceId: string;
  sourceKind: AutomationSourceKind;
  eventSourceId?: string;
  eventSourceKey?: string;
  eventSourceName?: string;
  sourceLocator?: string;
  matchKey?: string;
  dedupeKey?: string;
  sourceSnapshot?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  client?: QueryRunnerLike;
}) {
  const runner = resolveQueryRunner(params.client);
  const occurredAt = params.occurredAt || nowISO();
  const dedupeKey = params.dedupeKey?.trim() || null;

  if (dedupeKey) {
    const existing = await runner.run(
      `SELECT *
       FROM automation_occurrences
       WHERE workspace_id = $1
         AND ${params.eventSourceId ? 'event_source_id = $2' : 'source_kind = $2'}
         AND dedupe_key = $3
       LIMIT 1`,
      [params.workspaceId, params.eventSourceId || params.sourceKind, dedupeKey],
    );
    if (existing.rows[0]) {
      return mapOccurrenceRow(existing.rows[0]);
    }
  }

  const result = await runner.run(
    `INSERT INTO automation_occurrences
       (id, workspace_id, source_kind, event_source_id, source_locator, match_key, dedupe_key, source_snapshot, payload, occurred_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.sourceKind,
      params.eventSourceId || null,
      params.sourceLocator || null,
      params.matchKey || null,
      dedupeKey,
      JSON.stringify(params.sourceSnapshot || {}),
      JSON.stringify(params.payload || {}),
      occurredAt,
    ],
  );

  return mapOccurrenceRow(result.rows[0]!);
}

async function createAutomationExecution(params: {
  workspaceId: string;
  ruleId: string;
  occurrenceId: string;
  client?: QueryRunnerLike;
}) {
  const runner = resolveQueryRunner(params.client);
  const existing = await runner.run(
    `SELECT *
     FROM automation_executions
     WHERE rule_id = $1
       AND occurrence_id = $2
     LIMIT 1`,
    [params.ruleId, params.occurrenceId],
  );
  if (existing.rows[0]) {
    return {
      execution: mapExecutionRow(existing.rows[0]),
      isNew: false,
    };
  }

  const result = await runner.run(
    `INSERT INTO automation_executions
       (id, workspace_id, rule_id, occurrence_id, status, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, NOW(), NOW())
     RETURNING *`,
    [uuidv4(), params.workspaceId, params.ruleId, params.occurrenceId],
  );
  return {
    execution: mapExecutionRow(result.rows[0]!),
    isNew: true,
  };
}

async function recordExecutionTarget(params: {
  executionId: string;
  conversationId?: string;
  sessionId?: string;
  targetActorId?: string;
  targetUserId?: string;
  createdItemId?: string;
  wakeupId?: string;
  status: AutomationExecutionStatus;
  metadata?: Record<string, unknown>;
}) {
  const result = await executeSql<AutomationTargetRow>(
    `INSERT INTO automation_execution_targets
       (id, execution_id, conversation_id, session_id, target_actor_id, target_user_id, created_item_id, wakeup_id,
        status, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.executionId,
      params.conversationId || null,
      params.sessionId || null,
      params.targetActorId || null,
      params.targetUserId || null,
      params.createdItemId || null,
      params.wakeupId || null,
      params.status,
      JSON.stringify(params.metadata || {}),
    ],
  );
  return result.rows[0];
}

function buildAutomationNoticePayload(params: {
  rule: AutomationRule;
  executionId: string;
  occurrence: AutomationOccurrence;
}) {
  return {
    automationId: params.rule.id,
    executionId: params.executionId,
    occurrenceId: params.occurrence.id,
    category: params.rule.category,
    sourceKind: params.occurrence.sourceKind,
    eventSourceId: params.occurrence.eventSourceId,
    eventSourceName: params.occurrence.eventSourceName || params.rule.trigger.eventSourceName,
    sourceLabel: params.occurrence.displayTitle ||
      params.occurrence.eventSourceName ||
      params.rule.trigger.eventSourceName ||
      params.occurrence.matchKey ||
      params.occurrence.sourceLocator ||
      params.occurrence.sourceKind,
    sourceTitle: params.occurrence.displayTitle,
    sourceSummary: params.occurrence.displaySummary,
    sourceDescription: params.occurrence.displayDescription,
    occurredAt: params.occurrence.occurredAt,
    deliveryMode: params.rule.delivery.deliveryMode,
    message: params.rule.delivery.messageText,
    messageBlocks: params.rule.delivery.messageBlocks,
  };
}

async function resolveOperatorUserId(rule: AutomationRule) {
  if (rule.createdByUserId) return rule.createdByUserId;

  if (rule.ownerConversationId) {
    const members = await listConversationMembers(rule.ownerConversationId);
    const firstUser = members.find((member: any) => member.state === 'active' && member.user_id);
    if (firstUser?.user_id) return firstUser.user_id as string;
  }

  const result = await executeSql<{ owner_id: string }>(
    `SELECT owner_id
     FROM workspaces
     WHERE id = $1
     LIMIT 1`,
    [rule.workspaceId],
  );
  return result.rows[0]?.owner_id || null;
}

async function resolveExistingConversationId(rule: AutomationRule) {
  if (rule.delivery.deliveryMode === 'wake_session') {
    const sessionId = rule.delivery.sessionId || rule.ownerSessionId;
    if (!sessionId) {
      throw new Error('wake_session delivery requires a target session');
    }
    const session = await getSession(sessionId);
    if (!session || session.status === 'closed') {
      throw new Error(`Target session ${sessionId} is unavailable`);
    }
    return {
      conversationId: session.conversation_id as string,
      sessionId,
      createdConversationId: undefined as string | undefined,
    };
  }

  if (rule.delivery.deliveryMode === 'conversation_notice') {
    const conversationId = rule.delivery.conversationId || rule.ownerConversationId;
    if (!conversationId) {
      throw new Error('conversation_notice delivery requires conversationId');
    }
    const conversation = await getConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    return {
      conversationId,
      sessionId: undefined,
      createdConversationId: undefined as string | undefined,
    };
  }

  const operatorUserId = await resolveOperatorUserId(rule);
  if (!operatorUserId) {
    throw new Error('No operator user is available to create a conversation for this automation');
  }

  const participantActorIds = rule.delivery.participants
    .filter((entry) => entry.entityKind === 'actor')
    .map((entry) => entry.entityId);
  const participantUserIds = rule.delivery.participants
    .filter((entry) => entry.entityKind === 'user')
    .map((entry) => entry.entityId)
    .filter((userId) => userId !== operatorUserId);

  const reuseExisting =
    rule.delivery.deliveryMode === 'create_conversation_once'
      ? rule.delivery.reusedConversationId
      : undefined;
  if (reuseExisting) {
    const existingConversation = await getConversation(reuseExisting);
    if (existingConversation) {
      return {
        conversationId: reuseExisting,
        sessionId: undefined,
        createdConversationId: undefined as string | undefined,
      };
    }
  }

  const created = await createThread({
    workspaceId: rule.workspaceId,
    kind: 'group',
    createdBy: operatorUserId,
    title: rule.delivery.conversationTitle || rule.name,
    actorIds: participantActorIds,
  });

  if (participantUserIds.length > 0) {
    await addMembersToConversation({
      conversationId: created.conversation.id,
      workspaceId: rule.workspaceId,
      userIds: participantUserIds,
      initiator: {
        memberType: 'user',
        userId: operatorUserId,
      },
    });
  }

  if (rule.delivery.deliveryMode === 'create_conversation_once') {
    await executeSql(
      `UPDATE automation_deliveries
       SET reused_conversation_id = $2,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [rule.id, created.conversation.id],
    );
    rule.delivery.reusedConversationId = created.conversation.id;
  }

  return {
    conversationId: created.conversation.id as string,
    sessionId: undefined,
    createdConversationId: created.conversation.id as string,
  };
}

async function resolveRecipientMembers(rule: AutomationRule, conversationId: string) {
  const members = await listConversationMembers(conversationId);
  if (rule.delivery.targetPolicy === 'all_members') {
    return {
      targetMemberIds: members.filter((member: any) => member.state === 'active').map((member: any) => member.id as string),
      actorRecipientIds: members
        .filter((member: any) => member.state === 'active' && member.actor_id)
        .map((member: any) => member.actor_id as string),
    };
  }

  const recipientActors = new Set(
    rule.delivery.recipients
      .filter((entry) => entry.entityKind === 'actor')
      .map((entry) => entry.entityId),
  );
  const recipientUsers = new Set(
    rule.delivery.recipients
      .filter((entry) => entry.entityKind === 'user')
      .map((entry) => entry.entityId),
  );

  const targetMemberIds = members
    .filter((member: any) => member.state === 'active')
    .filter((member: any) => {
      if (member.actor_id) return recipientActors.has(member.actor_id);
      if (member.user_id) return recipientUsers.has(member.user_id);
      return false;
    })
    .map((member: any) => member.id as string);
  const actorRecipientIds = members
    .filter((member: any) => member.state === 'active' && member.actor_id && recipientActors.has(member.actor_id))
    .map((member: any) => member.actor_id as string);

  return {
    targetMemberIds,
    actorRecipientIds,
  };
}

async function createAutomationNotice(params: {
  rule: AutomationRule;
  executionId: string;
  occurrence: AutomationOccurrence;
  conversationId: string;
  targetMemberIds: string[];
}) {
  const payload = buildAutomationNoticePayload(params);
  const timelinePolicy = params.rule.delivery.targetPolicy === 'specified_members' ? 'targeted_members' : 'all_members';
  const contextPolicy = params.rule.delivery.targetPolicy === 'specified_members' ? 'targeted_members' : 'shared';
  const created = await createConversationEvent({
    workspaceId: params.rule.workspaceId,
    conversationId: params.conversationId,
    eventType: 'automation_notice',
    timelinePolicy,
    contextPolicy,
    metadata: {
      automationId: params.rule.id,
      executionId: params.executionId,
      occurrenceId: params.occurrence.id,
    },
    eventPayload: payload,
    targetMemberIds: timelinePolicy === 'targeted_members' ? params.targetMemberIds : undefined,
    contextTargetMemberIds: contextPolicy === 'targeted_members' ? params.targetMemberIds : undefined,
  });
  return created.item.id as string;
}

async function wakeAutomationTargets(params: {
  rule: AutomationRule;
  executionId: string;
  occurrence: AutomationOccurrence;
  conversationId: string;
  createdItemId: string;
  actorRecipientIds: string[];
}) {
  const memberRows = await getConversationMembers(params.conversationId).catch(
    () => [] as any[]
  );
  const sessionsByActor = new Map<string, { sessionId: string }>();
  for (const member of memberRows) {
    if (member.actor_id && member.session_id && member.state === 'active') {
      sessionsByActor.set(member.actor_id, { sessionId: member.session_id });
    }
  }

  const targetActorIds =
    params.rule.delivery.deliveryMode === 'wake_session' && params.rule.ownerSessionId
      ? [params.rule.createdByActorId || ''].filter(Boolean)
      : params.actorRecipientIds;
  let wakeupCount = 0;

  if (params.rule.delivery.deliveryMode === 'wake_session') {
    const sessionId = params.rule.delivery.sessionId || params.rule.ownerSessionId;
    if (!sessionId) {
      throw new Error('wake_session delivery requires a target session');
    }
    const session = await getSession(sessionId);
    if (!session || session.status === 'closed') {
      throw new Error(`Target session ${sessionId} is unavailable`);
    }

    const wakeup = await enqueueSessionWakeup({
      sessionId,
      actorId: session.actor_id as string,
      workspaceId: params.rule.workspaceId,
      sourceType: 'automation',
      sourceItemId: params.createdItemId,
      sourceMemberType: 'system',
      sourceName: params.rule.name,
      summary: params.rule.delivery.messageText || params.rule.name,
      reasonText: params.rule.delivery.wakeReasonText || params.rule.delivery.messageText || params.rule.name,
      automationExecutionId: params.executionId,
      automationOccurrenceId: params.occurrence.id,
      trigger: 'automation',
      metadata: {
        automationId: params.rule.id,
        deliveryMode: params.rule.delivery.deliveryMode,
      },
    });
    await recordExecutionTarget({
      executionId: params.executionId,
      conversationId: params.conversationId,
      sessionId,
      targetActorId: session.actor_id as string,
      createdItemId: params.createdItemId,
      wakeupId: wakeup.id as string,
      status: 'completed',
    });
    return 1;
  }

  for (const actorId of targetActorIds) {
    const sessionEntry = sessionsByActor.get(actorId);
    if (!sessionEntry?.sessionId) continue;
    const wakeup = await enqueueSessionWakeup({
      sessionId: sessionEntry.sessionId,
      actorId,
      workspaceId: params.rule.workspaceId,
      sourceType: 'automation',
      sourceItemId: params.createdItemId,
      sourceMemberType: 'system',
      sourceName: params.rule.name,
      summary: params.rule.delivery.messageText || params.rule.name,
      reasonText: params.rule.delivery.wakeReasonText || params.rule.delivery.messageText || params.rule.name,
      automationExecutionId: params.executionId,
      automationOccurrenceId: params.occurrence.id,
      trigger: 'automation',
      metadata: {
        automationId: params.rule.id,
        deliveryMode: params.rule.delivery.deliveryMode,
      },
    });
    wakeupCount += 1;
    await recordExecutionTarget({
      executionId: params.executionId,
      conversationId: params.conversationId,
      sessionId: sessionEntry.sessionId,
      targetActorId: actorId,
      createdItemId: params.createdItemId,
      wakeupId: wakeup.id as string,
      status: 'completed',
    });
  }

  return wakeupCount;
}

export function getAutomationSchedulerIntervalMs() {
  return AUTOMATION_SCHEDULER_INTERVAL_MS;
}

export async function createAutomationRule(
  workspaceId: string,
  creator: AutomationCreatorInput,
  input: CreateAutomationRuleInput,
) {
  const ruleId = uuidv4();
  const category: AutomationCategory = input.trigger.triggerKind === 'schedule' ? 'schedule' : 'event_subscription';
  const normalizedPolicy = normalizePolicyInput(input.policy);
  const normalizedTrigger = await normalizeTriggerInput(workspaceId, input.trigger, input.policy);
  const normalizedDelivery = await normalizeDeliveryInput(input.delivery);

  await transaction(async (client) => {
    await executeSqlOn(client, 
      `INSERT INTO automation_rules
         (id, workspace_id, category, status, name, description, created_by_kind, created_by_user_id, created_by_actor_id,
          created_by_session_id, owner_conversation_id, owner_session_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())`,
      [
        ruleId,
        workspaceId,
        category,
        input.status || 'active',
        input.name.trim(),
        (input.description || '').trim(),
        creator.kind,
        creator.userId || null,
        creator.actorId || null,
        creator.sessionId || null,
        input.ownerConversationId || null,
        input.ownerSessionId || null,
        JSON.stringify(input.metadata || {}),
      ],
    );

    await executeSqlOn(client, 
      `INSERT INTO automation_policies
         (rule_id, active_from, active_until, max_trigger_count, trigger_count, completion_status, completed_at,
          metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        ruleId,
        normalizedPolicy.active_from,
        normalizedPolicy.active_until,
        normalizedPolicy.max_trigger_count,
        normalizedPolicy.trigger_count,
        normalizedPolicy.completion_status,
        normalizedPolicy.completed_at,
        JSON.stringify(normalizedPolicy.metadata),
      ],
    );

    await executeSqlOn(client, 
      `INSERT INTO automation_triggers
         (rule_id, trigger_kind, source_kind, event_source_id, source_locator, match_key, matcher, schedule_kind, schedule_expr,
          schedule_timezone, interval_seconds, starts_at, next_fire_at, last_fired_at, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
      [
        ruleId,
        normalizedTrigger.trigger_kind,
        normalizedTrigger.source_kind,
        normalizedTrigger.event_source_id,
        normalizedTrigger.source_locator,
        normalizedTrigger.match_key,
        JSON.stringify(normalizedTrigger.matcher),
        normalizedTrigger.schedule_kind,
        normalizedTrigger.schedule_expr,
        normalizedTrigger.schedule_timezone,
        normalizedTrigger.interval_seconds,
        normalizedTrigger.starts_at,
        normalizedTrigger.next_fire_at,
        normalizedTrigger.last_fired_at,
        JSON.stringify(normalizedTrigger.metadata),
      ],
    );

    await executeSqlOn(client, 
      `INSERT INTO automation_deliveries
         (rule_id, delivery_mode, conversation_id, session_id, reused_conversation_id, conversation_title,
          message_text, wake_reason_text, message_blocks, target_policy, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
      [
        ruleId,
        normalizedDelivery.delivery_mode,
        normalizedDelivery.conversation_id,
        normalizedDelivery.session_id,
        normalizedDelivery.reused_conversation_id,
        normalizedDelivery.conversation_title,
        normalizedDelivery.message_text,
        normalizedDelivery.wake_reason_text,
        JSON.stringify(normalizedDelivery.message_blocks),
        normalizedDelivery.target_policy,
        JSON.stringify(normalizedDelivery.metadata),
      ],
    );

    await persistAutomationTargets(client, 'automation_delivery_participants', ruleId, normalizedDelivery.participants);
    await persistAutomationTargets(client, 'automation_delivery_recipients', ruleId, normalizedDelivery.recipients);

    await executeSqlOn(client, 
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.create', 'automation_rule', $4, $5)`,
      [
        workspaceId,
        creator.userId || null,
        creator.actorId || null,
        ruleId,
        JSON.stringify({
          category,
          triggerKind: normalizedTrigger.trigger_kind,
          policy: {
            activeFrom: normalizedPolicy.active_from,
            activeUntil: normalizedPolicy.active_until,
            maxTriggerCount: normalizedPolicy.max_trigger_count,
            completionStatus: normalizedPolicy.completion_status,
          },
          sourceKind: normalizedTrigger.source_kind,
          eventSourceId: normalizedTrigger.event_source_id,
          deliveryMode: normalizedDelivery.delivery_mode,
        }),
      ],
    );
  });

  const [rule] = await loadAutomationRulesByIds(workspaceId, [ruleId]);
  if (!rule) {
    throw new Error(`Automation rule ${ruleId} was not persisted`);
  }
  return rule;
}

export async function listAutomationRules(workspaceId: string, filters?: {
  status?: AutomationStatus;
  ownerSessionId?: string;
  category?: AutomationCategory;
}) {
  await expireAutomationRules({ workspaceId });

  const values: unknown[] = [workspaceId];
  let where = 'workspace_id = $1';

  if (filters?.status) {
    values.push(filters.status);
    where += ` AND status = $${values.length}`;
  }
  if (filters?.ownerSessionId) {
    values.push(filters.ownerSessionId);
    where += ` AND owner_session_id = $${values.length}`;
  }
  if (filters?.category) {
    values.push(filters.category);
    where += ` AND category = $${values.length}`;
  }

  const result = await executeSql<{ id: string }>(
    `SELECT id
     FROM automation_rules
     WHERE ${where}
     ORDER BY created_at DESC`,
    values,
  );
  return loadAutomationRulesByIds(workspaceId, result.rows.map((row) => row.id));
}

export async function getAutomationRule(workspaceId: string, ruleId: string) {
  await expireAutomationRules({ workspaceId });
  const [rule] = await loadAutomationRulesByIds(workspaceId, [ruleId]);
  return rule || null;
}

export async function updateAutomationRule(
  workspaceId: string,
  ruleId: string,
  actorOrUser: { userId?: string; actorId?: string },
  input: UpdateAutomationRuleInput,
) {
  const existing = await getAutomationRule(workspaceId, ruleId);
  if (!existing) {
    throw new Error('Automation rule not found');
  }

  const mergedInput = mergeAutomationRuleUpdatePayload(existing, input);
  const issues = validateAutomationRuleCreatePayload(mergedInput);
  if (issues.length > 0) {
    throw createAutomationValidationError(issues);
  }

  const normalizedPolicy = normalizePolicyInput(mergedInput.policy);
  const normalizedTrigger = await normalizeTriggerInput(workspaceId, mergedInput.trigger, mergedInput.policy);
  const normalizedDelivery = await normalizeDeliveryInput(mergedInput.delivery);

  await transaction(async (client) => {
    await executeSqlOn(client, 
      `UPDATE automation_rules
       SET status = $2,
           name = $3,
           description = $4,
           owner_conversation_id = $5,
           owner_session_id = $6,
           metadata = $7,
           updated_at = NOW()
       WHERE id = $1`,
      [
        ruleId,
        mergedInput.status || existing.status,
        mergedInput.name.trim(),
        (mergedInput.description || '').trim(),
        mergedInput.ownerConversationId || null,
        mergedInput.ownerSessionId || null,
        JSON.stringify(mergedInput.metadata || {}),
      ],
    );

    await executeSqlOn(client, 
      `UPDATE automation_policies
       SET active_from = $2,
           active_until = $3,
           max_trigger_count = $4,
           completion_status = $5,
           completed_at = $6,
           metadata = $7,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedPolicy.active_from,
        normalizedPolicy.active_until,
        normalizedPolicy.max_trigger_count,
        normalizedPolicy.completion_status,
        mergedInput.status === 'active' ? null : existing.policy.completedAt || null,
        JSON.stringify(normalizedPolicy.metadata),
      ],
    );

    await executeSqlOn(client, 
      `UPDATE automation_triggers
       SET trigger_kind = $2,
           source_kind = $3,
           event_source_id = $4,
           source_locator = $5,
           match_key = $6,
           matcher = $7,
           schedule_kind = $8,
           schedule_expr = $9,
           schedule_timezone = $10,
           interval_seconds = $11,
           starts_at = $12,
           next_fire_at = $13,
           metadata = $14,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedTrigger.trigger_kind,
        normalizedTrigger.source_kind,
        normalizedTrigger.event_source_id,
        normalizedTrigger.source_locator,
        normalizedTrigger.match_key,
        JSON.stringify(normalizedTrigger.matcher),
        normalizedTrigger.schedule_kind,
        normalizedTrigger.schedule_expr,
        normalizedTrigger.schedule_timezone,
        normalizedTrigger.interval_seconds,
        normalizedTrigger.starts_at,
        normalizedTrigger.next_fire_at,
        JSON.stringify(normalizedTrigger.metadata),
      ],
    );

    await executeSqlOn(client, 
      `UPDATE automation_deliveries
       SET delivery_mode = $2,
           conversation_id = $3,
           session_id = $4,
           conversation_title = $5,
           message_text = $6,
           wake_reason_text = $7,
           message_blocks = $8,
           target_policy = $9,
           metadata = $10,
           updated_at = NOW()
       WHERE rule_id = $1`,
      [
        ruleId,
        normalizedDelivery.delivery_mode,
        normalizedDelivery.conversation_id,
        normalizedDelivery.session_id,
        normalizedDelivery.conversation_title,
        normalizedDelivery.message_text,
        normalizedDelivery.wake_reason_text,
        JSON.stringify(normalizedDelivery.message_blocks),
        normalizedDelivery.target_policy,
        JSON.stringify(normalizedDelivery.metadata),
      ],
    );

    await persistAutomationTargets(client, 'automation_delivery_participants', ruleId, normalizedDelivery.participants);
    await persistAutomationTargets(client, 'automation_delivery_recipients', ruleId, normalizedDelivery.recipients);

    await executeSqlOn(client, 
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.update', 'automation_rule', $4, $5)`,
      [
        workspaceId,
        actorOrUser.userId || null,
        actorOrUser.actorId || null,
        ruleId,
        JSON.stringify({
          triggerKind: normalizedTrigger.trigger_kind,
          policy: {
            activeFrom: normalizedPolicy.active_from,
            activeUntil: normalizedPolicy.active_until,
            maxTriggerCount: normalizedPolicy.max_trigger_count,
            completionStatus: normalizedPolicy.completion_status,
          },
          sourceKind: normalizedTrigger.source_kind,
          eventSourceId: normalizedTrigger.event_source_id,
          deliveryMode: normalizedDelivery.delivery_mode,
        }),
      ],
    );
  });

  const updated = await getAutomationRule(workspaceId, ruleId);
  if (!updated) {
    throw new Error(`Automation rule ${ruleId} was not found after update`);
  }
  return updated;
}

export async function deleteAutomationRule(
  workspaceId: string,
  ruleId: string,
  actorOrUser: { userId?: string; actorId?: string },
) {
  await executeSql(
    `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
     VALUES ($1, $2, $3, 'automation_rule.delete', 'automation_rule', $4, $5)`,
    [workspaceId, actorOrUser.userId || null, actorOrUser.actorId || null, ruleId, JSON.stringify({ deleted: true })],
  );
  await executeSql(
    `DELETE FROM automation_rules
     WHERE id = $1
       AND workspace_id = $2`,
    [ruleId, workspaceId],
  );
}

export async function createAutomationWebhookEndpoint(
  workspaceId: string,
  createdBy: string,
  params: {
    name: string;
    metadata?: Record<string, unknown>;
  },
): Promise<AutomationWebhookEndpointCreateResult> {
  const secret = generateSecret();
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `INSERT INTO automation_webhook_endpoints
       (id, workspace_id, name, status, path_token, secret_ciphertext, secret_hint, metadata, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      workspaceId,
      params.name.trim(),
      crypto.randomBytes(18).toString('hex'),
      encrypt(secret),
      secretHint(secret),
      JSON.stringify(params.metadata || {}),
      createdBy,
    ],
  );

  return {
    endpoint: mapWebhookEndpointRow(result.rows[0]!),
    secret,
  };
}

export async function listAutomationWebhookEndpoints(workspaceId: string) {
  const result = await executeSql<AutomationWebhookEndpointRow>(
    `SELECT *
     FROM automation_webhook_endpoints
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(mapWebhookEndpointRow);
}

export async function listAutomationOccurrences(
  workspaceId: string,
  filters?: {
    eventSourceId?: string;
    limit?: number;
  },
) {
  const values: unknown[] = [workspaceId];
  let where = 'ao.workspace_id = $1';

  if (filters?.eventSourceId) {
    values.push(filters.eventSourceId);
    where += ` AND ao.event_source_id = $${values.length}`;
  }

  values.push(Math.max(1, Math.min(filters?.limit || 50, 200)));
  const result = await executeSql<AutomationOccurrenceRow>(
    `SELECT ao.*,
            aes.source_key AS event_source_key,
            aes.name AS event_source_name,
            aes.provider_ref AS event_provider_ref,
            aes.webhook_endpoint_id AS event_webhook_endpoint_id,
            aes.integration_binding_id AS event_integration_binding_id,
            aib.installation_id AS event_integration_installation_id,
            aib.provider AS event_integration_provider,
            aib.ingress_kind AS event_integration_ingress_kind,
            aib.target_kind AS event_integration_target_kind,
            aib.target_id AS event_integration_target_id,
            aib.target_label AS event_integration_target_label,
            aib.webhook_endpoint_id AS event_integration_webhook_endpoint_id,
            aib.external_subscription_id AS event_external_subscription_id
     FROM automation_occurrences ao
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     LEFT JOIN automation_integration_bindings aib ON aib.id = aes.integration_binding_id
     WHERE ${where}
     ORDER BY ao.created_at DESC
     LIMIT $${values.length}`,
    values,
  );

  return result.rows.map(mapOccurrenceRow);
}

export async function ingestAutomationProviderEvent(params: {
  workspaceId: string;
  providerKind: AutomationEventProviderKind;
  providerRef?: string;
  sourceKey: string;
  payload?: Record<string, unknown>;
  sourceSnapshot?: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt?: string;
}) {
  const result = await executeSql<AutomationEventSourceRow>(
    `SELECT *
     FROM automation_event_sources
     WHERE workspace_id = $1
       AND provider_kind = $2
       AND COALESCE(provider_ref, '') = COALESCE($3, '')
       AND source_key = $4
       AND status IN ('active', 'deprecated')
     LIMIT 1`,
    [params.workspaceId, params.providerKind, params.providerRef || null, params.sourceKey],
  );
  const eventSource = result.rows[0];
  if (!eventSource) {
    return null;
  }

  return ingestAutomationEvent({
    workspaceId: params.workspaceId,
    eventSourceId: eventSource.id,
    payload: params.payload,
    sourceSnapshot: params.sourceSnapshot,
    dedupeKey: params.dedupeKey,
    occurredAt: params.occurredAt,
  });
}

export async function ingestAutomationEvent(input: AutomationEventEnvelope) {
  const eventSource = await getAutomationEventSource(input.workspaceId, input.eventSourceId);
  if (!eventSource) {
    throw new Error(`Event source ${input.eventSourceId} not found`);
  }
  ensureEventSourceIsEmittable(eventSource);

  const payload = input.payload || {};
  const storedOccurrence = await createAutomationOccurrence({
    workspaceId: input.workspaceId,
    sourceKind: eventSource.providerKind,
    eventSourceId: eventSource.id,
    sourceLocator: buildEventSourceLocator(eventSource),
    matchKey: eventSourceMatchKey(eventSource),
    dedupeKey: input.dedupeKey,
    sourceSnapshot: {
      eventSourceId: eventSource.id,
      eventSourceName: eventSource.name,
      providerKind: eventSource.providerKind,
      providerRef: eventSource.providerRef || null,
      sourceKey: eventSource.sourceKey,
      ...(eventSource.integration
        ? {
            integrationInstallationId: eventSource.integration.installationId,
            integrationProvider: eventSource.integration.provider,
            integrationIngressKind: eventSource.integration.ingressKind,
            integrationTargetKind: eventSource.integration.targetKind,
            integrationTargetId: eventSource.integration.targetId,
            integrationTargetLabel: eventSource.integration.targetLabel,
            integrationEndpointId: eventSource.integration.endpointId || null,
            externalSubscriptionId: eventSource.integration.externalSubscriptionId || null,
          }
        : {}),
      ...(input.sourceSnapshot || {}),
    },
    payload,
    occurredAt: input.occurredAt,
  });
  const occurrence: AutomationOccurrence = {
    ...storedOccurrence,
    eventSourceId: eventSource.id,
    eventSourceKey: eventSource.sourceKey,
    eventSourceName: eventSource.name,
    eventSourceIntegration: eventSource.integration,
    sourceKind: eventSource.providerKind,
    sourceLocator: buildEventSourceLocator(eventSource),
    matchKey: eventSource.sourceKey,
  };
  const decoratedOccurrence = decorateOccurrenceDisplay(occurrence, {
    eventProviderRef: eventSource.providerRef,
  });

  await expireAutomationRules({
    workspaceId: input.workspaceId,
    referenceTime: occurrence.occurredAt,
  });
  const matches = await resolveAutomationRulesForEvent({
    workspaceId: input.workspaceId,
    eventSourceId: eventSource.id,
    payload,
    occurredAt: occurrence.occurredAt,
  });

  const executions = [] as AutomationExecution[];
  for (const match of matches) {
    const { execution, isNew } = await createAutomationExecution({
      workspaceId: input.workspaceId,
      ruleId: match.ruleId,
      occurrenceId: occurrence.id,
    });
    if (!isNew) {
      continue;
    }
    await applyAutomationPolicyAfterTrigger({
      ruleId: match.ruleId,
      workspaceId: input.workspaceId,
      occurrenceId: occurrence.id,
      executionId: execution.id,
      completionReason: 'max_trigger_count',
    });
    executions.push(execution);
  }

  await touchAutomationEventSourceTriggered(eventSource.id);
  await executeSql(
    `INSERT INTO audit_logs (workspace_id, action, resource_type, resource_id, details)
     VALUES ($1, 'automation_event_source.trigger', 'automation_event_source', $2, $3)`,
    [
      input.workspaceId,
      eventSource.id,
      JSON.stringify({
        occurrenceId: occurrence.id,
        occurrenceTitle: decoratedOccurrence.displayTitle,
        executionCount: executions.length,
      }),
    ],
  );

  return {
    occurrence: decoratedOccurrence,
    executions,
  };
}

export async function ingestAutomationWebhookEvent(params: {
  pathToken: string;
  sourceKey: string;
  secret?: string;
  headers?: Record<string, unknown>;
  rawBody?: string;
  payload?: Record<string, unknown>;
  sourceSnapshot?: Record<string, unknown>;
  dedupeKey?: string;
  occurredAt?: string;
}) {
  const sourceRow = await getAutomationEventSourceByWebhookPathToken(params.pathToken, params.sourceKey);
  if (!sourceRow) {
    throw new Error('Webhook event source not found');
  }
  if (!sourceRow.endpoint_secret_ciphertext) {
    throw new Error('Webhook endpoint secret is unavailable');
  }
  const endpointSecret = decrypt(sourceRow.endpoint_secret_ciphertext);

  let payload = params.payload || {};
  let sourceSnapshot: Record<string, unknown> = {
    endpointId: sourceRow.endpoint_id,
    endpointName: sourceRow.endpoint_name,
    ...(params.sourceSnapshot || {}),
  };
  let dedupeKey = params.dedupeKey;
  let occurredAt = params.occurredAt;

  if (!params.secret || !verifyPresentedSecret(params.secret, endpointSecret)) {
    throw new Error('Invalid webhook secret');
  }

  await touchWebhookReceived(sourceRow.endpoint_id);

  return ingestAutomationEvent({
    workspaceId: sourceRow.workspace_id,
    eventSourceId: sourceRow.id,
    payload,
    sourceSnapshot,
    dedupeKey,
    occurredAt,
  });
}

export async function ingestIntegrationAutomationWebhookEvent(params: {
  pathToken: string;
  headers?: Record<string, unknown>;
  rawBody?: string;
  payload?: Record<string, unknown>;
}) {
  const sourceRows = await listIntegrationEventSourcesByWebhookPathToken(params.pathToken);
  const sourceRow = sourceRows[0];
  if (!sourceRow) {
    throw new Error('Integration webhook binding not found');
  }
  if (!sourceRow.endpoint_secret_ciphertext) {
    throw new Error('Webhook endpoint secret is unavailable');
  }

  const endpointSecret = decrypt(sourceRow.endpoint_secret_ciphertext);
  const source = mapEventSourceRow(sourceRow);
  if (!source.integration) {
    throw new Error('Integration webhook ingress requires integration metadata');
  }

  const normalized = normalizeIntegrationWebhookIngress({
    integration: source.integration,
    secret: endpointSecret,
    headers: params.headers || {},
    rawBody: params.rawBody,
    body: params.payload || {},
  });
  if (normalized.ignore) {
    return {
      ignored: true as const,
      occurrences: [],
      executions: [],
    };
  }

  await touchWebhookReceived(sourceRow.endpoint_id);
  const matchingSourceKeys = listIntegrationSourceKeysForWebhookIngress({
    provider: source.integration.provider,
    headers: params.headers || {},
    payload: normalized.payload,
  });
  const matchingRows = sourceRows.filter((row) => matchingSourceKeys.includes(row.source_key));
  if (matchingRows.length === 0) {
    return {
      ignored: true as const,
      occurrences: [],
      executions: [],
    };
  }

  const sharedSourceSnapshot: Record<string, unknown> = {
    endpointId: sourceRow.endpoint_id,
    endpointName: sourceRow.endpoint_name,
    ...(normalized.sourceSnapshot || {}),
  };
  const occurrences: AutomationOccurrence[] = [];
  const executions: AutomationExecution[] = [];

  for (const row of matchingRows) {
    const result = await ingestAutomationEvent({
      workspaceId: row.workspace_id,
      eventSourceId: row.id,
      payload: normalized.payload,
      sourceSnapshot: sharedSourceSnapshot,
      dedupeKey: normalized.dedupeKey,
      occurredAt: normalized.occurredAt,
    });
    occurrences.push(result.occurrence);
    executions.push(...result.executions);
  }

  return {
    ignored: false as const,
    occurrences,
    executions,
  };
}

export async function scheduleDueAutomationExecutions(limit = MAX_SCHEDULER_BATCH_SIZE): Promise<ScheduleDueRulesResult> {
  const scheduledExecutions: string[] = [];
  const batchSize = Math.max(1, Math.min(limit, MAX_SCHEDULER_BATCH_SIZE));

  await transaction(async (client) => {
    await expireAutomationRules({ client });

    const dueResult = await executeSqlOn<{
      rule_id: string;
      rule_name: string;
      workspace_id: string;
      schedule_kind: 'cron' | 'at' | 'interval';
      schedule_expr: string | null;
      schedule_timezone: string | null;
      interval_seconds: number | null;
      starts_at: string | null;
      active_from: string | null;
      active_until: string | null;
      next_fire_at: string;
      last_fired_at: string | null;
    }>(client, 
      `SELECT at.rule_id, ar.name AS rule_name, ar.workspace_id, at.schedule_kind, at.schedule_expr, at.schedule_timezone,
              at.interval_seconds, at.starts_at, ap.active_from, ap.active_until, at.next_fire_at, at.last_fired_at
       FROM automation_triggers at
       JOIN automation_rules ar ON ar.id = at.rule_id
       JOIN automation_policies ap ON ap.rule_id = ar.id
       WHERE at.trigger_kind = 'schedule'
         AND ar.status = 'active'
         AND at.next_fire_at IS NOT NULL
         AND at.next_fire_at <= NOW()
         AND (ap.active_from IS NULL OR ap.active_from <= at.next_fire_at)
         AND (ap.active_until IS NULL OR ap.active_until >= at.next_fire_at)
         AND (ap.max_trigger_count IS NULL OR ap.trigger_count < ap.max_trigger_count)
       ORDER BY at.next_fire_at ASC
       LIMIT $1
       FOR UPDATE OF at SKIP LOCKED`,
      [batchSize],
    );

    for (const row of dueResult.rows) {
      const occurrence = await createAutomationOccurrence({
        workspaceId: row.workspace_id,
        sourceKind: 'clock',
        sourceLocator: row.schedule_timezone || 'UTC',
        dedupeKey: `${row.rule_id}:${row.next_fire_at}`,
        sourceSnapshot: {
          ruleId: row.rule_id,
          ruleName: row.rule_name,
          scheduleKind: row.schedule_kind,
          scheduleExpr: row.schedule_expr,
          scheduleTimezone: row.schedule_timezone,
          intervalSeconds: row.interval_seconds,
          startsAt: row.starts_at,
          activeFrom: row.active_from,
          activeUntil: row.active_until,
          scheduledAt: row.next_fire_at,
        },
        payload: {},
        occurredAt: row.next_fire_at,
        client,
      });

      const { execution, isNew } = await createAutomationExecution({
        workspaceId: row.workspace_id,
        ruleId: row.rule_id,
        occurrenceId: occurrence.id,
        client,
      });

      const nextFireAt = computeNextFireAt({
        scheduleKind: row.schedule_kind,
        scheduleExpr: row.schedule_expr || undefined,
        scheduleTimezone: row.schedule_timezone || undefined,
        intervalSeconds: row.interval_seconds || undefined,
        startsAt: row.starts_at,
        activeFrom: row.active_from,
        activeUntil: row.active_until,
        baseTime: new Date(row.next_fire_at),
        lastFiredAt: row.next_fire_at,
      });

      await executeSqlOn(client, 
        `UPDATE automation_triggers
         SET last_fired_at = $2,
             next_fire_at = $3,
             updated_at = NOW()
         WHERE rule_id = $1`,
        [row.rule_id, row.next_fire_at, nextFireAt],
      );
      if (isNew) {
        await applyAutomationPolicyAfterTrigger({
          ruleId: row.rule_id,
          workspaceId: row.workspace_id,
          occurrenceId: occurrence.id,
          executionId: execution.id,
          completeNow: nextFireAt === null,
          completionReason: 'schedule_exhausted',
          client,
        });
        scheduledExecutions.push(execution.id);
      }
    }
  });

  return { scheduledExecutions };
}

export async function processAutomationExecution(executionId: string): Promise<ProcessAutomationExecutionResult> {
  const executionResult = await executeSql<AutomationExecutionRow>(
    `UPDATE automation_executions
     SET status = 'running',
         attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'pending'
     RETURNING *`,
    [executionId],
  );
  const executionRow = executionResult.rows[0];
  if (!executionRow) {
    const existingResult = await executeSql<AutomationExecutionRow>(
      `SELECT *
       FROM automation_executions
       WHERE id = $1
       LIMIT 1`,
      [executionId],
    );
    if (!existingResult.rows[0]) {
      throw new Error(`Automation execution ${executionId} not found`);
    }
    return {
      executionId,
      wakeupCount: 0,
    };
  }

  const execution = mapExecutionRow(executionRow);
  const occurrenceResult = await executeSql<AutomationOccurrenceRow>(
    `SELECT ao.*,
            aes.source_key AS event_source_key,
            aes.name AS event_source_name,
            aes.provider_ref AS event_provider_ref
     FROM automation_occurrences
     ao
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     WHERE ao.id = $1
     LIMIT 1`,
    [execution.occurrenceId],
  );
  const occurrence = occurrenceResult.rows[0] ? mapOccurrenceRow(occurrenceResult.rows[0]) : null;
  if (!occurrence) {
    throw new Error(`Automation occurrence ${execution.occurrenceId} not found`);
  }

  const rule = await getAutomationRule(execution.workspaceId, execution.ruleId);
  if (!rule) {
    throw new Error(`Automation rule ${execution.ruleId} not found`);
  }

  try {
    const resolved = await resolveExistingConversationId(rule);
    const { targetMemberIds, actorRecipientIds } = await resolveRecipientMembers(rule, resolved.conversationId);
    const createdItemId = await createAutomationNotice({
      rule,
      executionId,
      occurrence,
      conversationId: resolved.conversationId,
      targetMemberIds,
    });

    const wakeupCount = await wakeAutomationTargets({
      rule,
      executionId,
      occurrence,
      conversationId: resolved.conversationId,
      createdItemId,
      actorRecipientIds,
    });

    await executeSql(
      `UPDATE automation_executions
       SET status = 'completed',
           error_message = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [executionId],
    );
    await executeSql(
      `UPDATE automation_rules
       SET last_triggered_at = NOW(),
           last_error_at = NULL,
           last_error_message = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [rule.id],
    );
    await executeSql(
      `INSERT INTO audit_logs (workspace_id, user_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, 'automation_rule.trigger', 'automation_rule', $4, $5)`,
      [
        rule.workspaceId,
        rule.createdByUserId || null,
        rule.createdByActorId || null,
        rule.id,
        JSON.stringify({
          executionId,
          occurrenceId: occurrence.id,
          deliveryMode: rule.delivery.deliveryMode,
          createdItemId,
          wakeupCount,
        }),
      ],
    );

    return {
      executionId,
      createdConversationId: resolved.createdConversationId,
      createdItemId,
      wakeupCount,
    };
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    await executeSql(
      `UPDATE automation_executions
       SET status = 'failed',
           error_message = $2,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [executionId, message],
    );
    await updateRuleError(rule.id, message);
    throw error;
  }
}

export async function listAutomationExecutions(workspaceId: string, ruleId: string, limit = 50) {
  const result = await executeSql<AutomationExecutionRow>(
    `SELECT ae.*,
            ar.name AS execution_rule_name,
            ao.occurred_at AS occurrence_occurred_at,
            ao.source_kind AS occurrence_source_kind,
            aes.name AS occurrence_event_source_name,
            aes.source_key AS event_source_key,
            aes.provider_ref AS event_provider_ref,
            ao.source_snapshot,
            ao.payload,
            ao.source_locator,
            ao.match_key,
            ao.dedupe_key,
            ao.created_at AS occurrence_created_at
     FROM automation_executions ae
     LEFT JOIN automation_rules ar ON ar.id = ae.rule_id
     LEFT JOIN automation_occurrences ao ON ao.id = ae.occurrence_id
     LEFT JOIN automation_event_sources aes ON aes.id = ao.event_source_id
     WHERE ae.workspace_id = $1
       AND ae.rule_id = $2
     ORDER BY ae.created_at DESC
     LIMIT $3`,
    [workspaceId, ruleId, Math.max(1, Math.min(limit, 200))],
  );

  return result.rows.map((row) => {
    const execution = mapExecutionRow(row);
    if (!row.occurrence_id || !row.occurrence_occurred_at) {
      return execution;
    }

    const rawSourceSnapshot =
      (row as AutomationExecutionRow & { source_snapshot?: Record<string, unknown> | string | null }).source_snapshot;
    const parsedSourceSnapshot = parseJsonObject(rawSourceSnapshot);
    const mergedSourceSnapshot = {
      ...parsedSourceSnapshot,
      ruleName:
        (typeof parsedSourceSnapshot.ruleName === 'string' && parsedSourceSnapshot.ruleName.trim()
          ? parsedSourceSnapshot.ruleName.trim()
          : null) ||
        row.execution_rule_name ||
        undefined,
    };

    const occurrence = mapOccurrenceRow({
      id: row.occurrence_id,
      workspace_id: row.workspace_id,
      source_kind: row.occurrence_source_kind || 'internal',
      event_source_id: null,
      event_source_key: (row as AutomationExecutionRow & { event_source_key?: string | null }).event_source_key || null,
      event_source_name: row.occurrence_event_source_name || null,
      event_provider_ref:
        (row as AutomationExecutionRow & { event_provider_ref?: string | null }).event_provider_ref || null,
      source_locator: (row as AutomationExecutionRow & { source_locator?: string | null }).source_locator || null,
      match_key: (row as AutomationExecutionRow & { match_key?: string | null }).match_key || null,
      dedupe_key: (row as AutomationExecutionRow & { dedupe_key?: string | null }).dedupe_key || null,
      source_snapshot: mergedSourceSnapshot,
      payload: (row as AutomationExecutionRow & { payload?: Record<string, unknown> | string | null }).payload || {},
      occurred_at: row.occurrence_occurred_at,
      created_at:
        (row as AutomationExecutionRow & { occurrence_created_at?: string | null }).occurrence_created_at ||
        row.occurrence_occurred_at,
    });

    return {
      ...execution,
      occurrenceOccurredAt: occurrence.occurredAt,
      occurrenceSourceKind: occurrence.sourceKind,
      occurrenceEventSourceName: occurrence.eventSourceName,
      occurrenceTitle: occurrence.displayTitle,
      occurrenceSummary: occurrence.displaySummary,
      occurrenceDescription: occurrence.displayDescription,
    };
  });
}
