export const AUTH_CLIENT_TYPES = ['web', 'android', 'windows', 'ios', 'cli', 'api'] as const;
export const AUTH_TRANSPORTS = ['cookie', 'token'] as const;
export const AUTH_SESSION_PERSISTENCES = ['persistent', 'temporary'] as const;
export const AUTH_QR_LOGIN_STATUSES = [
  'pending_scan',
  'pending_confirm',
  'approved',
  'rejected',
  'expired',
  'consumed',
] as const;

export const INVITE_TRUST_LEVELS = ['admin', 'member', 'guest'] as const;
export const PLATFORM_ACCESS_KEYS = [
  'super_admin',
  'workspace_admin',
  'model_admin',
  'support',
  'auditor',
] as const;

export const WORKSPACE_ACCESS_KEYS = [
  'model_admin',
  'actor_admin',
  'skill_admin',
  'plugin_admin',
  'memory_admin',
  'relay_admin',
  'conversation_admin',
] as const;

export const CONTACT_TARGET_TYPES = ['member', 'actor'] as const;
export const CANONICAL_FILE_CATEGORIES = ['image', 'audio', 'video', 'document'] as const;
export const CONVERSATION_BOUNDARIES = ['internal', 'external'] as const;
export const CONVERSATION_TYPE_KEYS = [
  'internal_private',
  'internal_group',
  'external_private',
  'external_group',
  'virtual',
] as const;
export const CONVERSATION_TYPE_MASK_BITS = {
  internal_private: 1 << 0,
  internal_group: 1 << 1,
  external_private: 1 << 2,
  external_group: 1 << 3,
  virtual: 1 << 4,
} as const;
export const CONVERSATION_TYPE_MASK_PRESETS = {
  ALL:
    CONVERSATION_TYPE_MASK_BITS.internal_private |
    CONVERSATION_TYPE_MASK_BITS.internal_group |
    CONVERSATION_TYPE_MASK_BITS.external_private |
    CONVERSATION_TYPE_MASK_BITS.external_group |
    CONVERSATION_TYPE_MASK_BITS.virtual,
  INTERNAL_ONLY:
    CONVERSATION_TYPE_MASK_BITS.internal_private |
    CONVERSATION_TYPE_MASK_BITS.internal_group,
  EXTERNAL_ONLY:
    CONVERSATION_TYPE_MASK_BITS.external_private |
    CONVERSATION_TYPE_MASK_BITS.external_group,
  GROUP_ONLY:
    CONVERSATION_TYPE_MASK_BITS.internal_group |
    CONVERSATION_TYPE_MASK_BITS.external_group,
  PRIVATE_ONLY:
    CONVERSATION_TYPE_MASK_BITS.internal_private |
    CONVERSATION_TYPE_MASK_BITS.external_private,
  VIRTUAL_ONLY: CONVERSATION_TYPE_MASK_BITS.virtual,
} as const;
export const DEFAULT_CONVERSATION_TYPE_MASK =
  CONVERSATION_TYPE_MASK_PRESETS.ALL;
export const CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES = [
  'plugin_installation',
  'installed_skill',
  'relay_capability',
] as const;
export const ATTACHMENT_TARGET_TYPES = [
  'workspace',
  'conversation',
  'actor',
  'workspace_member',
] as const;
export const ACCESS_TARGET_TYPES = [
  'workspace',
  'conversation',
  'actor',
  'actor_in_conversation',
] as const;
export const CAPABILITY_ACCESS_TARGET_TYPES = [
  'workspace',
  'conversation',
  'actor',
  'actor_in_conversation',
] as const;
export const REUSE_SCOPES = [
  'turn',
  'session',
  'workspace',
  'conversation',
  'actor',
] as const;
export const CONVERSATION_GRANT_PERMISSIONS = [
  'send',
  'moderate',
  'manage',
  'manage_members',
  'attach_resources',
] as const;
export const INTERACTION_REQUEST_KINDS = [
  'question_choice',
  'runtime_authorization',
] as const;
export const INTERACTION_REQUEST_STATUSES = [
  'pending',
  'answered',
  'approved',
  'rejected',
  'cancelled',
  'expired',
  'superseded',
] as const;
export const INTERACTION_QUESTION_FIELD_TYPES = [
  'single_select',
  'multi_select',
  'text',
] as const;
export const INTERACTION_DECISIONS = ['approve', 'reject'] as const;
export const MODEL_GROUP_ROUTING_STRATEGIES = [
  'weighted_random',
  'round_robin',
  'priority_failover',
] as const;

