import {
  ACTOR_DOC_VISIBILITIES,
  ACTOR_ROLES,
  ACCESS_TARGET_TYPES,
  CAPABILITY_ACCESS_TARGET_TYPES,
  CONTACT_DIRECT_STATES,
  CONTACT_HUB_KINDS,
  CONTACT_TARGET_TYPES,
  PLUGIN_ATTACHMENT_SCOPE_TYPES,
  CANONICAL_FILE_CATEGORIES,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_KINDS,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_PARTICIPANT_STATES,
  CONVERSATION_PARTICIPANT_TYPES,
  FILE_ORIGIN_SYSTEMS,
  FILE_ORIGIN_FAMILIES,
  USER_UPLOAD_FILE_ORIGIN_SYSTEMS,
  ACTOR_OUTPUT_FILE_ORIGIN_SYSTEMS,
  TOOL_OUTPUT_FILE_ORIGIN_SYSTEMS,
  MODEL_OUTPUT_FILE_ORIGIN_SYSTEMS,
  EXTERNAL_IMPORT_FILE_ORIGIN_SYSTEMS,
  PACKAGE_IMPORT_FILE_ORIGIN_SYSTEMS,
  SYSTEM_GENERATED_FILE_ORIGIN_SYSTEMS,
  PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS,
  FILE_PARSE_OUTPUT_KINDS,
  FILE_PARSE_RUN_STATUSES,
  FILE_STORAGE_BACKENDS,
  CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES,
  CONVERSATION_TYPE_KEYS,
  DEVICE_EXPOSURE_TRANSPORTS,
  MCP_SERVER_TRANSPORTS,
  PLUGIN_SPEC_TRANSPORTS,
  PLUGIN_TRANSPORTS,
  INVITE_TRUST_LEVELS,
  INTERACTION_DECISIONS,
  INTERACTION_INPUT_QUESTION_TYPES,
  INTERACTION_REQUEST_KIND,
  INTERACTION_REQUEST_KINDS,
  INTERACTION_REQUEST_STATUSES,
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
  PLUGIN_AUTH_CONNECTION_STATUSES,
  PLUGIN_AUTH_SESSION_STATUSES,
  PLAN_APPROVAL_DECISIONS,
  TARGETED_INTERACTION_REQUEST_KINDS,
  REUSE_SCOPES,
  RELATIONSHIP_APPROVAL_MODES,
  RELATIONSHIP_PROFILE_SUBJECT_TYPES,
  RELATIONSHIP_REQUEST_STATUSES,
  RELATIONSHIP_SCAN_OUTCOMES,
  DEVICE_ACCESS_DENIAL_KINDS,
  DEVICE_ACCESS_DENIAL_RESOLUTIONS,
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
  SESSION_COLLABORATION_MODES,
  SESSION_INTERRUPT_TYPES,
  SESSION_STATUSES,
  SESSION_TRIGGERS,
  SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES,
  SESSION_WAKEUP_SOURCE_TYPES,
  SESSION_WAKEUP_STATUSES,
  TASK_NOTICE_STATUSES,
  DIRECT_CONVERSATION_OPEN_STATUSES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_GRANT_STATUSES,
  MODEL_GROUP_OWNER_TYPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
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
} from "../constants/enums.js"
import type { ChatTypingState } from "../constants/enums.js"
import type { ProviderKind } from "../constants/model-providers.js"
import type {
  FilesystemPolicy as FilesystemPolicyBase,
  CUAPolicy as CUAPolicyBase,
  BrowserPolicy as BrowserPolicyBase,
  CommandlinePolicy as CommandlinePolicyBase,
  GrantPolicy as GrantPolicyBase,
} from "../access/policies/index.js"
import type {
  WorkspaceAppGrantPermission,
  WorkspaceAppGrantRequestStatus,
  WorkspaceAppGrantSource,
  WorkspaceAppGrantStatus,
  WorkspaceAppKind,
  WorkspaceAppStatus,
} from "../access/enums.js"
import type { SubjectRef, ScopedSubjectTarget } from "../access/subject.js"

// ============ Common ============
export type UUID = string
export type Timestamp = string // ISO 8601

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
export type TrustLevel = "owner" | "admin" | "member" | "guest"

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

export type CoreActorDocKey =
  | "identity_card"
  | "public_persona"
  | "soul"
  | "self_narrative"
  | "origin_story"
  | "relationship_with_user"
  | "relationship_with_team"
  | "representation_guidelines"
  | "social_protocol"
  | "role_charter"
  | "mission"
  | "work_doctrine"
  | "limitations_and_escalation"
  | "quirks_and_signatures"
  | "routines"
  | "conversation_examples"

export type ActorDocKey = CoreActorDocKey | "custom"

export interface ActorDoc {
  id: UUID
  key: ActorDocKey
  title: string
  content: CanonicalContentBlock[]
  visibility: ActorDocVisibility
  priority: number
}

export type ActorDocInput = Omit<ActorDoc, "id" | "content"> & {
  id?: UUID
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

export type ActorUpdateSourceType =
  | "workspace_member"
  | "actor"
  | "system"
  | "sync"

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
  | "displayName"
  | "role"
  | "title"
  | "parentId"
  | "canRepresentUser"
  | "specialties"
  | "config"

export type ActorDocChangedField =
  | "title"
  | "visibility"
  | "priority"
  | "content"

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
  changeType: "added" | "updated" | "removed"
  visibility: ActorDocVisibility
  priority: number
  fieldChanges: ActorDocFieldChange[]
  summary: CanonicalContentBlock[]
}

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

// Valid state transitions
export const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  created: ["assigned", "cancelled"],
  assigned: ["accepted", "cancelled"],
  accepted: ["in_progress", "cancelled"],
  in_progress: ["review", "escalated", "blocked", "cancelled", "failed"],
  review: ["completed", "rework", "cancelled"],
  completed: [],
  escalated: ["assigned", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  rework: ["in_progress", "cancelled"],
  cancelled: [],
  failed: [],
}

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
export type AutomationCategory = "schedule" | "event_subscription"
export type AutomationStatus =
  | "active"
  | "paused"
  | "error"
  | "archived"
  | "completed"
  | "expired"
export type AutomationCreatorKind = "workspace_member" | "session" | "system"
export type AutomationTriggerKind = "schedule" | "event"
export type AutomationSourceKind =
  | "clock"
  | "device"
  | "webhook"
  | "internal"
  | "integration"
export type AutomationEventProviderKind =
  | "device"
  | "webhook"
  | "internal"
  | "integration"
export type AutomationIntegrationProvider = "github" | "gitlab"
export type AutomationIntegrationIngressKind = "webhook" | "polling"
export type AutomationIntegrationTargetKind = "repository" | "project"
export type AutomationScheduleKind = "cron" | "at" | "interval"
export type AutomationCompletionStatus = "completed" | "archived"
export type AutomationTargetPolicy = "all_members" | "specified_members"
export type AutomationExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
export type AutomationWebhookStatus = "active" | "disabled" | "archived"
export type AutomationEventSourceStatus =
  | "active"
  | "deprecated"
  | "disabled"
  | "archived"

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
  createdByKind: AutomationCreatorKind
  createdByWorkspaceMemberId?: UUID
  createdByActorId?: UUID
  createdBySessionId?: UUID
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

// ============ Audit ============
export type AuditAction =
  | "user.register"
  | "user.login"
  | "workspace.create"
  | "workspace.update"
  | "workspace.delete"
  | "actor.create"
  | "actor.update"
  | "actor.delete"
  | "work_item.create"
  | "work_item.transition"
  | "work_item.assign"
  | "message.create"
  | "memory.create"
  | "memory.update"
  | "memory.delete"
  | "ai.think"
  | "ai.action"
  | "automation_rule.create"
  | "automation_rule.update"
  | "automation_rule.delete"
  | "automation_rule.pause"
  | "automation_rule.trigger"
  | "automation_event_source.create"
  | "automation_event_source.update"
  | "automation_event_source.archive"
  | "automation_event_source.trigger"

export interface AuditLog {
  id: UUID
  workspaceId?: UUID
  userId?: UUID
  actorId?: UUID
  action: AuditAction
  resourceType: string
  resourceId?: UUID
  details: Record<string, unknown>
  ipAddress?: string
  createdAt: Timestamp
}

// ============ Events ============
export type EventType =
  | "work_item.created"
  | "work_item.updated"
  | "work_item.transitioned"
  | "message.created"
  | "actor.created"
  | "actor.updated"
  | "memory.created"
  | "actor.thinking"
  | "actor.action"
  | "chat.sync.event"
  | "runtime.updated"
  | "mcp.config.changed"
  | "chat.typing"

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
export type ActorRuntimeHealth = "ok" | "error"
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
  activePlanApprovalInteractionId?: UUID
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

