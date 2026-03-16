export * from './relay.js';

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

export type AuthClientType = 'web' | 'android' | 'windows' | 'ios' | 'cli' | 'api';

export type AuthTransport = 'cookie' | 'token';

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

// ============ Workspace ============
export type TrustLevel = 'owner' | 'admin' | 'member' | 'guest';

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

// ============ Workspace Invites ============
export type InviteTrustLevel = 'admin' | 'member' | 'guest';

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
export type ActorRole = 'secretary' | 'manager' | 'specialist' | 'reviewer' | 'archivist' | 'receptionist' | 'assistant';

export type ActorDocVisibility = 'always' | 'solo_only' | 'group_only' | 'internal_only';

export type CoreActorDocKey =
  | 'identity_card'
  | 'public_persona'
  | 'soul'
  | 'self_narrative'
  | 'origin_story'
  | 'relationship_with_user'
  | 'relationship_with_team'
  | 'representation_guidelines'
  | 'social_protocol'
  | 'role_charter'
  | 'mission'
  | 'work_doctrine'
  | 'limitations_and_escalation'
  | 'quirks_and_signatures'
  | 'routines'
  | 'conversation_examples';

export type ActorDocKey = CoreActorDocKey | 'custom';

export interface ActorDoc {
  id: UUID;
  key: ActorDocKey;
  title: string;
  content: CanonicalContentBlock[];
  visibility: ActorDocVisibility;
  priority: number;
}

export type ActorDocInput = Omit<ActorDoc, 'id' | 'content'> & {
  id?: UUID;
  content: CanonicalContentBlockInput[];
};

export interface ActorDefinition {
  name: string;
  role: ActorRole;
  title: string;
  avatarFileId?: UUID;
  parentId?: UUID;
  canRepresentUser: boolean;
  docs: ActorDoc[];
  capabilities: string[];
  config: Record<string, unknown>;
}

export type ActorVersionChangedField =
  | 'name'
  | 'role'
  | 'title'
  | 'avatarFileId'
  | 'parentId'
  | 'canRepresentUser'
  | 'capabilities'
  | 'config';

export interface ActorVersionDocChange {
  docId: UUID;
  key: ActorDocKey;
  title: string;
  changeType: 'added' | 'updated' | 'removed';
  visibility: ActorDocVisibility;
  priority: number;
  before?: ActorDoc;
  after?: ActorDoc;
  summary: CanonicalContentBlock[];
}

export interface ActorVersionDelta {
  fromVersion: number;
  toVersion: number;
  changedFields: ActorVersionChangedField[];
  changedDocs: ActorVersionDocChange[];
  summary: CanonicalContentBlock[];
}

export interface ActorVersion {
  id: UUID;
  actorId: UUID;
  version: number;
  snapshot: ActorDefinition;
  delta?: ActorVersionDelta;
  createdAt: Timestamp;
}

