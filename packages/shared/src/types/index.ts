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

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JWTPayload {
  userId: UUID;
  email: string;
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

export interface ActorSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface Actor {
  id: UUID;
  workspaceId: UUID;
  name: string;
  role: ActorRole;
  title: string;
  charter: string; // Job description - what they're responsible for
  systemPrompt: string;
  parentId?: UUID; // Superior in org tree
  capabilities: string[]; // e.g. ['code.review', 'repo.write']
  skills: ActorSkill[];
  config: Record<string, unknown>;
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
export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'relationship' | 'procedure' | 'artifact' | 'summary';
export type MemoryStatus = 'candidate' | 'established' | 'superseded' | 'retracted';
export type MemoryStability = 'ephemeral' | 'durable';
export type MemoryRecallType = 'bootstrap' | 'turn_recall' | 'manual_search';

export interface MemoryGrant {
  id: UUID;
  memoryId: UUID;
  workspaceId: UUID;
  grantScope: MemoryScope;
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
  | 'session.message.new' | 'session.status.changed' | 'session.thinking' | 'group.updated'
  | 'group.member_joined' | 'group.member_kicked' | 'actor.version_changed'
  | 'mcp.config.changed'
  | 'relay.connected' | 'relay.disconnected' | 'relay.servers_updated';

export interface SystemEvent {
  type: EventType;
  workspaceId: UUID;
  payload: Record<string, unknown>;
  timestamp: Timestamp;
}

// ============ AI ============
export type SessionStatus = 'active' | 'sleeping' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type ChannelType = 'web' | 'api';
export type SessionTrigger = 'user_message' | 'group_message' | 'api_call' | 'actor_invite';
export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool_result';
export type SessionInterruptType = 'progress_check' | 'priority_override';

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
  routeId: UUID;
  bindingId: UUID;
  revisionId: UUID;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  builtinTools?: AnthropicBuiltinTool[];
  multimodal?: MultimodalConfig;
  crossTurnToolHistory?: boolean;
  bindingScope?: 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
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
  routeId: UUID;
  routeName: string;
  routingStrategy: 'weighted_random' | 'round_robin' | 'priority_failover';
  attemptPolicy: ModelAttemptPolicy;
  candidates: ResolvedModelConfig[];
}

// ============ Canonical Content Block ============
// Unified representation: text stored directly, media via file_ref pointing to platform file storage
export type CanonicalContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'file_ref';
      fileId: string;        // files table UUID
      storedName: string;    // disk relative path (resolved via readAsBuffer)
      url: string;           // /files/... (frontend display)
      mimeType: string;
      originalName: string;
      sizeBytes: number;
      category: 'image' | 'audio' | 'video' | 'document';
    };

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
  userCount?: number;
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
export type CapabilityBindingScope = 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
export type CapabilityReuseScope = 'turn' | 'platform' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
export type CapabilityGrantScope = CapabilityBindingScope;
export type CapabilitySourceType = 'builtin' | 'official' | 'workspace_upload' | 'user_upload' | 'relay_derived';
export type CapabilityRequirementKind = 'required' | 'recommended' | 'optional' | 'conflicts_with';
export type CapabilityRequirementTargetKind = 'package' | 'tag';
export type CapabilityBindingInstallMode =
  | 'manual'
  | 'seeded'
  | 'relay_derived'
  | 'template_required'
  | 'template_recommended';
export type CapabilityRevisionStatus = 'draft' | 'active' | 'deprecated' | 'archived';
export type CapabilityGrantStatus = 'active' | 'revoked';
export type CapabilityRequirementStatus = 'satisfied' | 'missing_required' | 'missing_recommended' | 'scope_mismatch' | 'config_incomplete';
export type CapabilityAssetKind = 'skill_markdown' | 'reference_markdown' | 'script' | 'json' | 'text' | 'binary';

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
  defaultConfig: Record<string, unknown>;
  transport?: CapabilityTransport;
  entryPoint?: string;
  toolsManifest: CapabilityPackageTool[];
  validationRules: McpValidationRule[];
  setupSteps: McpSetupStep[];
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
  description: string;
  longDescription: string;
  iconUrl?: string;
  sourceType: CapabilitySourceType;
  tags: string[];
  isActive: boolean;
  isBuiltin: boolean;
  downloadCount: number;
  latestRevisionId?: string;
  defaultBindingScope?: CapabilityBindingScope;
  defaultReuseScope?: CapabilityReuseScope;
  defaultIdleTtlMs?: number;
  defaultMaxAgeMs?: number;
  requiresHandshake: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  publisher?: CapabilityPublisher;
  latestRevision?: CapabilityPackageRevision;
}

export interface CapabilityBinding {
  id: string;
  workspaceId: string;
  packageId: string;
  revisionId: string;
  bindingScope: CapabilityBindingScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  installMode: CapabilityBindingInstallMode;
  reuseScope: CapabilityReuseScope;
  idleTtlMs?: number;
  maxAgeMs?: number;
  requiresHandshake: boolean;
  isEnabled: boolean;
  configData: Record<string, unknown>;
  installedBy?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  package?: CapabilityPackage;
  revision?: CapabilityPackageRevision;
}

export interface CapabilityGrant {
  id: string;
  bindingId: string;
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

export interface CapabilityRequirement {
  id: string;
  revisionId: string;
  requirementKind: CapabilityRequirementKind;
  targetKind: CapabilityRequirementTargetKind;
  targetPackageKind?: CapabilityPackageKind;
  targetPublisherSlug?: string;
  targetPackageSlug?: string;
  targetTag?: string;
  acceptableBindingScopes: CapabilityBindingScope[];
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
  matchedBindingIds: string[];
  missingPublisherSlug?: string;
  missingPackageSlug?: string;
  missingTag?: string;
}

export interface CapabilityInstallPlan {
  packageId: string;
  revisionId: string;
  workspaceId: string;
  bindingScope: CapabilityBindingScope;
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

export interface CapabilityAvailableSkill {
  bindingId: string;
  packageId: string;
  revisionId: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  bindingScope: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  entryPoint?: string;
}

export type McpTransport = Exclude<CapabilityTransport, 'filesystem'>;
export type McpLifecycleScope = CapabilityReuseScope;
export type McpScopeType = CapabilityBindingScope;

export type McpOrganization = CapabilityPublisher;
export type McpPluginTool = CapabilityPackageTool;

export interface McpPlugin extends CapabilityPackage {
  kind: 'plugin';
}

export interface McpInstallation extends CapabilityBinding {
  pluginId: string;
  scopeType: McpScopeType;
  scopeId: string;
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
  transport: 'stdio' | 'http';
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
  title: string;
  description: string;
  scope: 'workspace' | 'plugin';
  fields: string[];
  optional?: boolean;
  helpUrl?: string;
  helpText?: string;
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
  targetActorNames?: string[];
  targetUserNames?: string[];
}

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

/** Wrap a plain string into CanonicalContentBlock[] */
export function textBlocks(s: string): CanonicalContentBlock[] {
  return [{ type: 'text', text: s }];
}

/** Extract concatenated text from CanonicalContentBlock[] */
export function extractText(blocks: CanonicalContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
