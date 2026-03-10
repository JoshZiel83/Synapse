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

// ============ Actor (Digital Employee) ============
export type ActorRole = 'secretary' | 'manager' | 'specialist' | 'reviewer' | 'archivist' | 'receptionist' | 'assistant';

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
export type MemoryCategory = 'working' | 'experiential' | 'knowledge' | 'procedural' | 'relational';
export type MemoryScope = 'private' | 'team' | 'workspace';

export interface Memory {
  id: UUID;
  workspaceId: UUID;
  actorId?: UUID; // null = shared memory
  category: MemoryCategory;
  scope: MemoryScope;
  content: string; // Human-readable text
  summary?: string;
  tags: string[];
  sourceWorkItemId?: UUID;
  importance: number; // 0-1
  expiresAt?: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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
  | 'mcp.config.changed'
  | 'relay.connected' | 'relay.disconnected' | 'relay.servers_updated';

export interface SystemEvent {
  type: EventType;
  workspaceId: UUID;
  payload: Record<string, unknown>;
  timestamp: Timestamp;
}

// ============ AI ============
export type SessionStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type ChannelType = 'web' | 'im' | 'internal_delegation' | 'standing_order' | 'api';
export type SessionTrigger = 'user_message' | 'delegation' | 'standing_order' | 'api_call';
export type SessionMessageRole = 'user' | 'assistant' | 'system' | 'tool_result' | 'child_result';
export type SessionInterruptType = 'progress_check' | 'memory_changed' | 'priority_override';

export interface Session {
  id: UUID;
  workspaceId: UUID;
  actorId: UUID;
  parentSessionId?: UUID;
  rootSessionId?: UUID;
  depth: number;
  channelType: ChannelType;
  channelId?: string;
  workItemId?: UUID;
  trigger: string;
  status: SessionStatus;
  waitingFor: UUID[];
  waitTimeoutAt?: Timestamp;
  resumeContext?: Record<string, unknown>;
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
  type: 'respond' | 'delegate' | 'complete' | 'escalate' | 'request_info' | 'update_progress' | 'create_memory' | 'rename_self' | 'change_avatar' | 'wait';
  content: string;
  targetActorId?: UUID;
  workItemId?: UUID;
  waitingFor?: string[];
  metadata?: Record<string, unknown>;
}

export interface ThinkingResult {
  actions: ActorAction[];
  reasoning: string;
  tokensUsed: { input: number; output: number };
  toolsUsed?: string[]; // names of callable tools invoked during thinking
  serverToolCalls?: ServerToolCall[]; // cloud-side tool calls (web_search, web_fetch)
  citationSources?: Record<string, { url: string; title: string }>; // <cite index="X-Y"> → source
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
  groupId: UUID;
  itemId: UUID;
  configId: UUID;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  builtinTools?: AnthropicBuiltinTool[];
  multimodal?: MultimodalConfig;
}

// ============ AI Provider ============
export interface ToolParameterProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
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
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: string | unknown[];  // string for text-only, array for multimodal (MCP content blocks)
  isError?: boolean;
}

export interface ContinuationEntry {
  rawAssistantMessage: unknown;  // Provider-specific raw response, passed back as-is
  toolResults: ToolResult[];
}

export interface AIResponse {
  toolCalls: ToolCall[];
  textContent: string;
  tokensUsed: { input: number; output: number };
  stopReason: string;                // e.g. 'end_turn', 'tool_use' (Anthropic) or 'stop', 'tool_calls' (OpenAI)
  rawAssistantMessage: unknown;      // Provider-specific raw assistant message for continuation
}

// ============================================================
// MCP Plugin Marketplace Types
// ============================================================

export type McpTransport = 'builtin' | 'stdio' | 'http' | 'relay';
export type McpLifecycleScope = 'workspace' | 'user' | 'actor' | 'session';
export type McpScopeType = 'workspace' | 'user' | 'actor';

export interface McpOrganization {
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

export interface McpPluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpPlugin {
  id: string;
  orgId: string;
  slug: string;
  displayName: string;
  description: string;
  longDescription: string;
  iconUrl?: string;
  version: string;
  transport: McpTransport;
  entryPoint: string;
  lifecycleScope: McpLifecycleScope;
  configSchema: Record<string, unknown>;
  defaultConfig: Record<string, unknown>;
  toolsManifest: McpPluginTool[];
  tags: string[];
  isActive: boolean;
  isBuiltin: boolean;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
  // Joined fields
  orgSlug?: string;
  orgDisplayName?: string;
}

export interface McpInstallation {
  id: string;
  workspaceId: string;
  pluginId: string;
  scopeType: McpScopeType;
  scopeId: string;
  lifecycleScope: McpLifecycleScope;
  isEnabled: boolean;
  configData: Record<string, unknown>;
  installedBy?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
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
