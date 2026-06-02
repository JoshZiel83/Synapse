export const AUTH_CLIENT_TYPES = [
  "web",
  "android",
  "windows",
  "ios",
  "cli",
  "api",
] as const
export const AUTH_TRANSPORTS = ["cookie", "token"] as const
export const AUTH_SESSION_PERSISTENCES = ["persistent", "temporary"] as const
export const AUTH_QR_LOGIN_STATUSES = [
  "pending_scan",
  "pending_confirm",
  "approved",
  "rejected",
  "expired",
  "consumed",
] as const

export const INVITE_TRUST_LEVELS = ["admin", "member", "guest"] as const
export const PLATFORM_ACCESS_KEYS = [
  "super_admin",
  "workspace_admin",
  "model_admin",
  "support",
  "auditor",
] as const

export const WORKSPACE_ACCESS_KEYS = [
  "model_admin",
  "actor_admin",
  "remote_agent_admin",
  "skill_admin",
  "plugin_admin",
  "memory_admin",
  "device_admin",
  "conversation_admin",
] as const

export const RELATIONSHIP_PROFILE_SUBJECT_TYPE = {
  MEMBER: "workspace_member",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
} as const
export const RELATIONSHIP_PROFILE_SUBJECT_TYPES = [
  RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
  RELATIONSHIP_PROFILE_SUBJECT_TYPE.ACTOR,
  RELATIONSHIP_PROFILE_SUBJECT_TYPE.REMOTE_AGENT,
] as const
export const RELATIONSHIP_APPROVAL_MODE = {
  AUTO: "auto",
  MANUAL: "manual",
} as const
export const RELATIONSHIP_APPROVAL_MODES = [
  RELATIONSHIP_APPROVAL_MODE.AUTO,
  RELATIONSHIP_APPROVAL_MODE.MANUAL,
] as const
// P2: this enum used to be the value of the dropped `actors.access_policy` /
// `remote_agents.access_policy` columns. After P2 it is a pure
// application-layer "intent" enum — input to `setAccessPolicy(policy)` and the
// API request bodies. `workspace_open` translates to "ensure a
// source=default_open binding exists targeting the workspace"; `approval_required`
// translates to "revoke any default_open binding so access requires explicit
// approval". The DB no longer stores this value directly.
export const RELATIONSHIP_ACCESS_POLICY = {
  WORKSPACE_OPEN: "workspace_open",
  APPROVAL_REQUIRED: "approval_required",
} as const
export const RELATIONSHIP_ACCESS_POLICIES = [
  RELATIONSHIP_ACCESS_POLICY.WORKSPACE_OPEN,
  RELATIONSHIP_ACCESS_POLICY.APPROVAL_REQUIRED,
] as const
export const RELATIONSHIP_REQUEST_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const
export const RELATIONSHIP_REQUEST_STATUSES = [
  RELATIONSHIP_REQUEST_STATUS.PENDING,
  RELATIONSHIP_REQUEST_STATUS.APPROVED,
  RELATIONSHIP_REQUEST_STATUS.REJECTED,
] as const
export const CONTACT_TARGET_TYPE = {
  MEMBER: "workspace_member",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
} as const
export const CONTACT_TARGET_TYPES = [
  CONTACT_TARGET_TYPE.MEMBER,
  CONTACT_TARGET_TYPE.ACTOR,
  CONTACT_TARGET_TYPE.REMOTE_AGENT,
] as const
export const CONTACT_HUB_KIND = {
  WORKSPACE_ACTOR: "workspace-actor",
  WORKSPACE_REMOTE_AGENT: "workspace-remote-agent",
  WORKSPACE_MEMBER: "workspace-member",
  FRIEND_ACTOR: "friend-actor",
  FRIEND_REMOTE_AGENT: "friend-remote-agent",
  FRIEND_MEMBER: "friend-member",
} as const
export const CONTACT_HUB_KINDS = [
  CONTACT_HUB_KIND.WORKSPACE_ACTOR,
  CONTACT_HUB_KIND.WORKSPACE_REMOTE_AGENT,
  CONTACT_HUB_KIND.WORKSPACE_MEMBER,
  CONTACT_HUB_KIND.FRIEND_ACTOR,
  CONTACT_HUB_KIND.FRIEND_REMOTE_AGENT,
  CONTACT_HUB_KIND.FRIEND_MEMBER,
] as const
export const CONTACT_DIRECT_STATE = {
  EXISTING: "existing",
  AVAILABLE: "available",
  APPROVAL_REQUIRED: "approval_required",
  PENDING_APPROVAL: "pending_approval",
} as const
export const CONTACT_DIRECT_STATES = [
  CONTACT_DIRECT_STATE.EXISTING,
  CONTACT_DIRECT_STATE.AVAILABLE,
  CONTACT_DIRECT_STATE.APPROVAL_REQUIRED,
  CONTACT_DIRECT_STATE.PENDING_APPROVAL,
] as const
export const IDENTITY_SEARCH_OUTCOME = {
  EMPTY: "empty",
  INVALID: "invalid",
  SELF: "self",
  NOT_FOUND: "not_found",
  FOUND: "found",
} as const
export const IDENTITY_SEARCH_OUTCOMES = [
  IDENTITY_SEARCH_OUTCOME.EMPTY,
  IDENTITY_SEARCH_OUTCOME.INVALID,
  IDENTITY_SEARCH_OUTCOME.SELF,
  IDENTITY_SEARCH_OUTCOME.NOT_FOUND,
  IDENTITY_SEARCH_OUTCOME.FOUND,
] as const
export const IDENTITY_SEARCH_MATCH_STATE = {
  SAME_WORKSPACE_MEMBER: "same_workspace_member",
  FRIEND: "friend",
  PENDING_REQUEST: "pending_request",
  REQUESTABLE: "requestable",
  EXISTING: CONTACT_DIRECT_STATE.EXISTING,
  AVAILABLE: CONTACT_DIRECT_STATE.AVAILABLE,
  APPROVAL_REQUIRED: CONTACT_DIRECT_STATE.APPROVAL_REQUIRED,
  PENDING_APPROVAL: CONTACT_DIRECT_STATE.PENDING_APPROVAL,
} as const
export const IDENTITY_SEARCH_MATCH_STATES = [
  IDENTITY_SEARCH_MATCH_STATE.SAME_WORKSPACE_MEMBER,
  IDENTITY_SEARCH_MATCH_STATE.FRIEND,
  IDENTITY_SEARCH_MATCH_STATE.PENDING_REQUEST,
  IDENTITY_SEARCH_MATCH_STATE.REQUESTABLE,
  IDENTITY_SEARCH_MATCH_STATE.EXISTING,
  IDENTITY_SEARCH_MATCH_STATE.AVAILABLE,
  IDENTITY_SEARCH_MATCH_STATE.APPROVAL_REQUIRED,
  IDENTITY_SEARCH_MATCH_STATE.PENDING_APPROVAL,
] as const
export const RELATIONSHIP_SCAN_OUTCOME = {
  SELF_SCAN: "self_scan",
  SAME_WORKSPACE_MEMBER: "same_workspace_member",
  FRIEND_ACTIVE: "friend_active",
  FRIEND_REQUEST_CREATED: "friend_request_created",
  FRIEND_REQUEST_PENDING: "friend_request_pending",
  ACTOR_ACCESS_GRANTED: "actor_access_granted",
  ACTOR_ACCESS_REQUEST_CREATED: "actor_access_request_created",
  ACTOR_ACCESS_PENDING: "actor_access_pending",
  REMOTE_AGENT_ACCESS_GRANTED: "remote_agent_access_granted",
  REMOTE_AGENT_ACCESS_REQUEST_CREATED: "remote_agent_access_request_created",
  REMOTE_AGENT_ACCESS_PENDING: "remote_agent_access_pending",
} as const
export const RELATIONSHIP_SCAN_OUTCOMES = [
  RELATIONSHIP_SCAN_OUTCOME.SELF_SCAN,
  RELATIONSHIP_SCAN_OUTCOME.SAME_WORKSPACE_MEMBER,
  RELATIONSHIP_SCAN_OUTCOME.FRIEND_ACTIVE,
  RELATIONSHIP_SCAN_OUTCOME.FRIEND_REQUEST_CREATED,
  RELATIONSHIP_SCAN_OUTCOME.FRIEND_REQUEST_PENDING,
  RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_GRANTED,
  RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_REQUEST_CREATED,
  RELATIONSHIP_SCAN_OUTCOME.ACTOR_ACCESS_PENDING,
  RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_GRANTED,
  RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_REQUEST_CREATED,
  RELATIONSHIP_SCAN_OUTCOME.REMOTE_AGENT_ACCESS_PENDING,
] as const
export const DIRECT_CONVERSATION_OPEN_STATUS = {
  READY: "ready",
  PENDING_APPROVAL: "pending_approval",
} as const
export const DIRECT_CONVERSATION_OPEN_STATUSES = [
  DIRECT_CONVERSATION_OPEN_STATUS.READY,
  DIRECT_CONVERSATION_OPEN_STATUS.PENDING_APPROVAL,
] as const
export const CANONICAL_FILE_CATEGORIES = [
  "image",
  "audio",
  "video",
  "document",
] as const
export const FILE_STORAGE_BACKENDS = ["local_cas"] as const
export const FILE_ORIGIN_FAMILIES = [
  "user_upload",
  "actor_output",
  "tool_output",
  "model_output",
  "external_import",
  "package_import",
  "system_generated",
  "platform_asset",
] as const
export const FILE_ORIGIN_SYSTEMS = {
  WORKSPACE_WEB_UPLOAD: "workspace_web_upload",
  WORKSPACE_MOBILE_UPLOAD: "workspace_mobile_upload",
  ACTOR_TOOL_UPLOAD_FILE: "actor_tool_upload_file",
  MCP_TOOL_RESULT_INGEST: "mcp_tool_result_ingest",
  MCP_RESULT_NORMALIZER: "mcp_result_normalizer",
  ZHIPU_TEXT_TO_SPEECH: "zhipu_text_to_speech",
  ZHIPU_FILE_PARSER_SYNC: "zhipu_file_parser_sync",
  ZHIPU_IMAGE_GENERATION: "zhipu_image_generation",
  ZHIPU_LAYOUT_PARSING: "zhipu_layout_parsing",
  ANTHROPIC_RESPONSE_MEDIA_INGEST: "anthropic_response_media_ingest",
  OPENAI_RESPONSE_MEDIA_INGEST: "openai_response_media_ingest",
  GENERIC_MODEL_RESPONSE_MEDIA_INGEST: "generic_model_response_media_ingest",
  FEISHU_DOCS_DOWNLOAD_MEDIA: "feishu_docs_download_media",
  FEISHU_DRIVE_DOWNLOAD_FILE: "feishu_drive_download_file",
  QQ_INBOUND_MEDIA_INGEST: "qq_inbound_media_ingest",
  SKILL_MIRROR_IMPORT: "skill_mirror_import",
  GENERATED_USER_AVATAR: "generated_user_avatar",
  GENERATED_OFFICIAL_ACTOR_AVATAR: "generated_official_actor_avatar",
  GENERATED_ACTOR_PIXEL_ART_AVATAR: "generated_actor_pixel_art_avatar",
  MARKETPLACE_SKILL_ICON_COPY: "marketplace_skill_icon_copy",
  BUILTIN_PLUGIN_ICON: "builtin_plugin_icon",
} as const
export const USER_UPLOAD_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.WORKSPACE_WEB_UPLOAD,
  FILE_ORIGIN_SYSTEMS.WORKSPACE_MOBILE_UPLOAD,
] as const
export const ACTOR_OUTPUT_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.ACTOR_TOOL_UPLOAD_FILE,
] as const
export const TOOL_OUTPUT_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.MCP_TOOL_RESULT_INGEST,
  FILE_ORIGIN_SYSTEMS.MCP_RESULT_NORMALIZER,
  FILE_ORIGIN_SYSTEMS.ZHIPU_TEXT_TO_SPEECH,
  FILE_ORIGIN_SYSTEMS.ZHIPU_FILE_PARSER_SYNC,
  FILE_ORIGIN_SYSTEMS.ZHIPU_IMAGE_GENERATION,
  FILE_ORIGIN_SYSTEMS.ZHIPU_LAYOUT_PARSING,
] as const
export const MODEL_OUTPUT_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.ANTHROPIC_RESPONSE_MEDIA_INGEST,
  FILE_ORIGIN_SYSTEMS.OPENAI_RESPONSE_MEDIA_INGEST,
  FILE_ORIGIN_SYSTEMS.GENERIC_MODEL_RESPONSE_MEDIA_INGEST,
] as const
export const EXTERNAL_IMPORT_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.FEISHU_DOCS_DOWNLOAD_MEDIA,
  FILE_ORIGIN_SYSTEMS.FEISHU_DRIVE_DOWNLOAD_FILE,
  FILE_ORIGIN_SYSTEMS.QQ_INBOUND_MEDIA_INGEST,
] as const
export const PACKAGE_IMPORT_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.SKILL_MIRROR_IMPORT,
] as const
export const SYSTEM_GENERATED_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.GENERATED_USER_AVATAR,
  FILE_ORIGIN_SYSTEMS.GENERATED_OFFICIAL_ACTOR_AVATAR,
  FILE_ORIGIN_SYSTEMS.GENERATED_ACTOR_PIXEL_ART_AVATAR,
  FILE_ORIGIN_SYSTEMS.MARKETPLACE_SKILL_ICON_COPY,
] as const
export const PLATFORM_ASSET_FILE_ORIGIN_SYSTEMS = [
  FILE_ORIGIN_SYSTEMS.BUILTIN_PLUGIN_ICON,
] as const
export const FILE_PARSE_RUN_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const
export const FILE_PARSE_OUTPUT_KINDS = [
  "text",
  "structured_json",
  "derived_file",
] as const
export const CONVERSATION_KIND = {
  DIRECT: "direct",
  GROUP: "group",
} as const
export const CONVERSATION_KINDS = [
  CONVERSATION_KIND.DIRECT,
  CONVERSATION_KIND.GROUP,
] as const
export const CONVERSATION_PARTICIPANT_TYPE = {
  WORKSPACE_MEMBER: "workspace_member",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
  EXTERNAL: "external",
} as const
export const CONVERSATION_PARTICIPANT_TYPES = [
  CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
  CONVERSATION_PARTICIPANT_TYPE.ACTOR,
  CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT,
  CONVERSATION_PARTICIPANT_TYPE.EXTERNAL,
] as const
export const CONVERSATION_PARTICIPANT_STATE = {
  ACTIVE: "active",
  LEFT: "left",
  REMOVED: "removed",
} as const
export const CONVERSATION_PARTICIPANT_STATES = [
  CONVERSATION_PARTICIPANT_STATE.ACTIVE,
  CONVERSATION_PARTICIPANT_STATE.LEFT,
  CONVERSATION_PARTICIPANT_STATE.REMOVED,
] as const