export type ActorRuntimeToolKind = "system" | "plugin" | "device"

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
  kind: "system" | "plugin" | "device"
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
  titlePresentation?: import("@synapse/device-protocol/tool-presentation").PresentationString
  detailPresentation?: import("@synapse/device-protocol/tool-presentation").PresentationString
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
  titlePresentation?: import("@synapse/device-protocol/tool-presentation").PresentationString
  detailPresentation?: import("@synapse/device-protocol/tool-presentation").PresentationString
  resultSummary?: import("@synapse/device-protocol/tool-presentation").PresentationString
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

export type RemoteAgentRuntimeKind = (typeof REMOTE_AGENT_RUNTIME_KINDS)[number]
export type RemoteAgentRuntimeStateType =
  (typeof REMOTE_AGENT_RUNTIME_STATES)[number]
export type RemoteAgentRuntimeCatalogStatus =
  (typeof REMOTE_AGENT_RUNTIME_CATALOG_STATUSES)[number]
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
  activeInteractionId?: UUID
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
  trustLevel?: string
}

export interface RelationshipActorSummaryView {
  workspace: RelationshipWorkspaceSummary
  actorId: UUID
  displayName: string
  title: string
  role: string
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
  memberId?: UUID
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
}

export interface ConversationSummaryView {
  id: UUID
  kind: (typeof CONVERSATION_KINDS)[number]
  isIm: boolean
  status: "active" | "completed"
  transportKind?: string
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
  activeInteractionId?: UUID
  pendingConversationCount: number
  unreadDeliveryCount: number
  lastActivityAt?: Timestamp
  lastRunStartedAt?: Timestamp
  lastRunFinishedAt?: Timestamp
  lastError?: string
  capabilities?: RemoteAgentRuntimeCapabilityView
}

export interface RemoteAgentGroupInteractionGrantView {
  workspaceMemberId: UUID
  grantedByWorkspaceMemberId?: UUID
  createdAt?: Timestamp
  updatedAt?: Timestamp
  userId: UUID
  name: string
  avatarUrl?: string
}

export interface RemoteAgentBindingView {
  machineId: UUID
  machineTitle?: string
  status: string
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
  bindingCount: number
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
    status: string
    runtimeSummary?: RemoteAgentRuntimeSummaryView
  }>
}

export interface OneClickInstallCommands {
  unix: string
  windows: string
}

export interface RemoteAgentMachinePairingSessionView {
  machine: Omit<RemoteAgentMachineView, "bindingCount">
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
  type: "web_search" | "web_fetch"
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
  grantedByWorkspaceMemberId?: UUID | null
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

export type AnthropicBuiltinTool = "web_search" | "web_fetch"

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
  apiStyle?: "chat" | "responses"
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
export type FileStorageBackend = (typeof FILE_STORAGE_BACKENDS)[number]
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
export type PlatformAssetFileOriginSystem =
  (typeof PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS)[number]
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

export const ACTOR_DOC_TEMPLATES: ActorDocTemplate[] = [
  {
    key: "identity_card",
    title: "Identity Card",
    description: "How this actor introduces themselves in public.",
    defaultVisibility: "always",
    defaultPriority: 120,
  },
  {
    key: "public_persona",
    title: "Public Persona",
    description: "Voice, tone, and how this actor appears to others.",
    defaultVisibility: "always",
    defaultPriority: 115,
  },
  {
    key: "soul",
    title: "Soul",
    description: "Values, principles, taboos, and emotional core.",
    defaultVisibility: "always",
    defaultPriority: 110,
  },
  {
    key: "self_narrative",
    title: "Self Narrative",
    description: "How this actor understands themselves.",
    defaultVisibility: "always",
    defaultPriority: 105,
  },
  {
    key: "origin_story",
    title: "Origin Story",
    description: "Where this actor comes from and what shaped them.",
    defaultVisibility: "internal_only",
    defaultPriority: 100,
  },
  {
    key: "relationship_with_user",
    title: "Relationship With User",
    description: "How this actor relates to the human user.",
    defaultVisibility: "always",
    defaultPriority: 98,
  },
  {
    key: "relationship_with_team",
    title: "Relationship With Team",
    description: "How this actor views and works with other actors.",
    defaultVisibility: "multi_member_only",
    defaultPriority: 96,
  },
  {
    key: "representation_guidelines",
    title: "Representation Guidelines",
    description: "How to speak or act when representing the user.",
    defaultVisibility: "internal_only",
    defaultPriority: 94,
  },
  {
    key: "social_protocol",
    title: "Social Protocol",
    description: "When to speak, when to stay quiet, and what not to share.",
    defaultVisibility: "multi_member_only",
    defaultPriority: 92,
  },
  {
    key: "role_charter",
    title: "Role Charter",
    description: "Organizational responsibilities and scope.",
    defaultVisibility: "always",
    defaultPriority: 90,
  },
  {
    key: "mission",
    title: "Mission",
    description: "Long-term aim, current mission, and success criteria.",
    defaultVisibility: "always",
    defaultPriority: 88,
  },
  {
    key: "work_doctrine",
    title: "Work Doctrine",
    description: "How this actor approaches work, evidence, and communication.",
    defaultVisibility: "always",
    defaultPriority: 86,
  },
  {
    key: "limitations_and_escalation",
    title: "Limitations And Escalation",
    description: "Blind spots, refusal zones, and when to ask for help.",
    defaultVisibility: "always",
    defaultPriority: 84,
  },
  {
    key: "quirks_and_signatures",
    title: "Quirks And Signatures",
    description: "Habits, running jokes, signatures, and expressive details.",
    defaultVisibility: "always",
    defaultPriority: 82,
  },
  {
    key: "routines",
    title: "Routines",
    description: "Recurring habits, checks, and proactive rhythms.",
    defaultVisibility: "internal_only",
    defaultPriority: 80,
  },
  {
    key: "conversation_examples",
    title: "Conversation Examples",
    description:
      "Examples of how this actor speaks, declines, or collaborates.",
    defaultVisibility: "internal_only",
    defaultPriority: 78,
  },
]

export const ACTOR_DOC_TEMPLATE_MAP: Record<CoreActorDocKey, ActorDocTemplate> =
  Object.fromEntries(
    ACTOR_DOC_TEMPLATES.map((template) => [template.key, template])
  ) as Record<CoreActorDocKey, ActorDocTemplate>

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
      kind: "device"
      deviceToolId: string
      exposureStableKey: string
      deviceName?: string
      visibleToolName?: string
    }
  | { kind: "provider_native"; providerType: ProviderType; toolName: string }
  | {
      kind: "model_response"
      providerType: ProviderType
    }

export const TOOL_RESULT_ORIGIN_KINDS = [
  "system",
  "plugin",
  "device",
  "provider_native",
  "model_response",
] as const
export type ToolResultOriginKind = (typeof TOOL_RESULT_ORIGIN_KINDS)[number]

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
  | "none"
  | "all_members"
  | "users_only"
  | "actors_only"
  | "targeted_members"
export type ConversationEventContextPolicy =
  | "none"
  | "shared"
  | "actor_private"
  | "targeted_members"

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
  | "chat.message"
  | "user"
  | "assistant"
  | "system"
  | "tool_result"
  | "model_error_notice"

export type ConversationFeedMessageType = ConversationMessageSubtype | "summary"

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
  createdAt?: string
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
  // boundary). See docs/tool-provenance-and-routing.md.
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
  // Needed so that member-scoped workspace_app_grants become visible to the
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
  sourceType?: "builtin" | "mcp_plugin" | "device_capability"
}