export interface Actor {
  id: UUID;
  workspaceId: UUID;
  definition: ActorDefinition;
  avatarUrl?: string;
  currentVersion: number;
  templateLink?: ActorTemplateLink;
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
  | 'created'
  | 'assigned'
  | 'accepted'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'escalated'
  | 'blocked'
  | 'rework'
  | 'cancelled'
  | 'failed';

export type WorkItemPriority = 'low' | 'medium' | 'high' | 'urgent';

export type ParticipantRole = 'owner' | 'accountable' | 'executor' | 'reviewer' | 'watcher';

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
  sourceType: 'user_message' | 'delegation' | 'standing_order' | 'escalation' | 'collaboration';
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
  created: ['assigned', 'cancelled'],
  assigned: ['accepted', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['review', 'escalated', 'blocked', 'cancelled', 'failed'],
  review: ['completed', 'rework', 'cancelled'],
  completed: [],
  escalated: ['assigned', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  rework: ['in_progress', 'cancelled'],
  cancelled: [],
  failed: [],
};

// ============ Communication Protocol ============
export type MessageType =
  | 'assign'
  | 'accept'
  | 'reject'
  | 'info_request'
  | 'info_response'
  | 'progress'
  | 'escalate'
  | 'assist_request'
  | 'assist_response'
  | 'transfer'
  | 'complete'
  | 'feedback'
  | 'rework'
  | 'user_message'
  | 'secretary_response';

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
export type MemoryScope = 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
export type MemoryGrantScope = MemoryScope | 'workspace_user';
export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'relationship' | 'procedure' | 'artifact' | 'summary';
export type MemoryStatus = 'candidate' | 'established' | 'superseded' | 'retracted';
export type MemoryStability = 'ephemeral' | 'durable';
export type MemoryRecallType = 'bootstrap' | 'turn_recall' | 'manual_search';
export type MemoryPermission = 'read' | 'edit' | 'grant' | 'retarget' | 'delete';

export interface MemoryGrant {
  id: UUID;
  memoryId: UUID;
  workspaceId: UUID;
  permission: MemoryPermission;
  grantScope: MemoryGrantScope;
  actorId?: UUID;
  conversationId?: UUID;
  userId?: UUID;
  status: 'active' | 'revoked';
  grantedBy?: UUID;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  revokedAt?: Timestamp;
}

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
  grants: MemoryGrant[];
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
  matchedGrantIds?: UUID[];
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

// ============ Standing Orders ============
export type StandingOrderTrigger = 'cron' | 'event' | 'condition';

export interface StandingOrder {
  id: UUID;
  workspaceId: UUID;
  actorId: UUID;
  name: string;
  description: string;
  triggerType: StandingOrderTrigger;
  triggerConfig: Record<string, unknown>; // { cron: '0 9 * * *' } or { event: 'work_item.completed' }
  instruction: string;
  isActive: boolean;
  lastTriggeredAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============ Audit ============
export type AuditAction =
  | 'user.register' | 'user.login'
  | 'workspace.create' | 'workspace.update' | 'workspace.delete'
  | 'actor.create' | 'actor.update' | 'actor.delete'
  | 'work_item.create' | 'work_item.transition' | 'work_item.assign'
  | 'message.create'
  | 'memory.create' | 'memory.update' | 'memory.delete'
  | 'ai.think' | 'ai.action'
  | 'standing_order.create' | 'standing_order.trigger';

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
  | 'work_item.created' | 'work_item.updated' | 'work_item.transitioned'
  | 'message.created'
  | 'actor.created' | 'actor.updated'
  | 'memory.created'
  | 'user.message' // User sent message to secretary
  | 'secretary.response'
  | 'actor.thinking' | 'actor.action'
  | 'session.message.new' | 'session.status.changed' | 'session.thinking' | 'group.actor.runtime.updated' | 'group.updated'
  | 'group.member_joined' | 'group.member_kicked' | 'actor.version_changed'
  | 'chat.feed.item.created' | 'chat.runtime.updated' | 'chat.conversation.updated'
  | 'mcp.config.changed'
  | 'relay.connected' | 'relay.disconnected' | 'relay.servers_updated';

export interface SystemEvent {
  type: EventType;
  workspaceId: UUID;
  payload: Record<string, unknown>;
  timestamp: Timestamp;
}

// ============ AI ============
export type SessionStatus = 'idle' | 'queued' | 'running' | 'blocked' | 'closed';
export type ChannelType = 'web' | 'api';
export type SessionTrigger =
  | 'user_message'
  | 'group_message'
  | 'actor_message'
  | 'broadcast'
  | 'api_call'
  | 'actor_invite'
  | 'system_interrupt'
  | 'retry';
export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool_result';
export type SessionInterruptType = 'progress_check' | 'priority_override';
export type SessionWakeupSourceType =
  | 'user_message'
  | 'actor_message'
  | 'broadcast'
  | 'invite'
  | 'api_call'
  | 'system_interrupt'
  | 'retry';
export type SessionWakeupStatus = 'pending' | 'attached' | 'processed' | 'dropped';
export type ActorRuntimeHealth = 'ok' | 'error';
export type ActorRuntimePhase = 'idle' | 'thinking' | 'tool' | 'responding' | 'blocked' | 'error';

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
  sourceMemberType?: 'user' | 'actor' | 'system';
  sourceMemberId?: UUID;
  sourceName?: string;
  summary: string;
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
  sourceMemberType?: 'user' | 'actor' | 'system';
  sourceMemberId?: UUID;
  sourceName?: string;
  summary: string;
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
  type: 'respond' | 'create_memory' | 'rename_self' | 'change_avatar';
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
  type: 'web_search' | 'web_fetch';
  query?: string;   // web_search query
  url?: string;     // web_fetch URL
  results?: ServerToolSearchResult[];
}

export interface ServerToolSearchResult {
  url: string;
  title: string;
  pageAge?: string;
}

// ============ Model Groups ============
export type RoutingStrategy = 'weighted_random' | 'round_robin' | 'priority_failover';
export type ProviderType = 'anthropic' | 'openai';
export type AIRequestType = 'actor_think' | 'ai_complete';
export type AIRequestStatus = 'success' | 'error' | 'timeout';

export interface ModelGroup {
  id: UUID;
  ownerType?: 'platform' | 'workspace' | 'user';
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
  grantScope: 'platform' | 'workspace' | 'user' | 'workspace_user' | 'actor';
  workspaceId?: UUID | null;
  userId?: UUID | null;
  actorId?: UUID | null;
  status: 'active' | 'revoked';
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

export type AnthropicBuiltinTool = 'web_search' | 'web_fetch';

export type MultimodalType = 'image' | 'audio' | 'video' | 'document';

export interface MultimodalConfig {
  supported: boolean;
  types: MultimodalType[];
}

export interface ResolvedModelConfig {
  groupId: UUID;
  profileId: UUID;
  profileRevisionId: UUID;
  providerType: ProviderType;
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
  routingStrategy: 'weighted_random' | 'round_robin' | 'priority_failover';
  attemptPolicy: ModelAttemptPolicy;
  candidates: ResolvedModelConfig[];
}

// ============ Canonical Content Block ============
// Unified representation: text stored directly, media via file_ref pointing to platform file storage
export type CanonicalFileCategory = 'image' | 'audio' | 'video' | 'document';

export interface CanonicalTextBlock {
  id: UUID;
  type: 'text';
  text: string;
}

export interface CanonicalFileRefBlock {
  id: UUID;
  type: 'file_ref';
  fileId: string;        // files table UUID
  storedName: string;    // disk relative path (resolved via readAsBuffer)
  url: string;           // /files/... (frontend display)
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  category: CanonicalFileCategory;
}

export type CanonicalContentBlock = CanonicalTextBlock | CanonicalFileRefBlock;

export type CanonicalTextBlockInput = Omit<CanonicalTextBlock, 'id'> & { id?: UUID };
export type CanonicalFileRefBlockInput = Omit<CanonicalFileRefBlock, 'id'> & { id?: UUID };
export type CanonicalContentBlockInput = CanonicalTextBlockInput | CanonicalFileRefBlockInput;

export interface ActorDocTemplate {
  key: CoreActorDocKey;
  title: string;
  description: string;
  defaultVisibility: ActorDocVisibility;
  defaultPriority: number;
}

export const ACTOR_DOC_TEMPLATES: ActorDocTemplate[] = [
  {
    key: 'identity_card',
    title: 'Identity Card',
    description: 'How this actor introduces themselves in public.',
    defaultVisibility: 'always',
    defaultPriority: 120,
  },
  {
    key: 'public_persona',
    title: 'Public Persona',
    description: 'Voice, tone, and how this actor appears to others.',
    defaultVisibility: 'always',
    defaultPriority: 115,
  },
  {
    key: 'soul',
    title: 'Soul',
    description: 'Values, principles, taboos, and emotional core.',
    defaultVisibility: 'always',
    defaultPriority: 110,
  },
  {
    key: 'self_narrative',
    title: 'Self Narrative',
    description: 'How this actor understands themselves.',
    defaultVisibility: 'always',
    defaultPriority: 105,
  },
  {
    key: 'origin_story',
    title: 'Origin Story',
    description: 'Where this actor comes from and what shaped them.',
    defaultVisibility: 'internal_only',
    defaultPriority: 100,
  },
  {
    key: 'relationship_with_user',
    title: 'Relationship With User',
    description: 'How this actor relates to the human user.',
    defaultVisibility: 'always',
    defaultPriority: 98,
  },
  {
    key: 'relationship_with_team',
    title: 'Relationship With Team',
    description: 'How this actor views and works with other actors.',
    defaultVisibility: 'group_only',
    defaultPriority: 96,
  },
  {
    key: 'representation_guidelines',
    title: 'Representation Guidelines',
    description: 'How to speak or act when representing the user.',
    defaultVisibility: 'internal_only',
    defaultPriority: 94,
  },
  {
    key: 'social_protocol',
    title: 'Social Protocol',
    description: 'When to speak, when to stay quiet, and what not to share.',
    defaultVisibility: 'group_only',
    defaultPriority: 92,
  },
  {
    key: 'role_charter',
    title: 'Role Charter',
    description: 'Organizational responsibilities and scope.',
    defaultVisibility: 'always',
    defaultPriority: 90,
  },
  {
    key: 'mission',
    title: 'Mission',
    description: 'Long-term aim, current mission, and success criteria.',
    defaultVisibility: 'always',
    defaultPriority: 88,
  },
  {
    key: 'work_doctrine',
    title: 'Work Doctrine',
    description: 'How this actor approaches work, evidence, and communication.',
    defaultVisibility: 'always',
    defaultPriority: 86,
  },
  {
    key: 'limitations_and_escalation',
    title: 'Limitations And Escalation',
    description: 'Blind spots, refusal zones, and when to ask for help.',
    defaultVisibility: 'always',
    defaultPriority: 84,
  },
  {
    key: 'quirks_and_signatures',
    title: 'Quirks And Signatures',
    description: 'Habits, running jokes, signatures, and expressive details.',
    defaultVisibility: 'always',
    defaultPriority: 82,
  },
  {
    key: 'routines',
    title: 'Routines',
    description: 'Recurring habits, checks, and proactive rhythms.',
    defaultVisibility: 'internal_only',
    defaultPriority: 80,
  },
  {
    key: 'conversation_examples',
    title: 'Conversation Examples',
    description: 'Examples of how this actor speaks, declines, or collaborates.',
    defaultVisibility: 'internal_only',
    defaultPriority: 78,
  },
];

export const ACTOR_DOC_TEMPLATE_MAP: Record<CoreActorDocKey, ActorDocTemplate> = Object.fromEntries(
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

export type CanonicalContextScope = 'shared' | 'private';
export type CanonicalContextSurface = 'visible' | 'internal';
export type CanonicalContextRole = 'user' | 'assistant' | 'system' | 'tool';
export type CanonicalContextMemberType = 'actor' | 'user' | 'remote_agent' | 'system' | 'unknown';
export type ConversationEventTimelinePolicy =
  | 'none'
  | 'all_members'
  | 'users_only'
  | 'actors_only'
  | 'targeted_members';
export type ConversationEventContextPolicy =
  | 'none'
  | 'shared'
  | 'actor_private'
  | 'targeted_members';

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
  memberType: Exclude<CanonicalContextMemberType, 'unknown'>;
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
  kind: 'system_notice';
  noticeType: 'interrupt' | 'task_instruction' | 'legacy_tool_result' | 'generic';
  parts: CanonicalContentBlock[];
}

export interface CanonicalEventContextItem extends CanonicalContextItemBase {
  kind: 'event';
  eventType: string;
  eventPayload?: Record<string, unknown>;
  timelinePolicy?: ConversationEventTimelinePolicy;
  contextPolicy?: ConversationEventContextPolicy;
  author?: CanonicalContextAuthor;
  targets?: CanonicalContextTarget[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalMessageContextItem extends CanonicalContextItemBase {
  kind: 'message';
  messageType: string;
  role: CanonicalContextRole;
  author?: CanonicalContextAuthor;
  targets?: CanonicalContextTarget[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalToolCallBatchContextItem extends CanonicalContextItemBase {
  kind: 'tool_call_batch';
  role: 'assistant';
  bundleId?: string;
  author?: CanonicalContextAuthor;
  content?: CanonicalContentBlock[];
  toolCalls: CanonicalToolCall[];
}

export interface CanonicalToolResultBatchContextItem extends CanonicalContextItemBase {
  kind: 'tool_result_batch';
  bundleId?: string;
  toolResults: CanonicalToolResult[];
}

export interface CanonicalSummaryContextItem extends CanonicalContextItemBase {
  kind: 'summary';
  summaryType: string;
  sourceItemIds?: string[];
  parts: CanonicalContentBlock[];
}

export interface CanonicalMemoryRecallContextItem extends CanonicalContextItemBase {
  kind: 'memory_recall';
  recallType: Exclude<MemoryRecallType, 'manual_search'>;
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

export type CanonicalArchiveFrameRole = 'system' | 'user' | 'assistant' | 'tool';
export type CanonicalArchiveChainScope = 'shared' | 'private';

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

// ============ Conversation Message ============
export type ConversationMessage =
  | { role: 'user'; content: CanonicalContentBlock[] }
  | { role: 'assistant'; content: CanonicalContentBlock[]; toolCalls?: CanonicalToolCall[] }
  | { role: 'tool_result'; results: CanonicalToolResult[] };

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
    type: 'object';
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
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolResult {
  toolCallId: string;
  providerCallId?: string;
  toolName: string;
  content: string | unknown[];  // string for text-only, array for multimodal (MCP content blocks)
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
  type: 'actor' | 'user';
  id: string;
  name: string;
  title?: string;
}

export interface ToolResolveContext {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  groupId?: string;
  groupMembers?: GroupMemberEntry[];
  userId?: string;
  availableSkills?: CapabilityAvailableSkill[];
}

export interface ToolPlugin {
  name: string;
  kind: 'action' | 'callable';
  definition: ToolDefinition;
  resolve?: (ctx: ToolResolveContext) => { active: boolean; definition: ToolDefinition };
  execute?: (input: Record<string, unknown>) => Promise<string>;
}

export interface AIResponse {
  context: ConversationMessage[];    // [{ role: 'assistant', content, toolCalls? }]
  tokensUsed: { input: number; output: number };
  stopReason: string;                // e.g. 'end_turn', 'tool_use' (Anthropic) or 'stop', 'tool_calls' (OpenAI)
  rawAssistantMessage?: unknown;     // Provider-specific raw assistant message for server tool extraction
  mediaBlocks?: unknown[];           // Provider raw media content blocks (images, audio from model response)
}

// ============================================================
// MCP Plugin Marketplace Types
// ============================================================

export type CapabilityPackageKind = 'plugin' | 'skill' | 'actor_template' | 'model';
export type CapabilityTransport = 'builtin' | 'stdio' | 'http' | 'relay' | 'filesystem';
export type CapabilityAttachmentType = 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
export type CapabilityReuseScope = 'turn' | 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
export type CapabilityGrantScope = CapabilityAttachmentType;
export type CapabilitySourceType = 'builtin' | 'official' | 'workspace_upload' | 'user_upload' | 'relay_derived';
export type CapabilityRequirementKind = 'required' | 'recommended' | 'optional' | 'conflicts_with';
export type CapabilityRequirementTargetKind = 'package' | 'tag';
export type CapabilityInstanceInstallMode =
  | 'manual'
  | 'seeded'
  | 'relay_derived'
  | 'template_required'
  | 'template_recommended';
export type CapabilityRevisionStatus = 'draft' | 'active' | 'deprecated' | 'archived';
export type CapabilityGrantStatus = 'active' | 'revoked';
export type CapabilityRequirementStatus = 'satisfied' | 'missing_required' | 'missing_recommended' | 'scope_mismatch' | 'config_incomplete';
export type CapabilityAssetKind = 'skill_markdown' | 'reference_markdown' | 'script' | 'json' | 'text' | 'binary';
export type LocalizedText = Record<string, string>;
export type CapabilityConfigFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'secret'
  | 'oauth_connection'
  | 'file';
export type CapabilityInstallStepKind =
  | 'form'
  | 'oauth'
  | 'check'
  | 'confirm'
  | 'attachment_scope'
  | 'reuse_scope';
export type CapabilityInstallActionKind = 'oauth_authorize' | 'external_link' | 'noop';
export type CapabilityAuthProviderKind = 'oauth2_authorization_code_pkce';
export type CapabilityAuthSessionStatus = 'pending' | 'completed' | 'failed' | 'expired' | 'consumed';
export type CapabilityAuthConnectionStatus = 'active' | 'expired' | 'revoked';

export interface CapabilityConfigFieldOption {
  value: string;
  labelI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
}

export interface CapabilityConfigFieldDefinition {
  key: string;
  type: CapabilityConfigFieldType;
  titleI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  placeholderI18n?: LocalizedText;
  required?: boolean;
  defaultValue?: unknown;
  options?: CapabilityConfigFieldOption[];
  secret?: boolean;
  serverManaged?: boolean;
  authProviderKey?: string;
  validation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CapabilityInstallAction {
  kind: CapabilityInstallActionKind;
  providerKey?: string;
  url?: string;
  buttonLabelI18n?: LocalizedText;
  metadata?: Record<string, unknown>;
}

export interface CapabilityInstallStep {
  id: string;
  kind: CapabilityInstallStepKind;
  titleI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  scope: 'workspace' | 'plugin';
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpTextI18n?: LocalizedText;
  action?: CapabilityInstallAction;
  metadata?: Record<string, unknown>;
}

export interface CapabilityInstallFlow {
  steps: CapabilityInstallStep[];
}

export interface CapabilityAuthProviderDefinition {
  key: string;
  kind: CapabilityAuthProviderKind;
  displayNameI18n: LocalizedText;
  descriptionI18n?: LocalizedText;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  audience?: string;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  profileIdPath?: string;
  profileDisplayNamePath?: string;
  profileAvatarUrlPath?: string;
  reusable?: boolean;
  configFieldKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilityConfigFieldState {
  key: string;
  isConfigured: boolean;
  maskedValue?: string;
  authConnectionId?: string;
  accountDisplayName?: string;
  updatedAt?: string;
}

export interface CapabilityAuthorizationManifest {
  requiredPermissions: string[];
  defaultGrantScope?: CapabilityGrantScope;
  reason?: string;
}

export interface CapabilityPublisher {
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

export interface CapabilityCategory {
  id: string;
  slug: string;
  targetKind: CapabilityPackageKind;
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

export interface CapabilityPackageTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CapabilityAsset {
  id: string;
  revisionId: string;
  path: string;
  assetKind: CapabilityAssetKind;
  mediaType?: string;
  sizeBytes: number;
  sha256: string;
  textContent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CapabilityPackageRevision {
  id: string;
  packageId: string;
  version: string;
  status: CapabilityRevisionStatus;
  manifest: Record<string, unknown>;
  authorization?: CapabilityAuthorizationManifest;
  configSchema: Record<string, unknown>;
  configFields: CapabilityConfigFieldDefinition[];
  defaultConfig: Record<string, unknown>;
  transport?: CapabilityTransport;
  entryPoint?: string;
  toolsManifest: CapabilityPackageTool[];
  validationRules: McpValidationRule[];
  setupSteps: CapabilityInstallStep[];
  installFlow?: CapabilityInstallFlow;
  authProviders: CapabilityAuthProviderDefinition[];
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  assets?: CapabilityAsset[];
}

export interface CapabilityPackage {
  id: string;
  publisherId: string;
  workspaceId?: string;
  kind: CapabilityPackageKind;
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
  sourceType: CapabilitySourceType;
  tags: string[];
  isActive: boolean;
  isBuiltin: boolean;
  downloadCount: number;
  latestRevisionId?: string;
  defaultInstanceScope?: CapabilityAttachmentType;
  defaultReuseScope?: CapabilityReuseScope;
  defaultIdleTtlMs?: number;
  defaultMaxAgeMs?: number;
  requiresHandshake: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  categories?: CapabilityCategory[];
  publisher?: CapabilityPublisher;
  latestRevision?: CapabilityPackageRevision;
}

export interface CapabilityInstance {
  id: string;
  workspaceId: string;
  packageId: string;
  revisionId: string;
  attachmentType: CapabilityAttachmentType;
  attachmentId?: string;
  attachmentConversationId?: string;
  attachmentActorId?: string;
  attachmentUserId?: string;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  installMode: CapabilityInstanceInstallMode;
  reuseScope: CapabilityReuseScope;
  idleTtlMs?: number;
  maxAgeMs?: number;
  requiresHandshake: boolean;
  isEnabled: boolean;
  configData: Record<string, unknown>;
  configState: CapabilityConfigFieldState[];
  installedBy?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  package?: CapabilityPackage;
  revision?: CapabilityPackageRevision;
}

export interface CapabilityGrant {
  id: string;
  instanceId: string;
  workspaceId: string;
  grantScope: CapabilityGrantScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  permissions: string[];
  status: CapabilityGrantStatus;
  grantedBy?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  revokedAt?: string;
}

export interface CapabilityAuthSession {
  id: string;
  workspaceId: string;
  packageId: string;
  revisionId?: string;
  providerKey: string;
  userId: string;
  status: CapabilityAuthSessionStatus;
  state: string;
  codeVerifier?: string;
  redirectUri: string;
  authorizeUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  resultPreview: Record<string, unknown>;
  authConnectionId?: string;
  metadata: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityAuthConnection {
  id: string;
  workspaceId: string;
  packageId: string;
  providerKey: string;
  ownerUserId: string;
  externalAccountId?: string;
  displayName?: string;
  avatarUrl?: string;
  scopes: string[];
  status: CapabilityAuthConnectionStatus;
  expiresAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRequirement {
  id: string;
  revisionId: string;
  requirementKind: CapabilityRequirementKind;
  targetKind: CapabilityRequirementTargetKind;
  targetPackageKind?: CapabilityPackageKind;
  targetPublisherSlug?: string;
  targetPackageSlug?: string;
  targetTag?: string;
  acceptableInstanceScopes: CapabilityAttachmentType[];
  acceptableReuseScopes: CapabilityReuseScope[];
  description: string;
  configPredicate: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CapabilityRequirementCheck {
  requirementId: string;
  requirementKind: CapabilityRequirementKind;
  status: CapabilityRequirementStatus;
  message: string;
  matchedInstanceIds: string[];
  missingPublisherSlug?: string;
  missingPackageSlug?: string;
  missingTag?: string;
}

export interface CapabilityInstallPlan {
  packageId: string;
  revisionId: string;
  workspaceId: string;
  attachmentType: CapabilityAttachmentType;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  checks: CapabilityRequirementCheck[];
  grantPlan?: {
    requiresGrant: boolean;
    requiredPermissions: string[];
    suggestedGrantScope?: CapabilityGrantScope;
    reason?: string;
  };
}

export type ActorTemplateDependencyKind = Extract<CapabilityRequirementKind, 'required' | 'recommended'>;
export type ActorTemplateTargetKind = Extract<CapabilityPackageKind, 'plugin' | 'skill'>;
export type ActorTemplateSyncMode = 'notify' | 'manual_merge';
export type ActorTemplateLinkStatus =
  | 'up_to_date'
  | 'update_available'
  | 'diverged'
  | 'update_available_with_local_changes'
  | 'detached';

export interface ActorTemplateDependency {
  requirementId?: string;
  requirementKind: ActorTemplateDependencyKind;
  targetPackageKind: ActorTemplateTargetKind;
  targetPublisherSlug?: string;
  targetPackageSlug: string;
  acceptableInstanceScopes: CapabilityAttachmentType[];
  acceptableReuseScopes: CapabilityReuseScope[];
  description: string;
  notes: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
}

export interface ActorTemplateManifest {
  actor: ActorDefinition;
  setupGuide: CanonicalContentBlock[];
  releaseNotes: CanonicalContentBlock[];
}

export interface ActorTemplateLink {
  actorId: UUID;
  templatePackageId: UUID;
  importedRevisionId: UUID;
  templateSlug: string;
  templateDisplayName: string;
  templatePublisherSlug?: string;
  templatePublisherDisplayName?: string;
  importedTemplateVersion?: string;
  latestRevisionId?: UUID;
  latestTemplateVersion?: string;
  baselineActorVersion: number;
  syncMode: ActorTemplateSyncMode;
  hasLocalChanges: boolean;
  hasUpstreamUpdate: boolean;
  status: ActorTemplateLinkStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ActorTemplateRecord {
  package: CapabilityPackage;
  manifest: ActorTemplateManifest;
  dependencies: ActorTemplateDependency[];
  requirementChecks?: CapabilityRequirementCheck[];
}

export interface ActorTemplateCloneResult {
  actor: Actor;
  template: ActorTemplateRecord;
  templateLink: ActorTemplateLink;
  requirementChecks: CapabilityRequirementCheck[];
}

export interface CapabilityAvailableSkill {
  instanceId: string;
  packageId: string;
  revisionId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  attachmentType: CapabilityAttachmentType;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  entryPoint?: string;
}

export type McpTransport = Exclude<CapabilityTransport, 'filesystem'>;
export type McpLifecycleScope = CapabilityReuseScope;
export type McpAttachmentType = CapabilityAttachmentType;

export type McpOrganization = CapabilityPublisher;
export type McpPluginTool = CapabilityPackageTool;

export interface McpPlugin extends CapabilityPackage {
  kind: 'plugin';
}

export interface McpInstallation extends CapabilityInstance {
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
  transport: 'builtin' | 'stdio' | 'http';
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
  rule: 'required' | 'pattern' | 'url' | 'min_length' | 'max_length' | 'prefix' | 'enum';
  value?: string | number | string[];
  message: string;
}

export interface McpSetupStep {
  id: string;
  kind?: CapabilityInstallStepKind;
  title?: string;
  titleI18n?: LocalizedText;
  description?: string;
  descriptionI18n?: LocalizedText;
  scope: 'workspace' | 'plugin';
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpText?: string;
  helpTextI18n?: LocalizedText;
  action?: CapabilityInstallAction;
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
  sessionId: UUID | '';
  role: 'user' | 'assistant' | 'system';
  fromUserId?: UUID;
  fromActorId?: UUID;
  actorName?: string;
  targetActorIds: UUID[];
  targetUserIds: UUID[];
  content: string;
  contentBlocks: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
}

export type ConversationMemberType = 'actor' | 'user' | 'system';

export interface ConversationEntityRef {
  memberId?: UUID;
  memberType: ConversationMemberType;
  actorId?: UUID;
  userId?: UUID;
  name?: string;
  title?: string;
  role?: string;
  avatarUrl?: string;
  avatarEmoji?: string;
}

export type ConversationMemberRef = ConversationEntityRef & {
  memberId: UUID;
  memberType: 'actor' | 'user';
};

export interface ActorVersionDocChangeWire {
  docId: UUID;
  key: ActorDocKey;
  title: string;
  changeType: 'added' | 'updated' | 'removed';
  visibility: ActorDocVisibility;
  priority: number;
  summaryText?: string;
}

export type ConversationFeedEventType =
  | 'member_joined'
  | 'member_kicked'
  | 'member_left'
  | 'memory_saved'
  | 'memory_updated'
  | 'actor_renamed'
  | 'actor_avatar_changed'
  | 'actor_version_changed';

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
    newAvatarEmoji: string;
    sourceTurnId?: UUID;
  };
  actor_version_changed: {
    actor: ConversationEntityRef;
    fromVersion: number;
    toVersion: number;
    changedFields: ActorVersionChangedField[];
    changedDocs: ActorVersionDocChangeWire[];
  };
}

export type ConversationFeedEventPayload<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> = ConversationFeedEventPayloadMap[T];

export interface ConversationFeedMessageItem {
  kind: 'message';
  itemId: UUID;
  conversationId: UUID;
  sequence: number;
  workspaceSequence?: number;
  sessionId?: UUID;
  turnId?: UUID;
  role: 'user' | 'assistant' | 'system';
  author?: ConversationEntityRef;
  targets: ConversationEntityRef[];
  content: string;
  contentBlocks: CanonicalContentBlock[];
  metadata: Record<string, unknown>;
  createdAt: Timestamp;
  clientMessageId?: string;
}

export interface ConversationFeedEventItem<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> {
  kind: 'event';
  itemId: UUID;
  conversationId: UUID;
  sequence: number;
  workspaceSequence?: number;
  sessionId?: UUID;
  turnId?: UUID;
  author?: ConversationEntityRef;
  causedByItemId?: UUID;
  eventType: T;
  payload: ConversationFeedEventPayloadMap[T];
  fallbackText?: string;
  createdAt: Timestamp;
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
    kind: ConversationFeedItem['kind'];
    role?: 'user' | 'assistant' | 'system';
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

export type ChatSocketEventType =
  | 'auth.ok'
  | 'auth.error'
  | 'ping'
  | 'server.shutdown'
  | 'feed.item.created'
  | 'runtime.updated'
  | 'conversation.updated'
  | 'feed.resync.required';

export interface ChatSocketEventPayloadMap {
  'auth.ok': {
    connectionId: UUID;
    heartbeatMs: number;
    workspaceId: UUID;
    lastWorkspaceSequence: number;
  };
  'auth.error': {
    message: string;
  };
  ping: {
    at: Timestamp;
  };
  'server.shutdown': {
    message: string;
    retryable: boolean;
  };
  'feed.item.created': WorkspaceFeedEventRecord;
  'runtime.updated': {
    conversationId: UUID;
    runtimeSeq: number;
    snapshot: ActorRuntimeState;
  };
  'conversation.updated': {
    conversationId: UUID;
    action: 'created' | 'profile_updated' | 'cancelled';
    title?: string | null;
    avatarUrl?: string | null;
  };
  'feed.resync.required': {
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
export type A2ATaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';

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
  type: 'text';
  text: string;
}

export interface A2AMessage {
  role: 'user' | 'agent';
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

export function createCanonicalContentBlockId(prefix = 'block'): UUID {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) {
    return randomUUID();
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

export function textBlock(text: string, id?: UUID): CanonicalTextBlock {
  return {
    id: typeof id === 'string' && id.trim().length > 0 ? id : createCanonicalContentBlockId('text'),
    type: 'text',
    text,
  };
}

export function fileRefBlock(input: Omit<CanonicalFileRefBlock, 'id' | 'type'> & { id?: UUID }): CanonicalFileRefBlock {
  return {
    id: typeof input.id === 'string' && input.id.trim().length > 0 ? input.id : createCanonicalContentBlockId('file'),
    type: 'file_ref',
    fileId: input.fileId,
    storedName: input.storedName,
    url: input.url,
    mimeType: input.mimeType,
    originalName: input.originalName,
    sizeBytes: input.sizeBytes,
    category: input.category,
  };
}

export function isCanonicalContentBlock(value: unknown): value is CanonicalContentBlock {
  if (!value || typeof value !== 'object') return false;

  const block = value as Record<string, unknown>;
  if (typeof block.id !== 'string' || block.id.trim().length === 0) return false;

  if (block.type === 'text') {
    return typeof block.text === 'string';
  }

  if (block.type === 'file_ref') {
    return typeof block.fileId === 'string'
      && typeof block.storedName === 'string'
      && typeof block.url === 'string'
      && typeof block.mimeType === 'string'
      && typeof block.originalName === 'string'
      && typeof block.sizeBytes === 'number'
      && (block.category === 'image' || block.category === 'audio' || block.category === 'video' || block.category === 'document');
  }

  return false;
}

export function normalizeCanonicalContentBlocks(blocks: CanonicalContentBlockInput[]): CanonicalContentBlock[] {
  const normalized: CanonicalContentBlock[] = [];

  for (const block of blocks || []) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text') {
      if (typeof block.text !== 'string') continue;
      normalized.push(textBlock(block.text, block.id));
      continue;
    }

    if (block.type === 'file_ref') {
      if (
        typeof block.fileId !== 'string'
        || typeof block.storedName !== 'string'
        || typeof block.url !== 'string'
        || typeof block.mimeType !== 'string'
        || typeof block.originalName !== 'string'
        || typeof block.sizeBytes !== 'number'
        || (block.category !== 'image' && block.category !== 'audio' && block.category !== 'video' && block.category !== 'document')
      ) {
        continue;
      }

      normalized.push(fileRefBlock(block));
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

export const SECRETARY_DEFAULT_DOCS: ActorDoc[] = normalizeActorDocs([
  {
    id: createActorDocId(),
    key: 'identity_card',
    title: 'Identity Card',
    content: textBlocks('I am Secretary, the primary point of contact between the Boss (user) and the digital organization.'),
    visibility: 'always',
    priority: 120,
  },
  {
    id: createActorDocId(),
    key: 'relationship_with_user',
    title: 'Relationship With User',
    content: textBlocks('Maintain the long-term relationship with the Boss. Keep them informed, clarify intent, and report what matters without burying them in noise.'),
    visibility: 'always',
    priority: 98,
  },
  {
    id: createActorDocId(),
    key: 'role_charter',
    title: 'Role Charter',
    content: textBlocks(
      [
        'Responsibilities:',
        '1. Receive and understand the Boss\'s goals and instructions.',
        '2. Coordinate work with other actors in the group.',
        '3. Send messages to appropriate team members with clear instructions.',
        '4. Collect progress and synthesize reports.',
        '5. Report key progress, risks, and results to the Boss.',
      ].join('\n'),
    ),
    visibility: 'always',
    priority: 90,
  },
  {
    id: createActorDocId(),
    key: 'work_doctrine',
    title: 'Work Doctrine',
    content: textBlocks(
      [
        'You are not the sole executor. Coordinate the team by messaging the right actor with clear instructions.',
        'When you receive a message from the Boss, decide whether to answer directly, delegate, ask for more information, or invite a new actor.',
        'When reporting, be concise and focus on what matters to the Boss.',
      ].join('\n\n'),
    ),
    visibility: 'always',
    priority: 86,
  },
  {
    id: createActorDocId(),
    key: 'routines',
    title: 'Routines',
    content: textBlocks(
      [
        'Use memory deliberately for stable facts, preferences, decisions, relationships, procedures, or durable artifacts.',
        'If you are unsure whether something is durable or established, do not store it as memory.',
      ].join('\n'),
    ),
    visibility: 'internal_only',
    priority: 80,
  },
]);

/** Extract concatenated text from CanonicalContentBlock[] */
export function extractText(blocks: CanonicalContentBlock[]): string {
  return blocks
    .filter((b): b is CanonicalTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

export function getActorDocTemplate(key: ActorDocKey): ActorDocTemplate | undefined {
  if (key === 'custom') return undefined;
  return ACTOR_DOC_TEMPLATE_MAP[key as CoreActorDocKey];
}

function isNonEmptyActorDoc(doc: ActorDoc): boolean {
  return doc.content.some((block) => {
    if (block.type === 'text') return block.text.trim().length > 0;
    return true;
  });
}

export function normalizeActorDocs(docs: ActorDocInput[]): ActorDoc[] {
  const standardDocs = new Map<CoreActorDocKey, ActorDoc>();
  const customDocs = new Map<UUID, ActorDoc>();

  for (const doc of docs || []) {
    if (!doc || typeof doc !== 'object' || !doc.key || !Array.isArray(doc.content)) continue;
    if (doc.key !== 'custom' && !(doc.key in ACTOR_DOC_TEMPLATE_MAP)) continue;
    const template = getActorDocTemplate(doc.key);
    const normalizedDoc: ActorDoc = {
      id: typeof doc.id === 'string' && doc.id.trim().length > 0 ? doc.id : createActorDocId(),
      key: doc.key,
      title: doc.title?.trim() || template?.title || (doc.key === 'custom' ? 'Custom section' : doc.key),
      content: normalizeCanonicalContentBlocks(doc.content),
      visibility: doc.visibility || template?.defaultVisibility || 'always',
      priority: Number.isFinite(doc.priority) ? doc.priority : (template?.defaultPriority || 0),
    };

    if (!isNonEmptyActorDoc(normalizedDoc)) continue;
    if (normalizedDoc.key === 'custom') {
      customDocs.set(normalizedDoc.id, normalizedDoc);
    } else {
      standardDocs.set(normalizedDoc.key as CoreActorDocKey, normalizedDoc);
    }
  }

  return [...standardDocs.values(), ...customDocs.values()].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.title.localeCompare(right.title);
  });
}

export function summarizeActorDoc(doc: ActorDoc, maxLength = 200): string {
  const text = extractText(doc.content).replace(/\s+/g, ' ').trim();
  if (text.length > 0) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
  }

  const fileBlock = doc.content.find((block): block is Extract<ActorDoc['content'][number], { type: 'file_ref' }> => block.type === 'file_ref');
  return fileBlock ? `Attached file: ${fileBlock.originalName}` : '';
}

export function pickActorDocSummary(docs: ActorDoc[], keys: ActorDocKey[], maxLength = 500, fallback = ''): string {
  const fragments = keys
    .map((key) => docs.find((doc) => doc.key === key))
    .filter((doc): doc is ActorDoc => Boolean(doc))
    .map((doc) => summarizeActorDoc(doc, maxLength))
    .filter(Boolean);

  if (fragments.length > 0) {
    return fragments.join('\n\n');
  }

  return fallback;
}

export function summarizeActorForRole(docs: ActorDoc[], fallbackTitle = ''): string {
  return pickActorDocSummary(docs, ['role_charter', 'mission', 'limitations_and_escalation'], 500, fallbackTitle || 'No role summary provided.');
}

export function summarizeActorForPrompt(docs: ActorDoc[]): string {
  return pickActorDocSummary(
    docs,
    ['soul', 'self_narrative', 'work_doctrine', 'social_protocol', 'representation_guidelines', 'quirks_and_signatures'],
    700,
  );
}