export const CHAT_TYPING_STATE = {
  STARTED: "started",
  STOPPED: "stopped",
} as const
export const CHAT_TYPING_STATES = [
  CHAT_TYPING_STATE.STARTED,
  CHAT_TYPING_STATE.STOPPED,
] as const
export type ChatTypingState = (typeof CHAT_TYPING_STATES)[number]

export const PUSH_TOKEN_PLATFORM = {
  IOS: "ios",
  ANDROID: "android",
  WEB: "web",
} as const
export const PUSH_TOKEN_PLATFORMS = [
  PUSH_TOKEN_PLATFORM.IOS,
  PUSH_TOKEN_PLATFORM.ANDROID,
  PUSH_TOKEN_PLATFORM.WEB,
] as const
export type PushTokenPlatform = (typeof PUSH_TOKEN_PLATFORMS)[number]
export const CONVERSATION_ITEM_SCOPE = {
  SHARED: "shared",
  PRIVATE: "private",
} as const
export const CONVERSATION_ITEM_SCOPES = [
  CONVERSATION_ITEM_SCOPE.SHARED,
  CONVERSATION_ITEM_SCOPE.PRIVATE,
] as const
export const CONVERSATION_ITEM_SURFACE = {
  VISIBLE: "visible",
  INTERNAL: "internal",
} as const
export const CONVERSATION_ITEM_SURFACES = [
  CONVERSATION_ITEM_SURFACE.VISIBLE,
  CONVERSATION_ITEM_SURFACE.INTERNAL,
] as const
export const CONVERSATION_ITEM_TYPE = {
  MESSAGE: "message",
  EVENT: "event",
  SUMMARY: "summary",
  CONTROL: "control",
} as const
export const CONVERSATION_ITEM_TYPES = [
  CONVERSATION_ITEM_TYPE.MESSAGE,
  CONVERSATION_ITEM_TYPE.EVENT,
  CONVERSATION_ITEM_TYPE.SUMMARY,
  CONVERSATION_ITEM_TYPE.CONTROL,
] as const
export const CONVERSATION_ITEM_ROLE = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
} as const
export const CONVERSATION_ITEM_ROLES = [
  CONVERSATION_ITEM_ROLE.USER,
  CONVERSATION_ITEM_ROLE.ASSISTANT,
  CONVERSATION_ITEM_ROLE.SYSTEM,
  CONVERSATION_ITEM_ROLE.TOOL,
] as const
export const CONVERSATION_TYPE_KEYS = [
  "direct",
  "group",
  "im_direct",
  "im_group",
] as const
export const CONVERSATION_TYPE_MASK_BITS = {
  direct: 1 << 0,
  group: 1 << 1,
  im_direct: 1 << 2,
  im_group: 1 << 3,
} as const
export const CONVERSATION_TYPE_MASK_PRESETS = {
  ALL:
    CONVERSATION_TYPE_MASK_BITS.direct |
    CONVERSATION_TYPE_MASK_BITS.group |
    CONVERSATION_TYPE_MASK_BITS.im_direct |
    CONVERSATION_TYPE_MASK_BITS.im_group,
  // Native (in-app, non-IM) conversations only — replaces the old INTERNAL_ONLY.
  NATIVE_ONLY:
    CONVERSATION_TYPE_MASK_BITS.direct | CONVERSATION_TYPE_MASK_BITS.group,
  // IM-bridged conversations only — replaces the old EXTERNAL_ONLY / VIRTUAL_ONLY.
  IM_ONLY:
    CONVERSATION_TYPE_MASK_BITS.im_direct |
    CONVERSATION_TYPE_MASK_BITS.im_group,
  // 1:1 conversations across both native and IM.
  DIRECT_ONLY:
    CONVERSATION_TYPE_MASK_BITS.direct | CONVERSATION_TYPE_MASK_BITS.im_direct,
  // Group conversations across both native and IM.
  GROUP_ONLY:
    CONVERSATION_TYPE_MASK_BITS.group | CONVERSATION_TYPE_MASK_BITS.im_group,
  // Native (in-app) group conversations only — excludes IM groups. Used by
  // capabilities that must not act on IM-bridged group chats (e.g. invite_actor,
  // which must not pull more actors into a third-party IM group).
  NATIVE_GROUP_ONLY: CONVERSATION_TYPE_MASK_BITS.group,
} as const
export const DEFAULT_CONVERSATION_TYPE_MASK = CONVERSATION_TYPE_MASK_PRESETS.ALL
export const CAPABILITY_CONVERSATION_TYPE_POLICY_RESOURCE_FAMILIES = [
  "plugin_installation",
  "installed_skill",
  "device_capability",
] as const
export const ATTACHMENT_TARGET_TYPES = [
  "workspace",
  "conversation",
  "actor",
  "workspace_member",
] as const
// subject-scope-refactor: legacy UI label set. The actual D3 payload type
// (ScopedSubjectTarget) is {subject: SubjectRef, scope?: SubjectRef}; these
// string labels are kept for UI selector display only (skills / mcp-plugins
// rendering, web-next dropdowns). subjectScopeLabel emits the same union for
// derived labels. New code should consume SubjectRef shapes directly.
export const ACCESS_TARGET_TYPES = [
  "workspace",
  "workspace_member",
  "conversation",
  "actor",
  "actor_in_conversation",
  "remote_agent",
  "remote_agent_in_conversation",
] as const
export const CAPABILITY_ACCESS_TARGET_TYPES = [
  "workspace",
  "workspace_member",
  "conversation",
  "actor",
  "actor_in_conversation",
  "remote_agent",
  "remote_agent_in_conversation",
] as const
export const REUSE_SCOPES = [
  "turn",
  "session",
  "workspace",
  "conversation",
  "actor",
] as const
export const CONVERSATION_GRANT_PERMISSIONS = [
  "send",
  "moderate",
  "manage",
  "manage_members",
  "attach_resources",
] as const
export const INTERACTION_REQUEST_KIND = {
  USER_INPUT: "user_input",
  PLAN_APPROVAL: "plan_approval",
  RUNTIME_AUTHORIZATION: "runtime_authorization",
} as const
export const INTERACTION_REQUEST_KINDS = [
  INTERACTION_REQUEST_KIND.USER_INPUT,
  INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
  INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
] as const
export const TARGETED_INTERACTION_REQUEST_KINDS = [
  INTERACTION_REQUEST_KIND.USER_INPUT,
  INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
] as const
export const INTERACTION_REQUEST_STATUSES = [
  "pending",
  "answered",
  "approved",
  "rejected",
  "cancelled",
  "expired",
  "superseded",
] as const
export const INTERACTION_INPUT_QUESTION_TYPES = [
  "single_select",
  "multi_select",
  "text",
] as const
export const INTERACTION_DECISIONS = ["approve", "reject"] as const
export const PLAN_APPROVAL_DECISIONS = ["approve", "revise"] as const
export const MODEL_GROUP_ROUTING_STRATEGY = {
  WEIGHTED_RANDOM: "weighted_random",
  ROUND_ROBIN: "round_robin",
  PRIORITY_FAILOVER: "priority_failover",
} as const
export const MODEL_GROUP_ROUTING_STRATEGIES = [
  MODEL_GROUP_ROUTING_STRATEGY.WEIGHTED_RANDOM,
  MODEL_GROUP_ROUTING_STRATEGY.ROUND_ROBIN,
  MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER,
] as const
export const MODEL_GROUP_OWNER_TYPE = {
  PLATFORM: "platform",
  WORKSPACE: "workspace",
  WORKSPACE_MEMBER: "workspace_member",
} as const
export const MODEL_GROUP_OWNER_TYPES = [
  MODEL_GROUP_OWNER_TYPE.PLATFORM,
  MODEL_GROUP_OWNER_TYPE.WORKSPACE,
  MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER,
] as const
export const MODEL_GROUP_GRANT_SCOPE = {
  PLATFORM: "platform",
  WORKSPACE: "workspace",
  WORKSPACE_MEMBER: "workspace_member",
  ACTOR: "actor",
} as const
export const MODEL_GROUP_GRANT_SCOPES = [
  MODEL_GROUP_GRANT_SCOPE.PLATFORM,
  MODEL_GROUP_GRANT_SCOPE.WORKSPACE,
  MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER,
  MODEL_GROUP_GRANT_SCOPE.ACTOR,
] as const
export const MODEL_GROUP_GRANT_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const
export const MODEL_GROUP_GRANT_STATUSES = [
  MODEL_GROUP_GRANT_STATUS.ACTIVE,
  MODEL_GROUP_GRANT_STATUS.REVOKED,
] as const