export interface ToolSurfaceItem {
  id: string
  name: string
  source: "builtin" | "plugin_installation" | "device_capability"
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
  presentation?: import("@synapse/device-protocol/tool-presentation").ToolPresentationDescriptor
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

export type MarketplaceItemKind = "plugin" | "skill" | "actor" | "model"
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
export type PluginAttachmentScopeType =
  (typeof PLUGIN_ATTACHMENT_SCOPE_TYPES)[number]
export type AccessTargetType = (typeof ACCESS_TARGET_TYPES)[number]
export type CapabilityAccessTargetType =
  (typeof CAPABILITY_ACCESS_TARGET_TYPES)[number]
export type ReuseScope = (typeof REUSE_SCOPES)[number]
export type MarketplaceSourceType =
  | "builtin"
  | "official"
  | "workspace_upload"
  | "user_upload"
export type MarketplaceLineageKind = "installed_copy" | "fork" | "share"
export type MarketplaceSyncMode =
  | "notify"
  | "manual_merge"
  | "follow_upstream"
  | "detached"
export type MarketplaceRequirementKind =
  | "required"
  | "recommended"
  | "optional"
  | "conflicts_with"
export type MarketplaceRequirementTargetKind = "package" | "tag"
export type PluginInstallationMode =
  | "manual"
  | "seeded"
  | "package_required"
  | "package_recommended"
export type MarketplaceVersionStatus =
  | "draft"
  | "active"
  | "deprecated"
  | "archived"
export type AutomationEventSourceAccessGrantStatus = "active" | "revoked"
export type MarketplaceRequirementStatus =
  | "satisfied"
  | "missing_required"
  | "missing_recommended"
  | "scope_mismatch"
  | "config_incomplete"
export type MarketplaceAssetKind =
  | "skill_markdown"
  | "reference_markdown"
  | "script"
  | "json"
  | "text"
  | "binary"
export type LocalizedText = Record<string, string>
export type PluginConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "secret"
  | "auth_connection"
  | "file"
export type PluginInstallStepKind =
  | "form"
  | "auth"
  | "check"
  | "confirm"
  | "attachment_scope"
  | "reuse_scope"
  | "integration_events"
export type PluginInstallActionKind = "auth_start" | "external_link" | "noop"
export type PluginAuthBindingDriverKind =
  | "oauth2_authorization_code_pkce"
  | "mijia_qr_login"
  | "feishu_cli_setup"
export type PluginAuthSessionStatus =
  (typeof PLUGIN_AUTH_SESSION_STATUSES)[number]
export type PluginAuthConnectionStatus =
  (typeof PLUGIN_AUTH_CONNECTION_STATUSES)[number]
export type PluginAuthSessionPhase =
  | "awaiting_start"
  | "awaiting_external_input"
  | "awaiting_callback"
  | "pending_scan"
  | "pending_confirm"
  | "finalizing"
export type PluginAuthChallengeKind = "redirect" | "qr_code" | "none"

export interface PluginAttachmentScope {
  type: PluginAttachmentScopeType
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
}

// AccessTarget / CapabilityAccessTarget are canonical scoped-subject payloads:
// {subject: SubjectRef; scope?: SubjectRef}. Conversation scoping is represented
// by `scope`, not by flat target strings.
export type AccessTarget = ScopedSubjectTarget
export type CapabilityAccessTarget = ScopedSubjectTarget

export interface PluginAuthValueSource {
  source: "config" | "env" | "literal" | "derived"
  field?: string
  env?: string
  value?: unknown
  name?: "app_base_url" | "oauth_callback_url"
}

export interface PluginConfigFieldOption {
  value: string
  labelI18n: LocalizedText
  descriptionI18n?: LocalizedText
}

export interface PluginConfigFieldDefinition {
  key: string
  type: PluginConfigFieldType
  titleI18n: LocalizedText
  descriptionI18n?: LocalizedText
  placeholderI18n?: LocalizedText
  required?: boolean
  defaultValue?: unknown
  options?: PluginConfigFieldOption[]
  secret?: boolean
  serverManaged?: boolean
  authBindingKey?: string
  validation?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface PluginInstallAction {
  kind: PluginInstallActionKind
  bindingKey?: string
  url?: string
  buttonLabelI18n?: LocalizedText
  metadata?: Record<string, unknown>
}

export interface PluginInstallStep {
  id: string
  kind: PluginInstallStepKind
  titleI18n: LocalizedText
  descriptionI18n?: LocalizedText
  scope: "workspace" | "plugin"
  fields: string[]
  optional?: boolean
  helpUrl?: string
  helpTextI18n?: LocalizedText
  action?: PluginInstallAction
  metadata?: Record<string, unknown>
}

export interface PluginInstallFlow {
  steps: PluginInstallStep[]
}

export interface PluginAuthChallenge {
  kind: PluginAuthChallengeKind
  url?: string
  qrUrl?: string
  openMode?: "popup" | "replace"
  expiresAt?: string
  metadata?: Record<string, unknown>
}

export interface PluginAuthBindingDefinition {
  key: string
  driver: PluginAuthBindingDriverKind
  fieldKey: string
  displayNameI18n: LocalizedText
  descriptionI18n?: LocalizedText
  prerequisiteFields?: string[]
  authorizeUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  scopes?: string[]
  audience?: string
  extraAuthorizeParams?: Record<string, string>
  extraTokenParams?: Record<string, string>
  profileIdPath?: string
  profileDisplayNamePath?: string
  profileAvatarUrlPath?: string
  reusable?: boolean
  inputs?: Record<string, PluginAuthValueSource>
  metadata?: Record<string, unknown>
}

export interface PluginConfigFieldState {
  key: string
  isConfigured: boolean
  maskedValue?: string
  authConnectionId?: string
  accountDisplayName?: string
  updatedAt?: string
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
  createdAt: string
  updatedAt: string
}

export interface MarketplaceLineage {
  downstreamPackageId: string
  upstreamPackageId: string
  upstreamRevisionId?: string
  lineageKind: MarketplaceLineageKind
  syncMode: MarketplaceSyncMode
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
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
  createdAt: string
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
  transport?: PluginTransport
  entryPoint?: string
  toolsManifest: MarketplaceTool[]
  validationRules: McpValidationRule[]
  setupSteps: PluginInstallStep[]
  installFlow?: PluginInstallFlow
  authBindings: PluginAuthBindingDefinition[]
  metadata: Record<string, unknown>
  createdByUserId?: string
  createdAt: string
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
  defaultAttachmentScope?: PluginAttachmentScopeType
  defaultReuseScope?: ReuseScope
  defaultConversationTypeMask?: ConversationTypeMask
  supportedReuseScopes?: ReuseScope[]
  defaultIdleTtlMs?: number
  defaultMaxAgeMs?: number
  requiresHandshake: boolean
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
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
  attachmentScope: PluginAttachmentScope
  accessTarget: CapabilityAccessTarget
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
  createdAt: string
  updatedAt: string
  package?: MarketplaceItem
  revision?: MarketplaceVersion
}

export interface AutomationEventSourceAccessGrant {
  id: string
  resourceId: string
  workspaceId: string
  target: CapabilityAccessTarget
  status: AutomationEventSourceAccessGrantStatus
  grantedByWorkspaceMemberId?: string
  reason?: string
  conversationTypeMaskOverride?: ConversationTypeMask | null
  effectiveConversationTypeMask?: ConversationTypeMask
  createdAt: string
  revokedAt?: string
}

export interface WorkspaceAppView {
  id: string
  workspaceId: string
  kind: WorkspaceAppKind
  displayName: string
  ownerWorkspaceMemberId?: string
  status: WorkspaceAppStatus
  sourceDefaultConversationTypeMask?: ConversationTypeMask
  workspaceConversationTypeMask?: ConversationTypeMask
  conversationTypeMaskOverride?: ConversationTypeMask
  effectiveConversationTypeMask?: ConversationTypeMask
  createdAt: string
  updatedAt: string
}

export interface WorkspaceAppGrant {
  id: string
  workspaceId: string
  workspaceAppId: string
  target: CapabilityAccessTarget
  permissions: WorkspaceAppGrantPermission[]
  status: WorkspaceAppGrantStatus
  source: WorkspaceAppGrantSource
  grantedByWorkspaceMemberId?: string
  reason?: string
  conversationTypeMaskOverride?: ConversationTypeMask | null
  effectiveConversationTypeMask?: ConversationTypeMask
  createdAt: string
  revokedAt?: string
}

export interface WorkspaceAppGrantRequest {
  id: string
  workspaceId: string
  workspaceAppId: string
  grantee: CapabilityAccessTarget
  requestedPermissions: WorkspaceAppGrantPermission[]
  requesterWorkspaceMemberId: string
  status: WorkspaceAppGrantRequestStatus
  resolvedByWorkspaceMemberId?: string
  resolvedAt?: string
  reason?: string
  createdAt: string
  updatedAt: string
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
  expiresAt: string
  createdAt: string
  updatedAt: string
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
  expiresAt?: string
  publicPayload: Record<string, unknown>
  createdAt: string
  updatedAt: string
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
  acceptableAttachmentScopes: PluginAttachmentScopeType[]
  acceptableReuseScopes: ReuseScope[]
  description: string
  configPredicate: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: string
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
  attachmentScope: PluginAttachmentScope
  defaultAccessTarget: CapabilityAccessTarget
  checks: MarketplaceRequirementCheck[]
  grantPlan?: {
    requiresGrant: boolean
    requiredPermissions: string[]
    suggestedAccessTargetType?: CapabilityAccessTargetType
    reason?: string
  }
}

export type ActorPackageDependencyKind = Extract<
  MarketplaceRequirementKind,
  "required" | "recommended"
>
export type ActorPackageTargetKind = Extract<
  MarketplaceItemKind,
  "plugin" | "skill"
>
export type ActorPackageSyncMode = "notify" | "manual_merge"
export type ActorPackageLinkStatus =
  | "up_to_date"
  | "update_available"
  | "diverged"
  | "update_available_with_local_changes"
  | "detached"

export interface ActorPackageDependency {
  requirementId?: string
  requirementKind: ActorPackageDependencyKind
  targetPackageKind: ActorPackageTargetKind
  targetPublisherSlug?: string
  targetPackageSlug: string
  acceptableAttachmentScopes: PluginAttachmentScopeType[]
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

export type SkillSourceType = "github" | "clawhub"
export type SkillMirrorRefreshMode = "manual"
export type SkillMirrorSyncStatus = "pending" | "synced" | "error"
export type SkillFrontmatterEffort = "low" | "medium" | "high" | "max"
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
  lastSyncedAt?: string
  createdAt: string
  updatedAt: string
}

export interface SkillAttachmentFile {
  id: string
  path: string
  mediaType?: string
  contentBlocks: CanonicalContentBlock[]
  createdAt: string
  updatedAt: string
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
  createdAt: string
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
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
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
export type McpAttachmentScopeType = PluginAttachmentScopeType

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
  createdAt: string
  updatedAt: string
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
  createdAt: string
}

export interface McpEventLog {
  id: string
  workspaceId?: string
  userId?: string
  pluginId?: string
  deviceId?: string
  eventType: string
  eventData: Record<string, unknown>
  createdAt: string
}

export interface McpValidationRule {
  field: string
  rule:
    | "required"
    | "pattern"
    | "url"
    | "min_length"
    | "max_length"
    | "prefix"
    | "enum"
  value?: string | number | string[]
  message: string
}

export interface McpSetupStep {
  id: string
  kind?: PluginInstallStepKind
  title?: string
  titleI18n?: LocalizedText
  description?: string
  descriptionI18n?: LocalizedText
  scope: "workspace" | "plugin"
  fields: string[]
  optional?: boolean
  helpUrl?: string
  helpText?: string
  helpTextI18n?: LocalizedText
  action?: PluginInstallAction
  metadata?: Record<string, unknown>
}

export type ConversationParticipantType =
  (typeof CONVERSATION_PARTICIPANT_TYPES)[number]

export type TransportKind = (typeof TRANSPORT_KINDS)[number]

/**
 * Runtime guard for `TransportKind`. Use instead of hard-coding
 * `value === "feishu" || value === "weixin"` chains in dispatch sites —
 * those drift out of sync when new transports land.
 */
export function isTransportKind(value: unknown): value is TransportKind {
  return (
    typeof value === "string" &&
    (TRANSPORT_KINDS as readonly string[]).includes(value)
  )
}

/**
 * Static fallback label for a `TransportKind`. Intentionally NOT
 * exhaustiveness-checked: adding a new transport must not require
 * editing this file. The authoritative display name is on
 * `TransportConnectorCapability.displayName`; this helper only fires
 * when the metadata provider hasn't mounted yet (client) or no
 * connector is registered (server-side prose).
 */
export function describeTransportKind(kind: TransportKind): string {
  switch (kind) {
    case "feishu":
      return "Feishu"
    case "weixin":
      return "WeChat"
    case "wecom":
      return "WeCom"
    default:
      return String(kind)
  }
}

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
  subtype: string
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
   * Public asset path for this connector's icon (served from
   * `web-next/public`). Centralized so frontend doesn't hard-code
   * `/icon/${kind}.svg` and per-kind UI variants don't drift apart.
   */
  iconAssetPath: string
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

export type WeixinQrLoginStatus =
  | "waiting"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error"

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
  | "waiting"
  | "success"
  | "fail"
  | "expired"

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
  direction: "inbound" | "outbound"
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
  direction: "inbound" | "outbound"
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
  direction: "inbound" | "outbound"
  deliveryStatus: TransportDeliveryStatus
  endpointType?: TransportEndpointType
  endpointExternalId?: string
  endpointDisplayName?: string
  externalMessageId?: string
  deliveredAt?: Timestamp
  metadata: Record<string, unknown>
}