export const MODEL_GROUP_GRANT_SCOPES = [
  'platform',
  'workspace',
  'workspace_member',
  'actor',
] as const;

export const ACTOR_ROLES = [
  'secretary',
  'manager',
  'specialist',
  'reviewer',
  'archivist',
  'receptionist',
  'assistant',
] as const;

export const ACTOR_DOC_VISIBILITIES = [
  'always',
  'direct_only',
  'multi_member_only',
  'internal_only',
] as const;

export const MEMORY_SPACE_TYPES = [
  'workspace_shared',
  'conversation_shared',
  'actor_private',
  'participant_private',
  'user_private',
] as const;

// Deprecated alias kept for in-repo transition.
export const MEMORY_SCOPES = MEMORY_SPACE_TYPES;

export const MEMORY_CATEGORIES = [
  'fact',
  'preference',
  'decision',
  'relationship',
  'procedure',
  'artifact',
  'summary',
] as const;

export const MEMORY_ITEM_STATES = [
  'active',
  'superseded',
  'archived',
] as const;

// Deprecated alias kept for in-repo transition.
export const MEMORY_STATUSES = MEMORY_ITEM_STATES;

// Durable-only memory in v1. Extraction/ephemeral lifecycle is deferred.
export const MEMORY_STABILITIES = ['durable'] as const;
export const MEMORY_INDEX_STATUSES = ['lexical_ready', 'ready', 'failed'] as const;
export const MEMORY_RECALL_TYPES = ['bootstrap', 'turn_recall', 'manual_search'] as const;

export const SESSION_STATUSES = ['idle', 'queued', 'running', 'blocked', 'closed'] as const;
export const SESSION_CHANNELS = ['web', 'api', 'bridge'] as const;
export const SESSION_CHANNEL_INPUTS = ['web', 'im', 'api'] as const;
export const SESSION_TRIGGERS = [
  'user_message',
  'group_message',
  'actor_message',
  'broadcast',
  'api_call',
  'actor_invite',
  'automation',
  'system_interrupt',
  'retry',
] as const;

export const SESSION_INTERRUPT_TYPES = ['progress_check', 'priority_override'] as const;
export const SESSION_WAKEUP_SOURCE_TYPES = [
  'user_message',
  'actor_message',
  'broadcast',
  'invite',
  'api_call',
  'automation',
  'system_interrupt',
  'retry',
] as const;
export const SESSION_WAKEUP_SOURCE_MEMBER_TYPES = [
  'workspace_member',
  'actor',
  'external',
  'system',
] as const;

export const SESSION_WAKEUP_STATUSES = ['pending', 'attached', 'processed', 'dropped'] as const;
export const SEND_TO_INTENTS = ['reply', 'request'] as const;

export const TRANSPORT_ACCOUNT_OWNER_SCOPES = ['workspace', 'workspace_member'] as const;
export const TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES = [
  'none',
  'specified_actor',
  'follow_owner_chief_actor',
] as const;

export const TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES = [
  'inherit_account',
  'none',
  'specified_actor',
] as const;

export const TRANSPORT_KINDS = ['feishu', 'weixin'] as const;
export const TRANSPORT_CONNECTION_MODES = ['webhook', 'long_connection'] as const;
export const TRANSPORT_ENDPOINT_TYPES = ['direct', 'group'] as const;
export const TRANSPORT_ACCOUNT_STATUSES = ['active', 'disabled', 'error'] as const;
export const TRANSPORT_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;

export const PLUGIN_AUTH_OWNER_SCOPES = ['installation', 'workspace_member', 'workspace'] as const;
export const PLUGIN_AUTH_SESSION_STATUSES = [
  'pending',
  'completed',
  'failed',
  'expired',
  'consumed',
] as const;

export const PLUGIN_AUTH_CONNECTION_STATUSES = ['active', 'expired', 'revoked'] as const;

export const TASK_NOTICE_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export const RELAY_DEVICE_TRUST_STATUSES = ['pending', 'active', 'revoked', 'blocked'] as const;
export const RELAY_MANAGEABLE_TRUST_STATUSES = ['active', 'revoked', 'blocked'] as const;
export const RELAY_DEVICE_TYPES = [
  'desktop_computer',
  'laptop_computer',
  'mobile_phone',
  'tablet',
  'server',
  'virtual_machine',
  'custom',
] as const;
export const RELAY_AUTHORIZATION_MODES = ['server_trust', 'client_local'] as const;
export const RELAY_PAIRING_STATUSES = [
  'pending',
  'confirmed',
  'consumed',
  'expired',
  'cancelled',
  'rejected',
] as const;