export const REMOTE_AGENT_RUNTIME_KIND = {
  CLAUDE_CODE: "claude_code",
  CODEX: "codex",
} as const
export const REMOTE_AGENT_RUNTIME_KINDS = [
  REMOTE_AGENT_RUNTIME_KIND.CLAUDE_CODE,
  REMOTE_AGENT_RUNTIME_KIND.CODEX,
] as const
export const REMOTE_AGENT_RUNTIME_STATE = {
  OFFLINE: "offline",
  IDLE: "idle",
  RUNNING: "running",
  WAITING_USER_INPUT: "waiting_user_input",
  PLAN_DRAFTING: "plan_drafting",
  WAITING_PLAN_APPROVAL: "waiting_plan_approval",
  ERROR: "error",
} as const
export const REMOTE_AGENT_RUNTIME_STATES = [
  REMOTE_AGENT_RUNTIME_STATE.OFFLINE,
  REMOTE_AGENT_RUNTIME_STATE.IDLE,
  REMOTE_AGENT_RUNTIME_STATE.RUNNING,
  REMOTE_AGENT_RUNTIME_STATE.WAITING_USER_INPUT,
  REMOTE_AGENT_RUNTIME_STATE.PLAN_DRAFTING,
  REMOTE_AGENT_RUNTIME_STATE.WAITING_PLAN_APPROVAL,
  REMOTE_AGENT_RUNTIME_STATE.ERROR,
] as const
export const REMOTE_AGENT_RUNTIME_CATALOG_STATUS = {
  AVAILABLE: "available",
  MISSING_BINARY: "missing_binary",
  BROKEN_PATH: "broken_path",
  UNSUPPORTED_PLATFORM: "unsupported_platform",
  RUNTIME_ERROR: "runtime_error",
} as const
export const REMOTE_AGENT_RUNTIME_CATALOG_STATUSES = [
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS.AVAILABLE,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS.MISSING_BINARY,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS.BROKEN_PATH,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS.UNSUPPORTED_PLATFORM,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS.RUNTIME_ERROR,
] as const
export const REMOTE_AGENT_MACHINE_TRUST_STATUS = {
  PENDING: "pending",
  ACTIVE: "active",
  REVOKED: "revoked",
  BLOCKED: "blocked",
} as const
export const REMOTE_AGENT_MACHINE_TRUST_STATUSES = [
  REMOTE_AGENT_MACHINE_TRUST_STATUS.PENDING,
  REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE,
  REMOTE_AGENT_MACHINE_TRUST_STATUS.REVOKED,
  REMOTE_AGENT_MACHINE_TRUST_STATUS.BLOCKED,
] as const
export const REMOTE_AGENT_MACHINE_LIFECYCLE_STATE = {
  ONLINE: "online",
  OFFLINE: "offline",
} as const
export const REMOTE_AGENT_MACHINE_LIFECYCLE_STATES = [
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.ONLINE,
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.OFFLINE,
] as const