export type InteractionRequestKind = (typeof INTERACTION_REQUEST_KINDS)[number]
export type TargetedInteractionRequestKind =
  (typeof TARGETED_INTERACTION_REQUEST_KINDS)[number]

export type InteractionRequestStatus =
  (typeof INTERACTION_REQUEST_STATUSES)[number]

export function isInteractionRequestKind(
  value: unknown
): value is InteractionRequestKind {
  return (
    typeof value === "string" &&
    (INTERACTION_REQUEST_KINDS as readonly string[]).includes(value)
  )
}

export function isTargetedInteractionKind(
  value: unknown
): value is TargetedInteractionRequestKind {
  return (
    typeof value === "string" &&
    (TARGETED_INTERACTION_REQUEST_KINDS as readonly string[]).includes(value)
  )
}

export interface InteractionInputOption {
  id: string
  label: string
  description?: string
  preview?: string
}

export type InteractionInputQuestionType =
  (typeof INTERACTION_INPUT_QUESTION_TYPES)[number]

export interface InteractionInputQuestionDefinition {
  id: string
  header: string
  type: InteractionInputQuestionType
  prompt: string
  description?: string
  required?: boolean
  options?: InteractionInputOption[]
  allowOther?: boolean
  placeholder?: string
  minSelections?: number
  maxSelections?: number
  secret?: boolean
}

export interface InteractionInputAnswer {
  questionId: string
  selectedOptionIds?: string[]
  selectedOptionLabels?: string[]
  otherText?: string
  text?: string
}

export interface InteractionInputQuestionSummary extends InteractionInputQuestionDefinition {
  required: boolean
  answer?: InteractionInputAnswer
}

export interface UserInputInteractionSummary {
  title: string
  instructions?: string
  questions: InteractionInputQuestionSummary[]
}

export interface PlanApprovalInteractionSummary {
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
}

export type InteractionDecision = (typeof INTERACTION_DECISIONS)[number]
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
}

// subject-scope-refactor: SharedRuntimeAuthorizationGrantSpec (camelCase) is the
// API-side policy payload type. Wire-side snake_case spec is
// `RuntimeAuthorizationGrantWireSpec` in @synapse/device-protocol; API code
// MUST import the explicit alias rather than the deprecated bare
// `RuntimeAuthorizationGrantSpec` (which once doubled as both).
// P4: derived from the Zod GrantPolicySchema (see packages/shared/src/access/policies).
export type SharedRuntimeAuthorizationGrantSpec = GrantPolicyBase
/** @deprecated Use SharedRuntimeAuthorizationGrantSpec (camelCase, API side) or
 * RuntimeAuthorizationGrantWireSpec (snake_case, wire side from
 * @synapse/device-protocol) to disambiguate. */
export type RuntimeAuthorizationGrantSpec = SharedRuntimeAuthorizationGrantSpec

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
  deviceId: UUID
  deviceCapabilityId: UUID
  exposureId: UUID
}

export interface RuntimeAuthorizationInteractionSummary {
  requestedToolName: string
  deviceToolStableKey: string
  requestedAction: RuntimeAuthorizationRequestedAction
  reason: string
  deviceId: UUID
  deviceDisplayName: string
  deviceCapabilityId: UUID
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
   * dedupe branch. Optional because historical rows may not have one and
   * non-runtime-authorization summaries don't materialize this field.
   */
  sourceRetryNonce?: string
}

export interface TaskSummaryBase {
  id: UUID
  taskId?: UUID
  remoteAgentRunId?: UUID
  workspaceId: UUID
  conversationId: UUID
  itemId?: UUID
  status: InteractionRequestStatus
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
  userInput: UserInputInteractionSummary
  planApproval?: never
  runtimeAuthorization?: never
}

export interface PlanApprovalTaskSummary extends TaskSummaryBase {
  kind: "plan_approval"
  target?: ConversationEntityRef
  userInput?: never
  planApproval: PlanApprovalInteractionSummary
  runtimeAuthorization?: never
}

export interface RuntimeAuthorizationTaskSummary extends TaskSummaryBase {
  kind: "runtime_authorization"
  target?: never
  userInput?: never
  planApproval?: never
  runtimeAuthorization: RuntimeAuthorizationInteractionSummary
}

