export * from "./relay.js";

// ============ Common ============
export type UUID = string;
export type Timestamp = string; // ISO 8601

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============ Auth ============
export interface User {
  id: UUID;
  email: string;
  name: string;
  avatarUrl?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type AuthClientType =
  | "web"
  | "android"
  | "windows"
  | "ios"
  | "cli"
  | "api";

export type AuthTransport = "cookie" | "token";
export type AuthSessionPersistence = "persistent" | "temporary";

export interface AuthSessionSummary {
  id: UUID;
  clientType: AuthClientType;
  transport: AuthTransport;
  deviceName?: string;
  platform?: string;
  current: boolean;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt?: Timestamp;
}

export interface AuthResponse {
  user: User;
  session: AuthSessionSummary;
  sessionToken?: string;
}

export type AuthQrLoginStatus =
  | "pending_scan"
  | "pending_confirm"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed";

export interface AuthQrLoginRequestSummary {
  id: UUID;
  status: AuthQrLoginStatus;
  browserLabel: string;
  approvedSessionPersistence?: AuthSessionPersistence;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  scannedAt?: Timestamp;
  approvedAt?: Timestamp;
  rejectedAt?: Timestamp;
  consumedAt?: Timestamp;
}

export interface AuthQrLoginCreateResponse {
  request: AuthQrLoginRequestSummary;
  scanToken: string;
  browserToken: string;
}

export interface AuthQrLoginStatusResponse {
  request: AuthQrLoginRequestSummary;
}

export interface AuthQrLoginResolveResponse {
  request: AuthQrLoginRequestSummary;
  confirmation: {
    browserLabel: string;
    requestedAt: Timestamp;
    expiresAt: Timestamp;
  };
}

// ============ Workspace ============
export type TrustLevel = "owner" | "admin" | "member" | "guest";

export interface Workspace {
  id: UUID;
  name: string;
  slug: string;
  description?: string;
  ownerId: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WorkspaceMember {
  id: UUID;
  workspaceId: UUID;
  userId: UUID;
  trustLevel: TrustLevel;
  joinedAt: Timestamp;
}

export interface WorkspaceChiefActorSummary {
  id: UUID;
  name: string;
  role: ActorRole;
  title: string;
  avatarUrl?: string;
}

export interface WorkspaceChiefActorPreference {
  workspaceId: UUID;
  userId: UUID;
  chiefActorId?: UUID;
  chiefActor?: WorkspaceChiefActorSummary;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

// ============ Workspace Invites ============
export type InviteTrustLevel = "admin" | "member" | "guest";

export interface WorkspaceInvite {
  id: UUID;
  workspaceId: UUID;
  token: string;
  createdBy: UUID;
  trustLevel: InviteTrustLevel;
  maxUses?: number;
  useCount: number;
  expiresAt?: Timestamp;
  isRevoked: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Joined fields
  workspaceName?: string;
}

// ============ Actor (Digital Employee) ============
export type ActorRole =
  | "secretary"
  | "manager"
  | "specialist"
  | "reviewer"
  | "archivist"
  | "receptionist"
  | "assistant";

export type ActorDocVisibility =
  | "always"
  | "solo_only"
  | "group_only"
  | "internal_only";

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
  | "conversation_examples";

export type ActorDocKey = CoreActorDocKey | "custom";

export interface ActorDoc {
  id: UUID;
  key: ActorDocKey;
  title: string;
  content: CanonicalContentBlock[];
  visibility: ActorDocVisibility;
  priority: number;
}

export type ActorDocInput = Omit<ActorDoc, "id" | "content"> & {
  id?: UUID;
  content: CanonicalContentBlockInput[];
};

export interface ActorDefinition {
  name: string;
  role: ActorRole;
  title: string;
  avatarFileId?: UUID;
  avatarEmoji?: string;
  parentId?: UUID;
  canRepresentUser: boolean;
  docs: ActorDoc[];
  specialties: string[];
  config: Record<string, unknown>;
}

export type ActorUpdateSourceType = "user" | "actor" | "system" | "sync";

export interface ActorVersionSource {
  type: ActorUpdateSourceType;
  userId?: UUID;
  actorId?: UUID;
  sessionId?: UUID;
  turnId?: UUID;
  conversationId?: UUID;
  reason?: string;
}

export type ActorVersionChangedField =
  | "name"
  | "role"
  | "title"
  | "parentId"
  | "canRepresentUser"
  | "specialties"
  | "config";

export type ActorDocChangedField =
  | "title"
  | "visibility"
  | "priority"
  | "content";

export interface ActorDocFieldChange {
  field: ActorDocChangedField;
  before?: unknown;
  after?: unknown;
  beforeSummaryText?: string;
  afterSummaryText?: string;
}

export interface ActorFieldChange {
  kind: "field";
  field: ActorVersionChangedField;
  before?: unknown;
  after?: unknown;
  summary: CanonicalContentBlock[];
}

export interface ActorVersionDocChange {
  kind: "doc";
  docId: UUID;
  key: ActorDocKey;
  title: string;
  changeType: "added" | "updated" | "removed";
  visibility: ActorDocVisibility;
  priority: number;
  fieldChanges: ActorDocFieldChange[];
  summary: CanonicalContentBlock[];
}

export type ActorVersionChange = ActorFieldChange | ActorVersionDocChange;

export interface ActorVersionDelta {
  fromVersion: number;
  toVersion: number;
  source?: ActorVersionSource;
  changes: ActorVersionChange[];
  summary: CanonicalContentBlock[];
}

export interface ActorVersion {
  id: UUID;
  actorId: UUID;
  version: number;
  previousVersionId?: UUID;
  snapshot: ActorDefinition;
  delta?: ActorVersionDelta;
  createdBy?: UUID;
  source?: ActorVersionSource;
  createdAt: Timestamp;
}

export interface Actor {
  id: UUID;
  workspaceId: UUID;
  packageId?: UUID;
  packageInstanceId?: UUID;
  definition: ActorDefinition;
  avatarUrl?: string;
  currentVersion: number;
  sourceLink?: ActorPackageSourceLink;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ActorCollaboration {
  id: UUID;
  actorId: UUID;
  collaboratorId: UUID;
  relationship: string; // e.g. 'peer', 'consultant', 'backup'
  description?: string;
  createdAt: Timestamp;
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
  | "failed";

export type WorkItemPriority = "low" | "medium" | "high" | "urgent";

export type ParticipantRole =
  | "owner"
  | "accountable"
  | "executor"
  | "reviewer"
  | "watcher";

export interface WorkItem {
  id: UUID;
  workspaceId: UUID;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  parentId?: UUID; // Parent work item (for decomposition)
  createdBy: UUID; // Actor or user who created it
  assignedTo?: UUID; // Current owner actor
  accountableId?: UUID; // Ultimate accountability
  sourceType:
    | "user_message"
    | "delegation"
    | "automation"
    | "escalation"
    | "collaboration";
  sourceId?: UUID;
  dueAt?: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  result?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WorkItemParticipant {
  id: UUID;
  workItemId: UUID;
  actorId: UUID;
  role: ParticipantRole;
  addedAt: Timestamp;
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
};

// ============ Communication Protocol ============
export type MessageType =
  | "assign"
  | "accept"
  | "reject"
  | "info_request"
  | "info_response"
  | "progress"
  | "escalate"
  | "assist_request"
  | "assist_response"
  | "transfer"
  | "complete"
  | "feedback"
  | "rework"
  | "user_message";

export interface Message {
  id: UUID;
  workspaceId: UUID;
  workItemId?: UUID;
  type: MessageType;
  fromActorId?: UUID;
  toActorId?: UUID;
  fromUserId?: UUID;
  toUserId?: UUID;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
}

// ============ Memory ============
export type MemoryScope =
  | "workspace"
  | "conversation"
  | "actor_global"
  | "actor_conversation"
  | "user";
export type MemoryCategory =
  | "fact"
  | "preference"
  | "decision"
  | "relationship"
  | "procedure"
  | "artifact"
  | "summary";
export type MemoryStatus =
  | "candidate"
  | "established"
  | "superseded"
  | "retracted";
export type MemoryStability = "ephemeral" | "durable";
export type MemoryRecallType = "bootstrap" | "turn_recall" | "manual_search";

export interface MemoryEntry {
  id: UUID;
  workspaceId: UUID;
  ownerScope: MemoryScope;
  ownerActorId?: UUID;
  ownerConversationId?: UUID;
  ownerUserId?: UUID;
  category: MemoryCategory;
  status: MemoryStatus;
  stability: MemoryStability;
  importance: number;
  confidence: number;
  tags: string[];
  textDigest: string;
  searchText: string;
  contentBlocks: CanonicalContentBlock[];
  sourceItemId?: UUID;
  sourceToolCallId?: UUID;
  sourceTurnId?: UUID;
  supersedesMemoryId?: UUID;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  actorName?: string;
  conversationTitle?: string;
  userName?: string;
}

export type Memory = MemoryEntry;

export interface MemorySearchHit extends MemoryEntry {
  matchedChunkId?: UUID;
  rank: number;
  finalScore: number;
  vectorScore?: number;
  textScore?: number;
  similarityScore?: number;
  matchedTerms?: string[];
}

export interface MemoryRecallResult extends MemorySearchHit {
  recallReason?: string;
}

export interface MemoryRecallRun {
  id: UUID;
  workspaceId: UUID;
  actorId?: UUID;
  conversationId?: UUID;
  userId?: UUID;
  recallType: MemoryRecallType;
  queryText: string;
  queryBlocks: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  results: MemoryRecallResult[];
}

// ============ Automation ============
export type AutomationCategory = "schedule" | "event_subscription";
export type AutomationStatus =
  | "active"
  | "paused"
  | "error"
  | "archived"
  | "completed"
  | "expired";
export type AutomationCreatorKind = "user" | "session" | "system";
export type AutomationTriggerKind = "schedule" | "event";
export type AutomationSourceKind = "clock" | "relay" | "webhook" | "internal" | "integration";
export type AutomationEventProviderKind = "relay" | "webhook" | "internal" | "integration";
export type AutomationIntegrationProvider = "github" | "gitlab";
export type AutomationIntegrationIngressKind = "webhook" | "polling";
export type AutomationIntegrationTargetKind = "repository" | "project";
export type AutomationScheduleKind = "cron" | "at" | "interval";
export type AutomationCompletionStatus = "completed" | "archived";
export type AutomationDeliveryMode =
  | "wake_session"
  | "conversation_notice"
  | "create_conversation_once"
  | "create_conversation_each_time";
export type AutomationTargetPolicy = "all_members" | "specified_members";
export type AutomationExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";
export type AutomationTargetEntityKind = "actor" | "user";
export type AutomationWebhookStatus = "active" | "disabled" | "archived";
export type AutomationEventSourceStatus =
  | "active"
  | "deprecated"
  | "disabled"
  | "archived";

export interface AutomationEventSourceIntegration {
  installationId: UUID;
  provider: AutomationIntegrationProvider;
  ingressKind: AutomationIntegrationIngressKind;
  targetKind: AutomationIntegrationTargetKind;
  targetId: string;
  targetLabel: string;
  endpointId?: UUID;
  externalSubscriptionId?: string;
}

export interface AutomationEventSource {
  id: UUID;
  workspaceId: UUID;
  providerKind: AutomationEventProviderKind;
  providerRef?: string;
  integration?: AutomationEventSourceIntegration;
  sourceKey: string;
  name: string;
  description: string;
  recommendedUsage?: string;
  payloadSchema: Record<string, unknown>;
  examplePayload: Record<string, unknown>;
  status: AutomationEventSourceStatus;
  createdByKind: AutomationCreatorKind;
  createdByUserId?: UUID;
  createdByActorId?: UUID;
  createdBySessionId?: UUID;
  lastTriggeredAt?: Timestamp;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationRule {
  id: UUID;
  workspaceId: UUID;
  category: AutomationCategory;
  status: AutomationStatus;
  name: string;
  description: string;
  createdByKind: AutomationCreatorKind;
  createdByUserId?: UUID;
  createdByActorId?: UUID;
  createdBySessionId?: UUID;
  ownerConversationId?: UUID;
  ownerSessionId?: UUID;
  trigger: AutomationTrigger;
  policy: AutomationPolicy;
  delivery: AutomationDelivery;
  lastTriggeredAt?: Timestamp;
  lastErrorAt?: Timestamp;
  lastErrorMessage?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationTrigger {
  ruleId: UUID;
  triggerKind: AutomationTriggerKind;
  sourceKind: AutomationSourceKind;
  eventSourceId?: UUID;
  eventSourceKey?: string;
  eventSourceName?: string;
  eventProviderKind?: AutomationEventProviderKind;
  eventProviderRef?: string;
  eventSourceIntegration?: AutomationEventSourceIntegration;
  eventSourceStatus?: AutomationEventSourceStatus;
  sourceLocator?: string;
  matchKey?: string;
  matcher: Record<string, unknown>;
  scheduleKind?: AutomationScheduleKind;
  scheduleExpr?: string;
  scheduleTimezone?: string;
  intervalSeconds?: number;
  startsAt?: Timestamp;
  nextFireAt?: Timestamp;
  lastFiredAt?: Timestamp;
  metadata: Record<string, unknown>;
}

export interface AutomationPolicy {
  ruleId: UUID;
  activeFrom?: Timestamp;
  activeUntil?: Timestamp;
  maxTriggerCount?: number;
  triggerCount: number;
  completionStatus: AutomationCompletionStatus;
  completedAt?: Timestamp;
  metadata: Record<string, unknown>;
}

export interface AutomationDelivery {
  ruleId: UUID;
  deliveryMode: AutomationDeliveryMode;
  conversationId?: UUID;
  sessionId?: UUID;
  reusedConversationId?: UUID;
  conversationTitle?: string;
  messageText: string;
  wakeReasonText?: string;
  messageBlocks: CanonicalContentBlock[];
  targetPolicy: AutomationTargetPolicy;
  participants: AutomationTargetEntityRef[];
  recipients: AutomationTargetEntityRef[];
  metadata: Record<string, unknown>;
}

export interface AutomationTargetEntityRef {
  entityKind: AutomationTargetEntityKind;
  entityId: UUID;
}

export interface AutomationOccurrence {
  id: UUID;
  workspaceId: UUID;
  sourceKind: AutomationSourceKind;
  eventSourceId?: UUID;
  eventSourceKey?: string;
  eventSourceName?: string;
  eventSourceIntegration?: AutomationEventSourceIntegration;
  displayTitle?: string;
  displaySummary?: string;
  displayDescription?: string;
  sourceLocator?: string;
  matchKey?: string;
  dedupeKey?: string;
  sourceSnapshot: Record<string, unknown>;
  payload: Record<string, unknown>;
  occurredAt: Timestamp;
  createdAt: Timestamp;
}

export interface AutomationExecution {
  id: UUID;
  workspaceId: UUID;
  ruleId: UUID;
  occurrenceId: UUID;
  occurrenceOccurredAt?: Timestamp;
  occurrenceSourceKind?: AutomationSourceKind;
  occurrenceEventSourceName?: string;
  occurrenceTitle?: string;
  occurrenceSummary?: string;
  occurrenceDescription?: string;
  status: AutomationExecutionStatus;
  errorMessage?: string;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationExecutionTarget {
  id: UUID;
  executionId: UUID;
  conversationId?: UUID;
  sessionId?: UUID;
  targetActorId?: UUID;
  targetUserId?: UUID;
  createdItemId?: UUID;
  wakeupId?: UUID;
  status: AutomationExecutionStatus;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationWebhookEndpoint {
  id: UUID;
  workspaceId: UUID;
  name: string;
  status: AutomationWebhookStatus;
  pathToken: string;
  secretHint: string;
  metadata: Record<string, unknown>;
  createdBy?: UUID;
  lastReceivedAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AutomationWebhookEndpointCreateResult {
  endpoint: AutomationWebhookEndpoint;
  secret: string;
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
  | "automation_event_source.trigger";

export interface AuditLog {
  id: UUID;
  workspaceId?: UUID;
  userId?: UUID;
  actorId?: UUID;
  action: AuditAction;
  resourceType: string;
  resourceId?: UUID;
  details: Record<string, unknown>;
  ipAddress?: string;
  createdAt: Timestamp;
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
  | "session.message.new"
  | "session.status.changed"
  | "session.thinking"
  | "group.actor.runtime.updated"
  | "group.updated"
  | "group.member_joined"
  | "group.member_kicked"
  | "actor.version_changed"
  | "chat.feed.item.created"
  | "chat.runtime.updated"
  | "chat.conversation.updated"
  | "chat.interaction.updated"
  | "mcp.config.changed"
  | "relay.connected"
  | "relay.disconnected"
  | "relay.servers_updated";

export interface SystemEvent {
  type: EventType;
  workspaceId: UUID;
  payload: Record<string, unknown>;
  timestamp: Timestamp;
}

// ============ AI ============
export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "blocked"
  | "closed";
export type ChannelType = "web" | "api";
export type SessionTrigger =
  | "user_message"
  | "group_message"
  | "actor_message"
  | "broadcast"
  | "api_call"
  | "actor_invite"
  | "automation"
  | "system_interrupt"
  | "retry";
export type SessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool_result";
export type SessionInterruptType = "progress_check" | "priority_override";
export type SessionWakeupSourceType =
  | "user_message"
  | "actor_message"
  | "broadcast"
  | "invite"
  | "api_call"
  | "automation"
  | "system_interrupt"
  | "retry";
export type SessionWakeupStatus =
  | "pending"
  | "attached"
  | "processed"
  | "dropped";
export type ActorRuntimeHealth = "ok" | "error";
export type ActorRuntimePhase =
  | "idle"
  | "thinking"
  | "tool"
  | "responding"
  | "blocked"
  | "error";

export interface Session {
  id: UUID;
  workspaceId: UUID;
  actorId: UUID;
  groupId?: UUID;
  channelType: ChannelType;
  trigger: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  errorMessage?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  completedAt?: Timestamp;
}

export interface SessionWakeup {
  id: UUID;
  sessionId: UUID;
  turnId?: UUID;
  sourceType: SessionWakeupSourceType;
  sourceItemId?: UUID;
  sourceSessionId?: UUID;
  sourceMemberType?: "user" | "actor" | "external" | "system";
  sourceMemberId?: UUID;
  sourceName?: string;
  summary: string;
  reasonText?: string;
  status: SessionWakeupStatus;
  activationKind?: string;
  delivery?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  attachedAt?: Timestamp;
  processedAt?: Timestamp;
}

export interface ActorRuntimeWakeup {
  wakeupId: UUID;
  sourceType: SessionWakeupSourceType;
  sourceItemId?: UUID;
  sourceSessionId?: UUID;
  sourceMemberType?: "user" | "actor" | "external" | "system";
  sourceMemberId?: UUID;
  sourceName?: string;
  summary: string;
  reasonText?: string;
  status: SessionWakeupStatus;
  activationKind?: string;
  delivery?: string;
  createdAt: Timestamp;
  attachedAt?: Timestamp;
}

export interface ActorRuntimeState {
  groupId: UUID;
  sessionId: UUID;
  actorId: UUID;
  actorName: string;
  laneState: SessionStatus;
  health: ActorRuntimeHealth;
  phase: ActorRuntimePhase;
  statusText?: string;
  currentTurnId?: UUID;
  pendingWakeupCount: number;
  activeWakeups: ActorRuntimeWakeup[];
  latestWakeupAt?: Timestamp;
  lastError?: {
    message: string;
    at: Timestamp;
  };
  updatedAt: Timestamp;
}

export interface SessionMessage {
  id: UUID;
  sessionId: UUID;
  workspaceId: UUID;
  role: SessionMessageRole;
  content: string;
  contentBlocks: CanonicalContentBlock[];
  fromActorId?: UUID;
  fromUserId?: UUID;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface SessionInterrupt {
  id: UUID;
  targetSessionId: UUID;
  type: SessionInterruptType;
  content: string;
  fromSessionId?: UUID;
  isConsumed: boolean;
  createdAt: Timestamp;
}

export interface ActorAction {
  type: "respond" | "create_memory" | "rename_self" | "change_avatar";
  content: string;
  contentBlocks?: CanonicalContentBlock[];
  targetActorId?: UUID;
  metadata?: Record<string, unknown>;
}

export interface ThinkingResult {
  actions: ActorAction[];
  reasoning: string;
  tokensUsed: { input: number; output: number };
  toolsUsed?: string[]; // names of callable tools invoked during thinking
  serverToolCalls?: ServerToolCall[]; // cloud-side tool calls (web_search, web_fetch)
  citationSources?: Record<string, { url: string; title: string }>; // <cite index="X-Y"> → source
  toolHistory?: AssistantToolHistory; // cross-turn tool history for replay
  contentBlocks?: CanonicalContentBlock[];
}

// ============ Server Tool Calls (Anthropic/OpenAI cloud-side tools) ============

export interface ServerToolCall {
  type: "web_search" | "web_fetch";
  query?: string; // web_search query
  url?: string; // web_fetch URL
  results?: ServerToolSearchResult[];
}

export interface ServerToolSearchResult {
  url: string;
  title: string;
  pageAge?: string;
}

// ============ Model Groups ============
export type RoutingStrategy =
  | "weighted_random"
  | "round_robin"
  | "priority_failover";
export type ProviderType = string;
export type AIRequestType = "actor_think" | "ai_complete";
export type AIRequestStatus = "success" | "error" | "timeout";

export interface ModelGroup {
  id: UUID;
  ownerType?: "platform" | "workspace" | "user";
  ownerWorkspaceId?: UUID | null;
  ownerUserId?: UUID | null;
  workspaceId?: UUID;
  name: string;
  description: string;
  routingStrategy: RoutingStrategy;
  isDefault: boolean;
  isActive: boolean;
  createdBy?: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ModelGroupItem {
  id: UUID;
  groupId: UUID;
  currentConfigId?: UUID;
  displayName: string;
  priority: number;
  weight: number;
  isEnabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  currentConfig?: ModelItemConfig;
}

export interface ModelItemConfig {
  id: UUID;
  itemId: UUID;
  version: number;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  inputTokenCostMicros: number;
  outputTokenCostMicros: number;
  capabilityTags: string[];
  extraConfig: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface ActorModelGroup {
  actorId: UUID;
  groupId: UUID;
  priority: number;
  createdAt: Timestamp;
}

export interface ModelGroupGrant {
  id: UUID;
  groupId: UUID;
  grantScope: "platform" | "workspace" | "user" | "workspace_user" | "actor";
  workspaceId?: UUID | null;
  userId?: UUID | null;
  actorId?: UUID | null;
  status: "active" | "revoked";
  grantedBy?: UUID | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Timestamp | null;
  revokedAt?: Timestamp | null;
}

export interface AIRequestLog {
  id: UUID;
  workspaceId?: UUID;
  actorId?: UUID;
  groupId?: UUID;
  itemId?: UUID;
  configId?: UUID;
  requestType: AIRequestType;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  status: AIRequestStatus;
  errorMessage?: string;
  createdAt: Timestamp;
}

export type AnthropicBuiltinTool = "web_search" | "web_fetch";
export type ModelEngineKind = string;

export type MultimodalType = "image" | "audio" | "video" | "document";

export interface MultimodalConfig {
  supported: boolean;
  types: MultimodalType[];
}

export interface ResolvedModelConfig {
  groupId: UUID;
  profileId: UUID;
  profileRevisionId: UUID;
  providerType: ProviderType;
  engineKind: ModelEngineKind;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  builtinTools?: AnthropicBuiltinTool[];
  multimodal?: MultimodalConfig;
  crossTurnToolHistory?: boolean;
  priority?: number;
  weight?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

export interface ModelAttemptPolicy {
  maxAttemptsTotal: number;
  maxAttemptsPerBinding: number;
  timeoutMsPerAttempt: number;
  continueOn: string[];
  stopOn: string[];
  retryBackoffMs: number[];
}

export interface ResolvedModelPlan {
  groupId: UUID;
  groupName: string;
  routingStrategy: "weighted_random" | "round_robin" | "priority_failover";
  attemptPolicy: ModelAttemptPolicy;
  candidates: ResolvedModelConfig[];
}

// ============ Canonical Content Block ============
// Unified representation: text stored directly, media via file_ref pointing to platform file storage
export type CanonicalFileCategory = "image" | "audio" | "video" | "document";

export interface CanonicalTextBlock {
  id: UUID;
  type: "text";
  text: string;
}

export interface CanonicalFileRefBlock {
  id: UUID;
  type: "file_ref";
  fileId: string; // files table UUID
  storedName: string; // disk relative path (resolved via readAsBuffer)
  url: string; // /files/... (frontend display)
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  category: CanonicalFileCategory;
}

export type CanonicalContentBlock = CanonicalTextBlock | CanonicalFileRefBlock;

export type CanonicalTextBlockInput = Omit<CanonicalTextBlock, "id"> & {
  id?: UUID;
};
export type CanonicalFileRefBlockInput = Omit<CanonicalFileRefBlock, "id"> & {
  id?: UUID;
};
export type CanonicalContentBlockInput =
  | CanonicalTextBlockInput
  | CanonicalFileRefBlockInput;

// ============ Files ============

export interface RelayMcpFileSourceMetadata {
  kind: "relay_mcp";
  deviceId: UUID;
  deviceDisplayName?: string;
  exposureId: UUID;
  exposureStableKey: string;
  exposureDisplayName?: string;
  runtimeSessionId: UUID;
  visibleToolName: string;
  namespacedToolName: string;
}

export interface FileRecordView {
  id: UUID;
  workspaceId?: UUID | null;
  uploaderUserId?: UUID | null;
  originalName: string;
  storedName: string;
  url: string;
  fullUrl: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Timestamp;
  metadata?: Record<string, unknown> & {
    source?: RelayMcpFileSourceMetadata | Record<string, unknown>;
    absolutePath?: string;
    sha256?: string;
    modifiedAt?: Timestamp;
    createdAt?: Timestamp;
  };
}

export interface ActorDocTemplate {
  key: CoreActorDocKey;
  title: string;
  description: string;
  defaultVisibility: ActorDocVisibility;
  defaultPriority: number;
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
    defaultVisibility: "group_only",
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
    defaultVisibility: "group_only",
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
];

export const ACTOR_DOC_TEMPLATE_MAP: Record<CoreActorDocKey, ActorDocTemplate> =
  Object.fromEntries(
    ACTOR_DOC_TEMPLATES.map((template) => [template.key, template]),
  ) as Record<CoreActorDocKey, ActorDocTemplate>;

// ============ Canonical Tool History ============
export interface CanonicalToolCall {
  callId: string;
  providerCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CanonicalToolResult {
  toolCallId: string;
  providerCallId?: string;
  toolName: string;
  content: CanonicalContentBlock[];
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolRound {
  content?: CanonicalContentBlock[];
  toolCalls: CanonicalToolCall[];
  toolResults: CanonicalToolResult[];
}

export interface AssistantToolHistory {
  rounds: ToolRound[];
}

export type CanonicalContextScope = "shared" | "private";
export type CanonicalContextSurface = "visible" | "internal";
export type CanonicalContextRole = "user" | "assistant" | "system" | "tool";
export type CanonicalContextMemberType =
  | "actor"
  | "user"
  | "external"
  | "remote_agent"
  | "system"
  | "unknown";
export type ConversationEventTimelinePolicy =
  | "none"
  | "all_members"
  | "users_only"
  | "actors_only"
  | "targeted_members";
export type ConversationEventContextPolicy =
  | "none"
  | "shared"
  | "actor_private"
  | "targeted_members";

export interface CanonicalContextAuthor {
  memberId?: string;
  memberType: CanonicalContextMemberType;
  actorId?: string;
  userId?: string;
  sessionId?: string;
  name?: string;
  isSelf?: boolean;
}

export interface CanonicalContextTarget {
  memberId?: string;
  memberType: Exclude<CanonicalContextMemberType, "unknown">;
  actorId?: string;
  userId?: string;
  name?: string;
}

interface CanonicalContextItemBase {
  itemId?: string;
  conversationId?: string;
  sessionId?: string;
  turnId?: string;
  sequence?: number;
  scope: CanonicalContextScope;
  surface: CanonicalContextSurface;
  metadata?: Record<string, unknown>;
}

export interface CanonicalSystemNoticeItem extends CanonicalContextItemBase {
  kind: "system_notice";
  noticeType:
    | "interrupt"
    | "task_instruction"
    | "legacy_tool_result"
    | "generic";
  parts: CanonicalContentBlock[];
}

export interface CanonicalEventContextItem extends CanonicalContextItemBase {
  kind: "event";
  eventType: string;
  eventPayload?: Record<string, unknown>;
  timelinePolicy?: ConversationEventTimelinePolicy;
  contextPolicy?: ConversationEventContextPolicy;
  author?: CanonicalContextAuthor;
  targets?: CanonicalContextTarget[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalMessageContextItem extends CanonicalContextItemBase {
  kind: "message";
  messageType: string;
  role: CanonicalContextRole;
  author?: CanonicalContextAuthor;
  targets?: CanonicalContextTarget[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalToolCallBatchContextItem extends CanonicalContextItemBase {
  kind: "tool_call_batch";
  role: "assistant";
  bundleId?: string;
  author?: CanonicalContextAuthor;
  content?: CanonicalContentBlock[];
  toolCalls: CanonicalToolCall[];
}

export interface CanonicalToolResultBatchContextItem extends CanonicalContextItemBase {
  kind: "tool_result_batch";
  bundleId?: string;
  toolResults: CanonicalToolResult[];
}

export interface CanonicalSummaryContextItem extends CanonicalContextItemBase {
  kind: "summary";
  summaryType: string;
  sourceItemIds?: string[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalMemoryRecallContextItem extends CanonicalContextItemBase {
  kind: "memory_recall";
  recallType: Exclude<MemoryRecallType, "manual_search">;
  memories: MemoryRecallResult[];
  metadata?: Record<string, unknown>;
}

export type CanonicalContextItem =
  | CanonicalSystemNoticeItem
  | CanonicalEventContextItem
  | CanonicalMessageContextItem
  | CanonicalToolCallBatchContextItem
  | CanonicalToolResultBatchContextItem
  | CanonicalSummaryContextItem
  | CanonicalMemoryRecallContextItem;

export type CanonicalArchiveFrameRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";
export type CanonicalArchiveChainScope = "shared" | "private";

export interface CanonicalArchiveFrame {
  frameId?: string;
  role: CanonicalArchiveFrameRole;
  frameType: string;
  parts?: CanonicalContentBlock[];
  toolCalls?: CanonicalToolCall[];
  toolResults?: CanonicalToolResult[];
  sourceItemIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalArchivePoint {
  archivePointId: string;
  chainScope: CanonicalArchiveChainScope;
  conversationId: string;
  sessionId?: string;
  parentArchivePointId?: string;
  coversUntilSequence: number;
  frames: CanonicalArchiveFrame[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface ProviderContextWindow {
  sharedArchivePoint: CanonicalArchivePoint | null;
  sharedTailItems: CanonicalContextItem[];
  privateArchivePoint: CanonicalArchivePoint | null;
  privateTailItems: CanonicalContextItem[];
  orderedTailItems: CanonicalContextItem[];
}

export interface EngineBranchCursor {
  sharedSequence?: number;
  privateSequence?: number;
  appliedItemIds?: string[];
}

export interface EngineBranchState {
  branchId: string;
  sessionId: string;
  conversationId?: string;
  providerType: ProviderType;
  engineKind: ModelEngineKind;
  bindingKey: string;
  cursor: EngineBranchCursor;
  nativeState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============ Conversation Message ============
export type ConversationMessage =
  | { role: "user"; content: CanonicalContentBlock[] }
  | {
      role: "assistant";
      content: CanonicalContentBlock[];
      toolCalls?: CanonicalToolCall[];
    }
  | { role: "tool_result"; results: CanonicalToolResult[] };

// ============ AI Provider ============
export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string; enum?: string[] };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterProperty>;
    required: string[];
  };
}

export interface ToolCall {
  callId: string;
  providerCallId?: string;
  toolName: string;
  input: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolResult {
  toolCallId: string;
  providerCallId?: string;
  toolName: string;
  content: string | unknown[]; // string for text-only, array for multimodal (MCP content blocks)
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NormalizedMcpToolResult {
  content: CanonicalContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  rawResult?: unknown;
}

// ============ Tool Plugin System ============

export interface GroupMemberEntry {
  type: "actor" | "user" | "external";
  id: string;
  name: string;
  title?: string;
  participantId?: string;
  linkedUserId?: string;
  linkedUserName?: string;
  externalUserKey?: string;
}

export interface ToolResolveContext {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  groupId?: string;
  groupMembers?: GroupMemberEntry[];
  userId?: string;
  availableSkills?: AvailableSkillSummary[];
}

export interface ToolPlugin {
  name: string;
  kind: "action" | "callable";
  definition: ToolDefinition;
  resolve?: (ctx: ToolResolveContext) =>
    | {
        active: boolean;
        definition: ToolDefinition;
      }
    | Promise<{
        active: boolean;
        definition: ToolDefinition;
      }>;
  execute?: (input: Record<string, unknown>) => Promise<string>;
}

export interface AIResponse {
  context: ConversationMessage[]; // [{ role: 'assistant', content, toolCalls? }]
  tokensUsed: { input: number; output: number };
  stopReason: string; // e.g. 'end_turn', 'tool_use' (Anthropic) or 'stop', 'tool_calls' (OpenAI)
  rawAssistantMessage?: unknown; // Provider-specific raw assistant message for server tool extraction
  mediaBlocks?: unknown[]; // Provider raw media content blocks (images, audio from model response)
  serverToolCalls?: ServerToolCall[];
  citationSources?: Record<string, { url: string; title: string }>;
  branchState?: EngineBranchState;
}

// ============================================================
// MCP Plugin Marketplace Types
// ============================================================

export type MarketplaceItemKind = "plugin" | "skill" | "actor" | "model";
export type PluginTransport =
  | "builtin"
  | "stdio"
  | "http"
  | "relay"
  | "filesystem";
export type AttachmentScope =
  | "platform"
  | "workspace"
  | "conversation"
  | "actor_global"
  | "actor_conversation"
  | "user";
export type ReuseScope =
  | "turn"
  | "platform"
  | "workspace"
  | "conversation"
  | "actor_global"
  | "actor_conversation"
  | "user";
export type AccessGrantScope = AttachmentScope;
export type MarketplaceSourceType =
  | "builtin"
  | "official"
  | "workspace_upload"
  | "user_upload"
  | "relay_derived";
export type MarketplaceLineageKind =
  | "installed_copy"
  | "fork"
  | "share"
  | "relay_derivation";
export type MarketplaceSyncMode =
  | "notify"
  | "manual_merge"
  | "follow_upstream"
  | "detached";
export type MarketplaceRequirementKind =
  | "required"
  | "recommended"
  | "optional"
  | "conflicts_with";
export type MarketplaceRequirementTargetKind = "package" | "tag";
export type PluginInstallationMode =
  | "manual"
  | "seeded"
  | "relay_derived"
  | "package_required"
  | "package_recommended";
export type MarketplaceVersionStatus =
  | "draft"
  | "active"
  | "deprecated"
  | "archived";
export type AccessGrantStatus = "active" | "revoked";
export type MarketplaceRequirementStatus =
  | "satisfied"
  | "missing_required"
  | "missing_recommended"
  | "scope_mismatch"
  | "config_incomplete";
export type MarketplaceAssetKind =
  | "skill_markdown"
  | "reference_markdown"
  | "script"
  | "json"
  | "text"
  | "binary";
export type LocalizedText = Record<string, string>;
export type PluginConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "secret"
  | "auth_connection"
  | "file";
export type PluginInstallStepKind =
  | "form"
  | "auth"
  | "check"
  | "confirm"
  | "attachment_scope"
  | "reuse_scope"
  | "integration_events";
export type PluginInstallActionKind = "auth_start" | "external_link" | "noop";
export type PluginAuthBindingDriverKind =
  | "oauth2_authorization_code_pkce"
  | "mijia_qr_login";
export type PluginAuthOwnerScope = "installation" | "user" | "workspace";
export type PluginAuthSessionStatus =
  | "pending"
  | "completed"
  | "failed"
  | "expired"
  | "consumed";
export type PluginAuthConnectionStatus = "active" | "expired" | "revoked";
export type PluginAuthSessionPhase =
  | "awaiting_start"
  | "awaiting_external_input"
  | "awaiting_callback"
  | "pending_scan"
  | "pending_confirm"
  | "finalizing";
export type PluginAuthChallengeKind = "redirect" | "qr_code" | "none";

export interface PluginAuthValueSource {
  source: "config" | "env" | "literal" | "derived";
  field?: string;
  env?: string;
  value?: unknown;
  name?: "app_base_url" | "oauth_callback_url";
}

export interface PluginConfigFieldOption {
  value: string;
  labelI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
}

export interface PluginConfigFieldDefinition {
  key: string;
  type: PluginConfigFieldType;
  titleI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  placeholderI18n?: LocalizedText;
  required?: boolean;
  defaultValue?: unknown;
  options?: PluginConfigFieldOption[];
  secret?: boolean;
  serverManaged?: boolean;
  authBindingKey?: string;
  validation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PluginInstallAction {
  kind: PluginInstallActionKind;
  bindingKey?: string;
  url?: string;
  buttonLabelI18n?: LocalizedText;
  metadata?: Record<string, unknown>;
}

export interface PluginInstallStep {
  id: string;
  kind: PluginInstallStepKind;
  titleI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  scope: "workspace" | "plugin";
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpTextI18n?: LocalizedText;
  action?: PluginInstallAction;
  metadata?: Record<string, unknown>;
}

export interface PluginInstallFlow {
  steps: PluginInstallStep[];
}

export interface PluginAuthChallenge {
  kind: PluginAuthChallengeKind;
  url?: string;
  qrUrl?: string;
  openMode?: "popup" | "replace";
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PluginAuthBindingDefinition {
  key: string;
  driver: PluginAuthBindingDriverKind;
  fieldKey: string;
  displayNameI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  prerequisiteFields?: string[];
  ownerScope?: PluginAuthOwnerScope;
  authorizeUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
  audience?: string;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  profileIdPath?: string;
  profileDisplayNamePath?: string;
  profileAvatarUrlPath?: string;
  reusable?: boolean;
  inputs?: Record<string, PluginAuthValueSource>;
  metadata?: Record<string, unknown>;
}

export interface PluginConfigFieldState {
  key: string;
  isConfigured: boolean;
  maskedValue?: string;
  authConnectionId?: string;
  accountDisplayName?: string;
  updatedAt?: string;
}

export interface AccessPolicy {
  requiredPermissions: string[];
  defaultGrantScope?: AccessGrantScope;
  reason?: string;
}

export interface MarketplacePublisher {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  logoUrl?: string;
  isBuiltin: boolean;
  isVerified: boolean;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceLineage {
  downstreamPackageId: string;
  upstreamPackageId: string;
  upstreamRevisionId?: string;
  lineageKind: MarketplaceLineageKind;
  syncMode: MarketplaceSyncMode;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceCategory {
  id: string;
  slug: string;
  targetKind: MarketplaceItemKind;
  displayName: string;
  displayNameI18n?: LocalizedText;
  description?: string;
  descriptionI18n?: LocalizedText;
  iconUrl?: string;
  defaultLocale?: string;
  sortOrder: number;
  isBuiltin: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MarketplaceAsset {
  id: string;
  revisionId: string;
  path: string;
  assetKind: MarketplaceAssetKind;
  mediaType?: string;
  sizeBytes: number;
  sha256: string;
  textContent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MarketplaceVersion {
  id: string;
  packageId: string;
  version: string;
  status: MarketplaceVersionStatus;
  manifest: Record<string, unknown>;
  access?: AccessPolicy;
  authorization?: AccessPolicy;
  configSchema: Record<string, unknown>;
  configFields: PluginConfigFieldDefinition[];
  defaultConfig: Record<string, unknown>;
  transport?: PluginTransport;
  entryPoint?: string;
  toolsManifest: MarketplaceTool[];
  validationRules: McpValidationRule[];
  setupSteps: PluginInstallStep[];
  installFlow?: PluginInstallFlow;
  authBindings: PluginAuthBindingDefinition[];
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  assets?: MarketplaceAsset[];
}

export interface MarketplaceItem {
  id: string;
  publisherId: string;
  workspaceId?: string;
  kind: MarketplaceItemKind;
  slug: string;
  displayName: string;
  displayNameI18n?: LocalizedText;
  description: string;
  descriptionI18n?: LocalizedText;
  longDescription: string;
  longDescriptionI18n?: LocalizedText;
  summaryI18n?: LocalizedText;
  defaultLocale?: string;
  iconUrl?: string;
  sourceType: MarketplaceSourceType;
  tags: string[];
  isActive: boolean;
  isBuiltin: boolean;
  downloadCount: number;
  latestRevisionId?: string;
  defaultInstanceScope?: AttachmentScope;
  defaultReuseScope?: ReuseScope;
  defaultIdleTtlMs?: number;
  defaultMaxAgeMs?: number;
  requiresHandshake: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  categories?: MarketplaceCategory[];
  sourceLink?: MarketplaceLineage;
  publisher?: MarketplacePublisher;
  latestRevision?: MarketplaceVersion;
}

export interface PluginInstallationView {
  id: string;
  workspaceId: string;
  packageId: string;
  revisionId: string;
  attachmentType: AttachmentScope;
  attachmentId?: string;
  attachmentConversationId?: string;
  attachmentActorId?: string;
  attachmentUserId?: string;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  installMode: PluginInstallationMode;
  reuseScope: ReuseScope;
  idleTtlMs?: number;
  maxAgeMs?: number;
  requiresHandshake: boolean;
  isEnabled: boolean;
  configData: Record<string, unknown>;
  configState: PluginConfigFieldState[];
  installedBy?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  package?: MarketplaceItem;
  revision?: MarketplaceVersion;
}

export interface AccessGrant {
  id: string;
  resourceId: string;
  workspaceId: string;
  grantScope: AccessGrantScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  permissions: string[];
  status: AccessGrantStatus;
  grantedBy?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  revokedAt?: string;
}

export interface PluginAuthSession {
  id: string;
  workspaceId: string;
  packageId: string;
  revisionId?: string;
  bindingKey: string;
  driver: PluginAuthBindingDriverKind;
  userId: string;
  status: PluginAuthSessionStatus;
  phase?: PluginAuthSessionPhase;
  state?: string;
  challenge?: PluginAuthChallenge;
  errorCode?: string;
  errorMessage?: string;
  resultPreview: Record<string, unknown>;
  authConnectionId?: string;
  metadata: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PluginAuthConnection {
  id: string;
  workspaceId: string;
  packageId: string;
  bindingKey: string;
  driver: PluginAuthBindingDriverKind;
  ownerScope: PluginAuthOwnerScope;
  ownerUserId?: string;
  externalAccountId?: string;
  displayName?: string;
  avatarUrl?: string;
  status: PluginAuthConnectionStatus;
  expiresAt?: string;
  publicPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceRequirement {
  id: string;
  revisionId: string;
  requirementKind: MarketplaceRequirementKind;
  targetKind: MarketplaceRequirementTargetKind;
  targetPackageKind?: MarketplaceItemKind;
  targetPublisherSlug?: string;
  targetPackageSlug?: string;
  targetTag?: string;
  acceptableInstanceScopes: AttachmentScope[];
  acceptableReuseScopes: ReuseScope[];
  description: string;
  configPredicate: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MarketplaceRequirementCheck {
  requirementId: string;
  requirementKind: MarketplaceRequirementKind;
  status: MarketplaceRequirementStatus;
  message: string;
  matchedInstanceIds: string[];
  missingPublisherSlug?: string;
  missingPackageSlug?: string;
  missingTag?: string;
}

export interface PluginInstallPlan {
  packageId: string;
  revisionId: string;
  workspaceId: string;
  attachmentType: AttachmentScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  checks: MarketplaceRequirementCheck[];
  grantPlan?: {
    requiresGrant: boolean;
    requiredPermissions: string[];
    suggestedGrantScope?: AccessGrantScope;
    reason?: string;
  };
}

export type ActorPackageDependencyKind = Extract<
  MarketplaceRequirementKind,
  "required" | "recommended"
>;
export type ActorPackageTargetKind = Extract<
  MarketplaceItemKind,
  "plugin" | "skill"
>;
export type ActorPackageSyncMode = "notify" | "manual_merge";
export type ActorPackageLinkStatus =
  | "up_to_date"
  | "update_available"
  | "diverged"
  | "update_available_with_local_changes"
  | "detached";

export interface ActorPackageDependency {
  requirementId?: string;
  requirementKind: ActorPackageDependencyKind;
  targetPackageKind: ActorPackageTargetKind;
  targetPublisherSlug?: string;
  targetPackageSlug: string;
  acceptableInstanceScopes: AttachmentScope[];
  acceptableReuseScopes: ReuseScope[];
  description: string;
  notes: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
}

export interface ActorPackageManifest {
  actor: ActorDefinition;
  setupGuide: CanonicalContentBlock[];
  releaseNotes: CanonicalContentBlock[];
}

export interface ActorPackageSourceLink {
  actorId: UUID;
  packageId: UUID;
  importedRevisionId: UUID;
  packageSlug: string;
  packageDisplayName: string;
  packagePublisherSlug?: string;
  packagePublisherDisplayName?: string;
  importedVersion?: string;
  latestRevisionId?: UUID;
  latestVersion?: string;
  baselineActorVersion: number;
  syncMode: ActorPackageSyncMode;
  hasLocalChanges: boolean;
  hasUpstreamUpdate: boolean;
  status: ActorPackageLinkStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ActorPackageRecord {
  package: MarketplaceItem;
  manifest: ActorPackageManifest;
  dependencies: ActorPackageDependency[];
  requirementChecks?: MarketplaceRequirementCheck[];
}

export interface ActorPackageInstallResult {
  actor: Actor;
  sourcePackage: ActorPackageRecord;
  sourceLink: ActorPackageSourceLink;
  requirementChecks: MarketplaceRequirementCheck[];
}

export interface AvailableSkillSummary {
  instanceId: string;
  packageId: string;
  revisionId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  attachmentType: AttachmentScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  entryPoint?: string;
}

export type SkillUseScope =
  | "workspace"
  | "conversation"
  | "actor_global"
  | "actor_conversation"
  | "user";

export interface SkillAttachmentFile {
  id: string;
  path: string;
  contentBlocks: CanonicalContentBlock[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillMarketplaceVersion {
  id: string;
  skillId: string;
  version: string;
  changelog: string;
  description: CanonicalContentBlock;
  createdBy?: string;
  createdByName?: string;
  createdAt: string;
  attachmentFiles?: SkillAttachmentFile[];
}

export interface SkillMarketplaceWorkspaceInstallation {
  installed: boolean;
  installedSkillId?: string;
  installedCount: number;
}

export interface SkillMarketplaceEntry {
  id: string;
  slug: string;
  name: string;
  description: CanonicalContentBlock;
  iconUrl?: string;
  tags: string[];
  authorUserId?: string;
  authorName?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  latestVersionId?: string;
  latestVersion?: SkillMarketplaceVersion;
  workspaceInstallation?: SkillMarketplaceWorkspaceInstallation;
}

export interface InstalledSkill {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: CanonicalContentBlock;
  iconUrl?: string;
  tags: string[];
  useScope: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  isEnabled: boolean;
  isCustomized: boolean;
  installedBy?: string;
  createdAt: string;
  updatedAt: string;
  sourceSkillId?: string;
  sourceVersionId?: string;
  sourceVersion?: string;
  upgradeAvailable: boolean;
  latestSourceVersion?: string;
  attachmentFiles?: SkillAttachmentFile[];
}

export type McpTransport = Exclude<PluginTransport, "filesystem">;
export type McpLifecycleScope = ReuseScope;
export type McpAttachmentType = AttachmentScope;

export type McpOrganization = MarketplacePublisher;
export type McpPluginTool = MarketplaceTool;

export interface McpPlugin extends MarketplaceItem {
  kind: "plugin";
}

export interface McpInstallation extends PluginInstallationView {
  pluginId: string;
  attachmentType: McpAttachmentType;
  attachmentId: string;
  lifecycleScope: McpLifecycleScope;
  plugin?: McpPlugin;
}

export interface McpRelay {
  id: string;
  userId?: string;
  workspaceId?: string;
  name: string;
  authToken: string;
  isConnected: boolean;
  lastConnectedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface McpRelayServer {
  id: string;
  relayId: string;
  name: string;
  transport: "builtin" | "stdio" | "http";
  command?: string;
  endpoint?: string;
  envVars: Record<string, unknown>;
  toolsManifest: McpPluginTool[];
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolCallLog {
  id: string;
  workspaceId: string;
  sessionId?: string;
  actorId?: string;
  userId?: string;
  pluginId: string;
  relayId?: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  isError: boolean;
  errorMessage?: string;
  durationMs?: number;
  transport?: string;
  instanceKey?: string;
  createdAt: string;
}

export interface McpEventLog {
  id: string;
  workspaceId?: string;
  userId?: string;
  pluginId?: string;
  relayId?: string;
  eventType: string;
  eventData: Record<string, unknown>;
  createdAt: string;
}

export interface McpValidationRule {
  field: string;
  rule:
    | "required"
    | "pattern"
    | "url"
    | "min_length"
    | "max_length"
    | "prefix"
    | "enum";
  value?: string | number | string[];
  message: string;
}

export interface McpSetupStep {
  id: string;
  kind?: PluginInstallStepKind;
  title?: string;
  titleI18n?: LocalizedText;
  description?: string;
  descriptionI18n?: LocalizedText;
  scope: "workspace" | "plugin";
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpText?: string;
  helpTextI18n?: LocalizedText;
  action?: PluginInstallAction;
  metadata?: Record<string, unknown>;
}

// ============ Groups (Chat Groups) ============
export interface Group {
  id: UUID;
  workspaceId: UUID;
  title?: string;
  createdBy?: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface GroupMember {
  id: UUID;
  groupId: UUID;
  actorId?: UUID;
  userId?: UUID;
  sessionId?: UUID;
  joinedAt: Timestamp;
  // Joined fields
  actorName?: string;
  actorTitle?: string;
  actorRole?: string;
  userName?: string;
  status?: SessionStatus;
}

export interface GroupMessage {
  id: UUID;
  groupId: UUID;
  sessionId: UUID | "";
  role: "user" | "assistant" | "system";
  fromUserId?: UUID;
  fromActorId?: UUID;
  actorName?: string;
  targetParticipantIds: UUID[];
  content: string;
  contentBlocks: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
}

export type ConversationParticipantType =
  | "actor"
  | "user"
  | "external"
  | "remote_agent"
  | "system";

export type ConversationMemberType = ConversationParticipantType;

export type TransportKind = "feishu" | "weixin";
export type TransportConnectionMode = "webhook" | "long_connection";
export type TransportEndpointType = "direct" | "group";
export type TransportAccountStatus = "active" | "disabled" | "error";
export type TransportDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export interface ConversationEntityRef {
  memberId?: UUID;
  participantId?: UUID;
  memberType: ConversationMemberType;
  actorId?: UUID;
  userId?: UUID;
  externalUserKey?: string;
  transportAddressId?: UUID;
  transportKind?: TransportKind;
  name?: string;
  title?: string;
  role?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
}

export type ConversationMemberRef = ConversationEntityRef & {
  memberId: UUID;
  participantId: UUID;
  memberType: "actor" | "user" | "external";
};

export interface TransportConnectorCapability {
  transportKind: TransportKind;
  supportedConnectionModes: TransportConnectionMode[];
  supportedEndpointTypes: TransportEndpointType[];
  supportsDirectMessages: boolean;
  supportsGroupMessages: boolean;
}

export type TransportAccountOwnerScope = "workspace" | "workspace_user";
export type TransportAccountInboundActorMode =
  | "none"
  | "specified_actor"
  | "follow_owner_chief_actor";
export type TransportConversationInboundActorMode =
  | "inherit_account"
  | "none"
  | "specified_actor";

export interface TransportAccountSummary {
  id: UUID;
  workspaceId: UUID;
  transportKind: TransportKind;
  accountKey: string;
  displayName: string;
  ownerScope: TransportAccountOwnerScope;
  ownerUserId?: UUID;
  inboundActorMode: TransportAccountInboundActorMode;
  inboundActorId?: UUID;
  connectionMode: TransportConnectionMode;
  status: TransportAccountStatus;
  credentials?: Record<string, unknown>;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TransportEndpointSummary {
  id: UUID;
  transportAccountId: UUID;
  transportKind: TransportKind;
  endpointType: TransportEndpointType;
  externalId: string;
  parentExternalId?: string;
  displayName?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ConversationTransportBindingSummary {
  id: UUID;
  conversationId: UUID;
  workspaceId: UUID;
  transportKind: TransportKind;
  outboundEnabled: boolean;
  inboundActorMode: TransportConversationInboundActorMode;
  inboundActorId?: UUID;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  account: TransportAccountSummary;
  endpoint: TransportEndpointSummary;
}

export interface TransportSessionSummary {
  id: UUID;
  workspaceId: UUID;
  transportKind: TransportKind;
  outboundEnabled: boolean;
  inboundActorMode: TransportConversationInboundActorMode;
  inboundActorId?: UUID;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  conversationId?: UUID;
  conversationTitle?: string;
  lastInboundAt?: Timestamp;
  lastOutboundAt?: Timestamp;
  account: TransportAccountSummary;
  endpoint: TransportEndpointSummary;
}

export type WeixinQrLoginStatus =
  | "waiting"
  | "scanned"
  | "confirmed"
  | "expired"
  | "error";

export interface WeixinQrLoginSessionSummary {
  sessionId: string;
  workspaceId: UUID;
  status: WeixinQrLoginStatus;
  message: string;
  qrCodeUrl?: string;
  baseUrl?: string;
  botId?: string;
  scannerUserId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  transportAccount?: TransportAccountSummary;
}

export interface CurrentUserWeixinBindingSummary {
  account: TransportAccountSummary;
  scannerUserId?: string;
  externalUser?: TransportExternalUserSummary;
  pendingAutoLinkUserId?: UUID;
  pendingAutoLinkUserName?: string;
}

export interface TransportExternalUserSessionRef {
  conversationId?: UUID;
  conversationTitle?: string;
  endpointId?: UUID;
  endpointType?: TransportEndpointType;
  endpointExternalId?: string;
  endpointDisplayName?: string;
}

export interface TransportExternalUserSummary {
  id: UUID;
  workspaceId: UUID;
  transportAccountId: UUID;
  transportKind: TransportKind;
  accountDisplayName: string;
  externalId: string;
  displayName?: string;
  linkedUserId?: UUID;
  linkedUserName?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastSeenAt?: Timestamp;
  sessions: TransportExternalUserSessionRef[];
}

export interface TransportMessageLink {
  id: UUID;
  conversationId: UUID;
  itemId: UUID;
  transportKind: TransportKind;
  transportEndpointId: UUID;
  direction: "inbound" | "outbound";
  deliveryStatus: TransportDeliveryStatus;
  externalMessageId?: string;
  metadata: Record<string, unknown>;
  deliveredAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ConversationMessageTransportContext {
  direction: "inbound" | "outbound";
  transportKind: TransportKind;
  transportAccountId?: UUID;
  endpointType?: TransportEndpointType;
  endpointExternalId?: string;
  externalMessageId?: string;
  transportAddressId?: UUID;
  senderExternalId?: string;
}

export interface ConversationMessageTransportDelivery {
  linkId: UUID;
  transportKind: TransportKind;
  direction: "inbound" | "outbound";
  deliveryStatus: TransportDeliveryStatus;
  endpointType?: TransportEndpointType;
  endpointExternalId?: string;
  endpointDisplayName?: string;
  externalMessageId?: string;
  deliveredAt?: Timestamp;
  metadata: Record<string, unknown>;
}

export interface ActorVersionDocChangeWire {
  docId: UUID;
  key: ActorDocKey;
  title: string;
  changeType: "added" | "updated" | "removed";
  visibility: ActorDocVisibility;
  priority: number;
  fieldChanges?: ActorDocFieldChange[];
  summaryText?: string;
}

export interface ActorVersionFieldChangeWire {
  field: ActorVersionChangedField;
  before?: unknown;
  after?: unknown;
  summaryText?: string;
}

export type ActorVersionChangeWire =
  | ({ kind: "field" } & ActorVersionFieldChangeWire)
  | ({ kind: "doc" } & ActorVersionDocChangeWire);

export type InteractionRequestKind = "question_choice" | "relay_authorization";

export type InteractionRequestStatus =
  | "pending"
  | "answered"
  | "approved_pending_apply"
  | "applied"
  | "rejected"
  | "expired"
  | "apply_failed";

export interface InteractionChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export type InteractionQuestionFieldType =
  | "single_select"
  | "multi_select"
  | "text";

export interface InteractionQuestionFieldDefinition {
  id: string;
  type: InteractionQuestionFieldType;
  label: string;
  description?: string;
  required?: boolean;
  options?: InteractionChoiceOption[];
  allowOther?: boolean;
  otherLabel?: string;
  otherPlaceholder?: string;
  placeholder?: string;
  minSelections?: number;
  maxSelections?: number;
}

export interface InteractionQuestionFieldAnswer {
  fieldId: string;
  selectedOptionIds?: string[];
  selectedOptionLabels?: string[];
  otherText?: string;
  text?: string;
}

export interface InteractionQuestionFieldSummary extends InteractionQuestionFieldDefinition {
  required: boolean;
  answer?: InteractionQuestionFieldAnswer;
}

export interface QuestionChoiceInteractionSummary {
  prompt: string;
  instructions?: string;
  fields: InteractionQuestionFieldSummary[];
}

export type RelayAuthorizationDuration = "session" | "persistent";

export type RelayFilesystemAuthorizationAccess =
  | "read"
  | "write"
  | "read_write";

export interface RelayFilesystemAuthorizationScope {
  capability: "filesystem";
  path: string;
  access: RelayFilesystemAuthorizationAccess;
}

export interface RelayCuaAuthorizationScope {
  capability: "cua";
  mode: "control";
}

export type RelayAuthorizationScope =
  | RelayFilesystemAuthorizationScope
  | RelayCuaAuthorizationScope;

export interface RelayAuthorizationInteractionSummary {
  relayToolName: string;
  reason: string;
  deviceId: UUID;
  deviceDisplayName: string;
  exposureId: UUID;
  exposureDisplayName: string;
  duration: RelayAuthorizationDuration;
  requestedScope: RelayAuthorizationScope;
  approvedScope?: RelayAuthorizationScope;
  applyError?: string;
}

export interface InteractionRequestSummary {
  id: UUID;
  workspaceId: UUID;
  conversationId: UUID;
  itemId?: UUID;
  kind: InteractionRequestKind;
  status: InteractionRequestStatus;
  requester?: ConversationEntityRef;
  target?: ConversationEntityRef;
  resolvedBy?: ConversationEntityRef;
  resolutionNote?: string;
  question?: QuestionChoiceInteractionSummary;
  relayAuthorization?: RelayAuthorizationInteractionSummary;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  resolvedAt?: Timestamp;
  expiresAt?: Timestamp;
  viewerCanResolve?: boolean;
}

export type ConversationFeedEventType =
  | "member_joined"
  | "member_kicked"
  | "member_left"
  | "memory_saved"
  | "memory_updated"
  | "actor_renamed"
  | "actor_avatar_changed"
  | "actor_version_changed"
  | "automation_notice"
  | "interaction_requested";

export interface ConversationFeedEventPayloadMap {
  member_joined: {
    batchId: UUID;
    initiator?: ConversationEntityRef;
    members: ConversationMemberRef[];
    focusItemId?: UUID;
  };
  member_kicked: {
    batchId: UUID;
    initiator?: ConversationEntityRef;
    members: ConversationMemberRef[];
    focusItemId?: UUID;
    reason?: string;
  };
  member_left: {
    batchId: UUID;
    initiator?: ConversationEntityRef;
    members: ConversationMemberRef[];
    focusItemId?: UUID;
  };
  memory_saved: {
    actor: ConversationEntityRef;
    memoryId: UUID;
    memoryScope: MemoryScope;
    memoryCategory: MemoryCategory;
    textDigest?: string;
    sourceItemId?: UUID;
    sourceTurnId?: UUID;
  };
  memory_updated: {
    actor: ConversationEntityRef;
    memoryId: UUID;
    supersedesMemoryId?: UUID;
    memoryScope: MemoryScope;
    memoryCategory: MemoryCategory;
    textDigest?: string;
    sourceItemId?: UUID;
    sourceTurnId?: UUID;
  };
  actor_renamed: {
    actor: ConversationEntityRef;
    oldName?: string;
    newName: string;
    sourceTurnId?: UUID;
  };
  actor_avatar_changed: {
    actor: ConversationEntityRef;
    oldAvatarEmoji?: string;
    newAvatarEmoji?: string;
    oldAvatarUrl?: string;
    newAvatarUrl?: string;
    sourceTurnId?: UUID;
  };
  actor_version_changed: {
    actor: ConversationEntityRef;
    fromVersion: number;
    toVersion: number;
    changes: ActorVersionChangeWire[];
    source?: ActorVersionSource;
  };
  automation_notice: {
    automationId: UUID;
    executionId: UUID;
    occurrenceId: UUID;
    category: AutomationCategory;
    sourceKind: AutomationSourceKind;
    eventSourceId?: UUID;
    eventSourceName?: string;
    sourceLabel?: string;
    sourceTitle?: string;
    sourceSummary?: string;
    sourceDescription?: string;
    occurredAt?: Timestamp;
    deliveryMode: AutomationDeliveryMode;
    message: string;
    messageBlocks?: CanonicalContentBlock[];
  };
  interaction_requested: {
    interaction: InteractionRequestSummary;
  };
}

export type ConversationFeedEventPayload<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> = ConversationFeedEventPayloadMap[T];

export interface ConversationFeedMessageItem {
  kind: "message";
  itemId: UUID;
  conversationId: UUID;
  sequence: number;
  workspaceSequence?: number;
  sessionId?: UUID;
  turnId?: UUID;
  role: "user" | "assistant" | "system";
  messageType: string;
  author?: ConversationEntityRef;
  targets: ConversationEntityRef[];
  content: string;
  contentBlocks: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
  transport?: ConversationMessageTransportContext;
  transportDeliveries?: ConversationMessageTransportDelivery[];
  createdAt: Timestamp;
  clientMessageId?: string;
}

export interface ConversationFeedEventItem<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> {
  kind: "event";
  itemId: UUID;
  conversationId: UUID;
  sequence: number;
  workspaceSequence?: number;
  sessionId?: UUID;
  turnId?: UUID;
  author?: ConversationEntityRef;
  targets: ConversationEntityRef[];
  causedByItemId?: UUID;
  eventType: T;
  payload: ConversationFeedEventPayloadMap[T];
  createdAt: Timestamp;
}

function formatConversationEntityName(
  entity: Partial<ConversationEntityRef> | undefined,
  fallback: string,
) {
  const name = typeof entity?.name === "string" ? entity.name.trim() : "";
  return name || fallback;
}

function formatConversationEntityList(
  entities: Array<Partial<ConversationEntityRef> | undefined>,
  fallback = "Unknown",
) {
  const names = entities
    .map((entity) => formatConversationEntityName(entity, fallback))
    .filter(Boolean);
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function summarizeMembershipEvent(
  eventType: Extract<
    ConversationFeedEventType,
    "member_joined" | "member_kicked" | "member_left"
  >,
  payload:
    | ConversationFeedEventPayloadMap["member_joined"]
    | ConversationFeedEventPayloadMap["member_kicked"]
    | ConversationFeedEventPayloadMap["member_left"],
) {
  const initiator = payload.initiator;
  const members = Array.isArray(payload.members) ? payload.members : [];
  const initiatorName = formatConversationEntityName(initiator, "");
  const initiatorMemberId = initiator?.memberId;
  const memberList = formatConversationEntityList(members);
  const nonInitiatorMembers = initiatorMemberId
    ? members.filter((member) => member.memberId !== initiatorMemberId)
    : members;

  if (eventType === "member_joined") {
    if (initiatorName) {
      if (
        initiatorMemberId &&
        members.some((member) => member.memberId === initiatorMemberId)
      ) {
        if (nonInitiatorMembers.length === 0) {
          return `${initiatorName} joined the group`;
        }
        return `${initiatorName} started the group with ${formatConversationEntityList(nonInitiatorMembers)}`;
      }
      return `${initiatorName} invited ${memberList} to the group`;
    }
    return `${memberList} joined the group`;
  }

  if (eventType === "member_kicked") {
    if (initiatorName) {
      return `${initiatorName} removed ${memberList} from the group`;
    }
    return `${memberList} was removed from the group`;
  }

  if (initiatorName && initiatorMemberId && members.length === 1) {
    const leftMember = members[0];
    if (leftMember && leftMember.memberId === initiatorMemberId) {
      return `${initiatorName} left the group`;
    }
  }
  return `${memberList} left the group`;
}

export function summarizeConversationEvent(
  eventType: ConversationFeedEventType | string,
  payload: Record<string, unknown>,
) {
  if (eventType === "member_joined") {
    return summarizeMembershipEvent(
      "member_joined",
      payload as ConversationFeedEventPayloadMap["member_joined"],
    );
  }

  if (eventType === "member_kicked") {
    return summarizeMembershipEvent(
      "member_kicked",
      payload as ConversationFeedEventPayloadMap["member_kicked"],
    );
  }

  if (eventType === "member_left") {
    return summarizeMembershipEvent(
      "member_left",
      payload as ConversationFeedEventPayloadMap["member_left"],
    );
  }

  if (eventType === "memory_saved" || eventType === "memory_updated") {
    const textDigest =
      typeof payload.textDigest === "string" ? payload.textDigest.trim() : "";
    const scope =
      typeof payload.memoryScope === "string" ? payload.memoryScope : "memory";
    const actionLabel = eventType === "memory_updated" ? "updated" : "saved";
    const summary = textDigest || "durable memory saved";
    return `Memory ${actionLabel}: ${summary} (${scope})`;
  }

  if (eventType === "actor_renamed") {
    const newName =
      typeof payload.newName === "string" ? payload.newName.trim() : "Unknown";
    return `Actor renamed: will now be called ${newName}.`;
  }

  if (eventType === "actor_avatar_changed") {
    const avatarEmoji =
      typeof payload.newAvatarEmoji === "string"
        ? payload.newAvatarEmoji.trim()
        : "";
    if (avatarEmoji) {
      return `Actor avatar updated to ${avatarEmoji}.`;
    }
    return "Actor avatar updated.";
  }

  if (eventType === "actor_version_changed") {
    const actor =
      payload.actor && typeof payload.actor === "object"
        ? (payload.actor as { name?: string })
        : undefined;
    const actorName =
      typeof actor?.name === "string" ? actor.name.trim() : "An actor";
    const fromVersion =
      typeof payload.fromVersion === "number" ? payload.fromVersion : null;
    const toVersion =
      typeof payload.toVersion === "number" ? payload.toVersion : null;
    const changes = Array.isArray(payload.changes)
      ? payload.changes
          .filter(
            (
              change,
            ): change is {
              kind?: string;
              summaryText?: string;
              title?: string;
              changeType?: string;
              field?: string;
            } => !!change && typeof change === "object",
          )
          .map((change) => {
            const summaryText =
              typeof change.summaryText === "string"
                ? change.summaryText.trim()
                : "";
            if (summaryText) return summaryText;
            if (change.kind === "field" && typeof change.field === "string") {
              return `${change.field} changed.`;
            }
            if (change.kind === "doc") {
              const title =
                typeof change.title === "string"
                  ? change.title.trim()
                  : "a doc";
              const changeType =
                typeof change.changeType === "string"
                  ? change.changeType.trim()
                  : "updated";
              return `Doc ${changeType}: ${title}.`;
            }
            return "";
          })
          .filter((value): value is string => Boolean(value))
      : [];
    const source =
      payload.source && typeof payload.source === "object"
        ? (payload.source as { type?: string })
        : undefined;

    const fragments: string[] = [];
    if (fromVersion !== null && toVersion !== null) {
      fragments.push(
        `${actorName} updated from v${fromVersion} to v${toVersion}.`,
      );
    } else {
      fragments.push(`${actorName} updated their profile.`);
    }
    if (changes.length > 0) {
      fragments.push(...changes);
    } else {
      fragments.push("Profile details changed.");
    }
    if (source?.type === "user") {
      fragments.push("Updated by a user.");
    } else if (source?.type === "actor") {
      fragments.push("Updated by the actor.");
    }
    return fragments.join(" ");
  }

  if (eventType === "automation_notice") {
    const messageBlocks = Array.isArray(payload.messageBlocks)
      ? (payload.messageBlocks as CanonicalContentBlock[])
      : [];
    const messageFromBlocks = extractText(messageBlocks).trim();
    const message =
      messageFromBlocks ||
      (typeof payload.message === "string" ? payload.message.trim() : "");
    if (message) return message;
    const sourceTitle =
      typeof payload.sourceTitle === "string" ? payload.sourceTitle.trim() : "";
    const sourceSummary =
      typeof payload.sourceSummary === "string"
        ? payload.sourceSummary.trim()
        : "";
    if (sourceTitle && sourceSummary) {
      return `${sourceTitle}: ${sourceSummary}`;
    }
    if (sourceTitle) return sourceTitle;
    if (sourceSummary) return sourceSummary;
    const sourceLabel =
      typeof payload.sourceLabel === "string" ? payload.sourceLabel.trim() : "";
    if (sourceLabel) return sourceLabel;
    return "Automation notice";
  }

  if (eventType === "interaction_requested") {
    const interaction =
      payload.interaction && typeof payload.interaction === "object"
        ? (payload.interaction as InteractionRequestSummary)
        : undefined;
    if (!interaction) {
      return "Interaction requested";
    }
    if (interaction.kind === "question_choice") {
      const targetName = interaction.target?.name?.trim() || "a user";
      const prompt = interaction.question?.prompt?.trim() || "A question";
      return interaction.status === "answered"
        ? `${targetName} answered: ${prompt}`
        : `Question for ${targetName}: ${prompt}`;
    }
    const deviceName =
      interaction.relayAuthorization?.deviceDisplayName?.trim() || "relay";
    if (interaction.status === "rejected") {
      const resolverName = interaction.resolvedBy?.name?.trim() || "A user";
      return `${resolverName} rejected relay access for ${deviceName}`;
    }
    if (
      interaction.status === "approved_pending_apply" ||
      interaction.status === "applied"
    ) {
      const resolverName = interaction.resolvedBy?.name?.trim() || "A user";
      return `${resolverName} approved relay access for ${deviceName}`;
    }
    return `Relay authorization requested for ${deviceName}`;
  }

  return `[Event: ${eventType}]`;
}

export type ConversationFeedItem =
  | ConversationFeedMessageItem
  | ConversationFeedEventItem;

export interface ConversationSummary {
  id: UUID;
  workspaceId: UUID;
  title: string;
  avatarUrl?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  unreadCount: number;
  lastItem?: {
    itemId: UUID;
    sequence: number;
    kind: ConversationFeedItem["kind"];
    role?: "user" | "assistant" | "system";
    previewText: string;
    authorName?: string;
    createdAt: Timestamp;
  };
}

export interface ConversationFeedPage {
  items: ConversationFeedItem[];
  hasMore: boolean;
  nextBeforeSequence?: number;
}

export interface WorkspaceFeedEventRecord {
  workspaceSequence: number;
  item: ConversationFeedItem;
}

export interface WorkspaceFeedPage {
  records: WorkspaceFeedEventRecord[];
  hasMore: boolean;
  nextAfterSequence?: number;
}

export type ChatSocketEventType =
  | "auth.ok"
  | "auth.error"
  | "ping"
  | "server.shutdown"
  | "feed.item.created"
  | "runtime.updated"
  | "conversation.updated"
  | "interaction.updated"
  | "feed.resync.required";

export interface ChatSocketEventPayloadMap {
  "auth.ok": {
    connectionId: UUID;
    heartbeatMs: number;
    workspaceId: UUID;
    lastWorkspaceSequence: number;
  };
  "auth.error": {
    message: string;
  };
  ping: {
    at: Timestamp;
  };
  "server.shutdown": {
    message: string;
    retryable: boolean;
  };
  "feed.item.created": WorkspaceFeedEventRecord;
  "runtime.updated": {
    conversationId: UUID;
    runtimeSeq: number;
    snapshot: ActorRuntimeState;
  };
  "conversation.updated": {
    conversationId: UUID;
    action: "created" | "profile_updated" | "cancelled";
    title?: string | null;
    avatarUrl?: string | null;
  };
  "interaction.updated": {
    conversationId: UUID;
    interactionId: UUID;
    itemId?: UUID;
    interaction: InteractionRequestSummary;
  };
  "feed.resync.required": {
    expectedWorkspaceSequence: number;
    actualWorkspaceSequence: number;
  };
}

export type ChatSocketEvent<
  T extends ChatSocketEventType = ChatSocketEventType,
> = {
  type: T;
  payload: ChatSocketEventPayloadMap[T];
};

// ============ A2A (Agent-to-Agent) Protocol ============
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export interface A2AApp {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description: string;
  apiKeyPrefix: string;
  rateLimitRpm: number;
  isActive: boolean;
  createdBy?: UUID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface A2AAppActor {
  id: UUID;
  appId: UUID;
  actorId: UUID;
  createdAt: Timestamp;
}

export interface A2ATask {
  id: UUID;
  appId: UUID;
  contextId?: string;
  sessionId: UUID;
  createdAt: Timestamp;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: A2AAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface A2APart {
  type: "text";
  text: string;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
}

export interface A2ATaskResponse {
  id: string;
  contextId?: string;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
    timestamp: string;
  };
  artifacts?: { parts: A2APart[]; index: number }[];
  history?: A2AMessage[];
}

// ============ Content Helpers ============

export function createCanonicalContentBlockId(prefix = "block"): UUID {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return randomUUID();
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export function textBlock(text: string, id?: UUID): CanonicalTextBlock {
  return {
    id:
      typeof id === "string" && id.trim().length > 0
        ? id
        : createCanonicalContentBlockId("text"),
    type: "text",
    text,
  };
}

export function fileRefBlock(
  input: Omit<CanonicalFileRefBlock, "id" | "type"> & { id?: UUID },
): CanonicalFileRefBlock {
  return {
    id:
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id
        : createCanonicalContentBlockId("file"),
    type: "file_ref",
    fileId: input.fileId,
    storedName: input.storedName,
    url: input.url,
    mimeType: input.mimeType,
    originalName: input.originalName,
    sizeBytes: input.sizeBytes,
    category: input.category,
  };
}

function normalizeContentBlockSizeBytes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function isCanonicalContentBlock(
  value: unknown,
): value is CanonicalContentBlock {
  if (!value || typeof value !== "object") return false;

  const block = value as Record<string, unknown>;
  if (typeof block.id !== "string" || block.id.trim().length === 0)
    return false;

  if (block.type === "text") {
    return typeof block.text === "string";
  }

  if (block.type === "file_ref") {
    const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes);
    return (
      typeof block.fileId === "string" &&
      typeof block.storedName === "string" &&
      typeof block.url === "string" &&
      typeof block.mimeType === "string" &&
      typeof block.originalName === "string" &&
      sizeBytes !== null &&
      (block.category === "image" ||
        block.category === "audio" ||
        block.category === "video" ||
        block.category === "document")
    );
  }

  return false;
}

export function normalizeCanonicalContentBlocks(
  blocks: CanonicalContentBlockInput[],
): CanonicalContentBlock[] {
  const normalized: CanonicalContentBlock[] = [];

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text") {
      if (typeof block.text !== "string") continue;
      normalized.push(textBlock(block.text, block.id));
      continue;
    }

    if (block.type === "file_ref") {
      const sizeBytes = normalizeContentBlockSizeBytes(block.sizeBytes);
      if (
        typeof block.fileId !== "string" ||
        typeof block.storedName !== "string" ||
        typeof block.url !== "string" ||
        typeof block.mimeType !== "string" ||
        typeof block.originalName !== "string" ||
        sizeBytes === null ||
        (block.category !== "image" &&
          block.category !== "audio" &&
          block.category !== "video" &&
          block.category !== "document")
      ) {
        continue;
      }

      normalized.push(
        fileRefBlock({
          ...block,
          sizeBytes,
        }),
      );
    }
  }

  return normalized;
}

/** Wrap a plain string into CanonicalContentBlock[] */
export function textBlocks(s: string): CanonicalContentBlock[] {
  return [textBlock(s)];
}

function createActorDocId(): UUID {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return randomUUID();
  }
  return `doc_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export const SECRETARY_DEFAULT_NAME = "Default Assistant"
export const SECRETARY_DEFAULT_TITLE = "Assistant"
export const SECRETARY_DEFAULT_CAN_REPRESENT_USER = false
export const SECRETARY_DEFAULT_SPECIALTIES: string[] = []

export const SECRETARY_DEFAULT_DOCS: ActorDoc[] = normalizeActorDocs([
  {
    id: createActorDocId(),
    key: "identity_card",
    title: "Identity Card",
    content: textBlocks("Default workspace assistant placeholder."),
    visibility: "always",
    priority: 120,
  },
  {
    id: createActorDocId(),
    key: "role_charter",
    title: "Role Charter",
    content: textBlocks("Assist with workspace coordination when a custom actor seed has not been provided."),
    visibility: "always",
    priority: 90,
  },
])

/** Extract concatenated text from CanonicalContentBlock[] */
export function extractText(blocks: CanonicalContentBlock[]): string {
  return blocks
    .filter((b): b is CanonicalTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

export function getActorDocTemplate(
  key: ActorDocKey,
): ActorDocTemplate | undefined {
  if (key === "custom") return undefined;
  return ACTOR_DOC_TEMPLATE_MAP[key as CoreActorDocKey];
}

function isNonEmptyActorDoc(doc: ActorDoc): boolean {
  return doc.content.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return true;
  });
}

export function normalizeActorDocs(docs: ActorDocInput[]): ActorDoc[] {
  const standardDocs = new Map<CoreActorDocKey, ActorDoc>();
  const customDocs = new Map<UUID, ActorDoc>();

  for (const doc of docs || []) {
    if (
      !doc ||
      typeof doc !== "object" ||
      !doc.key ||
      !Array.isArray(doc.content)
    )
      continue;
    if (doc.key !== "custom" && !(doc.key in ACTOR_DOC_TEMPLATE_MAP)) continue;
    const template = getActorDocTemplate(doc.key);
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
      visibility: doc.visibility || template?.defaultVisibility || "always",
      priority: Number.isFinite(doc.priority)
        ? doc.priority
        : template?.defaultPriority || 0,
    };

    if (!isNonEmptyActorDoc(normalizedDoc)) continue;
    if (normalizedDoc.key === "custom") {
      customDocs.set(normalizedDoc.id, normalizedDoc);
    } else {
      standardDocs.set(normalizedDoc.key as CoreActorDocKey, normalizedDoc);
    }
  }

  return [...standardDocs.values(), ...customDocs.values()].sort(
    (left, right) => {
      if (right.priority !== left.priority)
        return right.priority - left.priority;
      return left.title.localeCompare(right.title);
    },
  );
}

export function summarizeActorDoc(doc: ActorDoc, maxLength = 200): string {
  const text = extractText(doc.content).replace(/\s+/g, " ").trim();
  if (text.length > 0) {
    return text.length > maxLength
      ? `${text.slice(0, maxLength - 1)}...`
      : text;
  }

  const fileBlock = doc.content.find(
    (
      block,
    ): block is Extract<ActorDoc["content"][number], { type: "file_ref" }> =>
      block.type === "file_ref",
  );
  return fileBlock ? `Attached file: ${fileBlock.originalName}` : "";
}

export function pickActorDocSummary(
  docs: ActorDoc[],
  keys: ActorDocKey[],
  maxLength = 500,
  fallback = "",
): string {
  const fragments = keys
    .map((key) => docs.find((doc) => doc.key === key))
    .filter((doc): doc is ActorDoc => Boolean(doc))
    .map((doc) => summarizeActorDoc(doc, maxLength))
    .filter(Boolean);

  if (fragments.length > 0) {
    return fragments.join("\n\n");
  }

  return fallback;
}

export function summarizeActorForRole(
  docs: ActorDoc[],
  fallbackTitle = "",
): string {
  return pickActorDocSummary(
    docs,
    ["role_charter", "mission", "limitations_and_escalation"],
    500,
    fallbackTitle || "No role summary provided.",
  );
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
    700,
  );
}

// ============================================================
// Domain Model V2
// ============================================================

export type CatalogItemKind =
  | "actor_template"
  | "skill_package"
  | "plugin_package";
export type CatalogSourceKind =
  | "builtin"
  | "official"
  | "workspace"
  | "user"
  | "relay";
export type CatalogVisibility = "public" | "workspace" | "private";
export type CatalogVersionStatus =
  | "draft"
  | "active"
  | "deprecated"
  | "archived";
export type CatalogLineageKind =
  | "installed_copy"
  | "fork"
  | "share"
  | "relay_projection";
export type CatalogSyncMode =
  | "notify"
  | "manual_merge"
  | "follow_upstream"
  | "detached";
export type CatalogFileRole =
  | "document"
  | "reference"
  | "script"
  | "image"
  | "json"
  | "binary";
export type RuntimeBindingScope =
  | "workspace"
  | "conversation"
  | "actor"
  | "actor_conversation"
  | "user";
export type PluginReuseScopeV2 =
  | "turn"
  | "workspace"
  | "conversation"
  | "actor"
  | "actor_conversation"
  | "user";
export type AccessBindingStatus = "active" | "revoked";
export type AccessResourceType =
  | "workspace"
  | "conversation"
  | "actor"
  | "installed_skill"
  | "plugin_installation"
  | "relay_device"
  | "relay_exposure";
export type AccessSubjectType =
  | "platform"
  | "workspace"
  | "conversation"
  | "user"
  | "actor"
  | "workspace_user"
  | "actor_conversation";

export interface CatalogPublisherRecord {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  logoBlobId?: string;
  ownerUserId?: string;
  workspaceId?: string;
  isBuiltin: boolean;
  isVerified: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogItemRecord {
  id: string;
  publisherId: string;
  workspaceId?: string;
  itemKind: CatalogItemKind;
  slug: string;
  displayName: string;
  summary: string;
  longDescription: string;
  iconBlobId?: string;
  sourceKind: CatalogSourceKind;
  visibility: CatalogVisibility;
  tags: string[];
  latestVersionId?: string;
  isActive: boolean;
  downloadCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogVersionRecord {
  id: string;
  catalogItemId: string;
  version: string;
  status: CatalogVersionStatus;
  changelog: string;
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

export interface CatalogVersionFileRecord {
  id: string;
  catalogVersionId: string;
  path: string;
  fileRole: CatalogFileRole;
  mediaType?: string;
  blobId?: string;
  textContent?: string;
  contentBlocks: CanonicalContentBlock[];
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ActorTemplateVersionSpecRecord {
  catalogVersionId: string;
  role: ActorRole;
  name: string;
  avatarFileId?: string;
  avatarEmoji?: string;
  title: string;
  canRepresentUser: boolean;
  docs: ActorDoc[];
  specialties: string[];
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SkillPackageVersionSpecRecord {
  catalogVersionId: string;
  canonicalSlug: string;
  name: string;
  descriptionBlocks: CanonicalContentBlock[];
  summaryText: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PluginRuntimePermissionRecord {
  id: string;
  catalogVersionId: string;
  permissionKey: string;
  isRequired: boolean;
  rationale: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PluginPackageVersionSpecRecord {
  catalogVersionId: string;
  transport: "builtin" | "stdio" | "http" | "relay";
  entryPoint?: string;
  toolManifest: MarketplaceTool[];
  configSchema: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  installFlow: Record<string, unknown>;
  authBindings: PluginAuthBindingDefinition[];
  defaultMountScope: RuntimeBindingScope;
  defaultReuseScope: PluginReuseScopeV2;
  requiresHandshake: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AccessBindingRecord {
  id: string;
  workspaceId?: string;
  resourceType: AccessResourceType;
  resourceId: string;
  relation: string;
  subjectType: AccessSubjectType;
  subjectId: string;
  subjectRelation?: string;
  status: AccessBindingStatus;
  createdBy?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  revokedAt?: string;
}

export interface InstalledSkillRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  iconBlobId?: string;
  tags: string[];
  currentVersion: number;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: number;
  name: string;
  descriptionBlocks: CanonicalContentBlock[];
  summaryText: string;
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
}

export interface SkillFileRecord {
  id: string;
  skillVersionId: string;
  path: string;
  mediaType?: string;
  blobId?: string;
  textContent?: string;
  contentBlocks: CanonicalContentBlock[];
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SkillBindingRecord {
  id: string;
  skillId: string;
  workspaceId: string;
  bindScope: RuntimeBindingScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  status: "active" | "disabled" | "revoked";
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInstallationRecord {
  id: string;
  workspaceId: string;
  catalogItemId: string;
  catalogVersionId: string;
  displayName: string;
  configData: Record<string, unknown>;
  approvedRuntimePermissions: string[];
  status: "active" | "disabled" | "error" | "archived";
  installedBy?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PluginMountRecord {
  id: string;
  installationId: string;
  workspaceId: string;
  mountScope: RuntimeBindingScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  reuseScope: PluginReuseScopeV2;
  status: "active" | "disabled" | "revoked";
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelayDeviceRecord {
  id: string;
  workspaceId: string;
  ownerUserId?: string;
  displayName: string;
  clientKind: string;
  platform?: string;
  publicKeyFingerprint: string;
  trustStatus: "pending" | "active" | "revoked" | "blocked";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RelayExposureRecord {
  id: string;
  deviceId: string;
  syncSourceId?: string;
  stableKey: string;
  displayName: string;
  transport: "builtin" | "stdio" | "http" | "sse" | "custom";
  runtimeStatus:
    | "discovered"
    | "starting"
    | "healthy"
    | "degraded"
    | "failed"
    | "quarantined"
    | "offline";
  projectedCatalogItemId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