export const ACTOR_ROLES = [
  "secretary",
  "manager",
  "specialist",
  "reviewer",
  "archivist",
  "receptionist",
  "assistant",
] as const

export const ACTOR_DOC_VISIBILITIES = [
  "always",
  "direct_only",
  "multi_member_only",
  "internal_only",
] as const

export const MEMORY_SPACE_TYPES = [
  "workspace_shared",
  "conversation_shared",
  "actor_private",
  "participant_private",
  "user_private",
] as const

// Deprecated alias kept for in-repo transition.
export const MEMORY_SCOPES = MEMORY_SPACE_TYPES

export const MEMORY_CATEGORIES = [
  "fact",
  "preference",
  "decision",
  "relationship",
  "procedure",
  "artifact",
  "summary",
] as const

export const MEMORY_ITEM_STATES = ["active", "superseded", "archived"] as const

// Deprecated alias kept for in-repo transition.
export const MEMORY_STATUSES = MEMORY_ITEM_STATES

// Durable-only memory in v1. Extraction/ephemeral lifecycle is deferred.
export const MEMORY_STABILITIES = ["durable"] as const
export const MEMORY_INDEX_STATUSES = [
  "lexical_ready",
  "ready",
  "failed",
] as const
export const MEMORY_RECALL_TYPES = [
  "bootstrap",
  "turn_recall",
  "manual_search",
] as const