/**
 * The human-facing projection of a Task that needs a response (task unification).
 * Carries the kind-specific request payload the FE card renders from. `status`
 * is the legacy interaction vocabulary, reverse-projected from the task's
 * lifecycle_status ⟂ outcome on the API side.
 */
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
  | "participant_joined"
  | "participant_kicked"
  | "participant_left"
  | "memory_saved"
  | "memory_updated"
  | "actor_renamed"
  | "actor_avatar_changed"
  | "automation_notice"
  | "task_requested"
  | "task_notice"

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

function formatConversationEntityName(
  entity: Partial<ConversationEntityRef> | undefined,
  fallback: string
) {
  const name = typeof entity?.name === "string" ? entity.name.trim() : ""
  return name || fallback
}

function formatConversationEntityList(
  entities: Array<Partial<ConversationEntityRef> | undefined>,
  fallback = "Unknown"
) {
  const names = entities
    .map((entity) => formatConversationEntityName(entity, fallback))
    .filter(Boolean)
  if (names.length === 0) return fallback
  if (names.length === 1) return names[0]!
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
}

function summarizeParticipantEvent(
  eventType: Extract<
    ConversationFeedEventType,
    "participant_joined" | "participant_kicked" | "participant_left"
  >,
  payload:
    | ConversationFeedEventPayloadMap["participant_joined"]
    | ConversationFeedEventPayloadMap["participant_kicked"]
    | ConversationFeedEventPayloadMap["participant_left"]
) {
  const initiator = payload.initiator
  const participants = Array.isArray(payload.participants)
    ? payload.participants
    : []
  const initiatorName = formatConversationEntityName(initiator, "")
  const initiatorParticipantId = initiator?.participantId
  const participantList = formatConversationEntityList(participants)
  const nonInitiatorParticipants = initiatorParticipantId
    ? participants.filter(
        (participant) => participant.participantId !== initiatorParticipantId
      )
    : participants

  if (eventType === "participant_joined") {
    if (initiatorName) {
      if (
        initiatorParticipantId &&
        participants.some(
          (participant) => participant.participantId === initiatorParticipantId
        )
      ) {
        if (nonInitiatorParticipants.length === 0) {
          return `${initiatorName} joined the conversation`
        }
        return `${initiatorName} started the conversation with ${formatConversationEntityList(nonInitiatorParticipants)}`
      }
      return `${initiatorName} invited ${participantList} to the conversation`
    }
    return `${participantList} joined the conversation`
  }

  if (eventType === "participant_kicked") {
    if (initiatorName) {
      return `${initiatorName} removed ${participantList} from the conversation`
    }
    return `${participantList} was removed from the conversation`
  }

  if (initiatorName && initiatorParticipantId && participants.length === 1) {
    const leavingParticipant = participants[0]
    if (
      leavingParticipant &&
      leavingParticipant.participantId === initiatorParticipantId
    ) {
      return `${initiatorName} left the conversation`
    }
  }
  return `${participantList} left the conversation`
}

export function summarizeConversationEvent(
  eventType: ConversationFeedEventType | string,
  payload: unknown
) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {}

  if (eventType === "participant_joined") {
    return summarizeParticipantEvent(
      "participant_joined",
      eventPayload as ConversationFeedEventPayloadMap["participant_joined"]
    )
  }

  if (eventType === "participant_kicked") {
    return summarizeParticipantEvent(
      "participant_kicked",
      eventPayload as ConversationFeedEventPayloadMap["participant_kicked"]
    )
  }

  if (eventType === "participant_left") {
    return summarizeParticipantEvent(
      "participant_left",
      eventPayload as ConversationFeedEventPayloadMap["participant_left"]
    )
  }

  if (eventType === "memory_saved" || eventType === "memory_updated") {
    const textDigest =
      typeof eventPayload.textDigest === "string"
        ? eventPayload.textDigest.trim()
        : ""
    const scope =
      typeof eventPayload.memorySpaceType === "string"
        ? eventPayload.memorySpaceType
        : typeof eventPayload.memoryScope === "string"
          ? eventPayload.memoryScope
          : "memory"
    const actionLabel = eventType === "memory_updated" ? "updated" : "saved"
    const summary = textDigest || "durable memory saved"
    return `Memory ${actionLabel}: ${summary} (${scope})`
  }

  if (eventType === "actor_renamed") {
    const newName =
      typeof eventPayload.newName === "string"
        ? eventPayload.newName.trim()
        : "Unknown"
    return `Actor renamed: will now be called ${newName}.`
  }

  if (eventType === "actor_avatar_changed") {
    const avatarEmoji =
      typeof eventPayload.newAvatarEmoji === "string"
        ? eventPayload.newAvatarEmoji.trim()
        : ""
    if (avatarEmoji) {
      return `Actor avatar updated to ${avatarEmoji}.`
    }
    return "Actor avatar updated."
  }

  if (eventType === "automation_notice") {
    const messageBlocks = Array.isArray(eventPayload.messageBlocks)
      ? (eventPayload.messageBlocks as CanonicalContentBlock[])
      : []
    const messageFromBlocks = extractText(messageBlocks).trim()
    const message =
      messageFromBlocks ||
      (typeof eventPayload.message === "string"
        ? eventPayload.message.trim()
        : "")
    if (message) return message
    const sourceTitle =
      typeof eventPayload.sourceTitle === "string"
        ? eventPayload.sourceTitle.trim()
        : ""
    const sourceSummary =
      typeof eventPayload.sourceSummary === "string"
        ? eventPayload.sourceSummary.trim()
        : ""
    if (sourceTitle && sourceSummary) {
      return `${sourceTitle}: ${sourceSummary}`
    }
    if (sourceTitle) return sourceTitle
    if (sourceSummary) return sourceSummary
    const sourceLabel =
      typeof eventPayload.sourceLabel === "string"
        ? eventPayload.sourceLabel.trim()
        : ""
    if (sourceLabel) return sourceLabel
    return "Automation notice"
  }

  if (eventType === "task_notice") {
    const summary =
      typeof eventPayload.summary === "string"
        ? eventPayload.summary.trim()
        : ""
    if (summary) return summary
    const toolName =
      typeof eventPayload.toolName === "string"
        ? eventPayload.toolName.trim()
        : "tool"
    const status =
      typeof eventPayload.status === "string"
        ? eventPayload.status.trim()
        : "completed"
    return `${toolName} ${status}`
  }

  if (eventType === "task_requested") {
    const interaction =
      eventPayload.task && typeof eventPayload.task === "object"
        ? (eventPayload.task as TaskSummary)
        : undefined
    if (!interaction) {
      return "Task requested"
    }
    if (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
      const targetName =
        interaction.target?.name?.trim() ||
        (interaction.requester?.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
          ? "the group"
          : "a user")
      const prompt = interaction.userInput?.title?.trim() || "A question"
      if (interaction.status === "cancelled") {
        return `Input request for ${targetName} was cancelled: ${prompt}`
      }
      return interaction.status === "answered"
        ? `${targetName} answered: ${prompt}`
        : `Input requested from ${targetName}: ${prompt}`
    }
    if (interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
      const targetName =
        interaction.target?.name?.trim() ||
        (interaction.requester?.participantType ===
        CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT
          ? "the group"
          : "a user")
      const title = interaction.planApproval?.title?.trim() || "Plan approval"
      if (interaction.status === "cancelled") {
        return `Plan approval for ${targetName} was cancelled: ${title}`
      }
      if (interaction.status === "approved") {
        return `${targetName} approved: ${title}`
      }
      if (interaction.status === "rejected") {
        return `${targetName} requested changes: ${title}`
      }
      return `Plan approval requested from ${targetName}: ${title}`
    }
    const deviceName =
      interaction.runtimeAuthorization?.deviceDisplayName?.trim() || "device"
    if (interaction.status === "cancelled") {
      return `Runtime authorization request was cancelled for ${deviceName}`
    }
    if (interaction.status === "rejected") {
      const resolverName = interaction.resolvedBy?.name?.trim() || "A user"
      return `${resolverName} rejected access for ${deviceName}`
    }
    if (interaction.status === "approved") {
      const resolverName = interaction.resolvedBy?.name?.trim() || "A user"
      return `${resolverName} approved access for ${deviceName}`
    }
    if (interaction.status === "superseded") {
      return `Runtime authorization request was superseded for ${deviceName}`
    }
    return `Runtime authorization requested for ${deviceName}`
  }

  return `[Event: ${eventType}]`
}

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
  sessionStatus?: string
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
  itemType: "message" | "summary" | "control"
  subtype: ConversationFeedMessageType
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
  status: "active" | "completed"
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
    subtype: string
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
    selfState: "active" | "removed" | "left"
    reason?: "kicked" | "left" | "added"
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