export const RELAY_SESSION_STATUSES = [
  'connecting',
  'active',
  'closing',
  'closed',
  'rejected',
] as const;

export const RELAY_SYNC_SOURCE_KINDS = [
  'manual',
  'claude_code',
  'claude_desktop',
  'codex',
  'gemini',
  'opencode',
  'custom',
] as const;

export const RELAY_SYNC_MODES = ['snapshot', 'follow'] as const;
export const RELAY_SYNC_STATUSES = ['unknown', 'idle', 'syncing', 'error', 'disabled'] as const;
export const RUNTIME_AUTHORIZATION_PRESETS = [
  'once',
  'actor',
  'conversation',
  'workspace',
] as const;
export const RUNTIME_GRANT_SCOPES = ['once', 'actor', 'conversation', 'workspace'] as const;
export const RUNTIME_GRANT_RETENTIONS = ['consume_once', 'until_revoked'] as const;
export const RUNTIME_GRANT_STATUSES = [
  'active',
  'consumed',
  'revoked',
  'superseded',
] as const;
export const RUNTIME_AUTHORIZATION_REQUEST_MODES = [
  'background',
  'blocking',
] as const;
export const RUNTIME_AUTHORIZATION_CAPABILITIES = [
  'filesystem',
  'cua',
  'browser',
  'commandline',
] as const;
export const RUNTIME_FILESYSTEM_AUTHORIZATION_ACCESSES = [
  'read',
  'write',
  'read_write',
] as const;
export const RUNTIME_COMMANDLINE_EXECUTORS = [
  'bash',
] as const;

export const RELAY_EXPOSURE_RUNTIME_STATUSES = [
  'discovered',
  'starting',
  'healthy',
  'degraded',
  'failed',
  'quarantined',
  'offline',
] as const;

export const RELAY_EXPOSURE_TRANSPORTS = ['builtin', 'stdio', 'http', 'sse', 'custom'] as const;
export const RELAY_CATALOG_REVISION_STATUSES = ['active', 'superseded'] as const;
export const RELAY_TOOL_STATUSES = ['active', 'removed'] as const;

export const RELAY_OPERATION_STATUSES = [
  'created',
  'cancel_requested',
  'dispatched',
  'received',
  'started',
  'completed',
  'failed',
  'cancelled',
  'aborted',
  'expired',
] as const;

export const RELAY_DELIVERY_STATUSES = [
  'queued',
  'sent',
  'acked',
  'nacked',
  'timed_out',
  'cancelled',
] as const;

export const AUTOMATION_TRIGGER_KINDS = ['schedule', 'event'] as const;
export const AUTOMATION_TRIGGER_SOURCE_KINDS = [
  'clock',
  'relay',
  'webhook',
  'internal',
  'integration',
] as const;

export const AUTOMATION_SCHEDULE_KINDS = ['cron', 'at', 'interval'] as const;
export const AUTOMATION_COMPLETION_STATUSES = ['completed', 'archived'] as const;
export const AUTOMATION_DELIVERY_MODES = [
  'wake_session',
  'conversation_notice',
  'create_conversation_once',
  'create_conversation_each_time',
] as const;

export const AUTOMATION_TARGET_POLICIES = ['all_members', 'specified_members'] as const;
export const AUTOMATION_RULE_STATUSES = [
  'active',
  'paused',
  'error',
  'archived',
  'completed',
  'expired',
] as const;

export const AUTOMATION_INTEGRATION_PROVIDERS = ['github', 'gitlab'] as const;
export const AUTOMATION_INTEGRATION_INGRESS_KINDS = ['webhook', 'polling'] as const;
export const AUTOMATION_INTEGRATION_TARGET_KINDS = ['repository', 'project'] as const;
export const AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS = [
  'relay',
  'webhook',
  'internal',
  'integration',
] as const;

export const AUTOMATION_EVENT_SOURCE_STATUSES = [
  'active',
  'deprecated',
  'disabled',
  'archived',
] as const;

export const ACTOR_PACKAGE_SYNC_MODES = ['notify', 'manual_merge'] as const;