export const SESSION_STATUSES = [
  "idle",
  "queued",
  "running",
  "blocked",
  "closed",
] as const
export const SESSION_COLLABORATION_MODES = [
  "default",
  "plan_drafting",
  "plan_awaiting_approval",
] as const
export const PLAN_CHECKLIST_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
] as const
export const SESSION_TRIGGERS = [
  "user_message",
  "actor_message",
  "automation",
  "system_interrupt",
  "retry",
] as const

export const SESSION_INTERRUPT_TYPES = ["remote_control_terminated"] as const
export const SESSION_WAKEUP_SOURCE_TYPES = [
  "user_message",
  "actor_message",
  "automation",
  "system_interrupt",
  "retry",
] as const
export const SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES = [
  "workspace_member",
  "actor",
  "remote_agent",
  "external",
  "system",
] as const

export const SESSION_WAKEUP_STATUSES = [
  "pending",
  "attached",
  "processed",
  "dropped",
] as const
export const SEND_TO_INTENTS = ["reply", "request"] as const

export const TRANSPORT_ACCOUNT_OWNER_SCOPES = [
  "workspace",
  "workspace_member",
] as const
export const TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES = [
  "none",
  "specified_actor",
  "follow_owner_chief_actor",
] as const

export const TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES = [
  "inherit_account",
  "none",
  "specified_actor",
] as const