export interface ChatBootstrapResponse {
  workspaceMemberId: UUID
  clientInstanceRequired: true
  conversations: ChatConversationView[]
  nextInboxCursor: number
}

export interface ChatSyncResponse {
  events: ChatSyncEvent[]
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

export interface ChatInteractionAnswerInput {
  questionId: string
  selectedOptionIds?: string[]
  otherText?: string
  text?: string
}

export interface ChatInteractionResolveCommandMetadata {
  commandId: UUID
  baseRevision: number
}

export interface ChatInteractionResolveUserInputPayload {
  answers: ChatInteractionAnswerInput[]
  decision?: never
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export interface ChatInteractionResolvePlanApprovalPayload {
  answers?: never
  decision: "approve" | "revise"
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export interface ChatInteractionResolveRuntimeAuthorizationApprovePayload {
  answers?: never
  decision: "approve"
  preset: RuntimeAuthorizationPreset
  selectedGrantOptionId: string
  note?: string
}

export interface ChatInteractionResolveRuntimeAuthorizationRejectPayload {
  answers?: never
  decision: "reject"
  preset?: never
  selectedGrantOptionId?: never
  note?: string
}

export type ChatInteractionResolvePayload =
  | ChatInteractionResolveUserInputPayload
  | ChatInteractionResolvePlanApprovalPayload
  | ChatInteractionResolveRuntimeAuthorizationApprovePayload
  | ChatInteractionResolveRuntimeAuthorizationRejectPayload

export type ChatInteractionResolveInput =
  ChatInteractionResolveCommandMetadata & ChatInteractionResolvePayload

export type ChatInteractionResolveOutcome = "applied" | "duplicate" | "conflict"

export interface ChatInteractionResolveAppliedResponse {
  outcome: "applied" | "duplicate"
  interaction: TaskSummary
}

export interface ChatInteractionResolveConflictResponse {
  outcome: "conflict"
  code: "interaction_conflict"
  error: string
  interaction: TaskSummary
}

export type ChatInteractionResolveResponse =
  | ChatInteractionResolveAppliedResponse
  | ChatInteractionResolveConflictResponse

export function isChatInteractionResolveConflictResponse(
  value: unknown
): value is ChatInteractionResolveConflictResponse {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { outcome?: unknown }).outcome === "conflict" &&
    (value as { code?: unknown }).code === "interaction_conflict" &&
    typeof (value as { error?: unknown }).error === "string" &&
    (value as { interaction?: unknown }).interaction &&
    typeof (value as { interaction?: unknown }).interaction === "object"
  )
}

export type RealtimeAsrAudioFormat = "pcm" | "ogg"
export type RealtimeAsrAudioCodec = "raw" | "opus"

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

// ============ Content Helpers ============

export function createCanonicalContentBlockId(_prefix = "block"): UUID {
  // crypto.randomUUID is available in every runtime this ships to. The prefix
  // arg is retained for call-site readability but no longer affects the id (a
  // real UUID has no prefix); it previously only fed a Math.random fallback.
  return globalThis.crypto.randomUUID()
}

export function textBlock(text: string, id?: UUID): CanonicalTextBlock {
  return {
    id:
      typeof id === "string" && id.trim().length > 0
        ? id
        : createCanonicalContentBlockId("text"),
    type: "text",
    text,
  }
}

export function fileRefBlock(
  input: Omit<CanonicalFileRefBlock, "id" | "type"> & { id?: UUID }
): CanonicalFileRefBlock {
  return {
    id:
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : createCanonicalContentBlockId("file"),
    type: "file_ref",
    sha256: input.sha256,
    ...(input.path !== undefined ? { path: input.path } : {}),
    mimeType: input.mimeType,
    name: input.name,
    sizeBytes: input.sizeBytes,
    category: input.category,
  }
}

export function mentionBlock(
  input: Omit<CanonicalMentionBlock, "id" | "type"> & { id?: UUID }
): CanonicalMentionBlock {
  return {
    id:
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : createCanonicalContentBlockId("mention"),
    type: "mention",
    mention: input.mention,
  }
}

function normalizeContentBlockSizeBytes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function isConversationEntityRef(
  value: unknown
): value is ConversationEntityRef {
  if (!value || typeof value !== "object") return false
  const entity = value as Record<string, unknown>
  return (
    typeof entity.participantType === "string" &&
    entity.participantType.trim().length > 0 &&
    (entity.participantId === undefined ||
      typeof entity.participantId === "string") &&
    (entity.workspaceMemberId === undefined ||
      typeof entity.workspaceMemberId === "string") &&
    (entity.actorId === undefined || typeof entity.actorId === "string") &&
    (entity.userId === undefined || typeof entity.userId === "string") &&
    (entity.externalUserKey === undefined ||
      typeof entity.externalUserKey === "string") &&
    (entity.transportAddressId === undefined ||
      typeof entity.transportAddressId === "string") &&
    (entity.transportKind === undefined ||
      isTransportKind(entity.transportKind)) &&
    (entity.name === undefined || typeof entity.name === "string") &&
    (entity.title === undefined || typeof entity.title === "string") &&
    (entity.role === undefined || typeof entity.role === "string") &&
    (entity.avatarUrl === undefined || typeof entity.avatarUrl === "string") &&
    (entity.avatarEmoji === undefined || typeof entity.avatarEmoji === "string")
  )
}

export function formatMentionText(block: CanonicalMentionBlock): string {
  const name = block.mention.name?.trim() || "Unknown"
  return `@${name}`
}

export function isCanonicalContentBlock(
  value: unknown
): value is CanonicalContentBlock {
  if (!value || typeof value !== "object") return false

  const block = value as Record<string, unknown>
  if (typeof block.id !== "string" || block.id.trim().length === 0) return false

  if (block.type === "text") {
    return typeof block.text === "string"
  }

  if (block.type === "file_ref") {
    const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes)
    return (
      // Redesigned FileRefBlock (file-service refactor): sha256 is the always-
      // present content identity; path is optional (present only for live
      // mounted spaces); name replaces originalName; fileId/url were dropped.
      // MUST mirror normalizeCanonicalContentBlocks' file_ref validation below,
      // else this guard (used as a strict filter in chat/event-registry.ts and
      // chat/message-content.ts) would reject every block fileRefBlock() emits.
      typeof block.sha256 === "string" &&
      (block.path === undefined || typeof block.path === "string") &&
      typeof block.mimeType === "string" &&
      typeof block.name === "string" &&
      sizeBytes !== null &&
      (block.category === "image" ||
        block.category === "audio" ||
        block.category === "video" ||
        block.category === "document")
    )
  }

  if (block.type === "mention") {
    return isConversationEntityRef(block.mention)
  }

  return false
}

export function normalizeCanonicalContentBlocks(
  blocks: CanonicalContentBlockInput[]
): CanonicalContentBlock[] {
  const normalized: CanonicalContentBlock[] = []

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue

    if (block.type === "text") {
      if (typeof block.text !== "string") continue
      normalized.push(textBlock(block.text, block.id))
      continue
    }

    if (block.type === "file_ref") {
      const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes)
      if (
        typeof block.sha256 !== "string" ||
        (block.path !== undefined && typeof block.path !== "string") ||
        typeof block.mimeType !== "string" ||
        typeof block.name !== "string" ||
        sizeBytes === null ||
        (block.category !== "image" &&
          block.category !== "audio" &&
          block.category !== "video" &&
          block.category !== "document")
      ) {
        continue
      }

      normalized.push(
        fileRefBlock({
          ...block,
          sizeBytes,
        })
      )
      continue
    }

    if (block.type === "mention") {
      if (!isConversationEntityRef(block.mention)) continue

      normalized.push(
        mentionBlock({
          id: block.id,
          mention: block.mention,
        })
      )
    }
  }

  return normalized
}

/** Wrap a plain string into CanonicalContentBlock[] */
export function textBlocks(s: string): CanonicalContentBlock[] {
  return [textBlock(s)]
}

/**
 * Convenience constructor for the common text-only CallableToolResult.
 * Equivalent to `{ content: textBlocks(text), ...opts }` but easier to read
 * in plugin handlers that return plain text plus an isError flag.
 */
