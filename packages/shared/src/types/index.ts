import {
  ACTOR_DOC_VISIBILITIES,
  ACTOR_DOC_CHANGED_FIELDS,
  ACTOR_PACKAGE_DEPENDENCY_KINDS,
  ACTOR_PACKAGE_LINK_STATUSES,
  ACTOR_PACKAGE_SYNC_MODES,
  ACTOR_PACKAGE_TARGET_KINDS,
  ACTOR_ROLES,
  ACTOR_RUNTIME_HEALTHS,
  ACTOR_UPDATE_SOURCE_TYPES,
  ACTOR_VERSION_CHANGED_FIELDS,
  ACTOR_VERSION_DOC_CHANGE_TYPES,
  ACCESS_TARGET_TYPES,
  AUTOMATION_COMPLETION_STATUSES,
  AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS,
  AUTOMATION_EVENT_SOURCE_STATUSES,
  AUTOMATION_RULE_CATEGORIES,
  AUTOMATION_RULE_STATUSES,
  AUTOMATION_SCHEDULE_KINDS,
  AUTOMATION_EXECUTION_STATUSES,
  AUTOMATION_INTEGRATION_INGRESS_KINDS,
  AUTOMATION_INTEGRATION_PROVIDERS,
  AUTOMATION_INTEGRATION_TARGET_KINDS,
  AUTOMATION_TARGET_POLICIES,
  AUTOMATION_TRIGGER_KINDS,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  AUTOMATION_WEBHOOK_ENDPOINT_STATUSES,
  CAPABILITY_ACCESS_TARGET_TYPES,
  CHAT_MEMBERSHIP_UPDATE_REASONS,
  CHAT_PARTICIPANT_REMOVAL_STATES,
  CONTACT_DIRECT_STATES,
  CONTACT_HUB_KINDS,
  CONTACT_TARGET_TYPES,
  CANONICAL_FILE_CATEGORIES,
  EVENT_TYPES,
  CONVERSATION_EVENT_CONTEXT_POLICIES,
  CONVERSATION_EVENT_TIMELINE_POLICIES,
  CONVERSATION_FEED_EVENT_TYPES,
  CONVERSATION_FEED_ITEM_SUBTYPES,
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_FEED_MESSAGE_TYPES,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_KINDS,
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS,
  CONVERSATION_MESSAGE_SUBTYPES,
  CONVERSATION_PARTICIPANT_ROLE_KEYS,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_PARTICIPANT_STATES,
  CONVERSATION_PARTICIPANT_TYPES,
  CONVERSATION_STATUSES,
  CONVERSATION_REPLY_REF_SUBTYPES,
  FILE_ORIGIN_SYSTEMS,
  FILE_ORIGIN_FAMILIES,
  USER_UPLOAD_FILE_ORIGIN_SYSTEMS,
  ACTOR_OUTPUT_FILE_ORIGIN_SYSTEMS,
  TOOL_OUTPUT_FILE_ORIGIN_SYSTEMS,
  MODEL_OUTPUT_FILE_ORIGIN_SYSTEMS,
  EXTERNAL_IMPORT_FILE_ORIGIN_SYSTEMS,
  PACKAGE_IMPORT_FILE_ORIGIN_SYSTEMS,
  SYSTEM_GENERATED_FILE_ORIGIN_SYSTEMS,
  FILE_PARSE_OUTPUT_KINDS,
  FILE_PARSE_RUN_STATUSES,
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  CONVERSATION_TYPE_KEYS,
  DEVICE_EXPOSURE_TRANSPORTS,
  MCP_SERVER_TRANSPORTS,
  PLUGIN_SPEC_TRANSPORTS,
  PLUGIN_TRANSPORTS,
  INVITE_TRUST_LEVELS,
  WORKSPACE_TRUST_LEVELS,
  TASK_DECISIONS,
  TASK_INPUT_QUESTION_TYPES,
  TASK_LIFECYCLE_STATUSES,
  TASK_OUTCOMES,
  TASK_REQUEST_KIND,
  TASK_REQUEST_KINDS,
  IDENTITY_SEARCH_MATCH_STATES,
  IDENTITY_SEARCH_OUTCOMES,
  MEMORY_CATEGORIES,
  MEMORY_INDEX_STATUSES,
  MEMORY_ITEM_STATES,
  MEMORY_RECALL_TYPES,
  MEMORY_SPACE_TYPES,
  MEMORY_SCOPES,
  MEMORY_STABILITIES,
  MEMORY_STATUSES,
  MARKETPLACE_ASSET_KINDS,
  MARKETPLACE_ITEM_KINDS,
  MARKETPLACE_LINEAGE_KINDS,
  MARKETPLACE_REQUIREMENT_KINDS,
  MARKETPLACE_REQUIREMENT_STATUSES,
  MARKETPLACE_REQUIREMENT_TARGET_KINDS,
  MARKETPLACE_SOURCE_TYPES,
  MARKETPLACE_SYNC_MODES,
  MARKETPLACE_VERSION_STATUSES,
  MCP_VALIDATION_RULE_KINDS,
  PLUGIN_AUTH_BINDING_DRIVER_KINDS,
  PLUGIN_AUTH_CHALLENGE_KINDS,
  PLUGIN_AUTH_CHALLENGE_OPEN_MODES,
  PLUGIN_AUTH_CONNECTION_STATUSES,
  PLUGIN_AUTH_DERIVED_VALUE_NAMES,
  PLUGIN_AUTH_SESSION_STATUSES,
  PLUGIN_AUTH_SESSION_PHASES,
  PLUGIN_AUTH_VALUE_SOURCE_KINDS,
  PLUGIN_CONFIG_FIELD_TYPES,
  PLUGIN_INSTALLATION_MODES,
  PLUGIN_INSTALLATION_STATUSES,
  PLUGIN_INSTALL_ACTION_KINDS,
  PLUGIN_INSTALL_STEP_KINDS,
  PLUGIN_INSTALL_STEP_SCOPES,
  PLATFORM_ACCESS_SOURCES,
  PLAN_APPROVAL_DECISIONS,
  REALTIME_ASR_AUDIO_CODECS,
  REALTIME_ASR_AUDIO_FORMATS,
  TARGETED_TASK_REQUEST_KINDS,
  REUSE_SCOPES,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_PROFILE_SUBJECT_TYPES,
  RELATIONSHIP_REQUEST_STATUSES,
  RELATIONSHIP_SCAN_OUTCOMES,
  DEVICE_ACCESS_DENIAL_KINDS,
  DEVICE_ACCESS_DENIAL_RESOLUTIONS,
  RUNTIME_CAPABILITY_ACCESS_SCOPE_KINDS,
  RUNTIME_CAPABILITY_ACCESS_SUBJECT_KINDS,
  RUNTIME_AUTHORIZATION_BROWSER_ACTIONS,
  RUNTIME_AUTHORIZATION_BROWSER_SCOPE_TYPES,
  RUNTIME_AUTHORIZATION_CAPABILITIES,
  RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS,
  RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES,
  RUNTIME_AUTHORIZATION_CUA_ACCESSES,
  RUNTIME_AUTHORIZATION_FILESYSTEM_ACCESSES,
  RUNTIME_AUTHORIZATION_GRANT_RETENTIONS,
  RUNTIME_AUTHORIZATION_GRANT_STATUSES,
  RUNTIME_AUTHORIZATION_PRESETS,
  RUNTIME_AUTHORIZATION_REQUEST_MODES,
  SKILL_FRONTMATTER_EFFORTS,
  SKILL_MIRROR_SYNC_STATUSES,
  SKILL_SOURCE_TYPES,
  SESSION_COLLABORATION_MODES,
  SESSION_INTERRUPT_TYPES,
  SESSION_STATUSES,
  SESSION_TRIGGERS,
  SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES,
  SESSION_WAKEUP_SOURCE_TYPES,
  SESSION_WAKEUP_STATUSES,
  TASK_NOTICE_STATUSES,
  DIRECT_CONVERSATION_OPEN_STATUSES,
  MODEL_API_STYLES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_GRANT_STATUSES,
  MODEL_GROUP_OWNER_TYPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  MODEL_SERVER_TOOLS,
  REMOTE_AGENT_BINDING_STATUSES,
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATES,
  REMOTE_AGENT_MACHINE_TRUST_STATUSES,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUSES,
  REMOTE_AGENT_RUNTIME_KINDS,
  REMOTE_AGENT_RUNTIME_STATES,
  PLAN_CHECKLIST_STEP_STATUSES,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  TRANSPORT_DELIVERY_STATUSES,
  TRANSPORT_ENDPOINT_TYPES,
  TRANSPORT_KINDS,
  WEIXIN_QR_LOGIN_STATUSES,
  DINGTALK_DEVICE_FLOW_STATUSES,
  CORE_ACTOR_DOC_KEYS,
  ACTOR_DOC_KEYS,
} from "../constants/enums.js"
import type { ChatTypingState } from "../constants/enums.js"
import type { ProviderKind } from "../constants/model-providers.js"
import type { ToolSourceKind } from "../tool-source/kinds.js"
import type {
  FilesystemPolicy as FilesystemPolicyBase,
  CUAPolicy as CUAPolicyBase,
  PtyPolicy as PtyPolicyBase,
  BrowserPolicy as BrowserPolicyBase,
  CommandlinePolicy as CommandlinePolicyBase,
  GrantPolicy as GrantPolicyBase,
} from "../access/policies/index.js"
import type {
  WorkspaceResourceGrantPermission,
  WorkspaceResourceGrantRequestStatus,
  WorkspaceResourceGrantSource,
  WorkspaceResourceGrantStatus,
  WorkspaceResourceKind,
  WorkspaceResourceStatus,
} from "../access/enums.js"
import type { SubjectRef, ScopedSubjectTarget } from "../access/subject.js"
import type { IsoInstantString } from "../datetime/instant.js"
import type { WorkspaceResourceGrantTargetInput as WorkspaceResourceGrantTargetContract } from "../schemas/workspace-resources.js"