export const TRANSPORT_KINDS = [
  "feishu",
  "weixin",
  "wecom",
  "dingtalk",
  "qq",
] as const
export const TRANSPORT_CONNECTION_MODES = [
  "webhook",
  "long_connection",
] as const
export const TRANSPORT_ENDPOINT_TYPES = ["direct", "group"] as const
export const TRANSPORT_ACCOUNT_STATUSES = [
  "active",
  "disabled",
  "error",
] as const
export const TRANSPORT_DELIVERY_STATUSES = [
  "pending",
  "sent",
  "failed",
  "skipped",
] as const

export const PLUGIN_AUTH_OWNER_SCOPES = [
  "installation",
  "workspace_member",
  "workspace",
] as const
export const PLUGIN_AUTH_SESSION_STATUSES = [
  "pending",
  "completed",
  "failed",
  "expired",
  "consumed",
] as const

export const PLUGIN_AUTH_CONNECTION_STATUSES = [
  "active",
  "expired",
  "revoked",
] as const

export const TASK_NOTICE_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const

// ============ Runtime authorization + device access (PR #20) ============
// Replaces the legacy RELAY_AUTHORIZATION_* / RELAY_DEVICE_* / RELAY_EXPOSURE_*
// constants. All consumers were migrated to the RUNTIME_* / DEVICE_* names; the
// relay_* tables and the Go relay binaries were deleted at the same time.