export function textResult(
  text: string,
  opts?: {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
): CallableToolResult {
  const result: CallableToolResult = { content: textBlocks(text) }
  if (opts?.isError !== undefined) result.isError = opts.isError
  if (opts?.structuredContent !== undefined)
    result.structuredContent = opts.structuredContent
  if (opts?.metadata !== undefined) result.metadata = opts.metadata
  return result
}

/**
 * Format a CanonicalToolResult.structuredContent payload as an XML-tagged
 * JSON suffix suitable for inclusion in provider tool_result content.
 *
 * Returns empty string when there is nothing to emit. Otherwise wraps the
 * JSON in `<structured_content>...</structured_content>` so the LLM has a
 * clear, parseable marker around the sidecar payload (distinct from the
 * primary text output). The XML tag matches the wrapping convention
 * context-compiler.ts uses for system_notice / event items.
 *
 * Callers append this to whatever string they're about to send to the
 * provider — Anthropic appends as a tool_result content text block,
 * OpenAI / OpenAI-Responses / BigModel append as a string suffix.
 */
export function formatStructuredContentForProvider(
  structuredContent: unknown
): string {
  if (!structuredContent || typeof structuredContent !== "object") return ""
  try {
    const json = JSON.stringify(structuredContent, null, 2)
    if (!json || json === "{}" || json === "null") return ""
    return `\n\n<structured_content>\n${json}\n</structured_content>`
  } catch {
    return ""
  }
}

/**
 * Type guard for ToolResultOrigin. Validates the discriminator and the
 * required fields per kind. Use at trust boundaries (e.g., when reading
 * a metadata column from the DB) before passing to downstream code that
 * relies on origin being correctly shaped.
 */
export function isToolResultOrigin(value: unknown): value is ToolResultOrigin {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case "system":
      return typeof v.registryKey === "string"
    case "plugin":
      return (
        typeof v.installationId === "string" &&
        typeof v.upstreamToolName === "string"
      )
    case "device":
      return (
        typeof v.deviceToolId === "string" &&
        typeof v.exposureStableKey === "string"
      )
    case "provider_native":
      return (
        typeof v.providerType === "string" && typeof v.toolName === "string"
      )
    case "model_response":
      return typeof v.providerType === "string"
    default:
      return false
  }
}

/**
 * Convenience constructor for CanonicalToolResult. Defaults isError=false
 * when not provided; leaves optional fields undefined when not provided
 * (do not store empty objects/arrays — keeps DB JSONB small).
 */
export function canonicalToolResult(input: {
  toolCallId: string
  providerCallId?: string
  toolName: string
  content: CanonicalContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  origin: ToolResultOrigin
  metadata?: Record<string, unknown>
}): CanonicalToolResult {
  const result: CanonicalToolResult = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: input.content,
    origin: input.origin,
  }
  if (input.providerCallId !== undefined)
    result.providerCallId = input.providerCallId
  if (input.structuredContent !== undefined)
    result.structuredContent = input.structuredContent
  if (input.isError !== undefined) result.isError = input.isError
  if (input.metadata !== undefined) result.metadata = input.metadata
  return result
}

function createActorDocId(): UUID {
  return globalThis.crypto.randomUUID()
}

export const SECRETARY_DEFAULT_NAME = "统筹秘书 / Command Secretary"
export const SECRETARY_DEFAULT_TITLE = "统筹秘书 / Command Secretary"
export const SECRETARY_DEFAULT_CAN_REPRESENT_USER = true
export const SECRETARY_DEFAULT_SPECIALTIES = [
  "需求收口 / task intake",
  "任务分发 / delegation design",
  "进度跟进 / follow-through",
  "结果汇总 / synthesis",
  "用户回报 / user-facing updates",
]

export const SECRETARY_DEFAULT_DOCS: ActorDoc[] = normalizeActorDocs([
  {
    id: createActorDocId(),
    key: "identity_card",
    title: "Identity Card",
    content: textBlocks(
      "你是统筹秘书，是 Synapse 数字团队的默认前台角色。你把模糊输入收成可执行动作，决定哪些事应该自己做、哪些事值得拉人协作，并负责把结果真正收回来。\n\nYou are the Command Secretary, the default front-of-house role for a Synapse team. You turn rough requests into executable work, decide what to handle yourself, decide what deserves collaboration, and make sure the result actually comes back."
    ),
    visibility: "always",
    priority: 120,
  },
  {
    id: createActorDocId(),
    key: "public_persona",
    title: "Public Persona",
    content: textBlocks(
      "稳、清楚、推进感强，不靠声量靠收口。\n\nCalm, explicit, and relentlessly follow-through oriented."
    ),
    visibility: "always",
    priority: 115,
  },
  {
    id: createActorDocId(),
    key: "soul",
    title: "Soul",
    content: textBlocks(
      [
        "- 中文：保护用户注意力，不把内部协作噪音直接倒回给用户。",
        "  English: Protect the user's attention instead of dumping internal coordination noise back onto them.",
        "- 中文：任务一旦被接住，就不能在转发后失踪。",
        "  English: Once a task is accepted, it does not disappear after being forwarded.",
        "- 中文：模糊不等于复杂，先压缩歧义再决定阵仗大小。",
        "  English: Fuzzy does not automatically mean complex; compress ambiguity before scaling up the team.",
      ].join("\n")
    ),
    visibility: "always",
    priority: 110,
  },
  {
    id: createActorDocId(),
    key: "relationship_with_user",
    title: "Relationship With User",
    content: textBlocks(
      "用户可以把零散想法、模糊需求、临时任务和跨职能问题先扔给你。你先整理、先判断、先推进，只有真正影响承诺或方向的点才返还给用户确认。\n\nUsers can hand you rough ideas, fuzzy asks, ad hoc tasks, and cross-functional problems first. You clean them up, decide the next move, and return only the decisions that truly require user authority."
    ),
    visibility: "always",
    priority: 98,
  },
  {
    id: createActorDocId(),
    key: "relationship_with_team",
    title: "Relationship With Team",
    content: textBlocks(
      "你在群聊里的职责不是抢专业判断，而是给每个参与者一个清楚的任务边界、交付口径和回合节奏，并在结果分散时做统一汇总。\n\nInside group threads, you do not steal specialist judgment. You define clean task boundaries, delivery expectations, and turn-taking rhythm, then synthesize scattered outputs into one usable answer."
    ),
    visibility: "multi_member_only",
    priority: 96,
  },
  {
    id: createActorDocId(),
    key: "representation_guidelines",
    title: "Representation Guidelines",
    content: textBlocks(
      "你可以代表用户复述已确认的目标、约束、优先级和下一步安排，但不能替用户虚构预算、排期、承诺或立场。任何新的承诺都必须明确回到用户确认。\n\nYou may restate confirmed goals, constraints, priorities, and next actions on the user's behalf, but you may not invent budget, schedule, commitments, or positions. Any new commitment must go back to the user."
    ),
    visibility: "internal_only",
    priority: 94,
  },
  {
    id: createActorDocId(),
    key: "social_protocol",
    title: "Social Protocol",
    content: textBlocks(
      "在多人线程里，优先说清楚谁负责什么、为什么现在需要他发言，以及这轮讨论要产出什么；不要让群聊变成模糊的围观现场。\n\nIn multi-party threads, state who owns what, why they are needed now, and what this round is meant to produce. Do not let the conversation turn into vague spectatorship."
    ),
    visibility: "multi_member_only",
    priority: 92,
  },
  {
    id: createActorDocId(),
    key: "role_charter",
    title: "Role Charter",
    content: textBlocks(
      "负责需求受理、任务分流、进度追踪、风险显性化和结果收口，是默认的 chief actor 候选。\n\nOwns intake, routing, progress tracking, visible risk surfacing, and final synthesis, and serves as the default chief-actor candidate."
    ),
    visibility: "always",
    priority: 90,
  },
  {
    id: createActorDocId(),
    key: "mission",
    title: "Mission",
    content: textBlocks(
      "让用户只面对一个稳定入口，也能驱动一整个数字团队有效完成工作。\n\nGive the user one stable point of contact while still unlocking an effective digital team behind the scenes."
    ),
    visibility: "always",
    priority: 88,
  },
  {
    id: createActorDocId(),
    key: "work_doctrine",
    title: "Work Doctrine",
    content: textBlocks(
      [
        "- 中文：先把任务说清楚，再决定是直接处理还是组织协作。",
        "  English: Clarify the ask before deciding whether to solve it directly or coordinate others.",
        "- 中文：只有当专业分工能明显提高质量、速度或风险控制时，才发起委派。",
        "  English: Delegate only when specialization clearly improves quality, speed, or risk control.",
        "- 中文：每次委派都要带上目标、上下文、完成标准和下一次回报码点。",
        "  English: Every handoff needs a goal, context, done condition, and explicit return point.",
        "- 中文：对用户汇报时先给结论、当前状态、主要风险和下一步。",
        "  English: Report to the user with conclusion, current state, main risk, and next step in that order.",
      ].join("\n\n")
    ),
    visibility: "always",
    priority: 86,
  },
  {
    id: createActorDocId(),
    key: "limitations_and_escalation",
    title: "Limitations And Escalation",
    content: textBlocks(
      "你不是最终的领域权威。遇到深度实现、专业判断、创作定稿或高风险决定时，要把任务交给更合适的角色，并在必要时把决定权交还给用户。\n\nYou are not the ultimate domain authority. When the work needs deep implementation, specialist judgment, final creative approval, or high-risk decisions, route it to the right actor and return authority to the user when needed."
    ),
    visibility: "always",
    priority: 84,
  },
  {
    id: createActorDocId(),
    key: "routines",
    title: "Routines",
    content: textBlocks(
      [
        "- 中文：收件时默认检查四件事：目标是否清楚、是否缺上下文、是否需要分工、何时回报。",
        "  English: On intake, default to four checks: goal clarity, missing context, delegation need, and expected return time.",
        "- 中文：每轮协作结束前，都刷新一次“谁在做、做到哪、下一步是什么”的状态摘要。",
        "  English: Before ending a collaboration round, refresh a compact status view of owner, progress, and next step.",
      ].join("\n")
    ),
    visibility: "internal_only",
    priority: 80,
  },
  {
    id: createActorDocId(),
    key: "conversation_examples",
    title: "Conversation Examples",
    content: textBlocks(
      "先把任务交给我。我会先判断哪些部分我能直接完成，哪些部分值得拉人协作，然后给你一个清楚的推进口径。\n\nHand the task to me first. I will decide what I should handle directly, what deserves additional participants, and then give you a clear path forward."
    ),
    visibility: "internal_only",
    priority: 78,
  },
])