// ============ Common ============
export type UUID = string
export type Timestamp = IsoInstantString

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// ============ Auth ============
export interface User {
  id: UUID
  email: string
  name: string
  avatarUrl?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

/**
 * Authentication is provided by Better Auth. The legacy client-type / transport
 * / session-persistence / QR-login shapes were removed when the hand-rolled
 * auth layer was replaced; clients talk to Better Auth's native endpoints and
 * use the `better-auth` client's own types for sessions/accounts.
 *
 * `AuthSessionSummary` / `AuthResponse` are retained only as the shape of the
 * custom GET /api/v1/auth/me endpoint (which preserves `{ user, session }` for
 * the web proxy guard and clients). `session` carries just the BA session id.
 */
export interface AuthSessionSummary {
  id: UUID
}

export interface AuthResponse {
  user: User
  session: AuthSessionSummary
}

// ============ Workspace ============
export type TrustLevel = (typeof WORKSPACE_TRUST_LEVELS)[number]

export interface Workspace {
  id: UUID
  name: string
  slug: string
  description?: string
  ownerId: UUID
  isTrusted: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface WorkspaceMember {
  id: UUID
  workspaceId: UUID
  userId: UUID
  trustLevel: TrustLevel
  joinedAt: Timestamp
}

export interface WorkspaceChiefActorSummary {
  id: UUID
  displayName: string
  role: ActorRole
  title: string
  avatarUrl?: string
}

export interface WorkspaceChiefActorPreference {
  workspaceId: UUID
  workspaceMemberId: UUID
  chiefActorId?: UUID
  chiefActor?: WorkspaceChiefActorSummary
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

// ============ Workspace Invites ============
export type InviteTrustLevel = (typeof INVITE_TRUST_LEVELS)[number]

export interface WorkspaceInvite {
  id: UUID
  workspaceId: UUID
  token: string
  createdByWorkspaceMemberId: UUID
  trustLevel: InviteTrustLevel
  maxUses?: number
  useCount: number
  expiresAt?: Timestamp
  isRevoked: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
  // Joined fields
  workspaceName?: string
}

// ============ Actor (Digital Employee) ============
export type ActorRole = (typeof ACTOR_ROLES)[number]

export type ActorDocVisibility = (typeof ACTOR_DOC_VISIBILITIES)[number]

export type CoreActorDocKey = (typeof CORE_ACTOR_DOC_KEYS)[number]

export type ActorDocKey = (typeof ACTOR_DOC_KEYS)[number]

export interface ActorDoc {
  // Stable string identifier, not necessarily a UUID: seeded official-template
  // docs use slug-based ids (e.g. "<slug>:identity-card"). See ActorDocSchema.
  id: string
  key: ActorDocKey
  title: string
  content: CanonicalContentBlock[]
  visibility: ActorDocVisibility
  priority: number
}

export type ActorDocInput = Omit<ActorDoc, "id" | "content"> & {
  id?: string
  content: CanonicalContentBlockInput[]
}

export interface ActorDefinition {
  displayName: string
  role: ActorRole
  title: string
  avatarFileId?: UUID
  avatarEmoji?: string
  parentId?: UUID
  canRepresentUser: boolean
  docs: ActorDoc[]
  specialties: string[]
  config: Record<string, unknown>
}

export type ActorUpdateSourceType = (typeof ACTOR_UPDATE_SOURCE_TYPES)[number]

export interface ActorVersionSource {
  type: ActorUpdateSourceType
  workspaceMemberId?: UUID
  actorId?: UUID
  sessionId?: UUID
  turnId?: UUID
  conversationId?: UUID
  reason?: string
}

export type ActorVersionChangedField =
  (typeof ACTOR_VERSION_CHANGED_FIELDS)[number]

export type ActorDocChangedField = (typeof ACTOR_DOC_CHANGED_FIELDS)[number]

export interface ActorDocFieldChange {
  field: ActorDocChangedField
  before?: unknown
  after?: unknown
  beforeSummaryText?: string
  afterSummaryText?: string
}

export interface ActorFieldChange {
  kind: "field"
  field: ActorVersionChangedField
  before?: unknown
  after?: unknown
  summary: CanonicalContentBlock[]
}

export interface ActorVersionDocChange {
  kind: "doc"
  docId: UUID
  key: ActorDocKey
  title: string
  changeType: ActorVersionDocChangeType
  visibility: ActorDocVisibility
  priority: number
  fieldChanges: ActorDocFieldChange[]
  summary: CanonicalContentBlock[]
}

export type ActorVersionDocChangeType =
  (typeof ACTOR_VERSION_DOC_CHANGE_TYPES)[number]

export type ActorVersionChange = ActorFieldChange | ActorVersionDocChange

export interface ActorVersionDelta {
  fromVersion: number
  toVersion: number
  source?: ActorVersionSource
  changes: ActorVersionChange[]
  summary: CanonicalContentBlock[]
}

export interface ActorVersion {
  id: UUID
  actorId: UUID
  version: number
  previousVersionId?: UUID
  snapshot: ActorDefinition
  delta?: ActorVersionDelta
  createdByWorkspaceMemberId?: UUID
  source?: ActorVersionSource
  createdAt: Timestamp
}

export interface Actor {
  id: UUID
  workspaceId: UUID
  displayName: string
  packageId?: UUID
  packageInstanceId?: UUID
  definition: ActorDefinition
  avatarUrl?: string
  currentVersion: number
  sourceLink?: ActorPackageSourceLink
  isActive: boolean
  isPublicShared: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ActorCollaboration {
  id: UUID
  actorId: UUID
  collaboratorId: UUID
  relationship: string // e.g. 'peer', 'consultant', 'backup'
  description?: string
  createdAt: Timestamp
}

// ============ WorkItem ============
export type WorkItemStatus =
  | "created"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "review"
  | "completed"
  | "escalated"
  | "blocked"
  | "rework"
  | "cancelled"
  | "failed"

export type WorkItemPriority = "low" | "medium" | "high" | "urgent"

export type ParticipantRole =
  | "owner"
  | "accountable"
  | "executor"
  | "reviewer"
  | "watcher"

export interface WorkItem {
  id: UUID
  workspaceId: UUID
  title: string
  description: string
  status: WorkItemStatus
  priority: WorkItemPriority
  parentId?: UUID // Parent work item (for decomposition)
  createdByPrincipalType: "workspace_member" | "actor" | "user"
  createdByPrincipalId: UUID
  assignedTo?: UUID // Current owner actor
  accountableId?: UUID // Ultimate accountability
  sourceType:
    | "user_message"
    | "delegation"
    | "automation"
    | "escalation"
    | "collaboration"
  sourceId?: UUID
  dueAt?: Timestamp
  startedAt?: Timestamp
  completedAt?: Timestamp
  result?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface WorkItemParticipant {
  id: UUID
  workItemId: UUID
  actorId: UUID
  role: ParticipantRole
  addedAt: Timestamp
}

// Valid state transitions: `WORK_ITEM_TRANSITIONS` moved to ../work-item/index.ts
// (runtime data) per §2.2.1; re-exported from the package root barrel.

// ============ Memory ============
export type MemorySpaceType = (typeof MEMORY_SPACE_TYPES)[number]
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]
export type MemoryItemState = (typeof MEMORY_ITEM_STATES)[number]
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]
export type MemoryStability = (typeof MEMORY_STABILITIES)[number]
export type MemoryIndexStatus = (typeof MEMORY_INDEX_STATUSES)[number]
export type MemoryRecallType = (typeof MEMORY_RECALL_TYPES)[number]

export interface MemoryEntry {
  id: UUID
  workspaceId: UUID
  spaceId: UUID
  // D4: memory_spaces is now (owner_subject_id, scope_subject_id?, namespace_key).
  // The wire shape exposes owner / scope as SubjectRefs and the literal namespace key.
  owner: SubjectRef
  scope?: SubjectRef
  namespaceKey: string
  category: MemoryCategory
  state: MemoryItemState
  status: MemoryStatus
  stability: MemoryStability
  importance: number
  confidence: number
  tags: string[]
  textDigest: string
  searchText: string
  contentBlocks: CanonicalContentBlock[]
  sourceItemId?: UUID
  sourceToolCallId?: UUID
  sourceTurnId?: UUID
  supersedesMemoryId?: UUID
  metadata: Record<string, unknown>
  indexStatus: MemoryIndexStatus
  embeddingModel?: string
  embeddingDim?: number
  indexedAt?: Timestamp
  indexError?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Display-friendly labels derived from owner / scope subject joins. */
  ownerLabel?: string
  scopeLabel?: string
}

export type Memory = MemoryEntry

export interface MemorySearchHit extends MemoryEntry {
  matchedChunkId?: UUID
  rank: number
  finalScore: number
  vectorScore?: number
  textScore?: number
  similarityScore?: number
  matchedTerms?: string[]
}

export interface MemoryRecallResult extends MemorySearchHit {
  recallReason?: string
}

export interface MemoryRecallRun {
  id: UUID
  workspaceId: UUID
  actorId?: UUID
  conversationId?: UUID
  workspaceMemberId?: UUID
  recallType: MemoryRecallType
  queryText: string
  queryBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  createdAt: Timestamp
  results: MemoryRecallResult[]
}

// ============ Automation ============
export type AutomationCategory = (typeof AUTOMATION_RULE_CATEGORIES)[number]
export type AutomationStatus = (typeof AUTOMATION_RULE_STATUSES)[number]
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGER_KINDS)[number]
export type AutomationSourceKind =
  (typeof AUTOMATION_TRIGGER_SOURCE_KINDS)[number]
export type AutomationEventProviderKind =
  (typeof AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS)[number]
export type AutomationIntegrationProvider =
  (typeof AUTOMATION_INTEGRATION_PROVIDERS)[number]
export type AutomationIntegrationIngressKind =
  (typeof AUTOMATION_INTEGRATION_INGRESS_KINDS)[number]
export type AutomationIntegrationTargetKind =
  (typeof AUTOMATION_INTEGRATION_TARGET_KINDS)[number]
export type AutomationScheduleKind = (typeof AUTOMATION_SCHEDULE_KINDS)[number]
export type AutomationCompletionStatus =
  (typeof AUTOMATION_COMPLETION_STATUSES)[number]
export type AutomationTargetPolicy = (typeof AUTOMATION_TARGET_POLICIES)[number]
export type AutomationExecutionStatus =
  (typeof AUTOMATION_EXECUTION_STATUSES)[number]
export type AutomationWebhookStatus =
  (typeof AUTOMATION_WEBHOOK_ENDPOINT_STATUSES)[number]
export type AutomationEventSourceStatus =
  (typeof AUTOMATION_EVENT_SOURCE_STATUSES)[number]

export interface AutomationEventSourceIntegration {
  bindingId?: UUID
  installationId: UUID
  provider: AutomationIntegrationProvider
  ingressKind: AutomationIntegrationIngressKind
  targetKind: AutomationIntegrationTargetKind
  targetId: string
  targetLabel: string
  endpointId?: UUID
  externalSubscriptionId?: string
}

export interface AutomationEventSource {
  id: UUID
  workspaceId: UUID
  providerKind: AutomationEventProviderKind
  providerRef?: string
  integration?: AutomationEventSourceIntegration
  sourceKey: string
  name: string
  description: string
  recommendedUsage?: string
  payloadSchema: Record<string, unknown>
  examplePayload: Record<string, unknown>
  status: AutomationEventSourceStatus
  createdByWorkspaceMemberId?: UUID
  lastTriggeredAt?: Timestamp
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationRule {
  id: UUID
  workspaceId: UUID
  authorityWorkspaceId: UUID
  conversationId: UUID
  category: AutomationCategory
  status: AutomationStatus
  name: string
  description: string
  createdByParticipantId: UUID
  createdBySessionId?: UUID
  trigger: AutomationTrigger
  policy: AutomationPolicy
  delivery: AutomationDelivery
  lastTriggeredAt?: Timestamp
  lastErrorAt?: Timestamp
  lastErrorMessage?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationTrigger {
  ruleId: UUID
  triggerKind: AutomationTriggerKind
  sourceKind: AutomationSourceKind
  eventSourceId?: UUID
  eventSourceKey?: string
  eventSourceName?: string
  eventProviderKind?: AutomationEventProviderKind
  eventProviderRef?: string
  eventSourceIntegration?: AutomationEventSourceIntegration
  eventSourceStatus?: AutomationEventSourceStatus
  sourceLocator?: string
  matchKey?: string
  matcher: Record<string, unknown>
  scheduleKind?: AutomationScheduleKind
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: Timestamp
  nextFireAt?: Timestamp
  lastFiredAt?: Timestamp
  metadata: Record<string, unknown>
}

export interface AutomationPolicy {
  ruleId: UUID
  activeFrom?: Timestamp
  activeUntil?: Timestamp
  maxTriggerCount?: number
  triggerCount: number
  completionStatus: AutomationCompletionStatus
  completedAt?: Timestamp
  metadata: Record<string, unknown>
}

export interface AutomationDelivery {
  ruleId: UUID
  messageText: string
  wakeReasonText?: string
  messageBlocks: CanonicalContentBlock[]
  targetPolicy: AutomationTargetPolicy
  targetParticipantIds: UUID[]
  metadata: Record<string, unknown>
}

export interface AutomationOccurrence {
  id: UUID
  workspaceId: UUID
  sourceKind: AutomationSourceKind
  eventSourceId?: UUID
  eventSourceKey?: string
  eventSourceName?: string
  eventSourceIntegration?: AutomationEventSourceIntegration
  displayTitle?: string
  displaySummary?: string
  displayDescription?: string
  sourceLocator?: string
  matchKey?: string
  dedupeKey?: string
  sourceSnapshot: Record<string, unknown>
  payload: Record<string, unknown>
  occurredAt: Timestamp
  createdAt: Timestamp
}

export interface AutomationExecution {
  id: UUID
  workspaceId: UUID
  ruleId: UUID
  occurrenceId: UUID
  occurrenceOccurredAt?: Timestamp
  occurrenceSourceKind?: AutomationSourceKind
  occurrenceEventSourceName?: string
  occurrenceTitle?: string
  occurrenceSummary?: string
  occurrenceDescription?: string
  status: AutomationExecutionStatus
  errorMessage?: string
  startedAt?: Timestamp
  completedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationExecutionTarget {
  id: UUID
  executionId: UUID
  conversationId?: UUID
  targetParticipantId?: UUID
  sessionId?: UUID
  targetActorId?: UUID
  createdItemId?: UUID
  wakeupId?: UUID
  status: AutomationExecutionStatus
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationWebhookEndpoint {
  id: UUID
  workspaceId: UUID
  name: string
  status: AutomationWebhookStatus
  pathToken: string
  secretHint: string
  metadata: Record<string, unknown>
  createdByWorkspaceMemberId?: UUID
  lastReceivedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface AutomationWebhookEndpointCreateResult {
  endpoint: AutomationWebhookEndpoint
  secret: string
}

// ============ Events ============
export type EventType = (typeof EVENT_TYPES)[number]

export interface SystemEvent {
  type: EventType
  workspaceId: UUID
  recipientWorkspaceMemberId?: UUID
  payload: Record<string, unknown>
  timestamp: Timestamp
}

// ============ AI ============
export type SessionStatus = (typeof SESSION_STATUSES)[number]
export type SessionCollaborationMode =
  (typeof SESSION_COLLABORATION_MODES)[number]
export type PlanChecklistStepStatus =
  (typeof PLAN_CHECKLIST_STEP_STATUSES)[number]
export type SessionTrigger = (typeof SESSION_TRIGGERS)[number]
export type SessionMessageRole = "user" | "assistant" | "system" | "tool_result"
export type SessionInterruptType = (typeof SESSION_INTERRUPT_TYPES)[number]
export type SessionWakeupSourceParticipantType =
  (typeof SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES)[number]
export type SessionWakeupSourceType =
  (typeof SESSION_WAKEUP_SOURCE_TYPES)[number]
export type SessionWakeupStatus = (typeof SESSION_WAKEUP_STATUSES)[number]
export type ActorRuntimeHealth = (typeof ACTOR_RUNTIME_HEALTHS)[number]
export type ActorRuntimePhase =
  | "idle"
  | "thinking"
  | "tool"
  | "responding"
  | "blocked"
  | "error"

export interface Session {
  id: UUID
  workspaceId: UUID
  actorId: UUID
  conversationId: UUID
  conversationKind?: "direct" | "group"
  conversationTitle?: string
  isGroupConversation?: boolean
  hasThreadContext?: boolean
  trigger: SessionTrigger
  status: SessionStatus
  collaborationMode: SessionCollaborationMode
  activePlanApprovalTaskId?: UUID
  collaborationState: SessionCollaborationState
  errorMessage?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  completedAt?: Timestamp
}

export interface PlanChecklistStep {
  step: string
  status: PlanChecklistStepStatus
}

export interface SessionPlanDraftState {
  summary?: string
  checklist: PlanChecklistStep[]
  explanation?: string
  enteredAt?: Timestamp
}

export interface SessionCollaborationState {
  planDraft?: SessionPlanDraftState
}

export interface SessionWakeup {
  id: UUID
  sessionId: UUID
  turnId?: UUID
  sourceType: SessionWakeupSourceType
  sourceItemId?: UUID
  sourceSessionId?: UUID
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: UUID
  sourceName?: string
  summary: string
  reasonText?: string
  status: SessionWakeupStatus
  activationKind?: string
  delivery?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
  attachedAt?: Timestamp
  processedAt?: Timestamp
}

export interface ActorRuntimeWakeup {
  wakeupId: UUID
  sourceType: SessionWakeupSourceType
  sourceItemId?: UUID
  sourceSessionId?: UUID
  sourceParticipantType?: SessionWakeupSourceParticipantType
  sourceParticipantId?: UUID
  sourceName?: string
  summary: string
  reasonText?: string
  status: SessionWakeupStatus
  activationKind?: string
  delivery?: string
  createdAt: Timestamp
  attachedAt?: Timestamp
}

export type ActorRuntimeActivityState =
  | "pending"
  | "running"
  | "input_required"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"

export type ActorRuntimeToolKind = ToolSourceKind

export type ActorRuntimeTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"

export interface ActorRuntimeProcessingTarget {
  wakeupId: UUID
  participantType?: SessionWakeupSourceParticipantType
  participantId?: UUID
  name: string
  summary?: string
  createdAt: Timestamp
  attachedAt?: Timestamp
}

// Structured tool provenance surfaced to the runtime UI so two same-leaf tools
// from different sources are distinguishable (a source badge + secondary text),
// rather than inferring from the wire name. Derived from tool_calls.source_kind
// + source_snapshot (tool provenance & routing refactor).
export interface ActorRuntimeToolSource {
  kind: ToolSourceKind
  /** Primary label, e.g. plugin "publisher/item" or the device name. */
  displayName?: string
  /** The source-native (visible/upstream) tool name, when distinct from leaf. */
  upstreamToolName?: string
}

export interface ActorRuntimeTurnPreviewTool {
  toolCallId: UUID
  toolKind: ActorRuntimeToolKind
  toolName: string
  source?: ActorRuntimeToolSource
  state: ActorRuntimeActivityState
  displayTitle: string
  displayDetail?: string
  // Presentation layer: semantic icon name + i18n-ready strings. The FE renders
  // `icon` + resolvePresentation(titlePresentation) (falling back to
  // displayTitle). Preview stays light: no result blocks/summary here.
  icon?: string
  titlePresentation?: import("../tool-presentation/index.js").PresentationString
  detailPresentation?: import("../tool-presentation/index.js").PresentationString
  startedAt: Timestamp
  updatedAt: Timestamp
  completedAt?: Timestamp
}

export interface ActorRuntimeTurnPreview {
  turnId: UUID
  startedAt: Timestamp
  updatedAt: Timestamp
  processingTargets: ActorRuntimeProcessingTarget[]
  activeTool?: ActorRuntimeTurnPreviewTool
  lastCompletedTool?: ActorRuntimeTurnPreviewTool
  totalToolCallCount: number
  completedToolCallCount: number
  failedToolCallCount: number
}

export interface ActorRuntimeTurnActivityItem {
  toolCallId: UUID
  toolKind: ActorRuntimeToolKind
  toolName: string
  source?: ActorRuntimeToolSource
  state: ActorRuntimeActivityState
  displayTitle: string
  displayDetail?: string
  // Presentation layer (see ActorRuntimeTurnPreviewTool). `resultSummary` is the
  // friendly one-line result; requestBlocks/resultBlocks are the (redacted)
  // rendered bodies.
  icon?: string
  titlePresentation?: import("../tool-presentation/index.js").PresentationString
  detailPresentation?: import("../tool-presentation/index.js").PresentationString
  resultSummary?: import("../tool-presentation/index.js").PresentationString
  requestBlocks: CanonicalContentBlock[]
  resultBlocks: CanonicalContentBlock[]
  taskStatus?: ActorRuntimeTaskStatus
  startedAt: Timestamp
  updatedAt: Timestamp
  completedAt?: Timestamp
}

export interface ActorRuntimeTurnActivityDetail {
  conversationId: UUID
  actorId: UUID
  actorDisplayName: string
  turnId: UUID
  startedAt: Timestamp
  updatedAt: Timestamp
  processingTargets: ActorRuntimeProcessingTarget[]
  items: ActorRuntimeTurnActivityItem[]
}

export interface ActorRuntimeState {
  conversationId: UUID
  sessionId: UUID
  actorId: UUID
  actorDisplayName: string
  laneState: SessionStatus
  health: ActorRuntimeHealth
  phase: ActorRuntimePhase
  statusText?: string
  pendingWakeupCount: number
  currentTurnPreview?: ActorRuntimeTurnPreview
  latestWakeupAt?: Timestamp
  lastError?: {
    message: string
    at: Timestamp
  }
  updatedAt: Timestamp
}

export type RelationshipProfileSubjectType =
  (typeof RELATIONSHIP_PROFILE_SUBJECT_TYPES)[number]
export type RelationshipApprovalMode =
  (typeof RELATIONSHIP_APPROVAL_MODES)[number]
export type RelationshipRequestStatus =
  (typeof RELATIONSHIP_REQUEST_STATUSES)[number]
export type ContactTargetType = (typeof CONTACT_TARGET_TYPES)[number]
export type ContactHubKind = (typeof CONTACT_HUB_KINDS)[number]
export type ContactDirectStateType = (typeof CONTACT_DIRECT_STATES)[number]
export type IdentitySearchOutcome = (typeof IDENTITY_SEARCH_OUTCOMES)[number]
export type IdentitySearchMatchState =
  (typeof IDENTITY_SEARCH_MATCH_STATES)[number]
export type RelationshipScanOutcome =
  (typeof RELATIONSHIP_SCAN_OUTCOMES)[number]
export type DirectConversationOpenStatus =
  (typeof DIRECT_CONVERSATION_OPEN_STATUSES)[number]
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

export type RemoteAgentRuntimeKind = (typeof REMOTE_AGENT_RUNTIME_KINDS)[number]
export type RemoteAgentRuntimeStateType =
  (typeof REMOTE_AGENT_RUNTIME_STATES)[number]
export type RemoteAgentRuntimeCatalogStatus =
  (typeof REMOTE_AGENT_RUNTIME_CATALOG_STATUSES)[number]
export type RemoteAgentBindingStatus =
  (typeof REMOTE_AGENT_BINDING_STATUSES)[number]
export type RemoteAgentMachineTrustStatus =
  (typeof REMOTE_AGENT_MACHINE_TRUST_STATUSES)[number]
export type RemoteAgentLifecycleState =
  (typeof REMOTE_AGENT_MACHINE_LIFECYCLE_STATES)[number]

export interface RemoteAgentRuntimeState {
  remoteAgentId: UUID
  runtimeKind: RemoteAgentRuntimeKind
  state: RemoteAgentRuntimeStateType
  statusText?: string
  activeConversationId?: UUID
  activeTaskId?: UUID
  sessionId?: string
  pendingConversationCount: number
  unreadDeliveryCount: number
  lastActivityAt?: Timestamp
  lastRunStartedAt?: Timestamp
  lastRunFinishedAt?: Timestamp
  lastError?: {
    message: string
    at: Timestamp
  }
  updatedAt: Timestamp
  capabilities?: RemoteAgentRuntimeCapabilityView
}

export interface RelationshipWorkspaceSummary {
  id: UUID
  name: string
  slug: string
}

export interface RelationshipProfileView {
  subjectType: RelationshipProfileSubjectType
  approvalMode: RelationshipApprovalMode
  qrToken: string
  qrUrl: string
  identityId: string
  identitySearchEnabled: boolean
  requiresContactApproval: boolean
  isPublicShared?: boolean
}

export interface ContactHubEntryRef {
  kind: ContactHubKind
  id: string
}

export interface ContactHubDirectState {
  status: ContactDirectStateType
  conversationId?: string
}

export interface ContactHubEntryView {
  kind: ContactHubKind
  id: string
  targetType: ContactTargetType
  title: string
  subtitle?: string
  avatarUrl?: string
  avatarEmoji?: string
  workspace: RelationshipWorkspaceSummary
  workspaceMemberId?: string
  userId?: string
  actorId?: string
  remoteAgentId?: string
  relationLabel: string
  directState: ContactHubDirectState
}

export interface IdentitySearchMatchView {
  profileId: UUID
  targetType: ContactTargetType
  title: string
  subtitle?: string
  avatarUrl?: string
  avatarEmoji?: string
  workspace: RelationshipWorkspaceSummary
  workspaceMemberId?: string
  userId?: string
  actorId?: string
  remoteAgentId?: string
  state: IdentitySearchMatchState
  contact?: ContactHubEntryRef
  conversationId?: UUID
  requestId?: UUID
}

export interface IdentitySearchResponse {
  query: string
  outcome: IdentitySearchOutcome
  matches: IdentitySearchMatchView[]
}

export interface RelationshipMemberSummaryView {
  workspace: RelationshipWorkspaceSummary
  workspaceMemberId: UUID
  userId: UUID
  name: string
  email: string
  avatarFileId?: UUID | null
  trustLevel?: TrustLevel
}

export interface RelationshipActorSummaryView {
  workspace: RelationshipWorkspaceSummary
  actorId: UUID
  displayName: string
  title: string
  role: ActorRole
  avatarFileId?: UUID | null
  avatarEmoji?: string | null
  requiresContactApproval: boolean
  isPublicShared: boolean
}

export interface RelationshipRemoteAgentSummaryView {
  workspace: RelationshipWorkspaceSummary
  remoteAgentId: UUID
  displayName: string
  title: string
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId?: UUID | null
  avatarEmoji?: string | null
  requiresContactApproval: boolean
  isPublicShared: boolean
}

export interface FriendRequestView {
  id: UUID
  status: RelationshipRequestStatus
  createdAt: Timestamp
  requester?: RelationshipMemberSummaryView | null
  targetType: ContactTargetType
  targetMember?: RelationshipMemberSummaryView | null
  targetActor?: RelationshipActorSummaryView | null
  targetRemoteAgent?: RelationshipRemoteAgentSummaryView | null
}

export interface FriendRequestListResponse {
  incoming: FriendRequestView[]
  outgoing: FriendRequestView[]
}

export interface ActorAccessRequestView {
  id: UUID
  status: RelationshipRequestStatus
  createdAt: Timestamp
  requester?: RelationshipMemberSummaryView | null
  actor?: RelationshipActorSummaryView | null
}

export interface ActorAccessRequestListResponse {
  incoming: ActorAccessRequestView[]
  outgoing: ActorAccessRequestView[]
}

export interface RemoteAgentAccessRequestView {
  id: UUID
  status: RelationshipRequestStatus
  createdAt: Timestamp
  requester?: RelationshipMemberSummaryView | null
  remoteAgent?: RelationshipRemoteAgentSummaryView | null
}

export interface RemoteAgentAccessRequestListResponse {
  incoming: RemoteAgentAccessRequestView[]
  outgoing: RemoteAgentAccessRequestView[]
}

export interface ConversationParticipantView {
  participantId?: UUID
  participantType?: ConversationParticipantType
  id?: UUID
  workspaceMemberId?: UUID
  actorId?: UUID
  remoteAgentId?: UUID
  name?: string
  title?: string
  role?: string
  conversationRole?: string
  avatarUrl?: string
  avatarEmoji?: string
  state?: (typeof CONVERSATION_PARTICIPANT_STATES)[number]
}

export interface ConversationMessagePreview {
  content: string
  role: Exclude<(typeof CONVERSATION_ITEM_ROLES)[number], "tool">
  actorName?: string
  createdAt: Timestamp
}

export interface ConversationPresentationView {
  chatType: "direct" | "group"
  title: string
  avatarUrl?: string
  subtitle?: string
  peer?: ConversationParticipantView
  canRename?: boolean
  canManageMembers?: boolean
  canManageParticipants?: boolean
}

export interface ConversationSummaryView {
  id: UUID
  kind: (typeof CONVERSATION_KINDS)[number]
  isIm: boolean
  status: ConversationStatus
  transportKind?: TransportKind
  participants: ConversationParticipantView[]
  members?: ConversationParticipantView[]
  lastMessage?: ConversationMessagePreview
  unreadCount: number
  createdAt: Timestamp
  title: string
  name: string
  avatarUrl?: string
  presentation?: ConversationPresentationView
  permissions?: {
    canManage?: boolean
    canManageMembers?: boolean
    canManageParticipants?: boolean
  }
  viewerParticipantId?: UUID
  viewerWorkspaceMemberId?: UUID
}

export interface ContactHubResponse {
  requestSummary: {
    friendPendingCount: number
    actorAccessPendingCount: number
    remoteAgentAccessPendingCount: number
    totalPendingCount: number
  }
  workspaceActors: ContactHubEntryView[]
  workspaceRemoteAgents: ContactHubEntryView[]
  workspaceMembers: ContactHubEntryView[]
  friends: ContactHubEntryView[]
  groups: ConversationSummaryView[]
}

export interface ContactHubDetailResponse {
  contact: ContactHubEntryView
  groups: ConversationSummaryView[]
}

export interface RelationshipScanResponse {
  outcome: RelationshipScanOutcome
  requestId?: UUID
  contact?: ContactHubEntryRef
}

export interface DirectConversationOpenResponse {
  status: DirectConversationOpenStatus
  created?: boolean
  conversationId?: UUID
  requestId?: UUID
}

export interface RemoteAgentRuntimeCapabilityView {
  supportsRequestUserInput?: boolean
  supportsPlanMode?: boolean
  supportsPersistentSession?: boolean
  supportsCodexAppServer?: boolean
  supportsStructuredIo?: boolean
}

export interface RemoteAgentRuntimeSummaryView {
  runtimeKind: RemoteAgentRuntimeKind
  state: RemoteAgentRuntimeState["state"]
  statusText?: string
  sessionId?: string
  activeConversationId?: UUID
  activeTaskId?: UUID
  pendingConversationCount: number
  unreadDeliveryCount: number
  lastActivityAt?: Timestamp
  lastRunStartedAt?: Timestamp
  lastRunFinishedAt?: Timestamp
  lastError?: string
  capabilities?: RemoteAgentRuntimeCapabilityView
}

export interface RemoteAgentGroupTaskGrantView {
  workspaceMemberId: UUID
  createdByWorkspaceMemberId?: UUID
  createdAt?: Timestamp
  updatedAt?: Timestamp
  userId: UUID
  name: string
  avatarUrl?: string
}

export interface RemoteAgentBindingView {
  machineId: UUID
  machineTitle?: string
  status: RemoteAgentBindingStatus
  runtimePath?: string
  localRootPath?: string
  machineLifecycleState?: RemoteAgentLifecycleState
  runtimeSummary?: RemoteAgentRuntimeSummaryView
}

export interface RemoteAgentView {
  id: UUID
  workspaceId: UUID
  displayName: string
  title: string
  description?: string
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId?: UUID
  avatarEmoji?: string
  requiresContactApproval: boolean
  isActive: boolean
  isPublicShared: boolean
  metadata: Record<string, unknown>
  ownerWorkspaceMemberId?: UUID
  createdAt?: Timestamp
  updatedAt?: Timestamp
  runtimeSummary?: RemoteAgentRuntimeSummaryView
  binding?: RemoteAgentBindingView
}

export interface RemoteAgentRuntimeCatalogEntryView {
  runtimeKind: RemoteAgentRuntimeKind
  executablePath?: string
  status: RemoteAgentRuntimeCatalogStatus
  version?: string
  metadata: Record<string, unknown>
  lastError?: string
  lastSeenAt?: Timestamp
}

export interface RemoteAgentMachineView {
  id: UUID
  workspaceId: UUID
  title: string
  description?: string
  trustStatus: RemoteAgentMachineTrustStatus
  lifecycleState?: RemoteAgentLifecycleState
  bindingCount?: number
  lastSeenAt?: Timestamp
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export interface RemoteAgentMachineDetailView {
  machine: Omit<RemoteAgentMachineView, "bindingCount"> & {
    bindingCount?: number
  }
  runtimeCatalog: RemoteAgentRuntimeCatalogEntryView[]
  bindings: Array<{
    remoteAgentId: UUID
    displayName: string
    runtimeKind: RemoteAgentRuntimeKind
    runtimePath?: string
    localRootPath?: string
    status: RemoteAgentBindingStatus
    runtimeSummary?: RemoteAgentRuntimeSummaryView
  }>
}

export interface OneClickInstallCommands {
  unix: string
  windows: string
}

export interface RemoteAgentMachinePairingSessionView {
  machine: RemoteAgentMachineView
  apiKey: string
  daemonCommand: string
  /**
   * One-click bootstrap installer commands (download-to-file + verify + run)
   * for hosts with no Node yet. null when PUBLIC_NPM_REGISTRY_URL is unset
   * (one-click bootstrap requires the private registry). Kept alongside the
   * legacy `daemonCommand` for back-compat.
   */
  oneClickCommands: OneClickInstallCommands | null
}

export interface SessionMessage {
  id: UUID
  sessionId: UUID
  workspaceId: UUID
  role: SessionMessageRole
  contentBlocks: CanonicalContentBlock[]
  fromActorId?: UUID
  fromWorkspaceMemberId?: UUID
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface SessionInterrupt {
  id: UUID
  targetSessionId: UUID
  type: SessionInterruptType
  // Plain-text snapshot of the interrupt content (legacy / FE display).
  content: string
  // Optional canonical content blocks; preferred over `content` when present
  // for context-builder consumption. New code should populate this.
  contentBlocks?: CanonicalContentBlock[]
  fromSessionId?: UUID
  isConsumed: boolean
  createdAt: Timestamp
}

export interface ActorAction {
  type: "respond" | "create_memory" | "rename_self" | "change_avatar"
  /**
   * Derived plaintext snapshot of the action body — computed from
   * `contentBlocks` via `extractText(...)`. Treat as read-only; new
   * code should write to `contentBlocks` and let the API recompute
   * `content` at the boundary. Persisted on the wire for legacy
   * consumers (e.g. analytics that don't understand blocks) but
   * MUST NOT be the source of truth.
   */
  content: string
  contentBlocks?: CanonicalContentBlock[]
  targetActorId?: UUID
  metadata?: Record<string, unknown>
}

export interface ThinkingResult {
  actions: ActorAction[]
  reasoning: string
  tokensUsed: { input: number; output: number }
  toolsUsed?: string[] // names of executable tools invoked during thinking
  serverToolCalls?: ServerToolCall[] // cloud-side tool calls (web_search, web_fetch)
  citationSources?: Record<string, { url: string; title: string }> // <cite index="X-Y"> → source
  toolHistory?: AssistantToolHistory // cross-turn tool history for replay
  contentBlocks?: CanonicalContentBlock[]
}

// ============ Server Tool Calls (Anthropic/OpenAI cloud-side tools) ============

export interface ServerToolCall {
  type: ModelServerTool
  // The provider-native tool name as reported by the SDK. `type` is the coarse
  // bucket the FE historically branched on; `toolName` is authoritative and lets
  // an unknown provider tool render its real name instead of being mislabeled
  // web_search. (Provider-executed tools never create tool_calls rows.)
  toolName?: string
  query?: string // web_search query
  url?: string // web_fetch URL
  results?: ServerToolSearchResult[]
  // Unified, FE-agnostic display model computed server-side so the client just
  // renders structure (icon + title + optional detail + clickable result links),
  // mirroring the activity-bubble presentation contract. No per-type if/else in
  // the FE. `displayTitle` is the Chinese fallback; titleKey/params reserved for
  // a future FE i18n layer (parallels PresentationString).
  display?: {
    icon: string
    displayTitle: string
    displayDetail?: string
    titleKey?: string
    resultLinks?: ServerToolSearchResult[]
  }
}

export interface ServerToolSearchResult {
  url: string
  title: string
  pageAge?: string
}

// ============ Model Groups ============
export type ModelGroupRoutingStrategy =
  (typeof MODEL_GROUP_ROUTING_STRATEGIES)[number]
export type ModelGroupOwnerType = (typeof MODEL_GROUP_OWNER_TYPES)[number]
export type ModelGroupGrantScope = (typeof MODEL_GROUP_GRANT_SCOPES)[number]
export type ModelGroupGrantStatus = (typeof MODEL_GROUP_GRANT_STATUSES)[number]
export type RoutingStrategy = ModelGroupRoutingStrategy
export type ProviderType = string
export type AIRequestType = "actor_think" | "ai_complete"
export type AIRequestStatus = "success" | "error" | "timeout"

export interface ModelGroup {
  id: UUID
  ownerType?: ModelGroupOwnerType
  ownerWorkspaceId?: UUID | null
  ownerWorkspaceMemberId?: UUID | null
  workspaceId?: UUID
  name: string
  description: string
  routingStrategy: ModelGroupRoutingStrategy
  isDefault: boolean
  isActive: boolean
  createdByWorkspaceMemberId?: UUID
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ModelGroupItem {
  id: UUID
  groupId: UUID
  currentConfigId?: UUID
  displayName: string
  priority: number
  weight: number
  isEnabled: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
  currentConfig?: ModelItemConfig
}

export interface ModelItemConfig {
  id: UUID
  itemId: UUID
  version: number
  providerType: ProviderType
  apiKey: string
  baseUrl: string
  modelName: string
  maxTokens: number
  inputTokenCostMicros: number
  outputTokenCostMicros: number
  capabilityTags: string[]
  extraConfig: Record<string, unknown>
  createdAt: Timestamp
}

export interface ActorModelGroup {
  actorId: UUID
  groupId: UUID
  priority: number
  createdAt: Timestamp
}

export interface ModelGroupGrant {
  id: UUID
  groupId: UUID
  grantScope: ModelGroupGrantScope
  workspaceId?: UUID | null
  workspaceMemberId?: UUID | null
  actorId?: UUID | null
  status: ModelGroupGrantStatus
  createdByWorkspaceMemberId?: UUID | null
  reason?: string | null
  createdAt?: Timestamp | null
  revokedAt?: Timestamp | null
}

export interface AIRequestLog {
  id: UUID
  workspaceId?: UUID
  actorId?: UUID
  groupId?: UUID
  itemId?: UUID
  configId?: UUID
  requestType: AIRequestType
  inputTokens: number
  outputTokens: number
  costMicros: number
  latencyMs: number
  status: AIRequestStatus
  errorMessage?: string
  createdAt: Timestamp
}

export type ModelApiStyle = (typeof MODEL_API_STYLES)[number]
export type ModelServerTool = (typeof MODEL_SERVER_TOOLS)[number]
export type AnthropicBuiltinTool = ModelServerTool

export type MultimodalType = (typeof CANONICAL_FILE_CATEGORIES)[number]

export interface MultimodalConfig {
  supported: boolean
  types: MultimodalType[]
}

export interface ResolvedModelConfig {
  groupId: UUID
  bindingId: UUID
  bindingVersionId: UUID
  providerKind: ProviderKind
  vendor: string
  apiStyle?: ModelApiStyle
  apiKey: string
  baseUrl: string
  modelName: string
  maxOutputTokens: number
  serverTools?: AnthropicBuiltinTool[]
  multimodal?: MultimodalConfig
  crossTurnToolHistory?: boolean
  providerOptions?: Record<string, unknown>
  priority?: number
  weight?: number
  requestTimeoutMs?: number
  maxRetries?: number
}

export interface ModelAttemptPolicy {
  maxAttemptsTotal: number
  maxAttemptsPerBinding: number
  timeoutMsPerAttempt: number
  continueOn: string[]
  stopOn: string[]
  retryBackoffMs: number[]
}

export interface ResolvedModelPlan {
  groupId: UUID
  groupName: string
  routingStrategy: ModelGroupRoutingStrategy
  attemptPolicy: ModelAttemptPolicy
  candidates: ResolvedModelConfig[]
}

// ============ Canonical Content Block ============
// Unified representation: text stored directly, media via file_ref pointing to platform file storage
export type CanonicalFileCategory = (typeof CANONICAL_FILE_CATEGORIES)[number]

export interface CanonicalTextBlock {
  id: UUID
  type: "text"
  text: string
}

export interface CanonicalFileRefBlock {
  id: UUID
  type: "file_ref"
  // Content identity — ALWAYS present. Pinned at message-persist time so the
  // block renders forever (even after the file is overwritten/deleted) and
  // the model/frontend fetch bytes by sha256 (GET /content/:sha256).
  sha256: string
  // The LLM-visible "live handle" (/conversation/..., /actor/...). Present
  // when the ref came from a mounted sandbox space; absent for pure history
  // / memory references that only need to render.
  path?: string
  mimeType: string
  sizeBytes: number
  category: CanonicalFileCategory
  // Display name (for a tree file = basename(path)).
  name: string
}

export interface CanonicalMentionBlock {
  id: UUID
  type: "mention"
  mention: ConversationEntityRef
}

export type CanonicalContentBlock =
  | CanonicalTextBlock
  | CanonicalFileRefBlock
  | CanonicalMentionBlock

export type CanonicalTextBlockInput = Omit<CanonicalTextBlock, "id"> & {
  id?: UUID
}
export type CanonicalFileRefBlockInput = Omit<CanonicalFileRefBlock, "id"> & {
  id?: UUID
}
export type CanonicalMentionBlockInput = Omit<CanonicalMentionBlock, "id"> & {
  id?: UUID
}
export type CanonicalContentBlockInput =
  | CanonicalTextBlockInput
  | CanonicalFileRefBlockInput
  | CanonicalMentionBlockInput

// ============ Files ============

export type FileContentKind = CanonicalFileCategory
// An opaque, deployment-config-driven backend id (plan §7#4 option b). The wire
// carries it as a plain string; `FILE_STORAGE_BACKENDS` lists the built-in
// default(s) but the valid set is the configured registry, checked at the app
// write boundary — so the type is open rather than a frozen union.
export type FileStorageBackend = string
export type FileOriginFamily = (typeof FILE_ORIGIN_FAMILIES)[number]
export type FileOriginSystem =
  (typeof FILE_ORIGIN_SYSTEMS)[keyof typeof FILE_ORIGIN_SYSTEMS]
export type UserUploadFileOriginSystem =
  (typeof USER_UPLOAD_FILE_ORIGIN_SYSTEMS)[number]
export type ActorOutputFileOriginSystem =
  (typeof ACTOR_OUTPUT_FILE_ORIGIN_SYSTEMS)[number]
export type ToolOutputFileOriginSystem =
  (typeof TOOL_OUTPUT_FILE_ORIGIN_SYSTEMS)[number]
export type ModelOutputFileOriginSystem =
  (typeof MODEL_OUTPUT_FILE_ORIGIN_SYSTEMS)[number]
export type ExternalImportFileOriginSystem =
  (typeof EXTERNAL_IMPORT_FILE_ORIGIN_SYSTEMS)[number]
export type PackageImportFileOriginSystem =
  (typeof PACKAGE_IMPORT_FILE_ORIGIN_SYSTEMS)[number]
export type SystemGeneratedFileOriginSystem =
  (typeof SYSTEM_GENERATED_FILE_ORIGIN_SYSTEMS)[number]
export type FileParseRunStatus = (typeof FILE_PARSE_RUN_STATUSES)[number]
export type FileParseOutputKind = (typeof FILE_PARSE_OUTPUT_KINDS)[number]

export interface DeviceMcpFileSourceMetadata {
  kind: "device_mcp"
  deviceId: UUID
  deviceDisplayName?: string
  exposureId: UUID
  exposureStableKey: string
  exposureDisplayName?: string
  runtimeSessionId: UUID
  visibleToolName: string
  namespacedToolName: string
}

export interface FileOriginSummary {
  family: FileOriginFamily
  system: FileOriginSystem
  initiatorUserId?: UUID | null
  initiatorActorId?: UUID | null
  providerKey?: string
  parentFileId?: UUID | null
  externalResourceKey?: string
  details?: DeviceMcpFileSourceMetadata | Record<string, unknown>
}

export interface FileCreateOriginInput {
  family: FileOriginFamily
  system: FileOriginSystem
  details?: Record<string, unknown>
}

export interface FileRecordView {
  id: UUID
  workspaceId?: UUID | null
  uploaderUserId?: UUID | null
  originalName: string
  url: string
  fullUrl: string
  mimeType: string
  contentKind: FileContentKind
  sizeBytes: number
  sha256: string
  storageBackend: FileStorageBackend
  originSummary: FileOriginSummary
  createdAt: Timestamp
}

export interface FileParseOutputView {
  id: UUID
  outputKind: FileParseOutputKind
  role: string
  isPrimary: boolean
  textContent?: string
  structuredJson?: Record<string, unknown>
  derivedFileId?: UUID | null
  derivedFile?: FileRecordView
  createdAt: Timestamp
}

export interface FileParseRunView {
  id: UUID
  fileId: UUID
  pipeline: string
  parserKey: string
  parserVersion?: string | null
  trigger: string
  status: FileParseRunStatus
  errorCode?: string | null
  errorMessage?: string | null
  createdAt: Timestamp
  startedAt?: Timestamp | null
  finishedAt?: Timestamp | null
  outputs: FileParseOutputView[]
}

export interface ActorDocTemplate {
  key: CoreActorDocKey
  title: string
  description: string
  defaultVisibility: ActorDocVisibility
  defaultPriority: number
}

export {
  ACTOR_DOC_TEMPLATES,
  ACTOR_DOC_TEMPLATE_MAP,
} from "../actor/templates.js"

// ============ Canonical Tool History ============
export interface CanonicalToolCall {
  callId: string
  providerCallId?: string
  toolName: string
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
}

// Provenance of a CanonicalToolResult — what produced it and where it came from.
// Set at the ingest boundary (mcp-plugins/result-normalizer, local callable
// executor, model response media ingest). Downstream consumers
// (FE display, audit logs, debugging tools) read this to attribute results.
export type ToolResultOrigin =
  | { kind: "system"; registryKey: string }
  | {
      kind: "plugin"
      installationId: string
      upstreamToolName: string
      publisherSlug?: string
      itemSlug?: string
    }
  | {
      kind: "runtime"
      runtimeToolId: string
      exposureStableKey: string
      runtimeName?: string
      visibleToolName?: string
    }
  | { kind: "provider_native"; providerType: ProviderType; toolName: string }
  | {
      kind: "model_response"
      providerType: ProviderType
    }

export { TOOL_RESULT_ORIGIN_KINDS } from "../constants/enums.js"
export type ToolResultOriginKind =
  (typeof import("../constants/enums.js").TOOL_RESULT_ORIGIN_KINDS)[number]

export interface CanonicalToolResult {
  toolCallId: string
  providerCallId?: string
  toolName: string
  content: CanonicalContentBlock[]
  // MCP protocol structured output (JSON sidecar to content blocks). Surface
  // as first-class so FE/audit and the LLM context compiler can use it without
  // grovelling through metadata.
  structuredContent?: Record<string, unknown>
  isError?: boolean
  // Where this result came from. Filled at the ingest boundary.
  origin: ToolResultOrigin
  metadata?: Record<string, unknown>
}

export interface ToolRound {
  content?: CanonicalContentBlock[]
  toolCalls: CanonicalToolCall[]
  toolResults: CanonicalToolResult[]
}

export interface AssistantToolHistory {
  rounds: ToolRound[]
}

export type CanonicalContextScope = "shared" | "private"
export type CanonicalContextSurface = "visible" | "internal"
export type CanonicalContextRole = "user" | "assistant" | "system" | "tool"
export type CanonicalContextParticipantType =
  | "actor"
  | "workspace_member"
  | "external"
  | "system"
  | "unknown"
export type ConversationEventTimelinePolicy =
  (typeof CONVERSATION_EVENT_TIMELINE_POLICIES)[number]
export type ConversationEventContextPolicy =
  (typeof CONVERSATION_EVENT_CONTEXT_POLICIES)[number]

export interface CanonicalContextAuthor {
  participantId?: string
  participantType: CanonicalContextParticipantType
  actorId?: string
  userId?: string
  sessionId?: string
  name?: string
  isSelf?: boolean
}

export interface CanonicalContextTarget {
  participantId?: string
  participantType: Exclude<CanonicalContextParticipantType, "unknown">
  actorId?: string
  userId?: string
  name?: string
}

interface CanonicalContextItemBase {
  itemId?: string
  itemRef?: string
  replyable?: boolean
  conversationId?: string
  sessionId?: string
  turnId?: string
  sequence?: number
  createdAt?: Timestamp
  scope: CanonicalContextScope
  surface: CanonicalContextSurface
  metadata?: Record<string, unknown>
}

export interface CanonicalSystemNoticeItem extends CanonicalContextItemBase {
  kind: "system_notice"
  noticeType: "interrupt" | "task_instruction" | "wakeup" | "generic"
  parts: CanonicalContentBlock[]
}

export interface CanonicalEventContextItem extends CanonicalContextItemBase {
  kind: "event"
  eventType: string
  eventPayload?: Record<string, unknown>
  timelinePolicy?: ConversationEventTimelinePolicy
  contextPolicy?: ConversationEventContextPolicy
  author?: CanonicalContextAuthor
  targets?: CanonicalContextTarget[]
  parts: CanonicalContentBlock[]
}

export interface CanonicalMessageContextItem extends CanonicalContextItemBase {
  kind: "message"
  messageType: string
  role: CanonicalContextRole
  author?: CanonicalContextAuthor
  targets?: CanonicalContextTarget[]
  replyTo?: ConversationReplyRef
  parts: CanonicalContentBlock[]
}

export type ConversationMessageSubtype =
  (typeof CONVERSATION_MESSAGE_SUBTYPES)[number]

export type ChatParticipantRemovalState =
  (typeof CHAT_PARTICIPANT_REMOVAL_STATES)[number]

export type ConversationFeedMessageType =
  (typeof CONVERSATION_FEED_MESSAGE_TYPES)[number]

export type ConversationFeedItemSubtype =
  (typeof CONVERSATION_FEED_ITEM_SUBTYPES)[number]

export type ConversationReplyRefSubtype =
  (typeof CONVERSATION_REPLY_REF_SUBTYPES)[number]

export interface CanonicalToolCallBatchContextItem extends CanonicalContextItemBase {
  kind: "tool_call_batch"
  role: "assistant"
  bundleId?: string
  author?: CanonicalContextAuthor
  content?: CanonicalContentBlock[]
  toolCalls: CanonicalToolCall[]
}

export interface CanonicalToolResultBatchContextItem extends CanonicalContextItemBase {
  kind: "tool_result_batch"
  bundleId?: string
  toolResults: CanonicalToolResult[]
}

export interface CanonicalSummaryContextItem extends CanonicalContextItemBase {
  kind: "summary"
  summaryType: string
  sourceItemIds?: string[]
  parts: CanonicalContentBlock[]
}

export interface CanonicalMemoryRecallContextItem extends CanonicalContextItemBase {
  kind: "memory_recall"
  recallType: Exclude<MemoryRecallType, "manual_search">
  memories: MemoryRecallResult[]
  metadata?: Record<string, unknown>
}

export type CanonicalContextItem =
  | CanonicalSystemNoticeItem
  | CanonicalEventContextItem
  | CanonicalMessageContextItem
  | CanonicalToolCallBatchContextItem
  | CanonicalToolResultBatchContextItem
  | CanonicalSummaryContextItem
  | CanonicalMemoryRecallContextItem

export type CanonicalArchiveFrameRole = "system" | "user" | "assistant" | "tool"
export type CanonicalArchiveChainScope = "shared" | "private"

export interface CanonicalArchiveFrame {
  frameId?: string
  role: CanonicalArchiveFrameRole
  frameType: string
  parts?: CanonicalContentBlock[]
  toolCalls?: CanonicalToolCall[]
  toolResults?: CanonicalToolResult[]
  sourceItemIds?: string[]
  metadata?: Record<string, unknown>
}

export interface CanonicalArchivePoint {
  archivePointId: string
  chainScope: CanonicalArchiveChainScope
  conversationId: string
  sessionId?: string
  parentArchivePointId?: string
  coversUntilSequence: number
  frames: CanonicalArchiveFrame[]
  metadata?: Record<string, unknown>
  createdAt?: Timestamp
}

export interface ProviderContextWindow {
  manifest?: ProviderContextManifest
  sharedArchivePoint: CanonicalArchivePoint | null
  sharedTailItems: CanonicalContextItem[]
  privateArchivePoint: CanonicalArchivePoint | null
  privateTailItems: CanonicalContextItem[]
  orderedTailItems: CanonicalContextItem[]
}

// ============ Conversation Message ============
export type ConversationMessage =
  | { role: "user"; content: CanonicalContentBlock[] }
  | {
      role: "assistant"
      content: CanonicalContentBlock[]
      toolCalls?: CanonicalToolCall[]
    }
  | { role: "tool_result"; results: CanonicalToolResult[] }

// ============ AI Provider ============
export interface ToolParameterProperty {
  type: string
  description: string
  enum?: string[]
  items?: { type: string; enum?: string[] }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, ToolParameterProperty>
    required: string[]
  }
  // Full, lossless JSON Schema for the tool input, when available. The lossy
  // `parameters` shape above drops nested object properties, oneOf/anyOf,
  // format, min/max, defaults, $ref, deep array items, etc. Remote MCP tools
  // (and stdio MCP servers) carry rich schemas, so the mapper stores the
  // server's raw `inputSchema` here verbatim. Consumers that forward tools to
  // a model (LLM providers, the reverse-MCP endpoint) MUST prefer
  // `rawInputSchema` when present and fall back to `parameters` otherwise.
  rawInputSchema?: Record<string, unknown>
  // NOTE: tool provenance/source no longer lives on ToolDefinition. The
  // structured ToolRef (`@synapse/shared/tool-source`) carries source + binding
  // on the internal `ProjectedToolDefinition`; a plain ToolDefinition that
  // crosses to the provider/model is intentionally source-free (stripped at the
  // boundary). See docs/design-archive/tool-provenance-and-routing.md.
}

export interface ToolCall {
  callId: string
  providerCallId?: string
  toolName: string
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface AIMessage {
  role: "user" | "assistant"
  content: string
}

export interface ToolResult {
  toolCallId: string
  providerCallId?: string
  toolName: string
  content: CanonicalContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  metadata?: Record<string, unknown>
}

export interface NormalizedMcpToolResult {
  content: CanonicalContentBlock[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
  // Provenance of the result (system / plugin / device / provider / model).
  // Filled by the
  // ingest pipeline so downstream code can attribute the result without
  // tracking it out-of-band.
  origin: ToolResultOrigin
  metadata?: Record<string, unknown>
  rawResult?: unknown
}

// ============ Tool Plugin System ============

export interface ConversationParticipantEntry {
  participantType: "actor" | "workspace_member" | "external"
  id: string
  name: string
  title?: string
  role?: string
  participantId?: string
  linkedWorkspaceMemberId?: string
  linkedWorkspaceMemberName?: string
  externalUserKey?: string
}

export interface ProviderContextManifest {
  conversationId?: UUID
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  selfParticipantId?: UUID
  selfActorId?: UUID
  participants: ConversationParticipantEntry[]
}

export interface ToolResolveContext {
  sessionId: string
  actorId: string
  workspaceId: string
  collaborationMode: SessionCollaborationMode
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  conversationParticipants?: ConversationParticipantEntry[]
  workspaceMemberId?: string
  availableSkills?: AvailableSkillSummary[]
}

export interface RuntimeActorContext {
  workspaceId: string
  actorId: string
  sessionId: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  userId?: string
  // Carries the workspace_member acting on behalf of `userId` in this workspace.
  // Needed so that member-scoped workspace_resource_grants become visible to the
  // tool resolver and capability discovery paths.
  workspaceMemberId?: string
}

export interface CapabilityInvocationContext {
  workspaceId: string
  ownerWorkspaceId?: string
  actorId?: string
  userId?: string
  workspaceMemberId?: string
  sessionId?: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  turnId?: string
  toolCallId?: string
  providerCallId?: string
  namespacedToolName?: string
  toolName?: string
}

export interface ToolSurfaceItem {
  id: string
  name: string
  // Canonical routed-source vocabulary. Was previously a parallel display
  // vocabulary (builtin/plugin_installation/runtime_capability); collapsed onto
  // the one ToolSourceKind axis.
  source: ToolSourceKind
}

export interface SkillSurfaceItem {
  id: string
  name: string
  source: "installed"
}

export interface CapabilitySurface {
  tools: ToolSurfaceItem[]
  skills: SkillSurfaceItem[]
  version: number
}

export interface ToolPlugin {
  name: string
  definition: ToolDefinition
  // Optional presentation descriptor co-located with the system tool. The API
  // display resolver reads it (keyed by the tool's registry name = its system
  // stableKey) to render a friendly title/result. Type from the base package.
  presentation?: import("../tool-presentation/index.js").ToolPresentationDescriptor
  conversationTypeMask?: ConversationTypeMask
  resolve?: (ctx: ToolResolveContext) =>
    | {
        active: boolean
        definition: ToolDefinition
      }
    | Promise<{
        active: boolean
        definition: ToolDefinition
      }>
  // Callable tools return content as CanonicalContentBlock[]. Authors can
  // either return just the blocks (most common) or the richer result object
  // when they need structuredContent / isError / metadata. The executor
  // (executeCallableTools) handles the union and lifts everything into the
  // canonical ToolResult shape so downstream code never sees plain strings.
  execute: (
    input: Record<string, unknown>
  ) => Promise<CallableToolResult | CanonicalContentBlock[]>
}

// Return shape for ToolPlugin.execute when the plugin needs to attach
// structuredContent, isError, or metadata alongside its blocks. For the
// simple text-only case, prefer `textResult("hello")` which produces this
// shape; or just return `textBlocks("hello")` if no extra fields are needed.
export interface CallableToolResult {
  content: CanonicalContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  metadata?: Record<string, unknown>
}

export interface AIResponse {
  context: ConversationMessage[] // [{ role: 'assistant', content, toolCalls? }]
  tokensUsed: { input: number; output: number }
  stopReason: string // e.g. 'end_turn', 'tool_use' (Anthropic) or 'stop', 'tool_calls' (OpenAI)
  rawAssistantMessage?: unknown // Provider-specific raw assistant message for server tool extraction
  mediaBlocks?: unknown[] // Provider raw media content blocks (images, audio from model response)
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
}

// ============================================================
// MCP Plugin Marketplace Types
// ============================================================

export type MarketplaceItemKind = (typeof MARKETPLACE_ITEM_KINDS)[number]
// Plugin transport tiers — single source of truth in constants/enums.ts.
// McpServerTransport: what the runtime instance-manager can start.
// PluginSpecTransport: the DB catalog spec column.
// PluginTransport: full application union (adds "filesystem").
// DeviceExposureTransport: the device-exposure transport set (has "custom").
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number]
export type PluginSpecTransport = (typeof PLUGIN_SPEC_TRANSPORTS)[number]
export type PluginTransport = (typeof PLUGIN_TRANSPORTS)[number]
export type DeviceExposureTransport =
  (typeof DEVICE_EXPOSURE_TRANSPORTS)[number]
export type ConversationTypeKey = (typeof CONVERSATION_TYPE_KEYS)[number]
export type ConversationTypeMask = number
export type CapabilityConversationTypePolicyResourceFamily =
  (typeof CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES)[number]
export type AccessTargetType = (typeof ACCESS_TARGET_TYPES)[number]
export type CapabilityAccessTargetType =
  (typeof CAPABILITY_ACCESS_TARGET_TYPES)[number]
export type ConversationMessageTransportDirection =
  (typeof CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS)[number]
export type DeviceCapabilityAccessSubjectKind =
  (typeof RUNTIME_CAPABILITY_ACCESS_SUBJECT_KINDS)[number]
export type DeviceCapabilityAccessScopeKind =
  (typeof RUNTIME_CAPABILITY_ACCESS_SCOPE_KINDS)[number]
export type ReuseScope = (typeof REUSE_SCOPES)[number]
export type PlatformAccessSource = (typeof PLATFORM_ACCESS_SOURCES)[number]
export type MarketplaceSourceType = (typeof MARKETPLACE_SOURCE_TYPES)[number]
export type MarketplaceLineageKind = (typeof MARKETPLACE_LINEAGE_KINDS)[number]
export type MarketplaceSyncMode = (typeof MARKETPLACE_SYNC_MODES)[number]
export type MarketplaceRequirementKind =
  (typeof MARKETPLACE_REQUIREMENT_KINDS)[number]
export type MarketplaceRequirementTargetKind =
  (typeof MARKETPLACE_REQUIREMENT_TARGET_KINDS)[number]
export type PluginInstallationMode = (typeof PLUGIN_INSTALLATION_MODES)[number]
export type MarketplaceVersionStatus =
  (typeof MARKETPLACE_VERSION_STATUSES)[number]
export type MarketplaceRequirementStatus =
  (typeof MARKETPLACE_REQUIREMENT_STATUSES)[number]
export type MarketplaceAssetKind = (typeof MARKETPLACE_ASSET_KINDS)[number]
export type LocalizedText = Record<string, string>
export type PluginConfigFieldType = (typeof PLUGIN_CONFIG_FIELD_TYPES)[number]
export type PluginInstallStepKind = (typeof PLUGIN_INSTALL_STEP_KINDS)[number]
export type PluginInstallStepScope = (typeof PLUGIN_INSTALL_STEP_SCOPES)[number]
export type PluginInstallActionKind =
  (typeof PLUGIN_INSTALL_ACTION_KINDS)[number]
export type PluginAuthBindingDriverKind =
  (typeof PLUGIN_AUTH_BINDING_DRIVER_KINDS)[number]
export type PluginAuthValueSourceKind =
  (typeof PLUGIN_AUTH_VALUE_SOURCE_KINDS)[number]
export type PluginAuthDerivedValueName =
  (typeof PLUGIN_AUTH_DERIVED_VALUE_NAMES)[number]
export type PluginAuthSessionStatus =
  (typeof PLUGIN_AUTH_SESSION_STATUSES)[number]
export type PluginAuthConnectionStatus =
  (typeof PLUGIN_AUTH_CONNECTION_STATUSES)[number]
export type PluginAuthSessionPhase = (typeof PLUGIN_AUTH_SESSION_PHASES)[number]
export type PluginAuthChallengeKind =
  (typeof PLUGIN_AUTH_CHALLENGE_KINDS)[number]
export type PluginAuthChallengeOpenMode =
  (typeof PLUGIN_AUTH_CHALLENGE_OPEN_MODES)[number]
export type McpValidationRuleKind = (typeof MCP_VALIDATION_RULE_KINDS)[number]
export type PluginInstallationStatus =
  (typeof PLUGIN_INSTALLATION_STATUSES)[number]

// AccessTarget / CapabilityAccessTarget are canonical scoped-subject payloads:
// {subject: SubjectRef; scope?: SubjectRef}. Conversation scoping is represented
// by `scope`, not by flat target strings.
export type AccessTarget = ScopedSubjectTarget
export type CapabilityAccessTarget = ScopedSubjectTarget

// Plugin config-field / install-step / auth-binding / config-state shapes are
// defined as zod schemas in ../schemas/mcp-plugins.ts (the single source) and
// re-exported here as inferred types so this pure-type surface stays zod-free.
// Imported (not just re-exported) so other interfaces in this file can use them.
// (See the existing view re-exports near the end of this file.)
import type {
  PluginAuthValueSource,
  PluginConfigFieldOption,
  PluginConfigFieldDefinition,
  PluginInstallAction,
  PluginInstallStep,
  PluginInstallFlow,
  PluginAuthBindingDefinition,
  PluginConfigFieldState,
  McpValidationRule,
  McpSetupStep,
} from "../schemas/mcp-plugins.js"
export type {
  PluginAuthValueSource,
  PluginConfigFieldOption,
  PluginConfigFieldDefinition,
  PluginInstallAction,
  PluginInstallStep,
  PluginInstallFlow,
  PluginAuthBindingDefinition,
  PluginConfigFieldState,
  McpValidationRule,
  McpSetupStep,
}

export interface PluginAuthChallenge {
  kind: PluginAuthChallengeKind
  url?: string
  qrUrl?: string
  openMode?: PluginAuthChallengeOpenMode
  expiresAt?: Timestamp
  metadata?: Record<string, unknown>
}

export interface AccessPolicy {
  requiredPermissions: string[]
  defaultAccessTargetType?: CapabilityAccessTargetType
  reason?: string
}

export interface MarketplacePublisher {
  id: string
  slug: string
  displayName: string
  description: string
  logoUrl?: string
  isBuiltin: boolean
  isVerified: boolean
  ownerUserId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MarketplaceLineage {
  downstreamPackageId: string
  upstreamPackageId: string
  upstreamRevisionId?: string
  lineageKind: MarketplaceLineageKind
  syncMode: MarketplaceSyncMode
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MarketplaceCategory {
  id: string
  slug: string
  targetKind: MarketplaceItemKind
  displayName: string
  displayNameI18n?: LocalizedText
  description?: string
  descriptionI18n?: LocalizedText
  iconUrl?: string
  defaultLocale?: string
  sortOrder: number
  isBuiltin: boolean
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MarketplaceTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MarketplaceAsset {
  id: string
  revisionId: string
  path: string
  assetKind: MarketplaceAssetKind
  mediaType?: string
  sizeBytes: number
  sha256: string
  textContent?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface MarketplaceVersion {
  id: string
  packageId: string
  version: string
  status: MarketplaceVersionStatus
  manifest: Record<string, unknown>
  access?: AccessPolicy
  authorization?: AccessPolicy
  configSchema: Record<string, unknown>
  configFields: PluginConfigFieldDefinition[]
  defaultConfig: Record<string, unknown>
  transport?: PluginSpecTransport
  entryPoint?: string
  toolsManifest: MarketplaceTool[]
  validationRules: McpValidationRule[]
  setupSteps: PluginInstallStep[]
  installFlow?: PluginInstallFlow
  authBindings: PluginAuthBindingDefinition[]
  metadata: Record<string, unknown>
  createdByUserId?: string
  createdAt: Timestamp
  assets?: MarketplaceAsset[]
}

export interface MarketplaceItem {
  id: string
  publisherId: string
  workspaceId?: string
  kind: MarketplaceItemKind
  slug: string
  displayName: string
  displayNameI18n?: LocalizedText
  description: string
  descriptionI18n?: LocalizedText
  longDescription: string
  longDescriptionI18n?: LocalizedText
  summaryI18n?: LocalizedText
  defaultLocale?: string
  iconUrl?: string
  sourceType: MarketplaceSourceType
  tags: string[]
  isActive: boolean
  isBuiltin: boolean
  downloadCount: number
  latestRevisionId?: string
  defaultReuseScope?: ReuseScope
  defaultConversationTypeMask?: ConversationTypeMask
  supportedReuseScopes?: ReuseScope[]
  defaultIdleTtlMs?: number
  defaultMaxAgeMs?: number
  requiresHandshake: boolean
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
  categories?: MarketplaceCategory[]
  sourceLink?: MarketplaceLineage
  publisher?: MarketplacePublisher
  latestRevision?: MarketplaceVersion
}

export interface PluginInstallationView {
  id: string
  workspaceId: string
  packageId: string
  revisionId: string
  installMode: PluginInstallationMode
  reuseScope: ReuseScope
  idleTtlMs?: number
  maxAgeMs?: number
  requiresHandshake: boolean
  isEnabled: boolean
  sourceDefaultConversationTypeMask?: ConversationTypeMask
  workspaceConversationTypeMask: ConversationTypeMask
  conversationTypeMaskOverride?: ConversationTypeMask
  effectiveConversationTypeMask: ConversationTypeMask
  configData: Record<string, unknown>
  configState: PluginConfigFieldState[]
  ownerWorkspaceMemberId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  package?: MarketplaceItem
  revision?: MarketplaceVersion
}

export interface WorkspaceResourceView {
  id: string
  workspaceId: string
  kind: WorkspaceResourceKind
  displayName: string
  ownerWorkspaceMemberId?: string
  status: WorkspaceResourceStatus
  sourceDefaultConversationTypeMask?: ConversationTypeMask
  workspaceConversationTypeMask?: ConversationTypeMask
  conversationTypeMaskOverride?: ConversationTypeMask
  effectiveConversationTypeMask?: ConversationTypeMask
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface WorkspaceResourceGrant {
  id: string
  workspaceId: string
  workspaceResourceId: string
  target: WorkspaceResourceGrantTargetContract
  permissions: WorkspaceResourceGrantPermission[]
  status: WorkspaceResourceGrantStatus
  source: WorkspaceResourceGrantSource
  createdByWorkspaceMemberId?: string
  reason?: string
  conversationTypeMaskOverride?: ConversationTypeMask | null
  effectiveConversationTypeMask?: ConversationTypeMask
  createdAt: Timestamp
  revokedAt?: Timestamp
}

export interface WorkspaceResourceGrantRequest {
  id: string
  workspaceId: string
  workspaceResourceId: string
  grantee: WorkspaceResourceGrantTargetContract
  requestedPermissions: WorkspaceResourceGrantPermission[]
  requesterWorkspaceMemberId: string
  status: WorkspaceResourceGrantRequestStatus
  resolvedByWorkspaceMemberId?: string
  resolvedAt?: Timestamp
  reason?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface WorkspaceCapabilityConversationTypePolicy {
  workspaceId: string
  resourceFamily: CapabilityConversationTypePolicyResourceFamily
  defaultConversationTypeMask: ConversationTypeMask
}

export interface WorkspaceCapabilityConversationTypePoliciesView {
  workspaceId: string
  policies: WorkspaceCapabilityConversationTypePolicy[]
}

export interface PluginAuthSession {
  id: string
  workspaceId: string
  packageId: string
  revisionId?: string
  bindingKey: string
  driver: PluginAuthBindingDriverKind
  workspaceMemberId: string
  status: PluginAuthSessionStatus
  phase?: PluginAuthSessionPhase
  state?: string
  challenge?: PluginAuthChallenge
  errorCode?: string
  errorMessage?: string
  resultPreview: Record<string, unknown>
  authConnectionId?: string
  metadata: Record<string, unknown>
  expiresAt: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface PluginAuthConnection {
  id: string
  workspaceId: string
  packageId: string
  bindingKey: string
  driver: PluginAuthBindingDriverKind
  externalAccountId?: string
  displayName?: string
  avatarUrl?: string
  status: PluginAuthConnectionStatus
  expiresAt?: Timestamp
  publicPayload: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MarketplaceRequirement {
  id: string
  revisionId: string
  requirementKind: MarketplaceRequirementKind
  targetKind: MarketplaceRequirementTargetKind
  targetPackageKind?: MarketplaceItemKind
  targetPublisherSlug?: string
  targetPackageSlug?: string
  targetTag?: string
  acceptableReuseScopes: ReuseScope[]
  description: string
  configPredicate: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface MarketplaceRequirementCheck {
  requirementId: string
  requirementKind: MarketplaceRequirementKind
  status: MarketplaceRequirementStatus
  message: string
  matchedInstanceIds: string[]
  missingPublisherSlug?: string
  missingPackageSlug?: string
  missingTag?: string
}

export interface PluginInstallPlan {
  packageId: string
  revisionId: string
  workspaceId: string
  checks: MarketplaceRequirementCheck[]
  grantPlan?: {
    requiresGrant: boolean
    requiredPermissions: string[]
    suggestedAccessTargetType?: CapabilityAccessTargetType
    reason?: string
  }
}

export type ActorPackageDependencyKind =
  (typeof ACTOR_PACKAGE_DEPENDENCY_KINDS)[number]
export type ActorPackageTargetKind = (typeof ACTOR_PACKAGE_TARGET_KINDS)[number]
export type ActorPackageSyncMode = (typeof ACTOR_PACKAGE_SYNC_MODES)[number]
export type ActorPackageLinkStatus =
  (typeof ACTOR_PACKAGE_LINK_STATUSES)[number]

export interface ActorPackageDependency {
  requirementId?: string
  requirementKind: ActorPackageDependencyKind
  targetPackageKind: ActorPackageTargetKind
  targetPublisherSlug?: string
  targetPackageSlug: string
  acceptableReuseScopes: ReuseScope[]
  description: string
  notes: CanonicalContentBlock[]
  metadata: Record<string, unknown>
}

export interface ActorPackageManifest {
  actor: ActorDefinition
  setupGuide: CanonicalContentBlock[]
  releaseNotes: CanonicalContentBlock[]
}

export interface ActorPackageSourceLink {
  actorId: UUID
  packageId: UUID
  importedRevisionId: UUID
  packageSlug: string
  packageDisplayName: string
  packagePublisherSlug?: string
  packagePublisherDisplayName?: string
  importedVersion?: string
  latestRevisionId?: UUID
  latestVersion?: string
  baselineActorVersion: number
  syncMode: ActorPackageSyncMode
  hasLocalChanges: boolean
  hasUpstreamUpdate: boolean
  status: ActorPackageLinkStatus
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ActorPackageRecord {
  package: MarketplaceItem
  manifest: ActorPackageManifest
  dependencies: ActorPackageDependency[]
  requirementChecks?: MarketplaceRequirementCheck[]
}

export interface ActorPackageInstallResult {
  actor: Actor
  sourcePackage: ActorPackageRecord
  sourceLink: ActorPackageSourceLink
  requirementChecks: MarketplaceRequirementCheck[]
}

export interface AvailableSkillSummary {
  instanceId: string
  packageId: string
  revisionId: string
  name: string
  description: string
  version: string
  accessTarget: CapabilityAccessTarget
  sourcePackageSlug?: string
  sourceKind?: "installed"
  entryPoint?: string
}

export type SkillAccessTargetType = CapabilityAccessTargetType

export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number]
export type SkillMirrorRefreshMode = "manual"
export type SkillMirrorSyncStatus = (typeof SKILL_MIRROR_SYNC_STATUSES)[number]
export type SkillFrontmatterEffort = (typeof SKILL_FRONTMATTER_EFFORTS)[number]
export type SkillFrontmatterContext = "fork"

export interface SkillFrontmatter {
  name: string
  description: string
  argumentHint?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  allowedTools: string[]
  model?: string
  effort?: SkillFrontmatterEffort
  context?: SkillFrontmatterContext
  agent?: string
  hooks?: Record<string, unknown>
}

export interface SkillMirrorSourceSummary {
  id: string
  sourceType: SkillSourceType
  locatorKey: string
  locator: Record<string, unknown>
  requestedRef?: string
  resolvedRevision?: string
  refreshMode: SkillMirrorRefreshMode
  lastSyncStatus: SkillMirrorSyncStatus
  sourceWarnings: string[]
  lastError?: string
  lastSyncedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SkillAttachmentFile {
  id: string
  path: string
  mediaType?: string
  contentBlocks: CanonicalContentBlock[]
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SkillMarketplaceVersion {
  id: string
  skillId: string
  version: string
  changelog: string
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  entryPath: string
  contentHash: string
  sourceWarnings: string[]
  resolvedRevision?: string
  description: CanonicalContentBlock
  defaultConversationTypeMask?: ConversationTypeMask
  createdByUserId?: string
  createdByName?: string
  createdAt: Timestamp
  files?: SkillAttachmentFile[]
  attachmentFiles?: SkillAttachmentFile[]
}

export interface SkillMarketplaceWorkspaceInstallation {
  installed: boolean
  installedSkillId?: string
  installedCount: number
}

export interface SkillMarketplaceEntry {
  id: string
  slug: string
  name: string
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  description: CanonicalContentBlock
  iconUrl?: string
  tags: string[]
  authorUserId?: string
  authorName?: string
  isActive: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
  defaultConversationTypeMask?: ConversationTypeMask
  latestVersionId?: string
  latestVersion?: SkillMarketplaceVersion
  mirrorSource?: SkillMirrorSourceSummary
  workspaceInstallation?: SkillMarketplaceWorkspaceInstallation
}

export interface InstalledSkill {
  id: string
  workspaceId: string
  displayName: string
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  entryPath: string
  contentHash: string
  sourceWarnings: string[]
  description: CanonicalContentBlock
  iconUrl?: string
  tags: string[]
  accessTarget: CapabilityAccessTarget
  isEnabled: boolean
  sourceDefaultConversationTypeMask?: ConversationTypeMask
  workspaceConversationTypeMask: ConversationTypeMask
  conversationTypeMaskOverride?: ConversationTypeMask
  effectiveConversationTypeMask: ConversationTypeMask
  isCustomized: boolean
  ownerWorkspaceMemberId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  sourceSkillId?: string
  sourcePackageSlug?: string
  sourceVersionId?: string
  sourceVersion?: string
  upgradeAvailable: boolean
  latestSourceVersion?: string
  files?: SkillAttachmentFile[]
  attachmentFiles?: SkillAttachmentFile[]
  mirrorSource?: SkillMirrorSourceSummary
}

// Catalog-spec transport set (= PluginTransport minus "filesystem").
export type McpTransport = PluginSpecTransport
export type McpLifecycleScope = ReuseScope

export type McpOrganization = MarketplacePublisher
export type McpPluginTool = MarketplaceTool

export interface McpPlugin extends MarketplaceItem {
  kind: "plugin"
}

export interface McpInstallation extends PluginInstallationView {
  pluginId: string
  lifecycleScope: McpLifecycleScope
  plugin?: McpPlugin
}

export interface McpDeviceServer {
  id: string
  deviceId: string
  name: string
  transport: DeviceExposureTransport
  command?: string
  endpoint?: string
  envVars: Record<string, unknown>
  toolsManifest: McpPluginTool[]
  isEnabled: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface McpToolCallLog {
  id: string
  workspaceId: string
  sessionId?: string
  actorId?: string
  userId?: string
  pluginId: string
  deviceId?: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  isError: boolean
  errorMessage?: string
  durationMs?: number
  transport?: string
  instanceKey?: string
  createdAt: Timestamp
}

export interface McpEventLog {
  id: string
  workspaceId?: string
  userId?: string
  pluginId?: string
  deviceId?: string
  eventType: string
  eventData: Record<string, unknown>
  createdAt: Timestamp
}

export type ConversationParticipantType =
  (typeof CONVERSATION_PARTICIPANT_TYPES)[number]

export type ConversationParticipantState =
  (typeof CONVERSATION_PARTICIPANT_STATES)[number]

export type ConversationParticipantRoleKey =
  (typeof CONVERSATION_PARTICIPANT_ROLE_KEYS)[number]

import type { TransportKind } from "../constants/enums.js"
export type { TransportKind } from "../constants/enums.js"

export type TransportConnectionMode =
  (typeof TRANSPORT_CONNECTION_MODES)[number]
export type TransportEndpointType = (typeof TRANSPORT_ENDPOINT_TYPES)[number]
export type TransportAccountStatus = (typeof TRANSPORT_ACCOUNT_STATUSES)[number]
export type TransportDeliveryStatus =
  (typeof TRANSPORT_DELIVERY_STATUSES)[number]

export interface ConversationEntityRef {
  participantId?: UUID
  participantType: ConversationParticipantType
  workspaceMemberId?: UUID
  actorId?: UUID
  remoteAgentId?: UUID
  externalUserKey?: string
  transportAddressId?: UUID
  transportKind?: TransportKind
  name?: string
  title?: string
  role?: string
  avatarUrl?: string
  avatarEmoji?: string
}

export interface ConversationReplyRef {
  itemId: UUID
  ref?: string
  sequence?: number
  itemType: (typeof CONVERSATION_ITEM_TYPES)[number]
  subtype: ConversationReplyRefSubtype
  author?: ConversationEntityRef
  previewText: string
  previewBlocks: CanonicalContentBlock[]
  createdAt?: Timestamp
  isUnavailable?: boolean
}

export type ConversationParticipantRef = ConversationEntityRef & {
  participantId: UUID
  participantType: ConversationParticipantType
}

export interface TransportConnectorCapability {
  transportKind: TransportKind
  supportedConnectionModes: TransportConnectionMode[]
  supportedEndpointTypes: TransportEndpointType[]
  supportsDirectMessages: boolean
  supportsGroupMessages: boolean
  /**
   * User-facing label exposed via the connectors metadata API. Frontend
   * components use this as the authoritative display name; the static
   * `describeTransportKind` is only a fallback.
   */
  displayName: string
  /**
   * UI feature flag: render the connector-specific base-URL config
   * panel. Currently only Weixin v1 sets this true (gateway base URL).
   * Replaces the previous `transportKind === "weixin"` hard-coded gate
   * in the dashboard.
   */
  showsBaseUrlConfig?: boolean
}

export type TransportAccountOwnerScope =
  (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number]
export type TransportAccountInboundActorMode =
  (typeof TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES)[number]
export type TransportConversationInboundActorMode =
  (typeof TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES)[number]

export interface TransportAccountSummary {
  id: UUID
  workspaceId: UUID
  transportKind: TransportKind
  accountKey: string
  displayName: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: UUID
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId?: UUID
  connectionMode: TransportConnectionMode
  status: TransportAccountStatus
  credentials?: Record<string, unknown>
  config: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface TransportEndpointSummary {
  id: UUID
  transportAccountId: UUID
  transportKind: TransportKind
  endpointType: TransportEndpointType
  externalId: string
  parentExternalId?: string
  displayName?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ConversationTransportBindingSummary {
  id: UUID
  conversationId: UUID
  workspaceId: UUID
  transportKind: TransportKind
  outboundEnabled: boolean
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId?: UUID
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
  account: TransportAccountSummary
  endpoint: TransportEndpointSummary
}

export interface TransportSessionSummary {
  id: UUID
  workspaceId: UUID
  transportKind: TransportKind
  outboundEnabled: boolean
  inboundActorMode: TransportConversationInboundActorMode
  inboundActorId?: UUID
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
  conversationId?: UUID
  conversationTitle?: string
  lastInboundAt?: Timestamp
  lastOutboundAt?: Timestamp
  account: TransportAccountSummary
  endpoint: TransportEndpointSummary
}

export type WeixinQrLoginStatus = (typeof WEIXIN_QR_LOGIN_STATUSES)[number]

export interface WeixinQrLoginSessionSummary {
  sessionId: string
  workspaceId: UUID
  status: WeixinQrLoginStatus
  message: string
  qrCodeUrl?: string
  baseUrl?: string
  botId?: string
  scannerUserId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  expiresAt: Timestamp
  transportAccount?: TransportAccountSummary
}

export interface CurrentUserWeixinBindingSummary {
  account: TransportAccountSummary
  scannerUserId?: string
  externalUser?: TransportExternalUserSummary
  pendingAutoLinkWorkspaceMemberId?: UUID
  pendingAutoLinkWorkspaceMemberName?: string
}

// ============ DingTalk Device Flow registration types ============

/**
 * Public-facing status enum for DingTalk Device Flow registration sessions.
 * Lowercase to match Weixin QR session conventions. Provider raw uppercase
 * states (WAITING/SUCCESS/FAIL/EXPIRED/UNKNOWN) are mapped at controller
 * boundary; UNKNOWN -> "fail" with a descriptive message.
 */
export type DingtalkDeviceFlowStatus =
  (typeof DINGTALK_DEVICE_FLOW_STATUSES)[number]

/**
 * Summary of a DingTalk Device Flow registration session.
 *
 * Contract:
 * - Returned by both POST /device-registration/start (wrapped in success
 *   variant of `DingtalkDeviceFlowStartResponse`) and GET /device-registration/
 *   :sessionId (wrapped in `DingtalkDeviceFlowPollResponse`).
 * - `transportAccount` is filled when status === "success" so the UI can
 *   render the newly connected account without a separate accounts reload
 *   (mirrors Weixin `qr-login.ts:280` precedent).
 * - The provider's `deviceCode` is intentionally NOT exposed here; it stays
 *   in the Redis store on the API side.
 */
export interface DingtalkDeviceFlowSessionSummary {
  sessionId: string
  workspaceId: UUID
  status: DingtalkDeviceFlowStatus
  message?: string
  verificationUriComplete: string
  verificationUri?: string
  userCode?: string
  expiresInSeconds: number
  intervalSeconds: number
  createdAt: Timestamp
  updatedAt: Timestamp
  expiresAt: Timestamp
  transportAccount?: TransportAccountSummary
}

/**
 * Response shape for POST /im/accounts/dingtalk/device-registration/start.
 *
 * Explicit discriminated union — success branch *must* carry
 * `providerStartFailed: false` so callers can use the discriminant directly
 * (`response.providerStartFailed`) without resorting to `in` checks.
 *
 * Provider business errors (errcode != 0, source disabled, etc.) and
 * transient network/5xx failures during init/begin both surface here with
 * `providerStartFailed: true`; the route NEVER returns a 5xx in that case,
 * letting the UI handle the failure uniformly via the union type instead of
 * splitting between ApiError catches and union narrowing.
 */
export type DingtalkDeviceFlowStartResponse =
  | { providerStartFailed: false; session: DingtalkDeviceFlowSessionSummary }
  | { providerStartFailed: true; error: string }

/**
 * Response shape for GET /im/accounts/dingtalk/device-registration/:sessionId.
 *
 * All session states (waiting / success / fail / expired) wrap the summary
 * in `{ session }` — clients always read `response.session.status`. Mirrors
 * the Weixin QR `{ session }` envelope (controller/weixin.ts:258).
 */
export interface DingtalkDeviceFlowPollResponse {
  session: DingtalkDeviceFlowSessionSummary
}

export interface TransportExternalUserSessionRef {
  conversationId?: UUID
  conversationTitle?: string
  endpointId?: UUID
  endpointType?: TransportEndpointType
  endpointExternalId?: string
  endpointDisplayName?: string
}

export interface TransportExternalUserSummary {
  id: UUID
  workspaceId: UUID
  transportAccountId: UUID
  transportKind: TransportKind
  accountDisplayName: string
  externalId: string
  displayName?: string
  linkedWorkspaceMemberId?: UUID
  linkedWorkspaceMemberName?: string
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
  lastSeenAt?: Timestamp
  sessions: TransportExternalUserSessionRef[]
}

export interface TransportMessageLink {
  id: UUID
  conversationId: UUID
  itemId: UUID
  transportKind: TransportKind
  transportEndpointId: UUID
  direction: ConversationMessageTransportDirection
  deliveryStatus: TransportDeliveryStatus
  externalMessageId?: string
  /** Platform reply-to id (Feishu parent_id). Populated on inbound when
   *  the user replied to a previous message. */
  externalReplyToId?: string
  /** Platform thread id (Feishu thread_id). */
  externalThreadId?: string
  /** Emoji glyph → platform reaction_id map maintained by
   *  StatusReactionAdapter so a restart can clean orphan reactions. */
  externalEmojiReactions?: Record<string, string>
  metadata: Record<string, unknown>
  deliveredAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ConversationMessageTransportContext {
  direction: ConversationMessageTransportDirection
  transportKind: TransportKind
  transportAccountId?: UUID
  endpointType?: TransportEndpointType
  endpointExternalId?: string
  externalMessageId?: string
  transportAddressId?: UUID
  senderExternalId?: string
}

export interface ConversationMessageTransportDelivery {
  linkId: UUID
  transportKind: TransportKind
  direction: ConversationMessageTransportDirection
  deliveryStatus: TransportDeliveryStatus
  endpointType?: TransportEndpointType
  endpointExternalId?: string
  endpointDisplayName?: string
  externalMessageId?: string
  deliveredAt?: Timestamp
  metadata: Record<string, unknown>
}

export type {
  TaskRequestKind,
  TargetedTaskRequestKind,
} from "../constants/enums.js"

export type TaskLifecycleStatus = (typeof TASK_LIFECYCLE_STATUSES)[number]
export type TaskOutcome = (typeof TASK_OUTCOMES)[number]

export interface TaskInputOption {
  id: string
  label: string
  description?: string
  preview?: string
}

export type TaskInputQuestionType = (typeof TASK_INPUT_QUESTION_TYPES)[number]

export interface TaskInputQuestionDefinition {
  id: string
  header: string
  type: TaskInputQuestionType
  prompt: string
  description?: string
  required?: boolean
  options?: TaskInputOption[]
  allowOther?: boolean
  placeholder?: string
  minSelections?: number
  maxSelections?: number
  secret?: boolean
}

export interface TaskInputAnswer {
  questionId: string
  selectedOptionIds?: string[]
  selectedOptionLabels?: string[]
  otherText?: string
  text?: string
}

export interface TaskInputQuestionSummary extends TaskInputQuestionDefinition {
  required: boolean
  answer?: TaskInputAnswer
}

export interface UserInputTaskDetails {
  title: string
  instructions?: string
  questions: TaskInputQuestionSummary[]
}

export interface PlanApprovalTaskDetails {
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
}

export type TaskDecision = (typeof TASK_DECISIONS)[number]
export type PlanApprovalDecision = (typeof PLAN_APPROVAL_DECISIONS)[number]

export type RuntimeAuthorizationPreset =
  (typeof RUNTIME_AUTHORIZATION_PRESETS)[number]

export type RuntimeAuthorizationRequestMode =
  (typeof RUNTIME_AUTHORIZATION_REQUEST_MODES)[number]

export type DeviceAccessDenialKind = (typeof DEVICE_ACCESS_DENIAL_KINDS)[number]

export type DeviceAccessDenialResolution =
  (typeof DEVICE_ACCESS_DENIAL_RESOLUTIONS)[number]

export interface DeviceAccessDenialDescriptor {
  kind: DeviceAccessDenialKind
  resolution: DeviceAccessDenialResolution
}

// subject-scope-refactor: RuntimeAuthorizationGrantScope type dropped at cutover.
// Scope is expressed via grant.subject + grant.scope SubjectRef pair, and the
// wire-stable `grant_scope` envelope field carries a derived label string via
// `subjectScopeLabel(target)` (see packages/shared/src/access/subject.ts).

export type RuntimeAuthorizationGrantRetention =
  (typeof RUNTIME_AUTHORIZATION_GRANT_RETENTIONS)[number]

export type RuntimeAuthorizationGrantStatus =
  (typeof RUNTIME_AUTHORIZATION_GRANT_STATUSES)[number]

export type RuntimeAuthorizationCapability =
  (typeof RUNTIME_AUTHORIZATION_CAPABILITIES)[number]

export type RuntimeAuthorizationBrowserScopeType =
  (typeof RUNTIME_AUTHORIZATION_BROWSER_SCOPE_TYPES)[number]

export type RuntimeAuthorizationCommandExecutor =
  (typeof RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS)[number]

export type RuntimeAuthorizationCommandMatchType =
  (typeof RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES)[number]

export type RuntimeAuthorizationFilesystemAccess =
  (typeof RUNTIME_AUTHORIZATION_FILESYSTEM_ACCESSES)[number]

export type RuntimeAuthorizationCUAAccess =
  (typeof RUNTIME_AUTHORIZATION_CUA_ACCESSES)[number]

export type RuntimeAuthorizationBrowserAction =
  (typeof RUNTIME_AUTHORIZATION_BROWSER_ACTIONS)[number]

export interface RuntimeAuthorizationFilesystemPolicy extends FilesystemPolicyBase {}

export interface RuntimeAuthorizationCUAPolicy extends CUAPolicyBase {}

export interface RuntimeAuthorizationPtyPolicy extends PtyPolicyBase {}

export interface RuntimeAuthorizationBrowserPolicy extends BrowserPolicyBase {}

/**
 * Commandline policy as it appears on a requested action. Discriminated by
 * `executor`. Shell branch keeps `commandText` (required when generated from
 * a tool call) so consumers can render the exact command being authorized;
 * exec_file branch carries `program + argvPrefix` instead.
 */
export type RuntimeAuthorizationCommandlinePolicy =
  | (Extract<CommandlinePolicyBase, { executor: "bash" | "powershell" }> & {
      commandText: string
    })
  | Extract<CommandlinePolicyBase, { executor: "exec_file" }>

/**
 * RequestedAction-side filesystem block. Extends the grant-side policy with
 * a `scopeIsPushdown` request-only signal: when set, the tool doesn't
 * actually need a path scope of its own (fs_search / fs_history_list /
 * fs_index_task_status all evaluate against the caller's existing read
 * prefixes). The matcher reads this flag and ignores the requested
 * `pathPrefixes` for grant-match purposes — any existing fs grant with
 * compatible access satisfies the call.
 *
 * The flag never appears on a stored GrantPolicy; it lives on the
 * in-memory RequestedAction only.
 */
export interface RuntimeAuthorizationRequestedActionFilesystem extends RuntimeAuthorizationFilesystemPolicy {
  scopeIsPushdown?: boolean
}

/**
 * RequestedAction-side browser block. Extends the grant-side policy with a
 * `scopeSource` signal so the UI / runtime can tell *where* the URL came from
 * (args vs runtime-discovered active page vs page_id lookup vs unknown). The
 * field is request-only — `BrowserPolicySchema.strip()` drops it when the
 * approval path round-trips through `GrantPolicySchema.parse`, and
 * `normalizeBrowserGrantPolicy` strips it again before any write to
 * `runtime_authorization_grants.policy` (3 layers of defence).
 */
export type RuntimeAuthorizationBrowserScopeSource =
  | "args"
  | "runtime_active_page"
  | "runtime_page_id"
  | "runtime_all_pages"
  | "unknown_tool"

export interface RuntimeAuthorizationRequestedActionBrowser extends RuntimeAuthorizationBrowserPolicy {
  scopeSource?: RuntimeAuthorizationBrowserScopeSource
}

export interface RuntimeAuthorizationRequestedAction {
  capability: RuntimeAuthorizationCapability
  toolName: string
  summary: string
  detail?: string
  filesystem?: RuntimeAuthorizationRequestedActionFilesystem
  cua?: RuntimeAuthorizationCUAPolicy
  browser?: RuntimeAuthorizationRequestedActionBrowser
  commandline?: RuntimeAuthorizationCommandlinePolicy
  /**
   * pty session-open request block (§5 / P4a S8). Present only for a
   * `capability:"pty"` action (produced by the pty projector on `pty.open`).
   * Carries the session cwd (default /conversation); ptyPolicyAllows matches on
   * it (cwd/isolation only — never command/byte content). Test-only in P4a.
   */
  pty?: RuntimeAuthorizationPtyPolicy
}

// subject-scope-refactor: SharedRuntimeAuthorizationGrantSpec (camelCase) is the
// API-side policy payload type. Wire-side snake_case spec is
// `RuntimeAuthorizationGrantWireSpec` in @synapse/device-protocol; API code
// MUST import the explicit alias rather than the deprecated bare
// `RuntimeAuthorizationGrantSpec` (which once doubled as both).
// P4: derived from the Zod GrantPolicySchema (see packages/shared/src/access/policies).
export type SharedRuntimeAuthorizationGrantSpec = GrantPolicyBase

export interface RuntimeAuthorizationGrantOption {
  id: string
  summary: string
  detail?: string
  grantSpec: SharedRuntimeAuthorizationGrantSpec
}

export interface RuntimeAuthorizationGrantSummary extends SharedRuntimeAuthorizationGrantSpec {
  id: UUID
  subject: SubjectRef
  scope?: SubjectRef
  scopeLabel: string
  retention: RuntimeAuthorizationGrantRetention
  status: RuntimeAuthorizationGrantStatus
  createdAt: Timestamp
  updatedAt: Timestamp
  consumedAt?: Timestamp
  revokedAt?: Timestamp
}

export interface RuntimeAuthorizationGrantView extends RuntimeAuthorizationGrantSummary {
  workspaceId: UUID
  runtimeId: UUID
  runtimeCapabilityId: UUID
  exposureId: UUID
}

export interface RuntimeAuthorizationTaskDetails {
  requestedToolName: string
  runtimeToolStableKey: string
  requestedAction: RuntimeAuthorizationRequestedAction
  reason: string
  runtimeId: UUID
  deviceDisplayName: string
  runtimeCapabilityId: UUID
  exposureId: UUID
  exposureDisplayName: string
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  approvedPreset?: RuntimeAuthorizationPreset
  approvedGrant?: RuntimeAuthorizationGrantSummary
  requestMode: RuntimeAuthorizationRequestMode
  /**
   * The retry_nonce baked into the row when the request was first created.
   * The post-approval grant carries the SAME value as source_retry_nonce —
   * surfacing it here lets the dedupe-reuse path return the persisted nonce
   * to its caller instead of a freshly-generated one that no grant will
   * ever match. See runtime-authorizations/requests.ts background-mode
   * dedupe branch. Optional because some callers operate on task kinds that
   * do not carry runtime-authorization retry metadata.
   */
  sourceRetryNonce?: string
}

export interface TaskSummaryBase {
  id: UUID
  remoteAgentRunId?: UUID
  workspaceId: UUID
  conversationId: UUID
  itemId?: UUID
  lifecycleStatus: TaskLifecycleStatus
  outcome?: TaskOutcome
  revision: number
  requester?: ConversationEntityRef
  resolvedBy?: ConversationEntityRef
  resolutionNote?: string
  createdAt: Timestamp
  updatedAt: Timestamp
  resolvedAt?: Timestamp
  expiresAt?: Timestamp
  viewerCanResolve: boolean
}

export interface UserInputTaskSummary extends TaskSummaryBase {
  kind: "user_input"
  target?: ConversationEntityRef
  userInput: UserInputTaskDetails
  planApproval?: never
  runtimeAuthorization?: never
}

export interface PlanApprovalTaskSummary extends TaskSummaryBase {
  kind: "plan_approval"
  target?: ConversationEntityRef
  userInput?: never
  planApproval: PlanApprovalTaskDetails
  runtimeAuthorization?: never
}

export interface RuntimeAuthorizationTaskSummary extends TaskSummaryBase {
  kind: "runtime_authorization"
  target?: never
  userInput?: never
  planApproval?: never
  runtimeAuthorization: RuntimeAuthorizationTaskDetails
}

/** Human-facing projection of a Task that needs a response. */
export type TaskSummary =
  | UserInputTaskSummary
  | PlanApprovalTaskSummary
  | RuntimeAuthorizationTaskSummary

export type TaskNoticeStatus = (typeof TASK_NOTICE_STATUSES)[number]

export interface TaskNoticeSummary {
  taskId: UUID
  toolName: string
  status: TaskNoticeStatus
  summary: string
  message?: string
  messageBlocks?: CanonicalContentBlock[]
}

export type ConversationFeedEventType =
  (typeof CONVERSATION_FEED_EVENT_TYPES)[number]

export interface ConversationFeedEventPayloadMap {
  participant_joined: {
    batchId: UUID
    initiator?: ConversationEntityRef
    participants: ConversationParticipantRef[]
    focusItemId?: UUID
  }
  participant_kicked: {
    batchId: UUID
    initiator?: ConversationEntityRef
    participants: ConversationParticipantRef[]
    focusItemId?: UUID
    reason?: string
  }
  participant_left: {
    batchId: UUID
    initiator?: ConversationEntityRef
    participants: ConversationParticipantRef[]
    focusItemId?: UUID
  }
  memory_saved: {
    actor: ConversationEntityRef
    memoryId: UUID
    memoryOwner: SubjectRef
    memoryScope?: SubjectRef
    memoryNamespaceKey: string
    memoryCategory: MemoryCategory
    textDigest?: string
    sourceItemId?: UUID
    sourceTurnId?: UUID
  }
  memory_updated: {
    actor: ConversationEntityRef
    memoryId: UUID
    supersedesMemoryId?: UUID
    memoryOwner: SubjectRef
    memoryScope?: SubjectRef
    memoryNamespaceKey: string
    memoryCategory: MemoryCategory
    textDigest?: string
    sourceItemId?: UUID
    sourceTurnId?: UUID
  }
  actor_renamed: {
    actor: ConversationEntityRef
    oldName?: string
    newName: string
    sourceTurnId?: UUID
  }
  actor_avatar_changed: {
    actor: ConversationEntityRef
    oldAvatarEmoji?: string
    newAvatarEmoji?: string
    oldAvatarUrl?: string
    newAvatarUrl?: string
    sourceTurnId?: UUID
  }
  automation_notice: {
    automationId: UUID
    executionId: UUID
    occurrenceId: UUID
    category: AutomationCategory
    sourceKind: AutomationSourceKind
    eventSourceId?: UUID
    eventSourceName?: string
    sourceLabel?: string
    sourceTitle?: string
    sourceSummary?: string
    sourceDescription?: string
    occurredAt?: Timestamp
    message: string
    messageBlocks?: CanonicalContentBlock[]
  }
  task_requested: {
    task: TaskSummary
  }
  task_notice: TaskNoticeSummary
}

export type ConversationFeedEventPayload<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> = ConversationFeedEventPayloadMap[T]

export interface ConversationFeedMessageItem {
  kind: "message"
  itemId: UUID
  conversationId: UUID
  sequence: number
  sessionId?: UUID
  turnId?: UUID
  role: "user" | "assistant" | "system"
  messageType: ConversationFeedMessageType
  author?: ConversationEntityRef
  replyToItemId?: UUID
  replyTo?: ConversationReplyRef
  restrictedAudience?: ConversationEntityRef[]
  /**
   * Derived plaintext snapshot of the message — produced by the API via
   * `extractText(contentBlocks)`. Treat as read-only on the consumer side;
   * `contentBlocks` is the source of truth (carries file_ref / mention
   * structure that `content` cannot represent). Do not mutate `content`
   * independently of `contentBlocks`.
   */
  content: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
  createdAt: Timestamp
  clientMessageId?: string
}

interface ConversationFeedEventItemBase {
  kind: "event"
  itemId: UUID
  conversationId: UUID
  sequence: number
  sessionId?: UUID
  turnId?: UUID
  author?: ConversationEntityRef
  restrictedAudience?: ConversationEntityRef[]
  causedByItemId?: UUID
  createdAt: Timestamp
}

type ConversationFeedEventItemMap = {
  [T in ConversationFeedEventType]: ConversationFeedEventItemBase & {
    eventType: T
    payload: ConversationFeedEventPayloadMap[T]
  }
}

export type ConversationFeedEventItem<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> = ConversationFeedEventItemMap[T]

// formatConversationEntityName / summarizeConversationEvent moved to
// ../conversation/index.ts (runtime) per §2.2.1; re-exported via root barrel.

export type ConversationFeedItem =
  | ConversationFeedMessageItem
  | ConversationFeedEventItem

export interface ConversationFeedPage {
  items: ConversationFeedItem[]
  hasMore: boolean
  nextBeforeSequence?: number
  readWatermarkSequence?: number
}

export interface ChatParticipantSummary extends Omit<
  ConversationEntityRef,
  "participantId" | "participantType" | "name"
> {
  participantId: UUID
  conversationId: UUID
  participantType: ConversationParticipantType
  name: string
  roleKey: string
  state: (typeof CONVERSATION_PARTICIPANT_STATES)[number]
  metadata: Record<string, unknown>
  joinedAt: Timestamp
  leftAt?: Timestamp
  sessionId?: UUID
  sessionStatus?: SessionStatus | RemoteAgentRuntimeStateType
}

interface ChatConversationItemBase {
  id: UUID
  conversationId: UUID
  sequence: number
  sessionId?: UUID
  turnId?: UUID
  clientMessageId?: UUID
  itemType: (typeof CONVERSATION_ITEM_TYPES)[number]
  role: (typeof CONVERSATION_ITEM_ROLES)[number]
  scope: (typeof CONVERSATION_ITEM_SCOPES)[number]
  surface: (typeof CONVERSATION_ITEM_SURFACES)[number]
  authorParticipantId?: UUID
  author?: ConversationEntityRef
  replyToItemId?: UUID
  replyTo?: ConversationReplyRef
  causedByItemId?: UUID
  /**
   * Derived plaintext snapshot of the item — produced by the API via
   * `extractText(contentBlocks)`. Treat as read-only; `contentBlocks` is
   * authoritative. Do not mutate `content` without rebuilding the blocks.
   */
  content: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown>
  restrictedAudienceParticipantIds?: UUID[]
  restrictedAudience?: ConversationEntityRef[]
  createdAt: Timestamp
}

export interface ChatConversationMessageItem extends ChatConversationItemBase {
  itemType: "message" | "control"
  subtype: ConversationMessageSubtype
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
}

export interface ChatConversationSummaryItem extends ChatConversationItemBase {
  itemType: "summary"
  subtype: typeof CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY
  transport?: ConversationMessageTransportContext
  transportDeliveries?: ConversationMessageTransportDelivery[]
}

type ChatConversationEventItemMap = {
  [T in ConversationFeedEventType]: ChatConversationItemBase & {
    itemType: "event"
    subtype: T
    eventPayload: ConversationFeedEventPayloadMap[T]
    eventTimelinePolicy?: ConversationEventTimelinePolicy
    eventContextPolicy?: ConversationEventContextPolicy
  }
}

export type ChatConversationEventItem<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> = ChatConversationEventItemMap[T]

export type ChatConversationItem =
  | ChatConversationMessageItem
  | ChatConversationSummaryItem
  | ChatConversationEventItem

export interface ChatConversationPresentation {
  chatType: "direct" | "group"
  subtitle?: string
  avatarParticipantIds: UUID[]
  peerParticipantId?: UUID
  avatarUrl?: string
  avatarEmoji?: string
}

export interface ChatConversationPermissions {
  canManageConversation: boolean
  canManageParticipants: boolean
  canRename: boolean
}

export interface ChatConversationView {
  conversationId: UUID
  workspaceId: UUID
  title: string
  kind: (typeof CONVERSATION_KINDS)[number]
  isIm: boolean
  status: ConversationStatus
  unreadCount: number
  muted: boolean
  archived: boolean
  pinnedSortKey?: Timestamp
  updatedAt: Timestamp
  createdAt: Timestamp
  participants: ChatParticipantSummary[]
  presentation: ChatConversationPresentation
  permissions: ChatConversationPermissions
  viewerParticipantId?: UUID
  lastItem?: {
    itemId: UUID
    sequence: number
    itemType: ChatConversationItem["itemType"]
    subtype: ConversationFeedItemSubtype
    previewText: string
    authorParticipantId?: UUID
    author?: ConversationEntityRef
    createdAt: Timestamp
  }
}

export interface ChatDeviceState {
  clientInstanceId: UUID
  conversationId: UUID
  lastVisibleSequence: number
  lastInboxSeq: number
  lastOpenedAt?: Timestamp
  draftPayload: Record<string, unknown>
}

export interface ChatSyncEventPayloadMap {
  "conversation.upsert": {
    conversation: ChatConversationView
  }
  "conversation.item.created": {
    conversationId: UUID
    item: ChatConversationItem
  }
  "conversation.read.updated": {
    conversationId: UUID
    workspaceMemberId: UUID
    participantId: UUID
    readWatermarkSequence: number
    lastReadAt: Timestamp
  }
  "task.updated": {
    conversationId: UUID
    taskId: UUID
    itemId?: UUID
    task: TaskSummary
  }
  "remote_agent.runtime_updated": {
    remoteAgentId: UUID
    snapshot: RemoteAgentRuntimeState
  }
  /**
   * A workspace member's participation in a conversation changed. Sent to the
   * affected member (incl. the member who was removed/left, so all their
   * devices drop the conversation) and is the authoritative "you were
   * removed / re-added" signal. `selfState` is the recipient's own state in
   * that conversation after the change.
   */
  "conversation.membership.updated": {
    conversationId: UUID
    selfState: (typeof CONVERSATION_PARTICIPANT_STATES)[number]
    reason?: (typeof CHAT_MEMBERSHIP_UPDATE_REASONS)[number]
    participants: ChatParticipantSummary[]
  }
}

export type ChatSyncEventType = keyof ChatSyncEventPayloadMap

export type ChatSyncEvent<T extends ChatSyncEventType = ChatSyncEventType> = {
  /**
   * Global INSERT-time identity (PK). NOT a reliable client cursor — not
   * commit-ordered, not per-member contiguous. Retained for debugging/joins.
   */
  syncSeq: number
  /**
   * Per-member, commit-ordered, gap-free cursor. THIS is the client sync
   * cursor: getChatSync pages by `member_seq > cursor`, and clients apply
   * live frames strictly in `member_seq` order (==base+1 apply / >base+1 gap).
   */
  memberSeq: number
  workspaceId: UUID
  workspaceMemberId: UUID
  conversationId?: UUID
  itemId?: UUID
  eventType: T
  payload: ChatSyncEventPayloadMap[T]
  occurredAt: Timestamp
}

/**
 * Discriminated union over ALL event types: each member correlates its
 * `eventType` with the matching `payload` (so `if (e.eventType === 'task.updated')`
 * narrows `e.payload` to the task payload). This is what the wire actually
 * carries and what ChatSyncEventSchema (a z.discriminatedUnion) infers — unlike
 * the bare `ChatSyncEvent<ChatSyncEventType>`, which decouples eventType from
 * payload and cannot be discriminated.
 */
export type ChatSyncEventUnion = {
  [K in ChatSyncEventType]: ChatSyncEvent<K>
}[ChatSyncEventType]

export interface ChatBootstrapResponse {
  workspaceMemberId: UUID
  clientInstanceRequired: true
  conversations: ChatConversationView[]
  nextInboxCursor: number
}

export interface ChatSyncResponse {
  events: ChatSyncEventUnion[]
  nextCursor: number
  hasMore: boolean
}

export interface ChatSyncQuery {
  cursor?: number
  limit?: number
}

export interface ChatConversationMessagesQuery {
  afterSequence?: number
  beforeSequence?: number
  limit?: number
  clientInstanceId: UUID
}

export interface ChatConversationMessagesPage {
  conversation: ChatConversationView
  items: ChatConversationItem[]
  runtimeByActor: Record<string, ActorRuntimeState>
  runtimeByRemoteAgent: Record<string, RemoteAgentRuntimeState>
  participantReadWatermarkSequence: number
  deviceState?: ChatDeviceState
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export interface ChatClientInstanceRegistrationRequest {
  platform?: string
  deviceLabel?: string
  metadata?: Record<string, unknown>
}

export type ChatClientInstanceRegistrationInput =
  ChatClientInstanceRegistrationRequest

export interface ChatClientInstanceCreateRequest extends ChatClientInstanceRegistrationRequest {}

export type ChatClientInstanceCreateInput = ChatClientInstanceCreateRequest

export interface ChatClientInstanceTouchRequest extends ChatClientInstanceRegistrationRequest {}

export type ChatClientInstanceTouchInput = ChatClientInstanceTouchRequest

export interface ChatClientInstanceRegistrationResponse {
  clientInstanceId: UUID
  workspaceMemberId: UUID
}

export interface ChatConversationCreateRequest {
  clientRequestId: UUID
  kind: (typeof CONVERSATION_KINDS)[number]
  title?: string
  workspaceMemberIds?: UUID[]
  actorIds?: UUID[]
  remoteAgentIds?: UUID[]
  metadata?: Record<string, unknown>
}

export type ChatConversationCreateInput = ChatConversationCreateRequest

export interface ChatConversationCreateResponse {
  conversation: ChatConversationView
}

export interface ChatConversationSendMessageRequest {
  contentBlocks: CanonicalContentBlock[]
  clientMessageId: UUID
  replyToItemId?: UUID
  clientInstanceId: UUID
  metadata?: Record<string, unknown>
}

export type ChatConversationSendMessageInput =
  ChatConversationSendMessageRequest

export interface ChatConversationSendMessageResponse {
  item: ChatConversationItem
}

export interface ChatConversationReadWatermarkRequest {
  readUpToSequence: number
  lastVisibleSequence?: number
  clientInstanceId: UUID
}

export type ChatConversationReadWatermarkInput =
  ChatConversationReadWatermarkRequest

export interface ChatConversationReadWatermarkResponse {
  conversationId: UUID
  workspaceMemberId: UUID
  participantId: UUID
  readWatermarkSequence: number
  lastReadAt: Timestamp
}

export interface ChatTaskAnswerInput {
  questionId: string
  selectedOptionIds?: string[]
  otherText?: string
  text?: string
}

export interface ChatTaskResolveCommandMetadata {
  commandId: UUID
  baseRevision: number
}

export interface ChatTaskResolveUserInputPayload {
  answers: ChatTaskAnswerInput[]
  decision?: never
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export interface ChatTaskResolvePlanApprovalPayload {
  answers?: never
  decision: "approve" | "revise"
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export interface ChatTaskResolveRuntimeAuthorizationApprovePayload {
  answers?: never
  decision: "approve"
  preset: RuntimeAuthorizationPreset
  selectedGrantOptionId: string
  note?: string
}

export interface ChatTaskResolveRuntimeAuthorizationRejectPayload {
  answers?: never
  decision: "reject"
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export type ChatTaskResolvePayload =
  | ChatTaskResolveUserInputPayload
  | ChatTaskResolvePlanApprovalPayload
  | ChatTaskResolveRuntimeAuthorizationApprovePayload
  | ChatTaskResolveRuntimeAuthorizationRejectPayload

export type ChatTaskResolveInput = ChatTaskResolveCommandMetadata &
  ChatTaskResolvePayload

export type ChatTaskResolveOutcome = "applied" | "duplicate" | "conflict"

export interface ChatTaskResolveAppliedResponse {
  outcome: "applied" | "duplicate"
  task: TaskSummary
}

export interface ChatTaskResolveConflictResponse {
  outcome: "conflict"
  code: "task_conflict"
  error: string
  task: TaskSummary
}

export type ChatTaskResolveResponse =
  | ChatTaskResolveAppliedResponse
  | ChatTaskResolveConflictResponse

// isChatTaskResolveConflictResponse moved to ../conversation/index.ts (§2.2.1)

export type RealtimeAsrAudioFormat = (typeof REALTIME_ASR_AUDIO_FORMATS)[number]
export type RealtimeAsrAudioCodec = (typeof REALTIME_ASR_AUDIO_CODECS)[number]

export interface RealtimeAsrAudioConfig {
  format: RealtimeAsrAudioFormat
  codec: RealtimeAsrAudioCodec
  rate: 16000
  bits: 16
  channel: 1
}

export type RealtimeAsrClientMessage =
  | {
      type: "auth"
      token?: string
      workspaceId: UUID
    }
  | {
      type: "start"
      audio: RealtimeAsrAudioConfig
    }
  | {
      type: "stop"
    }
  | {
      type: "cancel"
    }
  | {
      type: "pong"
    }

export interface RealtimeAsrFinalSegment {
  text: string
  segmentIndex: number
  startTimeMs: number
  endTimeMs: number
  receivedAt: Timestamp
}

export type RealtimeAsrSocketEventType =
  | "auth.ok"
  | "auth.error"
  | "ping"
  | "server.shutdown"
  | "asr.started"
  | "asr.partial"
  | "asr.segment.final"
  | "asr.completed"
  | "asr.error"

export interface RealtimeAsrSocketEventPayloadMap {
  "auth.ok": {
    connectionId: UUID
    heartbeatMs: number
  }
  "auth.error": {
    message: string
  }
  ping: {
    at: Timestamp
  }
  "server.shutdown": {
    message: string
    retryable: boolean
  }
  "asr.started": {
    sessionId: UUID
    providerConnectId: UUID
    heartbeatMs: number
  }
  "asr.partial": {
    displayText: string
    unstableText: string
    receivedAt: Timestamp
  }
  "asr.segment.final": RealtimeAsrFinalSegment
  "asr.completed": {
    text: string
    segments: RealtimeAsrFinalSegment[]
    durationMs: number
  }
  "asr.error": {
    code: string
    message: string
    retryable: boolean
    providerCode?: number
    providerLogId?: string
  }
}

export type RealtimeAsrSocketEvent<
  T extends RealtimeAsrSocketEventType = RealtimeAsrSocketEventType,
> = {
  type: T
  payload: RealtimeAsrSocketEventPayloadMap[T]
}

export type ChatSocketEventType =
  | "auth.ok"
  | "auth.error"
  | "ping"
  | "server.shutdown"
  | "chat.sync.event"
  | "runtime.updated"
  | "chat.typing"

export interface ChatSocketEventPayloadMap {
  "auth.ok": {
    connectionId: UUID
    heartbeatMs: number
  }
  "auth.error": {
    message: string
  }
  ping: {
    at: Timestamp
  }
  "server.shutdown": {
    message: string
    retryable: boolean
  }
  "chat.sync.event": ChatSyncEvent
  "runtime.updated": {
    conversationId: UUID
    runtimeSeq: number
    snapshot: ActorRuntimeState
  }
  "chat.typing": {
    conversationId: UUID
    fromWorkspaceMemberId: UUID
    state: ChatTypingState
    occurredAt: Timestamp
  }
}

export type ChatSocketEvent<
  T extends ChatSocketEventType = ChatSocketEventType,
> = {
  type: T
  payload: ChatSocketEventPayloadMap[T]
}
// Content-block + tool-result helpers moved to ../content/index.ts;
// actor-doc helpers + SECRETARY_DEFAULT_* moved to ../actor/index.ts (§2.2.1).

// ============================================================
// Domain Model V2
// ============================================================

export type CatalogItemKind =
  | "actor_template"
  | "skill_package"
  | "plugin_package"
export type CatalogSourceKind = "builtin" | "official" | "workspace" | "user"
export type CatalogVisibility = "public" | "workspace" | "private"
export type CatalogVersionStatus =
  | "draft"
  | "active"
  | "deprecated"
  | "archived"
export type CatalogLineageKind = "installed_copy" | "fork" | "share"
export type CatalogSyncMode =
  | "notify"
  | "manual_merge"
  | "follow_upstream"
  | "detached"
export type CatalogFileRole =
  | "document"
  | "reference"
  | "script"
  | "image"
  | "json"
  | "binary"
export type RuntimeBindingScope = AccessTargetType
export type PluginReuseScopeV2 =
  | "turn"
  | "session"
  | "workspace"
  | "conversation"
  | "actor"

export interface CatalogPublisherRecord {
  id: string
  slug: string
  displayName: string
  description: string
  logoBlobId?: string
  ownerUserId?: string
  workspaceId?: string
  isBuiltin: boolean
  isVerified: boolean
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CatalogItemRecord {
  id: string
  publisherId: string
  workspaceId?: string
  itemKind: CatalogItemKind
  slug: string
  displayName: string
  summary: string
  longDescription: string
  iconBlobId?: string
  sourceKind: CatalogSourceKind
  visibility: CatalogVisibility
  tags: string[]
  latestVersionId?: string
  isActive: boolean
  downloadCount: number
  metadata: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CatalogVersionRecord {
  id: string
  catalogItemId: string
  version: string
  status: CatalogVersionStatus
  changelog: string
  metadata: Record<string, unknown>
  createdByUserId?: string
  createdAt: Timestamp
}

export interface CatalogVersionFileRecord {
  id: string
  catalogVersionId: string
  path: string
  fileRole: CatalogFileRole
  mediaType?: string
  contentBlocks: CanonicalContentBlock[]
  sha256: string
  sizeBytes: number
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface ActorTemplateVersionSpecRecord {
  catalogVersionId: string
  role: ActorRole
  name: string
  avatarFileId?: string
  avatarEmoji?: string
  title: string
  canRepresentUser: boolean
  docs: ActorDoc[]
  specialties: string[]
  config: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface SkillPackageVersionSpecRecord {
  catalogVersionId: string
  skillSnapshotId: string
  defaultConversationTypeMask: number
  createdAt: Timestamp
}

export interface PluginRuntimePermissionRecord {
  id: string
  catalogVersionId: string
  permissionKey: string
  isRequired: boolean
  rationale: string
  createdAt: Timestamp
}

export interface PluginPackageVersionSpecRecord {
  catalogVersionId: string
  transport: PluginSpecTransport
  entryPoint?: string
  toolManifest: MarketplaceTool[]
  configSchema: Record<string, unknown>
  defaultConfig: Record<string, unknown>
  installFlow: Record<string, unknown>
  authBindings: PluginAuthBindingDefinition[]
  defaultReuseScope: PluginReuseScopeV2
  supportedReuseScopes: PluginReuseScopeV2[]
  requiresHandshake: boolean
  metadata: Record<string, unknown>
  createdAt: Timestamp
}

export interface InstalledSkillRecord {
  id: string
  workspaceId: string
  name: string
  iconFileId?: string
  tags: string[]
  currentVersion: number
  isActive: boolean
  currentSnapshotId: string
  conversationTypeMaskOverride?: number
  ownerWorkspaceMemberId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SkillVersionRecord {
  id: string
  skillId: string
  version: number
  skillSnapshotId: string
  metadata: Record<string, unknown>
  createdByWorkspaceMemberId?: string
  createdAt: Timestamp
}

export interface SkillSnapshotRecord {
  id: string
  entryPath: string
  name: string
  description: string
  argumentHint?: string
  disableModelInvocation: boolean
  userInvocable: boolean
  allowedTools: string[]
  model?: string
  effort?: SkillFrontmatterEffort
  context?: SkillFrontmatterContext
  agent?: string
  hooks: Record<string, unknown>
  bodyBlocks: CanonicalContentBlock[]
  contentHash: string
  sourceWarnings: string[]
  createdAt: Timestamp
}

export interface SkillSnapshotFileRecord {
  id: string
  skillSnapshotId: string
  path: string
  mediaType?: string
  contentBlocks: CanonicalContentBlock[]
  sha256: string
  sizeBytes: number
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SkillMirrorSourceRecord {
  id: string
  sourceType: SkillSourceType
  locatorKey: string
  locator: Record<string, unknown>
  requestedRef?: string
  resolvedRevision?: string
  refreshMode: SkillMirrorRefreshMode
  lastSyncStatus: SkillMirrorSyncStatus
  sourceWarnings: string[]
  lastError?: string
  lastSyncedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface SkillBindingRecord {
  id: string
  skillId: string
  workspaceId: string
  bindScope: RuntimeBindingScope
  conversationId?: string
  actorId?: string
  status: "active" | "disabled" | "revoked"
  metadata: Record<string, unknown>
  createdByWorkspaceMemberId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface PluginInstallationRecord {
  id: string
  workspaceId: string
  catalogItemId: string
  catalogVersionId: string
  displayName: string
  configData: Record<string, unknown>
  approvedRuntimePermissions: string[]
  status: "active" | "disabled" | "error" | "archived"
  ownerWorkspaceMemberId?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// buildConversationMessageRef / parseConversationMessageRef moved to
// ../conversation/index.ts (§2.2.1); re-exported via the package root barrel.

// ── Schema-first app contracts (type-only re-export, §2.2 / §5.1) ──
// The runtime zod schemas live under ../schemas/* and are reachable via the
// `@synapse/shared/schemas` subpath; here we surface only the inferred types so
// the root barrel stays zod-free.
export type {
  WorkspaceInviteView,
  WorkspaceInviteListView,
  WorkspaceInvitePublicView,
  WorkspaceInviteRedeemResult,
} from "../schemas/workspace-invites.js"
export type {
  WorkspaceView,
  WorkspaceListView,
  WorkspaceListItemView,
  WorkspaceCreateResultView,
  WorkspaceMemberListView,
  WorkspaceMemberView,
  WorkspaceAccessBindingListView,
  WorkspaceAccessBindingView,
  WorkspaceNavigationView,
  WorkspaceChiefActorPreferenceView,
  WorkspaceCapabilityConversationTypePoliciesViewSchemaType,
} from "../schemas/workspace.js"
export type {
  UserProfileView,
  AuthSessionSummaryView,
  AuthMeView,
  UpdateMeInput,
  UnlinkAccountInput,
} from "../schemas/auth.js"
export type {
  AutomationEventSourceSchemaType,
  AutomationEventSourceListSchemaType,
  AutomationRuleSchemaType,
  AutomationRuleListSchemaType,
  AutomationOccurrenceSchemaType,
  AutomationOccurrenceListSchemaType,
  AutomationExecutionSchemaType,
  AutomationExecutionListSchemaType,
  AutomationWebhookEndpointSchemaType,
  AutomationWebhookEndpointListSchemaType,
  AutomationWebhookEndpointCreateResultSchemaType,
  AutomationEventSourceAccessStateSchemaType,
  AutomationSuccessSchemaType,
  AutomationEventIngestResultSchemaType,
} from "../schemas/automation.js"
export type {
  ModelGroupView,
  ModelGroupItemView,
  ModelGroupGrantView,
  ModelGroupDetailView,
  ActorModelGroupAssignmentView,
  ModelGroupItemVersionView,
  ModelGroupListView,
  ModelGroupGrantListView,
  ModelGroupItemVersionListView,
  ActorModelGroupAssignmentListView,
} from "../schemas/model-groups.js"
export type {
  ActorListView,
  ActorView,
  ActorTreeView,
  ActorTreeNodeView,
  ActorVersionListView,
  ActorVersionView,
  ActorPackageListView,
  ActorPackageRecordView,
  ActorPackageInstallResultView,
} from "../schemas/organization.js"
export type {
  PluginAuthorizationView,
  MarketplacePluginCategoryView,
  MarketplacePluginPublisherSummary,
  MarketplacePluginView,
  MarketplacePublisherView,
  PluginCategoryView,
  PluginInstallationDetailView,
  PluginAuthSessionView,
  PluginAuthSessionEnvelope,
  PluginInstallPlanView,
  PluginInstallPlanEnvelope,
  PluginAuditLogList,
  PluginInstallPlanInput,
  StartPluginAuthInput,
} from "../schemas/mcp-plugins.js"
export type {
  SkillFrontmatterView,
  SkillMirrorSourceSummaryView,
  SkillAttachmentFileView,
  SkillMarketplaceVersionView,
  SkillMarketplaceWorkspaceInstallationView,
  SkillMarketplaceEntryView,
  InstalledSkillView,
  SkillMarketplaceListView,
  SkillMarketplaceItemView,
  InstalledSkillListView,
  InstalledSkillItemView,
  SkillAttachmentInput,
  PublishMarketplaceSkillInput,
  ImportMarketplaceSkillInput,
  InstalledSkillListQuery,
} from "../schemas/skills.js"
export type {
  DeviceView,
  DeviceListView,
  DeviceServiceView,
  DeviceCapabilityView,
  DeviceDetailView,
  DevicePairingTicketView,
  CreateCloudDeviceInput,
  CreateCloudDeviceResultView,
  StartPairingInput,
  ClaimDaemonServiceInput,
  RuntimeCapabilityAccessTargetInput,
  SetActiveRuntimeCapabilitiesInput,
  ActiveRuntimeCapabilitiesView,
} from "../schemas/devices.js"
export type {
  RuntimeAuthorizationGrantRecordView,
  CreateManualRuntimeAuthorizationGrantInput,
} from "../schemas/runtime-authorizations.js"
export type {
  FileOriginSummaryView,
  StoredFileRecordView,
  FileParseEnqueueResult,
} from "../schemas/files.js"
export type {
  RelationshipProfileViewSchemaType,
  IdentitySearchResponseSchemaType,
  RelationshipScanResponseSchemaType,
  FriendsListResponseSchemaType,
  RequestListResponseSchemaType,
  ResolveRequestResponseSchemaType,
  ContactHubResponseSchemaType,
  ContactHubDetailResponseSchemaType,
  DirectConversationOpenResponseSchemaType,
  RelationshipScanInput,
  OpenDirectConversationInput,
  UpdateMemberRelationshipProfileInput,
  UpdateActorRelationshipProfileInput,
  IdentitySearchQuery,
  RequestRelationshipBySearchInput,
} from "../schemas/relationship.js"
export type {
  RemoteAgentListResponseSchemaType,
  RemoteAgentResponseSchemaType,
  RemoteAgentGroupTaskGrantsResponseSchemaType,
  RemoteAgentMachinePairingSessionResponseSchemaType,
  RemoteAgentMachineListResponseSchemaType,
  RemoteAgentMachineDetailResponseSchemaType,
  CreateRemoteAgentMachineInput,
  BindRemoteAgentInput,
  UpdateRemoteAgentGroupTaskGrantsInput,
} from "../schemas/remote-agents.js"
export type {
  TransportConnectorsResponseSchemaType,
  TransportAccountsResponseSchemaType,
  TransportSessionsResponseSchemaType,
  TransportExternalUsersResponseSchemaType,
  TransportAccountResponseSchemaType,
  TransportSessionResponseSchemaType,
  TransportAddressResponseSchemaType,
  WeixinBindingCandidatesResponseSchemaType,
  WeixinQrSessionResponseSchemaType,
  WeixinBindingResponseSchemaType,
  DingtalkDeviceFlowStartResponseSchemaType,
  DingtalkDeviceFlowPollResponseSchemaType,
} from "../schemas/im.js"
export type {
  WorkspaceResourceViewSchemaType,
  WorkspaceResourceEnvelopeViewSchemaType,
  WorkspaceResourceListViewSchemaType,
  WorkspaceResourceGrantViewSchemaType,
  WorkspaceResourceGrantListViewSchemaType,
  WorkspaceResourceGrantRequestViewSchemaType,
  WorkspaceResourceGrantRequestListViewSchemaType,
  WorkspaceResourceGrantRequestEnvelopeViewSchemaType,
  WorkspaceResourceSuccessViewSchemaType,
  WorkspaceResourceGrantTargetInput,
  WorkspaceResourceGrantEntryInput,
  ReplaceWorkspaceResourceGrantsInput,
  CreateWorkspaceResourceGrantRequestInput,
  CreateWorkspaceResourceInput,
  UpdateWorkspaceResourceInput,
} from "../schemas/workspace-resources.js"
export type {
  ChatBootstrapViewSchemaType,
  ChatSyncViewSchemaType,
  ChatClientInstanceViewSchemaType,
  ChatConversationEnvelopeViewSchemaType,
  ChatConversationListViewSchemaType,
  ChatConversationMessagesViewSchemaType,
  ChatRuntimeTurnDetailViewSchemaType,
  ChatSendMessageViewSchemaType,
  ChatReadWatermarkViewSchemaType,
  ChatParticipantRemovalViewSchemaType,
  ChatPushTokenRegistrationViewSchemaType,
  ChatPushTokenListViewSchemaType,
  ChatPushTokenDeleteViewSchemaType,
  ChatTypingBroadcastViewSchemaType,
  ChatMessageRetryViewSchemaType,
  ChatTaskRespondViewSchemaType,
  ChatDedupCountersViewSchemaType,
  ChatRealtimeOutboxGcViewSchemaType,
} from "../schemas/chat.js"