// subject-scope-refactor: RUNTIME_AUTHORIZATION_GRANT_SCOPE / RUNTIME_AUTHORIZATION_GRANT_SCOPES
// constants dropped at cutover. Scope is now expressed via subject_id +
// scope_subject_id on runtime_authorization_grants; the wire-stable
// `grant_scope` envelope field carries a derived label string via
// `subjectScopeLabel(target)` (see packages/shared/src/access/subject.ts).
// 'actor_in_conversation' removed from RUNTIME_AUTHORIZATION_PRESETS; UI
// renders it via subjectScopeLabel from (subject=actor, scope=conversation).

export const RUNTIME_AUTHORIZATION_PRESETS = [
  "once",
  "actor",
  "conversation",
  "remote_agent",
  "workspace",
] as const
export const RUNTIME_AUTHORIZATION_GRANT_RETENTIONS = [
  "consume_once",
  "until_revoked",
] as const
export const RUNTIME_AUTHORIZATION_GRANT_STATUSES = [
  "active",
  "consumed",
  "revoked",
  "superseded",
] as const
export const RUNTIME_AUTHORIZATION_REQUEST_MODES = [
  "background",
  "blocking",
] as const
export const DEVICE_ACCESS_DENIAL_KINDS = [
  "permission_denied",
  "runtime_constraint",
  "invalid_request",
] as const
export const DEVICE_ACCESS_DENIAL_RESOLUTIONS = [
  "server_grant",
  "local_setting",
  "unresolvable",
] as const
export const RUNTIME_AUTHORIZATION_CAPABILITIES = [
  "filesystem",
  "cua",
  "browser",
  "commandline",
] as const
export const RUNTIME_AUTHORIZATION_FILESYSTEM_ACCESSES = [
  "read",
  "write",
] as const
export const RUNTIME_AUTHORIZATION_CUA_ACCESSES = ["read", "write"] as const
export const RUNTIME_AUTHORIZATION_BROWSER_ACTIONS = ["read", "write"] as const
export const RUNTIME_AUTHORIZATION_BROWSER_SCOPE_TYPES = [
  "host",
  "domain",
  "origin",
] as const
// v3.1: Re-export the operation enum from device-protocol so both packages stay
// in lockstep. Callers should `import {BrowserOperation, RUNTIME_AUTHORIZATION_
// BROWSER_OPERATIONS} from "@synapse/shared"` to avoid reaching across packages.
export {
  RUNTIME_AUTHORIZATION_BROWSER_OPERATIONS,
  type BrowserOperation,
} from "@synapse/device-protocol/browser-tools"
export const RUNTIME_AUTHORIZATION_COMMAND_EXECUTORS = [
  "bash",
  "powershell",
  "exec_file",
  // Sandbox confinement: "any command inside a bwrap jail (no network, root =
  // the mounted file space)". Isolation is the boundary, so this variant carries
  // no command/argv matcher — a sandbox grant authorizes every command whose cwd
  // resolves inside the sandbox mount points. Linux-only; fail-closed elsewhere.
  "sandbox",
] as const
export const RUNTIME_AUTHORIZATION_COMMAND_MATCH_TYPES = [
  "exact",
  "prefix",
  "tool",
  "argv_exact",
  "argv_prefix",
  "argv_exact_preapproved",
] as const