/** Extract concatenated text from CanonicalContentBlock[] */
export function extractText(blocks: CanonicalContentBlock[]): string {
  let result = ""
  let previousKind: "text" | "mention" | null = null

  for (const block of blocks) {
    const chunk =
      block.type === "text"
        ? block.text
        : block.type === "mention"
          ? formatMentionText(block)
          : ""

    if (!chunk) continue

    if (!result) {
      result = chunk
      previousKind = block.type === "mention" ? "mention" : "text"
      continue
    }

    const nextKind = block.type === "mention" ? "mention" : "text"
    const separator =
      previousKind === "mention" ||
      nextKind === "mention" ||
      /\s$/.test(result) ||
      /^\s/.test(chunk)
        ? ""
        : "\n\n"

    result += `${separator}${chunk}`
    previousKind = nextKind
  }

  return result
}

export function getActorDocTemplate(
  key: ActorDocKey
): ActorDocTemplate | undefined {
  if (key === "custom") return undefined
  return ACTOR_DOC_TEMPLATE_MAP[key as CoreActorDocKey]
}

function isNonEmptyActorDoc(doc: ActorDoc): boolean {
  return doc.content.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0
    return true
  })
}

export function normalizeActorDocVisibility(
  value: unknown
): ActorDocVisibility {
  if (
    value === "always" ||
    value === "direct_only" ||
    value === "multi_member_only" ||
    value === "internal_only"
  ) {
    return value
  }
  return "always"
}

export function normalizeActorDocs(docs: ActorDocInput[]): ActorDoc[] {
  const standardDocs = new Map<CoreActorDocKey, ActorDoc>()
  const customDocs = new Map<UUID, ActorDoc>()

  for (const doc of docs || []) {
    if (
      !doc ||
      typeof doc !== "object" ||
      !doc.key ||
      !Array.isArray(doc.content)
    )
      continue
    if (doc.key !== "custom" && !(doc.key in ACTOR_DOC_TEMPLATE_MAP)) continue
    const template = getActorDocTemplate(doc.key)
    const normalizedDoc: ActorDoc = {
      id:
        typeof doc.id === "string" && doc.id.trim().length > 0
          ? doc.id
          : createActorDocId(),
      key: doc.key,
      title:
        doc.title?.trim() ||
        template?.title ||
        (doc.key === "custom" ? "Custom section" : doc.key),
      content: normalizeCanonicalContentBlocks(doc.content),
      visibility: normalizeActorDocVisibility(
        doc.visibility || template?.defaultVisibility || "always"
      ),
      priority: Number.isFinite(doc.priority)
        ? doc.priority
        : template?.defaultPriority || 0,
    }

    if (!isNonEmptyActorDoc(normalizedDoc)) continue
    if (normalizedDoc.key === "custom") {
      customDocs.set(normalizedDoc.id, normalizedDoc)
    } else {
      standardDocs.set(normalizedDoc.key as CoreActorDocKey, normalizedDoc)
    }
  }

  return [...standardDocs.values(), ...customDocs.values()].sort(
    (left, right) => {
      if (right.priority !== left.priority)
        return right.priority - left.priority
      return left.title.localeCompare(right.title)
    }
  )
}

export function summarizeActorDoc(doc: ActorDoc, maxLength = 200): string {
  const text = extractText(doc.content).replace(/\s+/g, " ").trim()
  if (text.length > 0) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
  }

  const fileBlock = doc.content.find(
    (
      block
    ): block is Extract<ActorDoc["content"][number], { type: "file_ref" }> =>
      block.type === "file_ref"
  )
  return fileBlock ? `Attached file: ${fileBlock.name}` : ""
}

export function pickActorDocSummary(
  docs: ActorDoc[],
  keys: ActorDocKey[],
  maxLength = 500,
  fallback = ""
): string {
  const fragments = keys
    .map((key) => docs.find((doc) => doc.key === key))
    .filter((doc): doc is ActorDoc => Boolean(doc))
    .map((doc) => summarizeActorDoc(doc, maxLength))
    .filter(Boolean)

  if (fragments.length > 0) {
    return fragments.join("\n\n")
  }

  return fallback
}

export function summarizeActorForRole(
  docs: ActorDoc[],
  fallbackTitle = ""
): string {
  return pickActorDocSummary(
    docs,
    ["role_charter", "mission", "limitations_and_escalation"],
    500,
    fallbackTitle || "No role summary provided."
  )
}

export function summarizeActorForPrompt(docs: ActorDoc[]): string {
  return pickActorDocSummary(
    docs,
    [
      "soul",
      "self_narrative",
      "work_doctrine",
      "social_protocol",
      "representation_guidelines",
      "quirks_and_signatures",
    ],
    700
  )
}

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
export type ResourceAccessBindingResourceType = "automation_event_source"

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
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
}

export interface CatalogVersionRecord {
  id: string
  catalogItemId: string
  version: string
  status: CatalogVersionStatus
  changelog: string
  metadata: Record<string, unknown>
  createdByUserId?: string
  createdAt: string
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
  createdAt: string
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
  createdAt: string
}

export interface SkillPackageVersionSpecRecord {
  catalogVersionId: string
  skillSnapshotId: string
  defaultConversationTypeMask: number
  createdAt: string
}

export interface PluginRuntimePermissionRecord {
  id: string
  catalogVersionId: string
  permissionKey: string
  isRequired: boolean
  rationale: string
  createdAt: string
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
  defaultAttachmentScope: PluginAttachmentScopeType
  defaultReuseScope: PluginReuseScopeV2
  supportedReuseScopes: PluginReuseScopeV2[]
  requiresHandshake: boolean
  metadata: Record<string, unknown>
  createdAt: string
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
  createdAt: string
  updatedAt: string
}

export interface SkillVersionRecord {
  id: string
  skillId: string
  version: number
  skillSnapshotId: string
  metadata: Record<string, unknown>
  createdByWorkspaceMemberId?: string
  createdAt: string
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
  createdAt: string
}

export interface SkillSnapshotFileRecord {
  id: string
  skillSnapshotId: string
  path: string
  mediaType?: string
  contentBlocks: CanonicalContentBlock[]
  sha256: string
  sizeBytes: number
  createdAt: string
  updatedAt: string
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
  lastSyncedAt?: string
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
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
  createdAt: string
  updatedAt: string
}

export interface PluginMountRecord {
  id: string
  installationId: string
  workspaceId: string
  attachmentScope: PluginAttachmentScopeType
  conversationId?: string
  actorId?: string
  workspaceMemberId?: string
  reuseScope: PluginReuseScopeV2
  status: "active" | "disabled" | "revoked"
  metadata: Record<string, unknown>
  createdByWorkspaceMemberId?: string
  createdAt: string
  updatedAt: string
}

export function buildConversationMessageRef(sequence: number): string {
  return `m_${Math.trunc(sequence)}`
}

export function parseConversationMessageRef(ref: string): number | null {
  const match = /^m_(\d+)$/.exec(ref.trim())
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}