// The fixed mount points a sandbox device-runtime exposes (the materialized
// file-space roots). A commandline:sandbox grant only covers a command whose
// working directory resolves within one of these. Kept here (not device-runtime)
// so the shared matcher and the API projection agree on the boundary.
export const SANDBOX_MOUNT_POINTS = [
  "/conversation",
  "/actor",
  "/actor-conversation",
] as const

export const AUTOMATION_TRIGGER_KINDS = ["schedule", "event"] as const
export const AUTOMATION_TRIGGER_SOURCE_KINDS = [
  "clock",
  "device",
  "webhook",
  "internal",
  "integration",
] as const

export const AUTOMATION_SCHEDULE_KINDS = ["cron", "at", "interval"] as const
export const AUTOMATION_COMPLETION_STATUSES = ["completed", "archived"] as const
export const AUTOMATION_TARGET_POLICIES = [
  "all_members",
  "specified_members",
] as const
export const AUTOMATION_RULE_STATUSES = [
  "active",
  "paused",
  "error",
  "archived",
  "completed",
  "expired",
] as const

export const AUTOMATION_INTEGRATION_PROVIDERS = ["github", "gitlab"] as const
export const AUTOMATION_INTEGRATION_INGRESS_KINDS = [
  "webhook",
  "polling",
] as const
export const AUTOMATION_INTEGRATION_TARGET_KINDS = [
  "repository",
  "project",
] as const
export const AUTOMATION_EVENT_SOURCE_PROVIDER_KINDS = [
  "device",
  "webhook",
  "internal",
  "integration",
] as const

export const AUTOMATION_EVENT_SOURCE_STATUSES = [
  "active",
  "deprecated",
  "disabled",
  "archived",
] as const

export const ACTOR_PACKAGE_SYNC_MODES = ["notify", "manual_merge"] as const

// ============ v3 device-runtime aliases (PR #16) ============
// PR #16 of the device-runtime refactor introduces device-shaped names that
// are now the only ones. PR #20 finally dropped the legacy RELAY_* aliases.

export const DEVICE_KINDS = [
  "desktop_computer",
  "laptop_computer",
  "mobile_phone",
  "tablet",
  "server",
  "virtual_machine",
  "custom",
] as const
export const DEVICE_TRUST_STATUSES_V3 = [
  "pending",
  "trusted",
  "revoked",
] as const
export const DEVICE_EXPOSURE_RUNTIME_STATUSES = [
  "discovered",
  "healthy",
  "degraded",
  "failed",
  "quarantined",
  "offline",
] as const
export const DEVICE_EXPOSURE_TRANSPORTS = [
  "builtin",
  "stdio",
  "http",
  "sse",
  "custom",
] as const

// Plugin transport tiers. Three distinct, non-overlapping sets so each
// consumer references the one that matches its semantics:
//  - MCP_SERVER_TRANSPORTS: transports the runtime instance-manager can
//    actually start (in-process builtin, stdio child, remote http/sse). No
//    "device" (that goes through the device-exposure path) and no "filesystem".
//  - PLUGIN_SPEC_TRANSPORTS: the values stored in the DB catalog spec column
//    (plugin_package_version_specs.transport) — adds "device".
//  - PLUGIN_TRANSPORTS: the full application-level union — adds "filesystem".
export const MCP_SERVER_TRANSPORTS = [
  "builtin",
  "stdio",
  "http",
  "sse",
] as const
export const PLUGIN_SPEC_TRANSPORTS = [
  "builtin",
  "stdio",
  "http",
  "sse",
  "device",
] as const
export const PLUGIN_TRANSPORTS = [
  "builtin",
  "stdio",
  "http",
  "sse",
  "device",
  "filesystem",
] as const
