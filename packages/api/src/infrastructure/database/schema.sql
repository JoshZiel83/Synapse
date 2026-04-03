-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE auth_sessions_client_type AS ENUM ('web', 'android', 'windows', 'ios', 'cli', 'api');
CREATE TYPE auth_sessions_transport AS ENUM ('cookie', 'token');
CREATE TYPE auth_qr_login_requests_status AS ENUM ('pending_scan', 'pending_confirm', 'approved', 'rejected', 'expired', 'consumed');
CREATE TYPE auth_qr_login_requests_approved_session_persistence AS ENUM ('persistent', 'temporary');
CREATE TYPE platform_access_bindings_access_key AS ENUM ('super_admin', 'workspace_admin', 'model_admin', 'support', 'auditor');
CREATE TYPE platform_access_bindings_source AS ENUM ('config', 'manual');
CREATE TYPE workspace_members_trust_level AS ENUM ('admin', 'member', 'guest');
CREATE TYPE workspace_access_bindings_access_key AS ENUM ('model_admin', 'actor_admin', 'skill_admin', 'plugin_admin', 'memory_admin', 'relay_admin', 'conversation_admin');
CREATE TYPE workspace_invites_trust_level AS ENUM ('admin', 'member', 'guest');
CREATE TYPE conversations_kind AS ENUM ('group', 'private', 'virtual');
CREATE TYPE conversations_boundary AS ENUM ('internal', 'external');
CREATE TYPE files_category AS ENUM ('general', 'chat_attachment', 'plugin_output', 'plugin_asset');
CREATE TYPE resource_access_bindings_status AS ENUM ('active', 'revoked');
CREATE TYPE resource_access_bindings_target_type AS ENUM ('workspace', 'conversation', 'actor', 'actor_in_conversation');
CREATE TYPE resource_access_binding_resource_type AS ENUM ('installed_skill', 'plugin_installation', 'relay_capability');
CREATE TYPE authz_outbox_operation AS ENUM ('touch', 'delete');
CREATE TYPE authz_outbox_status AS ENUM ('pending', 'processing', 'applied', 'failed');
CREATE TYPE realtime_event_outbox_status AS ENUM ('pending', 'processing', 'dispatched', 'failed');
CREATE TYPE catalog_categories_item_kind AS ENUM ('actor_template', 'skill_package', 'plugin_package');
CREATE TYPE catalog_items_item_kind AS ENUM ('actor_template', 'skill_package', 'plugin_package');
CREATE TYPE catalog_items_source_kind AS ENUM ('builtin', 'official', 'workspace', 'user', 'relay');
CREATE TYPE catalog_items_visibility AS ENUM ('public', 'workspace', 'private');
CREATE TYPE catalog_versions_status AS ENUM ('draft', 'active', 'deprecated', 'archived');
CREATE TYPE catalog_version_files_file_role AS ENUM ('document', 'reference', 'script', 'image', 'json', 'binary');
CREATE TYPE plugin_package_version_specs_transport AS ENUM ('builtin', 'stdio', 'http', 'relay');
CREATE TYPE plugin_package_version_specs_default_mount_scope AS ENUM ('workspace', 'conversation', 'actor', 'workspace_member');
CREATE TYPE plugin_package_version_specs_default_reuse_scope AS ENUM ('turn', 'session', 'workspace', 'conversation', 'actor');
CREATE TYPE actors_role AS ENUM ('secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant');
CREATE TYPE relationship_target_type AS ENUM ('member', 'actor');
CREATE TYPE actor_access_policy AS ENUM ('workspace_open', 'approval_required');
CREATE TYPE relationship_approval_mode AS ENUM ('auto', 'manual');
CREATE TYPE relationship_request_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE actor_versions_source_type AS ENUM ('workspace_member', 'actor', 'system', 'sync');
CREATE TYPE actor_version_docs_visibility AS ENUM ('always', 'direct_only', 'multi_member_only', 'internal_only');
CREATE TYPE actor_source_refs_sync_mode AS ENUM ('notify', 'manual_merge', 'follow_upstream', 'detached');
CREATE TYPE model_groups_owner_type AS ENUM ('platform', 'workspace', 'workspace_member');
CREATE TYPE model_groups_routing_strategy AS ENUM ('weighted_random', 'round_robin', 'priority_failover');
CREATE TYPE model_group_grants_grant_scope AS ENUM ('platform', 'workspace', 'workspace_member', 'actor');
CREATE TYPE model_group_grants_status AS ENUM ('active', 'revoked');
CREATE TYPE sessions_channel_type AS ENUM ('web', 'api', 'bridge');
CREATE TYPE sessions_status AS ENUM ('idle', 'queued', 'running', 'blocked', 'closed');
CREATE TYPE conversation_members_member_type AS ENUM ('actor', 'workspace_member', 'external', 'remote_agent', 'system');
CREATE TYPE conversation_members_state AS ENUM ('active', 'left', 'kicked');
CREATE TYPE conversation_members_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE transport_accounts_transport_kind AS ENUM ('feishu', 'weixin');
CREATE TYPE transport_accounts_owner_scope AS ENUM ('workspace', 'workspace_member');
CREATE TYPE transport_accounts_inbound_actor_mode AS ENUM ('none', 'specified_actor', 'follow_owner_chief_actor');
CREATE TYPE transport_accounts_connection_mode AS ENUM ('webhook', 'long_connection');
CREATE TYPE transport_accounts_status AS ENUM ('active', 'disabled', 'error');
CREATE TYPE transport_endpoints_endpoint_type AS ENUM ('direct', 'group');
CREATE TYPE conversation_transport_bindings_inbound_actor_mode AS ENUM ('inherit_account', 'none', 'specified_actor');
CREATE TYPE transport_addresses_transport_kind AS ENUM ('feishu', 'weixin');
CREATE TYPE transport_addresses_address_type AS ENUM ('user', 'bot', 'system');
CREATE TYPE conversation_grants_permission AS ENUM ('send', 'moderate', 'manage', 'manage_members', 'attach_resources');
CREATE TYPE conversation_grants_subject_type AS ENUM ('workspace_member', 'actor');
CREATE TYPE conversation_grants_status AS ENUM ('active', 'revoked');
CREATE TYPE conversation_items_scope AS ENUM ('shared', 'private');
CREATE TYPE conversation_items_surface AS ENUM ('visible', 'internal');
CREATE TYPE conversation_items_item_type AS ENUM ('message', 'event', 'summary', 'control');
CREATE TYPE conversation_items_role AS ENUM ('user', 'assistant', 'system', 'tool');
CREATE TYPE conversation_items_event_timeline_policy AS ENUM ('none', 'all_members', 'users_only', 'actors_only', 'targeted_members');
CREATE TYPE conversation_items_event_context_policy AS ENUM ('none', 'shared', 'actor_private', 'targeted_members');
CREATE TYPE conversation_item_parts_part_type AS ENUM ('text', 'file_ref', 'json');
CREATE TYPE conversation_item_targets_target_kind AS ENUM ('to', 'cc', 'visible');
CREATE TYPE transport_message_links_transport_kind AS ENUM ('feishu', 'weixin');
CREATE TYPE transport_message_links_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE transport_message_links_delivery_status AS ENUM ('pending', 'sent', 'failed', 'skipped');
CREATE TYPE turns_status AS ENUM ('running', 'completed', 'failed', 'cancelled');
CREATE TYPE payload_blobs_content_type AS ENUM ('json', 'text');
CREATE TYPE payload_blobs_retention_class AS ENUM ('ephemeral', 'debug', 'audit');
CREATE TYPE provider_steps_request_type AS ENUM ('actor_think', 'ai_complete');
CREATE TYPE provider_steps_status AS ENUM ('success', 'error', 'timeout');
CREATE TYPE tool_calls_tool_kind AS ENUM ('builtin', 'callable', 'action', 'mcp_plugin', 'mcp_relay', 'provider_builtin', 'a2a_proxy');
CREATE TYPE tool_calls_status AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
CREATE TYPE tool_call_tasks_executor_kind AS ENUM ('interaction_question', 'interaction_form', 'runtime_authorization', 'relay_mcp');
CREATE TYPE tool_call_tasks_delivery_policy AS ENUM ('online_only', 'store_and_forward', 'human_interaction');
CREATE TYPE tool_call_tasks_status AS ENUM ('working', 'input_required', 'completed', 'failed', 'cancelled');
CREATE TYPE tool_call_tasks_dispatch_status AS ENUM ('accepted', 'queued', 'dispatched', 'received', 'started', 'input_requested', 'cancel_requested');
CREATE TYPE tool_call_task_output_chunks_stream AS ENUM ('stdout', 'stderr', 'system');
CREATE TYPE tool_execution_attempts_executor_kind AS ENUM ('builtin', 'callable', 'action', 'mcp_plugin', 'mcp_relay', 'provider_builtin', 'a2a_proxy');
CREATE TYPE tool_execution_attempts_status AS ENUM ('success', 'error', 'timeout');
CREATE TYPE tool_result_parts_part_type AS ENUM ('text', 'file_ref', 'json');
CREATE TYPE session_wakeups_source_type AS ENUM ('user_message', 'actor_message', 'broadcast', 'invite', 'api_call', 'automation', 'system_interrupt', 'retry');
CREATE TYPE session_wakeups_source_member_type AS ENUM ('workspace_member', 'actor', 'external', 'system');
CREATE TYPE session_wakeups_status AS ENUM ('pending', 'attached', 'processed', 'dropped');
CREATE TYPE automation_rules_category AS ENUM ('schedule', 'event_subscription');
CREATE TYPE automation_rules_status AS ENUM ('active', 'paused', 'error', 'archived', 'completed', 'expired');
CREATE TYPE automation_rules_created_by_kind AS ENUM ('workspace_member', 'session', 'system');
CREATE TYPE automation_policies_completion_status AS ENUM ('completed', 'archived');
CREATE TYPE automation_event_sources_provider_kind AS ENUM ('relay', 'webhook', 'internal', 'integration');
CREATE TYPE automation_event_sources_status AS ENUM ('active', 'deprecated', 'disabled', 'archived');
CREATE TYPE automation_event_sources_created_by_kind AS ENUM ('workspace_member', 'session', 'system');
CREATE TYPE automation_triggers_trigger_kind AS ENUM ('schedule', 'event');
CREATE TYPE automation_triggers_source_kind AS ENUM ('clock', 'relay', 'webhook', 'internal', 'integration');
CREATE TYPE automation_triggers_schedule_kind AS ENUM ('cron', 'at', 'interval');
CREATE TYPE automation_deliveries_delivery_mode AS ENUM ('wake_session', 'conversation_notice', 'create_conversation_once', 'create_conversation_each_time');
CREATE TYPE automation_deliveries_target_policy AS ENUM ('all_members', 'specified_members');
CREATE TYPE automation_delivery_participants_entity_kind AS ENUM ('actor', 'workspace_member');
CREATE TYPE automation_delivery_recipients_entity_kind AS ENUM ('actor', 'workspace_member');
CREATE TYPE automation_webhook_endpoints_status AS ENUM ('active', 'disabled', 'archived');
CREATE TYPE automation_occurrences_source_kind AS ENUM ('clock', 'relay', 'webhook', 'internal', 'integration');
CREATE TYPE automation_executions_status AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
CREATE TYPE automation_execution_targets_status AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');
CREATE TYPE memory_spaces_space_type AS ENUM ('workspace_shared', 'conversation_shared', 'actor_private', 'participant_private', 'user_private');
CREATE TYPE memory_items_category AS ENUM ('fact', 'preference', 'decision', 'relationship', 'procedure', 'artifact', 'summary');
CREATE TYPE memory_items_state AS ENUM ('active', 'superseded', 'archived');
CREATE TYPE memory_items_index_status AS ENUM ('lexical_ready', 'ready', 'failed');
CREATE TYPE memory_item_parts_part_type AS ENUM ('text', 'file_ref', 'json');
CREATE TYPE memory_recall_runs_recall_type AS ENUM ('bootstrap', 'turn_recall', 'manual_search');
CREATE TYPE context_archive_points_chain_scope AS ENUM ('shared', 'private');
CREATE TYPE context_archive_frames_role AS ENUM ('system', 'user', 'assistant', 'tool');
CREATE TYPE context_archive_frame_parts_part_type AS ENUM ('text', 'file_ref', 'json');
CREATE TYPE context_compaction_runs_chain_scope AS ENUM ('shared', 'private');
CREATE TYPE context_compaction_runs_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
CREATE TYPE context_compaction_run_inputs_input_kind AS ENUM ('archive_point', 'sequence_range', 'item');
CREATE TYPE session_engine_branches_status AS ENUM ('active', 'superseded', 'archived');
CREATE TYPE engine_branch_checkpoints_checkpoint_kind AS ENUM ('snapshot', 'compaction');
CREATE TYPE session_interrupts_type AS ENUM ('progress_check', 'priority_override');
CREATE TYPE runtime_events_source AS ENUM ('conversation', 'provider', 'tool', 'relay', 'a2a', 'system');
CREATE TYPE runtime_events_level AS ENUM ('debug', 'info', 'warn', 'error');
CREATE TYPE skill_source_refs_sync_mode AS ENUM ('notify', 'manual_merge', 'follow_upstream', 'detached');
CREATE TYPE skill_mirror_sources_source_type AS ENUM ('github', 'clawhub');
CREATE TYPE skill_mirror_sources_refresh_mode AS ENUM ('manual');
CREATE TYPE skill_mirror_sources_sync_status AS ENUM ('pending', 'synced', 'error');
CREATE TYPE plugin_installations_attachment_target_type AS ENUM ('workspace', 'conversation', 'actor', 'workspace_member');
CREATE TYPE plugin_installations_reuse_scope AS ENUM ('turn', 'session', 'workspace', 'conversation', 'actor');
CREATE TYPE plugin_installations_status AS ENUM ('active', 'disabled', 'error', 'archived');
CREATE TYPE automation_integration_bindings_provider AS ENUM ('github', 'gitlab');
CREATE TYPE automation_integration_bindings_ingress_kind AS ENUM ('webhook', 'polling');
CREATE TYPE automation_integration_bindings_target_kind AS ENUM ('repository', 'project');
CREATE TYPE plugin_auth_sessions_status AS ENUM ('pending', 'completed', 'failed', 'expired', 'consumed');
CREATE TYPE plugin_connections_owner_scope AS ENUM ('installation', 'workspace_member', 'workspace');
CREATE TYPE plugin_connections_status AS ENUM ('active', 'expired', 'revoked');
CREATE TYPE plugin_source_refs_sync_mode AS ENUM ('notify', 'manual_merge', 'follow_upstream', 'detached');
CREATE TYPE relay_devices_trust_status AS ENUM ('pending', 'active', 'revoked', 'blocked');
CREATE TYPE relay_devices_automation_lifecycle_state AS ENUM ('online', 'offline');
CREATE TYPE relay_devices_device_type AS ENUM ('desktop_computer', 'laptop_computer', 'mobile_phone', 'tablet', 'server', 'virtual_machine', 'custom');
CREATE TYPE relay_authorization_mode AS ENUM ('server_trust', 'client_local');
CREATE TYPE relay_pairing_sessions_status AS ENUM ('pending', 'confirmed', 'consumed', 'expired', 'cancelled', 'rejected');
CREATE TYPE relay_device_sessions_status AS ENUM ('connecting', 'active', 'closing', 'closed', 'rejected');
CREATE TYPE relay_device_sessions_transport AS ENUM ('websocket');
CREATE TYPE relay_sync_sources_source_kind AS ENUM ('manual', 'claude_code', 'claude_desktop', 'codex', 'gemini', 'opencode', 'custom');
CREATE TYPE relay_sync_sources_sync_mode AS ENUM ('snapshot', 'follow');
CREATE TYPE relay_sync_sources_status AS ENUM ('unknown', 'idle', 'syncing', 'error', 'disabled');
CREATE TYPE relay_exposures_transport AS ENUM ('builtin', 'stdio', 'http', 'sse', 'custom');
CREATE TYPE relay_exposures_runtime_status AS ENUM ('discovered', 'starting', 'healthy', 'degraded', 'failed', 'quarantined', 'offline');
CREATE TYPE relay_catalog_revisions_status AS ENUM ('active', 'superseded');
CREATE TYPE relay_tools_status AS ENUM ('active', 'removed');
CREATE TYPE relay_capabilities_status AS ENUM ('active', 'unavailable', 'archived');
CREATE TYPE relay_operations_delivery_policy AS ENUM ('online_only', 'store_and_forward');
CREATE TYPE relay_operations_status AS ENUM ('created', 'dispatched', 'received', 'started', 'cancel_requested', 'completed', 'failed', 'cancelled', 'aborted', 'expired');
CREATE TYPE relay_operation_deliveries_status AS ENUM ('queued', 'sent', 'acked', 'nacked', 'timed_out', 'cancelled');
CREATE TYPE interaction_requests_kind AS ENUM ('question_choice', 'runtime_authorization');
CREATE TYPE interaction_requests_status AS ENUM ('pending', 'answered', 'approved', 'rejected', 'cancelled', 'expired', 'superseded');
CREATE TYPE runtime_grants_scope AS ENUM ('once', 'actor', 'conversation', 'workspace');
CREATE TYPE runtime_grants_retention AS ENUM ('consume_once', 'until_revoked');
CREATE TYPE runtime_grants_status AS ENUM ('active', 'consumed', 'revoked', 'superseded');

-- ============ Users ============
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_file_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============ Auth Sessions ============
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_type auth_sessions_client_type NOT NULL DEFAULT 'web',
  transport auth_sessions_transport NOT NULL DEFAULT 'cookie',
  device_name VARCHAR(255),
  platform VARCHAR(120),
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  token_hint VARCHAR(16) NOT NULL,
  ip_address VARCHAR(120),
  user_agent TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason VARCHAR(50)
);

CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, created_at DESC);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE auth_qr_login_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scan_token_hash VARCHAR(128) UNIQUE NOT NULL,
  browser_token_hash VARCHAR(128) UNIQUE NOT NULL,
  status auth_qr_login_requests_status NOT NULL DEFAULT 'pending_scan',
  browser_ip_address VARCHAR(120),
  browser_user_agent TEXT,
  browser_label VARCHAR(160) NOT NULL,
  approved_session_persistence auth_qr_login_requests_approved_session_persistence,
  resolver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scanned_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_auth_qr_login_requests_expires
  ON auth_qr_login_requests(expires_at);
CREATE INDEX idx_auth_qr_login_requests_resolver
  ON auth_qr_login_requests(resolver_user_id, created_at DESC);

-- ============ Workspaces ============
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_trusted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_slug ON workspaces(slug);

CREATE TABLE platform_access_bindings (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key platform_access_bindings_access_key NOT NULL,
  source platform_access_bindings_source NOT NULL DEFAULT 'manual',
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, access_key)
);

CREATE TABLE workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trust_level workspace_members_trust_level NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE workspace_access_bindings (
  workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  access_key workspace_access_bindings_access_key NOT NULL,
  assigned_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_member_id, access_key)
);

CREATE TABLE workspace_capability_conversation_type_policies (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_family VARCHAR(60) NOT NULL
    CHECK (resource_family IN ('plugin_installation', 'installed_skill', 'relay_capability')),
  default_conversation_type_mask INT NOT NULL
    CHECK (default_conversation_type_mask > 0 AND default_conversation_type_mask <= 31),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, resource_family)
);

CREATE TABLE workspace_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token VARCHAR(12) UNIQUE NOT NULL,
  created_by_workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  trust_level workspace_invites_trust_level NOT NULL DEFAULT 'member',
  max_uses INT,
  use_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Conversations ============
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind conversations_kind NOT NULL,
  boundary conversations_boundary NOT NULL,
  internal_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(500),
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_conversations_internal_workspace CHECK (
    (boundary = 'internal' AND internal_workspace_id IS NOT NULL) OR
    (boundary = 'external' AND internal_workspace_id IS NULL)
  )
);

CREATE INDEX idx_conversations_kind ON conversations(kind, created_at DESC);
CREATE INDEX idx_conversations_boundary ON conversations(boundary, created_at DESC);
CREATE INDEX idx_conversations_internal_workspace
  ON conversations(internal_workspace_id, created_at DESC)
  WHERE internal_workspace_id IS NOT NULL;

-- ============ Audit Logs ============
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id UUID,
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(120) NOT NULL,
  resource_id UUID,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(120),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- ============ Files ============
CREATE TABLE files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  uploader_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  original_name VARCHAR(500) NOT NULL,
  stored_name VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  category files_category DEFAULT 'general',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_workspace ON files(workspace_id, created_at DESC);
CREATE INDEX idx_files_uploader ON files(uploader_user_id, created_at DESC);

ALTER TABLE users
  ADD CONSTRAINT users_avatar_file_id_fkey
  FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;

-- ============ Access Core ============
CREATE TABLE authz_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation authz_outbox_operation NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id TEXT NOT NULL,
  relation VARCHAR(60) NOT NULL,
  subject_type VARCHAR(60) NOT NULL,
  subject_id TEXT NOT NULL,
  subject_relation VARCHAR(60),
  metadata JSONB DEFAULT '{}',
  status authz_outbox_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  zed_token TEXT,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_authz_outbox_status ON authz_outbox(status, created_at);
CREATE INDEX idx_authz_outbox_resource ON authz_outbox(resource_type, resource_id, created_at DESC);

CREATE TABLE realtime_event_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type VARCHAR(100) NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}',
  event_timestamp TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status realtime_event_outbox_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  processing_started_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_realtime_event_outbox_status
  ON realtime_event_outbox(status, available_at, created_at);
CREATE INDEX idx_realtime_event_outbox_workspace
  ON realtime_event_outbox(workspace_id, event_timestamp DESC, created_at DESC);
CREATE INDEX idx_realtime_event_outbox_recipient
  ON realtime_event_outbox(recipient_workspace_member_id, event_timestamp DESC, created_at DESC);

-- ============ Skill Content ============
CREATE TABLE skill_mirror_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type skill_mirror_sources_source_type NOT NULL,
  locator_key TEXT NOT NULL,
  locator JSONB NOT NULL DEFAULT '{}',
  requested_ref VARCHAR(255),
  resolved_revision VARCHAR(255),
  refresh_mode skill_mirror_sources_refresh_mode NOT NULL DEFAULT 'manual',
  last_sync_status skill_mirror_sources_sync_status NOT NULL DEFAULT 'pending',
  source_warnings TEXT[] NOT NULL DEFAULT '{}',
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_type, locator_key)
);

CREATE INDEX idx_skill_mirror_sources_sync
  ON skill_mirror_sources(source_type, last_sync_status, updated_at DESC);

CREATE TABLE skill_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mirror_source_id UUID REFERENCES skill_mirror_sources(id) ON DELETE SET NULL,
  entry_path TEXT NOT NULL DEFAULT 'SKILL.md',
  name VARCHAR(64) NOT NULL,
  description TEXT NOT NULL,
  argument_hint VARCHAR(255),
  disable_model_invocation BOOLEAN NOT NULL DEFAULT FALSE,
  user_invocable BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_tools TEXT[] NOT NULL DEFAULT '{}',
  model VARCHAR(255),
  effort VARCHAR(16)
    CHECK (effort IS NULL OR effort IN ('low', 'medium', 'high', 'max')),
  context VARCHAR(16)
    CHECK (context IS NULL OR context IN ('fork')),
  agent VARCHAR(255),
  hooks JSONB NOT NULL DEFAULT '{}',
  body_blocks JSONB NOT NULL DEFAULT '[]',
  content_hash VARCHAR(64) NOT NULL,
  source_warnings TEXT[] NOT NULL DEFAULT '{}',
  resolved_revision VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_skill_snapshots_mirror_source
  ON skill_snapshots(mirror_source_id, created_at DESC);
CREATE INDEX idx_skill_snapshots_content_hash
  ON skill_snapshots(content_hash);

CREATE TABLE skill_snapshot_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  skill_snapshot_id UUID NOT NULL REFERENCES skill_snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  media_type VARCHAR(255),
  content_blocks JSONB NOT NULL DEFAULT '[]',
  sha256 VARCHAR(64) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_snapshot_id, path)
);

CREATE INDEX idx_skill_snapshot_files_snapshot
  ON skill_snapshot_files(skill_snapshot_id, path);

-- ============ Catalog Core ============
CREATE TABLE publishers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  logo_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  is_builtin BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE catalog_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) NOT NULL,
  item_kind catalog_categories_item_kind NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  icon_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  sort_order INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item_kind, slug)
);

CREATE TABLE catalog_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publisher_id UUID NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  item_kind catalog_items_item_kind NOT NULL,
  slug VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  summary TEXT DEFAULT '',
  long_description TEXT DEFAULT '',
  icon_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  mirror_source_id UUID REFERENCES skill_mirror_sources(id) ON DELETE SET NULL,
  source_kind catalog_items_source_kind NOT NULL DEFAULT 'official',
  visibility catalog_items_visibility NOT NULL DEFAULT 'public',
  tags TEXT[] DEFAULT '{}',
  latest_version_id UUID,
  is_active BOOLEAN DEFAULT TRUE,
  download_count INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_catalog_items_global_slug
  ON catalog_items(publisher_id, item_kind, slug)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX uq_catalog_items_workspace_slug
  ON catalog_items(publisher_id, workspace_id, item_kind, slug)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uq_catalog_items_mirror_source
  ON catalog_items(mirror_source_id)
  WHERE mirror_source_id IS NOT NULL;
CREATE INDEX idx_catalog_items_kind ON catalog_items(item_kind, created_at DESC);
CREATE INDEX idx_catalog_items_workspace ON catalog_items(workspace_id, item_kind, created_at DESC);
CREATE INDEX idx_catalog_items_tags ON catalog_items USING GIN(tags);

CREATE TABLE catalog_item_categories (
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (catalog_item_id, category_id)
);

CREATE TABLE catalog_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  version VARCHAR(80) NOT NULL,
  status catalog_versions_status NOT NULL DEFAULT 'active',
  changelog TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(catalog_item_id, version)
);

CREATE INDEX idx_catalog_versions_item ON catalog_versions(catalog_item_id, created_at DESC);

ALTER TABLE catalog_items
  ADD CONSTRAINT fk_catalog_items_latest_version
  FOREIGN KEY (latest_version_id) REFERENCES catalog_versions(id) ON DELETE SET NULL;

CREATE TABLE catalog_version_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  catalog_version_id UUID NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  file_role catalog_version_files_file_role NOT NULL,
  media_type VARCHAR(255),
  text_content TEXT NOT NULL,
  content_blocks JSONB DEFAULT '[]',
  sha256 VARCHAR(64) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(catalog_version_id, path)
);

CREATE INDEX idx_catalog_version_files_version ON catalog_version_files(catalog_version_id, path);

-- ============ Catalog Specs ============
CREATE TABLE actor_template_version_specs (
  catalog_version_id UUID PRIMARY KEY REFERENCES catalog_versions(id) ON DELETE CASCADE,
  role actors_role NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  avatar_emoji VARCHAR(32),
  title VARCHAR(255) NOT NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  docs JSONB NOT NULL DEFAULT '[]',
  specialties TEXT[] DEFAULT '{}',
  config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (avatar_file_id IS NULL OR avatar_emoji IS NULL)
);

CREATE TABLE skill_package_version_specs (
  catalog_version_id UUID PRIMARY KEY REFERENCES catalog_versions(id) ON DELETE CASCADE,
  skill_snapshot_id UUID NOT NULL REFERENCES skill_snapshots(id) ON DELETE RESTRICT,
  default_conversation_type_mask INT NOT NULL DEFAULT 31
    CHECK (default_conversation_type_mask > 0 AND default_conversation_type_mask <= 31),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE plugin_package_version_specs (
  catalog_version_id UUID PRIMARY KEY REFERENCES catalog_versions(id) ON DELETE CASCADE,
  transport plugin_package_version_specs_transport NOT NULL,
  entry_point TEXT,
  tool_manifest JSONB NOT NULL DEFAULT '[]',
  config_schema JSONB NOT NULL DEFAULT '{}',
  default_config JSONB NOT NULL DEFAULT '{}',
  install_flow JSONB NOT NULL DEFAULT '{}',
  auth_bindings JSONB NOT NULL DEFAULT '[]',
  default_mount_scope plugin_package_version_specs_default_mount_scope NOT NULL DEFAULT 'workspace',
  default_reuse_scope plugin_package_version_specs_default_reuse_scope NOT NULL DEFAULT 'conversation',
  default_conversation_type_mask INT NOT NULL DEFAULT 31
    CHECK (default_conversation_type_mask > 0 AND default_conversation_type_mask <= 31),
  supported_reuse_scopes plugin_package_version_specs_default_reuse_scope[] NOT NULL
    DEFAULT ARRAY['turn', 'session', 'workspace', 'conversation', 'actor']::plugin_package_version_specs_default_reuse_scope[],
  requires_handshake BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE plugin_version_runtime_permissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  catalog_version_id UUID NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  permission_key VARCHAR(120) NOT NULL,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  rationale TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(catalog_version_id, permission_key)
);

-- ============ Actor Runtime ============
CREATE TABLE actors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role actors_role NOT NULL,
  title VARCHAR(255) NOT NULL,
  avatar_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  avatar_emoji VARCHAR(32),
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  specialties TEXT[] DEFAULT '{}',
  access_policy actor_access_policy NOT NULL DEFAULT 'workspace_open',
  config JSONB DEFAULT '{}',
  current_version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_public_shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (avatar_file_id IS NULL OR avatar_emoji IS NULL)
);

CREATE INDEX idx_actors_workspace ON actors(workspace_id, created_at DESC);
CREATE INDEX idx_actors_parent ON actors(parent_id);

CREATE TABLE workspace_relationship_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type relationship_target_type NOT NULL,
  subject_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  subject_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  identity_id VARCHAR(32) NOT NULL UNIQUE
    DEFAULT lower('id_' || substr(replace(uuid_generate_v4()::text, '-', ''), 1, 12)),
  identity_search_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  approval_mode relationship_approval_mode NOT NULL DEFAULT 'manual',
  qr_token VARCHAR(128) NOT NULL UNIQUE,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (subject_type = 'member' AND subject_workspace_member_id IS NOT NULL AND subject_actor_id IS NULL) OR
    (subject_type = 'actor' AND subject_actor_id IS NOT NULL AND subject_workspace_member_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_workspace_relationship_profiles_member
  ON workspace_relationship_profiles(workspace_id, subject_workspace_member_id)
  WHERE subject_type = 'member' AND subject_workspace_member_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workspace_relationship_profiles_actor
  ON workspace_relationship_profiles(workspace_id, subject_actor_id)
  WHERE subject_type = 'actor' AND subject_actor_id IS NOT NULL;
CREATE INDEX idx_workspace_relationship_profiles_identity_lookup
  ON workspace_relationship_profiles(identity_id)
  WHERE identity_search_enabled = TRUE;

CREATE TABLE workspace_friend_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  requester_workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  target_subject_type relationship_target_type NOT NULL,
  target_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  target_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  requested_via_profile_id UUID REFERENCES workspace_relationship_profiles(id) ON DELETE SET NULL,
  status relationship_request_status NOT NULL DEFAULT 'pending',
  resolved_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (target_subject_type = 'member' AND target_workspace_member_id IS NOT NULL AND target_actor_id IS NULL) OR
    (target_subject_type = 'actor' AND target_actor_id IS NOT NULL AND target_workspace_member_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_workspace_friend_requests_pending_member
  ON workspace_friend_requests(
    requester_workspace_member_id,
    target_workspace_member_id
  )
  WHERE status = 'pending' AND target_subject_type = 'member' AND target_workspace_member_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workspace_friend_requests_pending_actor
  ON workspace_friend_requests(
    requester_workspace_member_id,
    target_actor_id
  )
  WHERE status = 'pending' AND target_subject_type = 'actor' AND target_actor_id IS NOT NULL;
CREATE INDEX idx_workspace_friend_requests_target_member
  ON workspace_friend_requests(target_workspace_member_id, created_at DESC)
  WHERE target_workspace_member_id IS NOT NULL;
CREATE INDEX idx_workspace_friend_requests_target_actor
  ON workspace_friend_requests(target_actor_id, created_at DESC)
  WHERE target_actor_id IS NOT NULL;
CREATE INDEX idx_workspace_friend_requests_requester
  ON workspace_friend_requests(requester_workspace_member_id, created_at DESC);

CREATE TABLE workspace_friend_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  peer_type relationship_target_type NOT NULL,
  peer_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  peer_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  source_request_id UUID REFERENCES workspace_friend_requests(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (peer_type = 'member' AND peer_workspace_member_id IS NOT NULL AND peer_actor_id IS NULL) OR
    (peer_type = 'actor' AND peer_actor_id IS NOT NULL AND peer_workspace_member_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_workspace_friend_entries_member
  ON workspace_friend_entries(workspace_id, owner_workspace_member_id, peer_workspace_member_id)
  WHERE peer_type = 'member' AND peer_workspace_member_id IS NOT NULL;
CREATE UNIQUE INDEX uq_workspace_friend_entries_actor
  ON workspace_friend_entries(workspace_id, owner_workspace_member_id, peer_actor_id)
  WHERE peer_type = 'actor' AND peer_actor_id IS NOT NULL;
CREATE INDEX idx_workspace_friend_entries_owner
  ON workspace_friend_entries(workspace_id, owner_workspace_member_id, created_at DESC);

CREATE TABLE actor_access_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  requester_workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  status relationship_request_status NOT NULL DEFAULT 'pending',
  resolved_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_actor_access_requests_pending
  ON actor_access_requests(workspace_id, actor_id, requester_workspace_member_id)
  WHERE status = 'pending';
CREATE INDEX idx_actor_access_requests_actor
  ON actor_access_requests(workspace_id, actor_id, created_at DESC);
CREATE INDEX idx_actor_access_requests_requester
  ON actor_access_requests(workspace_id, requester_workspace_member_id, created_at DESC);

CREATE TABLE direct_conversation_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  participant_one_kind relationship_target_type NOT NULL,
  participant_one_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  participant_one_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  participant_two_kind relationship_target_type NOT NULL,
  participant_two_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  participant_two_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (participant_one_kind = 'member' AND participant_one_workspace_member_id IS NOT NULL AND participant_one_actor_id IS NULL) OR
    (participant_one_kind = 'actor' AND participant_one_workspace_member_id IS NULL AND participant_one_actor_id IS NOT NULL)
  ),
  CHECK (
    (participant_two_kind = 'member' AND participant_two_workspace_member_id IS NOT NULL AND participant_two_actor_id IS NULL) OR
    (participant_two_kind = 'actor' AND participant_two_workspace_member_id IS NULL AND participant_two_actor_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_direct_conversation_bindings_pair
  ON direct_conversation_bindings(
    participant_one_kind,
    COALESCE(participant_one_workspace_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(participant_one_actor_id, '00000000-0000-0000-0000-000000000000'::uuid),
    participant_two_kind,
    COALESCE(participant_two_workspace_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(participant_two_actor_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX idx_direct_conversation_bindings_participant_one
  ON direct_conversation_bindings(
    participant_one_kind,
    participant_one_workspace_member_id,
    participant_one_actor_id
  );
CREATE INDEX idx_direct_conversation_bindings_participant_two
  ON direct_conversation_bindings(
    participant_two_kind,
    participant_two_workspace_member_id,
    participant_two_actor_id
  );

CREATE TABLE workspace_member_preferences (
  workspace_member_id UUID PRIMARY KEY REFERENCES workspace_members(id) ON DELETE CASCADE,
  chief_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspace_member_preferences_actor ON workspace_member_preferences(chief_actor_id);

CREATE TABLE actor_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  version INT NOT NULL,
  previous_version_id UUID REFERENCES actor_versions(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  role actors_role NOT NULL,
  title VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  specialties TEXT[] DEFAULT '{}',
  config JSONB DEFAULT '{}',
  version_delta JSONB,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  source_type actor_versions_source_type NOT NULL DEFAULT 'system',
  source_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  source_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  source_session_id UUID,
  source_turn_id UUID,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  source_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(actor_id, version)
);

CREATE TABLE actor_version_docs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_version_id UUID NOT NULL REFERENCES actor_versions(id) ON DELETE CASCADE,
  doc_key VARCHAR(40) NOT NULL,
  title VARCHAR(255) NOT NULL,
  visibility actor_version_docs_visibility NOT NULL DEFAULT 'always',
  priority INT NOT NULL DEFAULT 0,
  content_blocks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_actor_version_docs_version ON actor_version_docs(actor_version_id, priority DESC, created_at);

CREATE TABLE actor_source_refs (
  actor_id UUID PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  source_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  source_catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  sync_mode actor_source_refs_sync_mode NOT NULL DEFAULT 'notify',
  baseline_actor_version INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Model Routing ============
CREATE TABLE model_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type model_groups_owner_type NOT NULL,
  owner_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  routing_strategy model_groups_routing_strategy NOT NULL DEFAULT 'priority_failover',
  attempt_policy JSONB DEFAULT '{}',
  is_default BOOLEAN DEFAULT FALSE,
  is_enabled BOOLEAN DEFAULT TRUE,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (owner_type = 'platform' AND owner_workspace_id IS NULL AND owner_workspace_member_id IS NULL) OR
    (owner_type = 'workspace' AND owner_workspace_id IS NOT NULL AND owner_workspace_member_id IS NULL) OR
    (owner_type = 'workspace_member' AND owner_workspace_id IS NULL AND owner_workspace_member_id IS NOT NULL)
  )
);

CREATE INDEX idx_model_groups_owner_workspace ON model_groups(owner_workspace_id, created_at DESC);
CREATE INDEX idx_model_groups_owner_workspace_member ON model_groups(owner_workspace_member_id, created_at DESC);
CREATE UNIQUE INDEX idx_model_groups_default_platform
  ON model_groups ((1)) WHERE owner_type = 'platform' AND is_default = TRUE AND is_enabled = TRUE;
CREATE UNIQUE INDEX idx_model_groups_default_workspace
  ON model_groups (owner_workspace_id) WHERE owner_type = 'workspace' AND owner_workspace_id IS NOT NULL AND is_default = TRUE AND is_enabled = TRUE;
CREATE UNIQUE INDEX idx_model_groups_default_workspace_member
  ON model_groups (owner_workspace_member_id) WHERE owner_type = 'workspace_member' AND owner_workspace_member_id IS NOT NULL AND is_default = TRUE AND is_enabled = TRUE;

CREATE TABLE model_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name VARCHAR(255) NOT NULL,
  current_revision_id UUID,
  is_enabled BOOLEAN DEFAULT TRUE,
  installed_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_model_profiles_workspace ON model_profiles(workspace_id, created_at DESC);

CREATE TABLE model_profile_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  provider_type VARCHAR(64) NOT NULL CHECK (provider_type ~ '^[a-z][a-z0-9_-]*$'),
  api_key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name VARCHAR(255) NOT NULL,
  max_tokens INT NOT NULL DEFAULT 4096,
  capability_tags TEXT[] DEFAULT '{}',
  extra_config JSONB DEFAULT '{}',
  request_timeout_ms INT,
  max_retries INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, version)
);

CREATE INDEX idx_model_profile_revisions_profile ON model_profile_revisions(profile_id, version DESC);

ALTER TABLE model_profiles ADD CONSTRAINT fk_model_profiles_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES model_profile_revisions(id) ON DELETE SET NULL;

CREATE TABLE model_group_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  grant_scope model_group_grants_grant_scope NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  status model_group_grants_status NOT NULL DEFAULT 'active',
  granted_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_model_group_grants_target CHECK (
    (grant_scope = 'platform' AND workspace_id IS NULL AND workspace_member_id IS NULL AND actor_id IS NULL) OR
    (grant_scope = 'workspace' AND workspace_id IS NOT NULL AND workspace_member_id IS NULL AND actor_id IS NULL) OR
    (grant_scope = 'workspace_member' AND workspace_id IS NULL AND workspace_member_id IS NOT NULL AND actor_id IS NULL) OR
    (grant_scope = 'actor' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND workspace_member_id IS NULL)
  )
);

CREATE INDEX idx_model_group_grants_group ON model_group_grants(group_id, created_at DESC);
CREATE INDEX idx_model_group_grants_workspace ON model_group_grants(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_model_group_grants_actor ON model_group_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_model_group_grants_workspace_member ON model_group_grants(workspace_member_id, created_at DESC) WHERE workspace_member_id IS NOT NULL;

CREATE TABLE model_group_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  is_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, profile_id)
);

CREATE INDEX idx_model_group_profiles_group ON model_group_profiles(group_id, priority, created_at DESC);

CREATE TABLE actor_model_group_assignments (
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (actor_id, group_id)
);

CREATE INDEX idx_actor_model_group_assignments_actor ON actor_model_group_assignments(actor_id);

-- ============ Chat Runtime ============
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_type sessions_channel_type NOT NULL DEFAULT 'web',
  trigger VARCHAR(50) NOT NULL DEFAULT 'user_message',
  status sessions_status NOT NULL DEFAULT 'idle',
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_actor ON sessions(actor_id);
CREATE INDEX idx_sessions_actor_status ON sessions(actor_id, status);
CREATE INDEX idx_sessions_conversation ON sessions(conversation_id);
CREATE UNIQUE INDEX uq_sessions_conversation_actor
  ON sessions(conversation_id, actor_id);

CREATE TABLE conversation_actor_contexts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, actor_id)
);

CREATE INDEX idx_conversation_actor_contexts_conversation
  ON conversation_actor_contexts(conversation_id, created_at DESC);
CREATE INDEX idx_conversation_actor_contexts_actor
  ON conversation_actor_contexts(actor_id, created_at DESC);

CREATE TABLE conversation_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_type conversation_members_member_type NOT NULL,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  actor_join_version_id UUID REFERENCES actor_versions(id) ON DELETE SET NULL,
  display_name VARCHAR(255),
  role conversation_members_role NOT NULL DEFAULT 'member',
  state conversation_members_state NOT NULL DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  CHECK (
    (member_type = 'actor' AND actor_id IS NOT NULL AND workspace_member_id IS NULL) OR
    (member_type = 'workspace_member' AND actor_id IS NULL AND workspace_member_id IS NOT NULL) OR
    (member_type IN ('external', 'remote_agent', 'system') AND actor_id IS NULL AND workspace_member_id IS NULL)
  )
);

CREATE INDEX idx_conversation_members_conversation ON conversation_members(conversation_id, state);
CREATE INDEX idx_conversation_members_actor ON conversation_members(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_conversation_members_workspace_member
  ON conversation_members(workspace_member_id) WHERE workspace_member_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_actor
  ON conversation_members(conversation_id, actor_id) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_workspace_member
  ON conversation_members(conversation_id, workspace_member_id)
  WHERE workspace_member_id IS NOT NULL;

CREATE TABLE transport_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transport_kind transport_accounts_transport_kind NOT NULL,
  account_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  owner_scope transport_accounts_owner_scope NOT NULL DEFAULT 'workspace',
  owner_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  inbound_actor_mode transport_accounts_inbound_actor_mode NOT NULL DEFAULT 'none',
  inbound_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  connection_mode transport_accounts_connection_mode NOT NULL,
  status transport_accounts_status NOT NULL DEFAULT 'active',
  credentials JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (owner_scope = 'workspace' AND owner_workspace_member_id IS NULL) OR
    (owner_scope = 'workspace_member' AND owner_workspace_member_id IS NOT NULL)
  ),
  CHECK (
    owner_scope = 'workspace_member' OR
    inbound_actor_mode <> 'follow_owner_chief_actor'
  ),
  CHECK (
    (inbound_actor_mode = 'specified_actor' AND inbound_actor_id IS NOT NULL) OR
    (inbound_actor_mode <> 'specified_actor' AND inbound_actor_id IS NULL)
  ),
  UNIQUE(workspace_id, transport_kind, account_key)
);

CREATE INDEX idx_transport_accounts_workspace
  ON transport_accounts(workspace_id, transport_kind, created_at DESC);
CREATE INDEX idx_transport_accounts_owner_workspace_member
  ON transport_accounts(owner_workspace_member_id, created_at DESC)
  WHERE owner_workspace_member_id IS NOT NULL;

CREATE TABLE transport_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  endpoint_type transport_endpoints_endpoint_type NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  parent_external_id VARCHAR(255),
  display_name VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(transport_account_id, endpoint_type, external_id)
);

CREATE INDEX idx_transport_endpoints_account
  ON transport_endpoints(transport_account_id, endpoint_type, created_at DESC);

CREATE TABLE conversation_transport_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  transport_endpoint_id UUID NOT NULL REFERENCES transport_endpoints(id) ON DELETE CASCADE,
  outbound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  inbound_actor_mode conversation_transport_bindings_inbound_actor_mode NOT NULL DEFAULT 'inherit_account',
  inbound_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (inbound_actor_mode = 'specified_actor' AND inbound_actor_id IS NOT NULL) OR
    (inbound_actor_mode <> 'specified_actor' AND inbound_actor_id IS NULL)
  ),
  UNIQUE(conversation_id),
  UNIQUE(transport_endpoint_id)
);

CREATE INDEX idx_conversation_transport_bindings_workspace
  ON conversation_transport_bindings(workspace_id, created_at DESC);

CREATE TABLE transport_addresses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  transport_kind transport_addresses_transport_kind NOT NULL,
  address_type transport_addresses_address_type NOT NULL DEFAULT 'user',
  external_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(transport_account_id, address_type, external_id)
);

CREATE INDEX idx_transport_addresses_workspace
  ON transport_addresses(workspace_id, transport_kind, created_at DESC);
CREATE INDEX idx_transport_addresses_workspace_member
  ON transport_addresses(workspace_member_id, transport_kind, created_at DESC)
  WHERE workspace_member_id IS NOT NULL;

CREATE TABLE conversation_participant_addresses (
  conversation_member_id UUID NOT NULL REFERENCES conversation_members(id) ON DELETE CASCADE,
  transport_address_id UUID NOT NULL REFERENCES transport_addresses(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_member_id, transport_address_id)
);

CREATE UNIQUE INDEX idx_conversation_participant_addresses_primary
  ON conversation_participant_addresses(conversation_member_id)
  WHERE is_primary = TRUE;
CREATE INDEX idx_conversation_participant_addresses_address
  ON conversation_participant_addresses(transport_address_id, created_at DESC);

CREATE TABLE conversation_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  permission conversation_grants_permission NOT NULL,
  subject_type conversation_grants_subject_type NOT NULL,
  workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  status conversation_grants_status NOT NULL DEFAULT 'active',
  granted_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_conversation_grants_target CHECK (
    (subject_type = 'workspace_member' AND workspace_member_id IS NOT NULL AND actor_id IS NULL) OR
    (subject_type = 'actor' AND actor_id IS NOT NULL AND workspace_member_id IS NULL)
  )
);

CREATE INDEX idx_conversation_grants_conversation ON conversation_grants(conversation_id, created_at DESC);
CREATE INDEX idx_conversation_grants_workspace ON conversation_grants(workspace_id, created_at DESC);
CREATE INDEX idx_conversation_grants_workspace_member ON conversation_grants(workspace_member_id, created_at DESC) WHERE workspace_member_id IS NOT NULL;
CREATE INDEX idx_conversation_grants_actor ON conversation_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

CREATE TABLE conversation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  client_message_id UUID,
  scope conversation_items_scope NOT NULL,
  surface conversation_items_surface NOT NULL,
  item_type conversation_items_item_type NOT NULL,
  subtype VARCHAR(50) NOT NULL,
  role conversation_items_role NOT NULL,
  author_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  bundle_id UUID,
  reply_to_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  caused_by_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  event_payload JSONB DEFAULT '{}',
  event_timeline_policy conversation_items_event_timeline_policy,
  event_context_policy conversation_items_event_context_policy,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_conversation_items_sequence_unique
  ON conversation_items(conversation_id, sequence);
CREATE INDEX idx_conversation_items_conversation_created
  ON conversation_items(conversation_id, created_at);
CREATE INDEX idx_conversation_items_session_created
  ON conversation_items(session_id, created_at) WHERE session_id IS NOT NULL;
CREATE INDEX idx_conversation_items_turn
  ON conversation_items(turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_conversation_items_bundle
  ON conversation_items(bundle_id) WHERE bundle_id IS NOT NULL;

CREATE TABLE conversation_item_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type conversation_item_parts_part_type NOT NULL,
  text_value TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  json_value JSONB,
  mime_type VARCHAR(255),
  name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  UNIQUE(item_id, ordinal),
  CHECK (
    (part_type = 'text' AND text_value IS NOT NULL) OR
    (part_type = 'file_ref' AND file_id IS NOT NULL) OR
    (part_type = 'json' AND json_value IS NOT NULL)
  )
);

CREATE INDEX idx_conversation_item_parts_item ON conversation_item_parts(item_id, ordinal);

CREATE TABLE conversation_item_targets (
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  target_member_id UUID NOT NULL REFERENCES conversation_members(id) ON DELETE CASCADE,
  target_kind conversation_item_targets_target_kind NOT NULL DEFAULT 'to',
  PRIMARY KEY (item_id, target_member_id, target_kind)
);

CREATE INDEX idx_conversation_item_targets_member ON conversation_item_targets(target_member_id, item_id);

CREATE TABLE conversation_item_context_targets (
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  target_member_id UUID NOT NULL REFERENCES conversation_members(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, target_member_id)
);

CREATE INDEX idx_conversation_item_context_targets_member
  ON conversation_item_context_targets(target_member_id, item_id);

CREATE TABLE conversation_user_states (
  workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  read_watermark_sequence BIGINT NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_member_id, conversation_id)
);

CREATE INDEX idx_conversation_user_states_conversation
  ON conversation_user_states(conversation_id, updated_at DESC);

CREATE TABLE transport_message_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  transport_endpoint_id UUID NOT NULL REFERENCES transport_endpoints(id) ON DELETE CASCADE,
  transport_kind transport_message_links_transport_kind NOT NULL,
  direction transport_message_links_direction NOT NULL,
  delivery_status transport_message_links_delivery_status NOT NULL DEFAULT 'pending',
  external_message_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}',
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(item_id, transport_endpoint_id, direction)
);

CREATE INDEX idx_transport_message_links_conversation
  ON transport_message_links(conversation_id, created_at DESC);
CREATE INDEX idx_transport_message_links_endpoint
  ON transport_message_links(transport_endpoint_id, created_at DESC);
CREATE INDEX idx_transport_message_links_status
  ON transport_message_links(delivery_status, created_at DESC);

-- ============ Turns ============
CREATE TABLE turns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  trigger_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  trigger_type VARCHAR(50) NOT NULL,
  status turns_status NOT NULL DEFAULT 'running',
  metadata JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_turns_session_started ON turns(session_id, started_at DESC);
CREATE INDEX idx_turns_conversation_started ON turns(conversation_id, started_at DESC);

ALTER TABLE conversation_items ADD CONSTRAINT fk_conversation_items_turn
  FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE SET NULL;

-- ============ Payload Blobs ============
CREATE TABLE payload_blobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sha256 VARCHAR(64) UNIQUE NOT NULL,
  content_type payload_blobs_content_type NOT NULL,
  json_body JSONB,
  text_body TEXT,
  byte_size INT NOT NULL DEFAULT 0,
  retention_class payload_blobs_retention_class NOT NULL DEFAULT 'audit',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (content_type = 'json' AND json_body IS NOT NULL) OR
    (content_type = 'text' AND text_body IS NOT NULL)
  )
);

-- ============ Provider Steps ============
CREATE TABLE provider_steps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  turn_id UUID NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  step_index INT NOT NULL,
  provider_type VARCHAR(64) NOT NULL CHECK (provider_type ~ '^[a-z][a-z0-9_-]*$'),
  request_type provider_steps_request_type NOT NULL,
  model_group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL,
  model_profile_id UUID REFERENCES model_profiles(id) ON DELETE SET NULL,
  model_profile_revision_id UUID REFERENCES model_profile_revisions(id) ON DELETE SET NULL,
  model_name VARCHAR(255) NOT NULL,
  capabilities_snapshot JSONB DEFAULT '{}',
  request_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  response_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  stop_reason VARCHAR(50),
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cost_micros BIGINT DEFAULT 0,
  latency_ms INT DEFAULT 0,
  status provider_steps_status NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(turn_id, step_index)
);

CREATE INDEX idx_provider_steps_turn ON provider_steps(turn_id, step_index);
CREATE INDEX idx_provider_steps_profile ON provider_steps(model_profile_id);
CREATE INDEX idx_provider_steps_revision ON provider_steps(model_profile_revision_id);

-- ============ Tool Calls ============
CREATE TABLE tool_calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  turn_id UUID NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  provider_step_id UUID REFERENCES provider_steps(id) ON DELETE SET NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  call_index INT NOT NULL DEFAULT 0,
  provider_call_id VARCHAR(255),
  bundle_id UUID NOT NULL,
  tool_kind tool_calls_tool_kind NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  plugin_id UUID,
  relay_id UUID,
  normalized_input JSONB NOT NULL DEFAULT '{}',
  status tool_calls_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id, created_at);
CREATE INDEX idx_tool_calls_bundle ON tool_calls(bundle_id);
CREATE INDEX idx_tool_calls_provider_step ON tool_calls(provider_step_id);

CREATE TABLE tool_call_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  turn_id UUID REFERENCES turns(id) ON DELETE SET NULL,
  source_tool_call_id UUID REFERENCES tool_calls(id) ON DELETE SET NULL,
  source_tool_name VARCHAR(255) NOT NULL,
  executor_kind tool_call_tasks_executor_kind NOT NULL,
  delivery_policy tool_call_tasks_delivery_policy NOT NULL,
  status tool_call_tasks_status NOT NULL DEFAULT 'working',
  status_message TEXT,
  dispatch_status tool_call_tasks_dispatch_status NOT NULL DEFAULT 'accepted',
  supports_cancel BOOLEAN NOT NULL DEFAULT FALSE,
  supports_output_tail BOOLEAN NOT NULL DEFAULT FALSE,
  request_payload JSONB NOT NULL DEFAULT '{}',
  immediate_result_payload JSONB NOT NULL DEFAULT '{}',
  final_result_payload JSONB NOT NULL DEFAULT '{}',
  final_error_payload JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  completion_item_id UUID UNIQUE REFERENCES conversation_items(id) ON DELETE SET NULL,
  deadline_at TIMESTAMPTZ,
  retention_ttl_ms INT,
  retain_until TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  cancel_reason TEXT,
  last_output_seq BIGINT NOT NULL DEFAULT 0,
  last_output_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tool_call_tasks_session_status
  ON tool_call_tasks(session_id, status, created_at DESC);
CREATE INDEX idx_tool_call_tasks_source_tool_call
  ON tool_call_tasks(source_tool_call_id)
  WHERE source_tool_call_id IS NOT NULL;
CREATE INDEX idx_tool_call_tasks_conversation_status
  ON tool_call_tasks(conversation_id, status, created_at DESC);

CREATE TABLE tool_call_task_output_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tool_call_tasks(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  stream tool_call_task_output_chunks_stream NOT NULL,
  text_value TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, seq)
);

CREATE INDEX idx_tool_call_task_output_chunks_task
  ON tool_call_task_output_chunks(task_id, seq DESC);

-- ============ Tool Execution Attempts ============
CREATE TABLE tool_execution_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_call_id UUID NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  attempt_no INT NOT NULL,
  executor_kind tool_execution_attempts_executor_kind NOT NULL,
  plugin_id UUID,
  relay_id UUID,
  transport VARCHAR(30),
  instance_key VARCHAR(512),
  request_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  response_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  status tool_execution_attempts_status NOT NULL DEFAULT 'success',
  is_error BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tool_call_id, attempt_no)
);

CREATE INDEX idx_tool_execution_attempts_tool_call ON tool_execution_attempts(tool_call_id, attempt_no);

-- ============ Tool Results ============
CREATE TABLE tool_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_call_id UUID NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES tool_execution_attempts(id) ON DELETE SET NULL,
  result_index INT NOT NULL DEFAULT 0,
  is_error BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tool_call_id, result_index)
);

CREATE INDEX idx_tool_results_tool_call ON tool_results(tool_call_id, result_index);

-- ============ Tool Result Parts ============
CREATE TABLE tool_result_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_result_id UUID NOT NULL REFERENCES tool_results(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type tool_result_parts_part_type NOT NULL,
  text_value TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  json_value JSONB,
  mime_type VARCHAR(255),
  name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  UNIQUE(tool_result_id, ordinal),
  CHECK (
    (part_type = 'text' AND text_value IS NOT NULL) OR
    (part_type = 'file_ref' AND file_id IS NOT NULL) OR
    (part_type = 'json' AND json_value IS NOT NULL)
  )
);

CREATE INDEX idx_tool_result_parts_result ON tool_result_parts(tool_result_id, ordinal);

CREATE TABLE session_wakeups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id UUID,
  source_type session_wakeups_source_type NOT NULL,
  source_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  source_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  source_member_type session_wakeups_source_member_type,
  source_member_id UUID,
  source_name VARCHAR(255),
  summary TEXT NOT NULL,
  reason_text TEXT,
  status session_wakeups_status NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  attached_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_session_wakeups_session_created
  ON session_wakeups(session_id, created_at DESC);
CREATE INDEX idx_session_wakeups_session_status
  ON session_wakeups(session_id, status, created_at DESC);
CREATE INDEX idx_session_wakeups_turn
  ON session_wakeups(turn_id, created_at DESC) WHERE turn_id IS NOT NULL;

-- ============ Automation Runtime ============
CREATE TABLE automation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category automation_rules_category NOT NULL,
  status automation_rules_status NOT NULL DEFAULT 'active',
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_kind automation_rules_created_by_kind NOT NULL,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_by_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  created_by_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  owner_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  owner_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  last_triggered_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_automation_rules_workspace
  ON automation_rules(workspace_id, created_at DESC);
CREATE INDEX idx_automation_rules_workspace_status
  ON automation_rules(workspace_id, status, created_at DESC);
CREATE INDEX idx_automation_rules_owner_session
  ON automation_rules(owner_session_id, created_at DESC) WHERE owner_session_id IS NOT NULL;
CREATE INDEX idx_automation_rules_owner_conversation
  ON automation_rules(owner_conversation_id, created_at DESC) WHERE owner_conversation_id IS NOT NULL;

CREATE TABLE automation_policies (
  rule_id UUID PRIMARY KEY REFERENCES automation_rules(id) ON DELETE CASCADE,
  active_from TIMESTAMPTZ,
  active_until TIMESTAMPTZ,
  max_trigger_count INT CHECK (max_trigger_count IS NULL OR max_trigger_count > 0),
  trigger_count INT NOT NULL DEFAULT 0 CHECK (trigger_count >= 0),
  completion_status automation_policies_completion_status NOT NULL DEFAULT 'completed',
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    active_from IS NULL OR active_until IS NULL OR active_until >= active_from
  )
);

CREATE INDEX idx_automation_policies_active_until
  ON automation_policies(active_until)
  WHERE active_until IS NOT NULL;

CREATE TABLE automation_event_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_kind automation_event_sources_provider_kind NOT NULL,
  provider_ref TEXT,
  webhook_endpoint_id UUID,
  integration_binding_id UUID,
  source_key VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  recommended_usage TEXT NOT NULL DEFAULT '',
  payload_schema JSONB NOT NULL DEFAULT '{}',
  example_payload JSONB NOT NULL DEFAULT '{}',
  status automation_event_sources_status NOT NULL DEFAULT 'active',
  created_by_kind automation_event_sources_created_by_kind NOT NULL,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_by_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  created_by_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  last_triggered_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (
      provider_kind = 'integration' AND
      integration_binding_id IS NOT NULL AND
      webhook_endpoint_id IS NULL
    ) OR (
      provider_kind <> 'integration' AND
      integration_binding_id IS NULL
    )
  ),
  CHECK (
    (
      provider_kind = 'webhook' AND
      webhook_endpoint_id IS NOT NULL
    ) OR (
      provider_kind IN ('relay', 'internal', 'integration') AND
      webhook_endpoint_id IS NULL
    )
  )
);

CREATE UNIQUE INDEX uq_automation_event_sources_provider_key_non_integration
  ON automation_event_sources(
    workspace_id,
    provider_kind,
    COALESCE(provider_ref, ''),
    COALESCE(webhook_endpoint_id::text, ''),
    source_key
  )
  WHERE provider_kind <> 'integration';
CREATE UNIQUE INDEX uq_automation_event_sources_integration_target_key
  ON automation_event_sources(
    workspace_id,
    integration_binding_id,
    source_key
  )
  WHERE provider_kind = 'integration';
CREATE INDEX idx_automation_event_sources_workspace
  ON automation_event_sources(workspace_id, created_at DESC);
CREATE INDEX idx_automation_event_sources_workspace_status
  ON automation_event_sources(workspace_id, status, created_at DESC);
CREATE INDEX idx_automation_event_sources_provider
  ON automation_event_sources(workspace_id, provider_kind, source_key, created_at DESC);
CREATE INDEX idx_automation_event_sources_endpoint
  ON automation_event_sources(webhook_endpoint_id)
  WHERE webhook_endpoint_id IS NOT NULL;
CREATE INDEX idx_automation_event_sources_integration_binding
  ON automation_event_sources(integration_binding_id, created_at DESC)
  WHERE integration_binding_id IS NOT NULL;

CREATE TABLE automation_triggers (
  rule_id UUID PRIMARY KEY REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_kind automation_triggers_trigger_kind NOT NULL,
  source_kind automation_triggers_source_kind NOT NULL,
  event_source_id UUID REFERENCES automation_event_sources(id) ON DELETE RESTRICT,
  source_locator TEXT,
  match_key VARCHAR(255),
  matcher JSONB NOT NULL DEFAULT '{}',
  schedule_kind automation_triggers_schedule_kind,
  schedule_expr VARCHAR(255),
  schedule_timezone VARCHAR(64),
  interval_seconds INT,
  starts_at TIMESTAMPTZ,
  next_fire_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (trigger_kind = 'schedule' AND source_kind = 'clock' AND event_source_id IS NULL) OR
    (trigger_kind = 'event' AND source_kind IN ('relay', 'webhook', 'internal', 'integration') AND event_source_id IS NOT NULL)
  ),
  CHECK (
    (trigger_kind = 'schedule' AND schedule_kind IS NOT NULL) OR
    (trigger_kind = 'event' AND schedule_kind IS NULL)
  )
);

CREATE INDEX idx_automation_triggers_due
  ON automation_triggers(next_fire_at)
  WHERE trigger_kind = 'schedule';
CREATE INDEX idx_automation_triggers_event_source
  ON automation_triggers(event_source_id)
  WHERE event_source_id IS NOT NULL;
CREATE INDEX idx_automation_triggers_event_match
  ON automation_triggers(source_kind, match_key, source_locator)
  WHERE trigger_kind = 'event';

CREATE TABLE automation_deliveries (
  rule_id UUID PRIMARY KEY REFERENCES automation_rules(id) ON DELETE CASCADE,
  delivery_mode automation_deliveries_delivery_mode NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  reused_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  conversation_title VARCHAR(500),
  message_text TEXT NOT NULL DEFAULT '',
  wake_reason_text TEXT,
  message_blocks JSONB NOT NULL DEFAULT '[]',
  target_policy automation_deliveries_target_policy NOT NULL DEFAULT 'all_members',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE automation_delivery_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_kind automation_delivery_participants_entity_kind NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rule_id, entity_kind, entity_id)
);

CREATE INDEX idx_automation_delivery_participants_rule
  ON automation_delivery_participants(rule_id, created_at);

CREATE TABLE automation_delivery_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_kind automation_delivery_recipients_entity_kind NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rule_id, entity_kind, entity_id)
);

CREATE INDEX idx_automation_delivery_recipients_rule
  ON automation_delivery_recipients(rule_id, created_at);

CREATE TABLE automation_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  status automation_webhook_endpoints_status NOT NULL DEFAULT 'active',
  path_token VARCHAR(64) UNIQUE NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_hint VARCHAR(16) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  last_received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_automation_webhook_endpoints_workspace
  ON automation_webhook_endpoints(workspace_id, created_at DESC);

ALTER TABLE automation_event_sources
  ADD CONSTRAINT fk_automation_event_sources_webhook_endpoint
  FOREIGN KEY (webhook_endpoint_id)
  REFERENCES automation_webhook_endpoints(id)
  ON DELETE RESTRICT;

CREATE TABLE automation_occurrences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind automation_occurrences_source_kind NOT NULL,
  event_source_id UUID REFERENCES automation_event_sources(id) ON DELETE SET NULL,
  source_locator TEXT,
  match_key VARCHAR(255),
  dedupe_key VARCHAR(255),
  source_snapshot JSONB NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX uq_automation_occurrences_event_source_dedupe
  ON automation_occurrences(workspace_id, event_source_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND event_source_id IS NOT NULL;
CREATE UNIQUE INDEX uq_automation_occurrences_source_kind_dedupe
  ON automation_occurrences(workspace_id, source_kind, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND event_source_id IS NULL;
CREATE INDEX idx_automation_occurrences_workspace_created
  ON automation_occurrences(workspace_id, created_at DESC);
CREATE INDEX idx_automation_occurrences_event_source
  ON automation_occurrences(event_source_id, created_at DESC)
  WHERE event_source_id IS NOT NULL;
CREATE INDEX idx_automation_occurrences_event_match
  ON automation_occurrences(workspace_id, source_kind, match_key, source_locator, created_at DESC);

CREATE TABLE automation_executions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  occurrence_id UUID NOT NULL REFERENCES automation_occurrences(id) ON DELETE CASCADE,
  status automation_executions_status NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rule_id, occurrence_id)
);

CREATE INDEX idx_automation_executions_rule_created
  ON automation_executions(rule_id, created_at DESC);
CREATE INDEX idx_automation_executions_status_created
  ON automation_executions(status, created_at);
CREATE INDEX idx_automation_executions_occurrence
  ON automation_executions(occurrence_id, created_at DESC);

CREATE TABLE automation_execution_targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  execution_id UUID NOT NULL REFERENCES automation_executions(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  target_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  target_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  wakeup_id UUID REFERENCES session_wakeups(id) ON DELETE SET NULL,
  status automation_execution_targets_status NOT NULL DEFAULT 'pending',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_automation_execution_targets_execution
  ON automation_execution_targets(execution_id, created_at);
CREATE INDEX idx_automation_execution_targets_session
  ON automation_execution_targets(session_id, created_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX idx_automation_execution_targets_conversation
  ON automation_execution_targets(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;

ALTER TABLE session_wakeups
  ADD COLUMN automation_execution_id UUID REFERENCES automation_executions(id) ON DELETE SET NULL,
  ADD COLUMN automation_occurrence_id UUID REFERENCES automation_occurrences(id) ON DELETE SET NULL;

CREATE INDEX idx_session_wakeups_automation_execution
  ON session_wakeups(automation_execution_id, created_at DESC)
  WHERE automation_execution_id IS NOT NULL;
CREATE INDEX idx_session_wakeups_automation_occurrence
  ON session_wakeups(automation_occurrence_id, created_at DESC)
  WHERE automation_occurrence_id IS NOT NULL;

-- ============ Memory Runtime ============
CREATE TABLE memory_spaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_type memory_spaces_space_type NOT NULL,
  anchor_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  anchor_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  anchor_conversation_actor_context_id UUID REFERENCES conversation_actor_contexts(id) ON DELETE CASCADE,
  anchor_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (space_type = 'workspace_shared'
      AND anchor_conversation_id IS NULL
      AND anchor_actor_id IS NULL
      AND anchor_conversation_actor_context_id IS NULL
      AND anchor_workspace_member_id IS NULL) OR
    (space_type = 'conversation_shared'
      AND anchor_conversation_id IS NOT NULL
      AND anchor_actor_id IS NULL
      AND anchor_conversation_actor_context_id IS NULL
      AND anchor_workspace_member_id IS NULL) OR
    (space_type = 'actor_private'
      AND anchor_conversation_id IS NULL
      AND anchor_actor_id IS NOT NULL
      AND anchor_conversation_actor_context_id IS NULL
      AND anchor_workspace_member_id IS NULL) OR
    (space_type = 'participant_private'
      AND anchor_conversation_id IS NULL
      AND anchor_actor_id IS NULL
      AND anchor_conversation_actor_context_id IS NOT NULL
      AND anchor_workspace_member_id IS NULL) OR
    (space_type = 'user_private'
      AND anchor_conversation_id IS NULL
      AND anchor_actor_id IS NULL
      AND anchor_conversation_actor_context_id IS NULL
      AND anchor_workspace_member_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_memory_spaces_workspace_shared
  ON memory_spaces(workspace_id, space_type)
  WHERE space_type = 'workspace_shared';
CREATE UNIQUE INDEX idx_memory_spaces_conversation
  ON memory_spaces(workspace_id, space_type, anchor_conversation_id)
  WHERE anchor_conversation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_memory_spaces_actor
  ON memory_spaces(workspace_id, space_type, anchor_actor_id)
  WHERE anchor_actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_memory_spaces_participant
  ON memory_spaces(workspace_id, space_type, anchor_conversation_actor_context_id)
  WHERE anchor_conversation_actor_context_id IS NOT NULL;
CREATE UNIQUE INDEX idx_memory_spaces_workspace_member
  ON memory_spaces(workspace_id, space_type, anchor_workspace_member_id)
  WHERE anchor_workspace_member_id IS NOT NULL;

CREATE TABLE memory_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  memory_space_id UUID NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
  category memory_items_category NOT NULL,
  state memory_items_state NOT NULL DEFAULT 'active',
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  tags TEXT[] DEFAULT '{}',
  text_digest TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  index_status memory_items_index_status NOT NULL DEFAULT 'lexical_ready',
  active_index_version INT NOT NULL DEFAULT 0,
  staged_index_version INT,
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_dim INT,
  indexed_at TIMESTAMPTZ,
  index_error TEXT,
  source_kind TEXT NOT NULL DEFAULT 'manual',
  source_item_id UUID,
  source_tool_call_id UUID,
  source_turn_id UUID,
  supersedes_item_id UUID REFERENCES memory_items(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_items_workspace ON memory_items(workspace_id, created_at DESC);
CREATE INDEX idx_memory_items_space ON memory_items(memory_space_id, updated_at DESC);
CREATE INDEX idx_memory_items_state ON memory_items(workspace_id, state, updated_at DESC);
CREATE INDEX idx_memory_items_tags ON memory_items USING GIN(tags);

CREATE TABLE memory_item_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type memory_item_parts_part_type NOT NULL,
  text_value TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  json_value JSONB,
  mime_type VARCHAR(255),
  name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  UNIQUE(memory_item_id, ordinal),
  CHECK (
    (part_type = 'text' AND text_value IS NOT NULL) OR
    (part_type = 'file_ref' AND file_id IS NOT NULL) OR
    (part_type = 'json' AND json_value IS NOT NULL)
  )
);

CREATE INDEX idx_memory_item_parts_item ON memory_item_parts(memory_item_id, ordinal);

CREATE TABLE memory_item_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  index_version INT NOT NULL,
  chunk_index INT NOT NULL,
  chunk_kind TEXT NOT NULL DEFAULT 'body',
  search_text TEXT NOT NULL,
  embedding VECTOR(384),
  token_count INT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_item_id, index_version, chunk_index)
);

CREATE INDEX idx_memory_item_chunks_item ON memory_item_chunks(memory_item_id, index_version, chunk_index);
CREATE INDEX idx_memory_item_chunks_workspace ON memory_item_chunks(workspace_id, created_at DESC);
CREATE INDEX idx_memory_item_chunks_fts ON memory_item_chunks USING GIN(to_tsvector('simple', search_text));
CREATE INDEX idx_memory_item_chunks_trgm ON memory_item_chunks USING GIN(search_text gin_trgm_ops);
CREATE INDEX idx_memory_item_chunks_hnsw ON memory_item_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE memory_embedding_cache (
  model_id TEXT NOT NULL,
  input_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding VECTOR(384) NOT NULL,
  embedding_dim INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (model_id, input_type, content_hash),
  CHECK (input_type = 'passage')
);

CREATE INDEX idx_memory_embedding_cache_updated_at
  ON memory_embedding_cache(updated_at DESC);

CREATE TABLE memory_recall_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  recall_type memory_recall_runs_recall_type NOT NULL,
  query_text TEXT NOT NULL DEFAULT '',
  query_blocks JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_recall_runs_workspace ON memory_recall_runs(workspace_id, created_at DESC);
CREATE INDEX idx_memory_recall_runs_actor ON memory_recall_runs(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_memory_recall_runs_conversation ON memory_recall_runs(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_memory_recall_runs_workspace_member ON memory_recall_runs(workspace_member_id, created_at DESC) WHERE workspace_member_id IS NOT NULL;

CREATE TABLE memory_recall_run_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES memory_recall_runs(id) ON DELETE CASCADE,
  memory_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  matched_chunk_id UUID REFERENCES memory_item_chunks(id) ON DELETE SET NULL,
  rank INT NOT NULL,
  final_score REAL NOT NULL DEFAULT 0,
  vector_score REAL,
  text_score REAL,
  similarity_score REAL,
  matched_terms TEXT[] DEFAULT '{}',
  recall_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_recall_run_results_run ON memory_recall_run_results(run_id, rank);
CREATE INDEX idx_memory_recall_run_results_memory ON memory_recall_run_results(memory_item_id, created_at DESC);

-- ============ Context Runtime ============
CREATE TABLE context_archive_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  chain_scope context_archive_points_chain_scope NOT NULL,
  parent_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  covers_until_sequence BIGINT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (chain_scope = 'shared' AND session_id IS NULL) OR
    (chain_scope = 'private' AND session_id IS NOT NULL)
  )
);

CREATE INDEX idx_context_archive_points_conversation
  ON context_archive_points(conversation_id, chain_scope, covers_until_sequence DESC);
CREATE INDEX idx_context_archive_points_session
  ON context_archive_points(session_id, covers_until_sequence DESC) WHERE session_id IS NOT NULL;

CREATE TABLE context_archive_frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  archive_point_id UUID NOT NULL REFERENCES context_archive_points(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  role context_archive_frames_role NOT NULL,
  frame_type VARCHAR(50) NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  source_item_ids UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  UNIQUE(archive_point_id, ordinal)
);

CREATE INDEX idx_context_archive_frames_point
  ON context_archive_frames(archive_point_id, ordinal);

CREATE TABLE context_archive_frame_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  archive_frame_id UUID NOT NULL REFERENCES context_archive_frames(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type context_archive_frame_parts_part_type NOT NULL,
  text_value TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  json_value JSONB,
  mime_type VARCHAR(255),
  name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  UNIQUE(archive_frame_id, ordinal),
  CHECK (
    (part_type = 'text' AND text_value IS NOT NULL) OR
    (part_type = 'file_ref' AND file_id IS NOT NULL) OR
    (part_type = 'json' AND json_value IS NOT NULL)
  )
);

CREATE INDEX idx_context_archive_frame_parts_frame
  ON context_archive_frame_parts(archive_frame_id, ordinal);

CREATE TABLE context_compaction_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  chain_scope context_compaction_runs_chain_scope NOT NULL,
  strategy_key VARCHAR(255) NOT NULL,
  base_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  output_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  status context_compaction_runs_status NOT NULL DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (
    (chain_scope = 'shared' AND session_id IS NULL) OR
    (chain_scope = 'private' AND session_id IS NOT NULL)
  )
);

CREATE INDEX idx_context_compaction_runs_conversation
  ON context_compaction_runs(conversation_id, chain_scope, started_at DESC);
CREATE INDEX idx_context_compaction_runs_session
  ON context_compaction_runs(session_id, started_at DESC) WHERE session_id IS NOT NULL;

CREATE TABLE context_compaction_run_inputs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES context_compaction_runs(id) ON DELETE CASCADE,
  input_kind context_compaction_run_inputs_input_kind NOT NULL,
  archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  from_sequence BIGINT,
  to_sequence BIGINT,
  item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  CHECK (
    (input_kind = 'archive_point' AND archive_point_id IS NOT NULL AND from_sequence IS NULL AND to_sequence IS NULL AND item_id IS NULL) OR
    (input_kind = 'sequence_range' AND archive_point_id IS NULL AND from_sequence IS NOT NULL AND to_sequence IS NOT NULL AND item_id IS NULL) OR
    (input_kind = 'item' AND archive_point_id IS NULL AND from_sequence IS NULL AND to_sequence IS NULL AND item_id IS NOT NULL)
  )
);

CREATE INDEX idx_context_compaction_run_inputs_run
  ON context_compaction_run_inputs(run_id);

CREATE TABLE conversation_context_states (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  active_shared_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE session_context_states (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  active_private_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE session_engine_branches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  provider_type VARCHAR(64) NOT NULL CHECK (provider_type ~ '^[a-z][a-z0-9_-]*$'),
  engine_kind VARCHAR(120) NOT NULL
    CHECK (engine_kind ~ '^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$'),
  binding_key VARCHAR(255) NOT NULL,
  last_shared_sequence BIGINT NOT NULL DEFAULT 0,
  last_private_sequence BIGINT NOT NULL DEFAULT 0,
  applied_item_keys TEXT[] DEFAULT '{}',
  native_state JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  status session_engine_branches_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, binding_key)
);

CREATE INDEX idx_session_engine_branches_session
  ON session_engine_branches(session_id, updated_at DESC);
CREATE INDEX idx_session_engine_branches_engine
  ON session_engine_branches(session_id, engine_kind, updated_at DESC);

CREATE TABLE engine_branch_checkpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id UUID NOT NULL REFERENCES session_engine_branches(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  provider_type VARCHAR(64) NOT NULL CHECK (provider_type ~ '^[a-z][a-z0-9_-]*$'),
  engine_kind VARCHAR(120) NOT NULL
    CHECK (engine_kind ~ '^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$'),
  binding_key VARCHAR(255) NOT NULL,
  checkpoint_kind engine_branch_checkpoints_checkpoint_kind NOT NULL DEFAULT 'snapshot',
  shared_sequence BIGINT NOT NULL DEFAULT 0,
  private_sequence BIGINT NOT NULL DEFAULT 0,
  applied_item_keys TEXT[] DEFAULT '{}',
  native_state JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_engine_branch_checkpoints_branch
  ON engine_branch_checkpoints(branch_id, created_at DESC);
CREATE INDEX idx_engine_branch_checkpoints_session
  ON engine_branch_checkpoints(session_id, created_at DESC);

CREATE TABLE session_interrupts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type session_interrupts_type NOT NULL,
  content TEXT NOT NULL,
  from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  is_consumed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_interrupts_target
  ON session_interrupts(target_session_id) WHERE is_consumed = FALSE;

-- ============ Runtime Events ============
CREATE TABLE runtime_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID REFERENCES turns(id) ON DELETE SET NULL,
  provider_step_id UUID REFERENCES provider_steps(id) ON DELETE SET NULL,
  tool_call_id UUID REFERENCES tool_calls(id) ON DELETE SET NULL,
  tool_attempt_id UUID REFERENCES tool_execution_attempts(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source runtime_events_source NOT NULL,
  level runtime_events_level NOT NULL DEFAULT 'info',
  event_type VARCHAR(50) NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_runtime_events_workspace_time ON runtime_events(workspace_id, created_at DESC);
CREATE INDEX idx_runtime_events_turn_time ON runtime_events(turn_id, created_at DESC) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_runtime_events_tool_call_time ON runtime_events(tool_call_id, created_at DESC) WHERE tool_call_id IS NOT NULL;

-- ============ Skill Runtime ============
CREATE TABLE installed_skills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug VARCHAR(120) NOT NULL,
  name VARCHAR(255) NOT NULL,
  icon_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  tags TEXT[] DEFAULT '{}',
  current_version INT NOT NULL DEFAULT 1,
  current_snapshot_id UUID NOT NULL REFERENCES skill_snapshots(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  conversation_type_mask_override INT
    CHECK (conversation_type_mask_override IS NULL OR (conversation_type_mask_override > 0 AND conversation_type_mask_override <= 31)),
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, slug)
);

CREATE INDEX idx_installed_skills_workspace ON installed_skills(workspace_id, created_at DESC);

CREATE TABLE skill_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  skill_id UUID NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
  version INT NOT NULL,
  skill_snapshot_id UUID NOT NULL REFERENCES skill_snapshots(id) ON DELETE RESTRICT,
  metadata JSONB DEFAULT '{}',
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_id, version)
);

CREATE TABLE skill_source_refs (
  skill_id UUID PRIMARY KEY REFERENCES installed_skills(id) ON DELETE CASCADE,
  source_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  source_catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  sync_mode skill_source_refs_sync_mode NOT NULL DEFAULT 'manual_merge',
  is_customized BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Plugin Runtime ============
CREATE TABLE plugin_installations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE RESTRICT,
  catalog_version_id UUID NOT NULL REFERENCES catalog_versions(id) ON DELETE RESTRICT,
  display_name VARCHAR(255) NOT NULL,
  attachment_target_type plugin_installations_attachment_target_type NOT NULL,
  attachment_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  attachment_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  attachment_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  config_data JSONB NOT NULL DEFAULT '{}',
  approved_runtime_permissions TEXT[] DEFAULT '{}',
  reuse_scope plugin_installations_reuse_scope NOT NULL DEFAULT 'conversation',
  conversation_type_mask_override INT
    CHECK (conversation_type_mask_override IS NULL OR (conversation_type_mask_override > 0 AND conversation_type_mask_override <= 31)),
  status plugin_installations_status NOT NULL DEFAULT 'active',
  installed_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (attachment_target_type = 'workspace' AND attachment_actor_id IS NULL AND attachment_conversation_id IS NULL AND attachment_workspace_member_id IS NULL) OR
    (attachment_target_type = 'conversation' AND attachment_conversation_id IS NOT NULL AND attachment_actor_id IS NULL AND attachment_workspace_member_id IS NULL) OR
    (attachment_target_type = 'actor' AND attachment_actor_id IS NOT NULL AND attachment_conversation_id IS NULL AND attachment_workspace_member_id IS NULL) OR
    (attachment_target_type = 'workspace_member' AND attachment_workspace_member_id IS NOT NULL AND attachment_actor_id IS NULL AND attachment_conversation_id IS NULL)
  )
);

CREATE INDEX idx_plugin_installations_workspace ON plugin_installations(workspace_id, created_at DESC);
CREATE INDEX idx_plugin_installations_item ON plugin_installations(catalog_item_id, created_at DESC);

CREATE TABLE automation_integration_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  provider automation_integration_bindings_provider NOT NULL,
  ingress_kind automation_integration_bindings_ingress_kind NOT NULL,
  target_kind automation_integration_bindings_target_kind NOT NULL,
  target_id TEXT NOT NULL,
  target_label VARCHAR(255) NOT NULL,
  webhook_endpoint_id UUID REFERENCES automation_webhook_endpoints(id) ON DELETE RESTRICT,
  external_subscription_id VARCHAR(255),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (
      ingress_kind = 'webhook' AND
      webhook_endpoint_id IS NOT NULL
    ) OR (
      ingress_kind = 'polling' AND
      webhook_endpoint_id IS NULL
    )
  ),
  UNIQUE(workspace_id, installation_id, provider, ingress_kind, target_kind, target_id)
);

CREATE UNIQUE INDEX uq_automation_integration_bindings_webhook_endpoint
  ON automation_integration_bindings(webhook_endpoint_id)
  WHERE webhook_endpoint_id IS NOT NULL;
CREATE INDEX idx_automation_integration_bindings_workspace
  ON automation_integration_bindings(workspace_id, created_at DESC);
CREATE INDEX idx_automation_integration_bindings_installation
  ON automation_integration_bindings(installation_id, created_at DESC);

ALTER TABLE automation_event_sources
  ADD CONSTRAINT fk_automation_event_sources_integration_binding
  FOREIGN KEY (integration_binding_id)
  REFERENCES automation_integration_bindings(id)
  ON DELETE CASCADE;

CREATE TABLE plugin_auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  installation_id UUID REFERENCES plugin_installations(id) ON DELETE CASCADE,
  binding_key VARCHAR(100) NOT NULL,
  driver VARCHAR(100) NOT NULL,
  workspace_member_id UUID NOT NULL REFERENCES workspace_members(id) ON DELETE CASCADE,
  status plugin_auth_sessions_status NOT NULL DEFAULT 'pending',
  phase VARCHAR(64),
  state VARCHAR(255) UNIQUE,
  challenge_payload JSONB DEFAULT '{}',
  transient_payload JSONB DEFAULT '{}',
  error_code VARCHAR(120),
  error_message TEXT,
  result_preview JSONB DEFAULT '{}',
  result_payload JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_auth_sessions_workspace ON plugin_auth_sessions(workspace_id, created_at DESC);
CREATE INDEX idx_plugin_auth_sessions_item ON plugin_auth_sessions(catalog_item_id, created_at DESC);
CREATE INDEX idx_plugin_auth_sessions_workspace_member ON plugin_auth_sessions(workspace_member_id, created_at DESC);

CREATE TABLE plugin_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_scope plugin_connections_owner_scope NOT NULL DEFAULT 'installation',
  owner_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  binding_key VARCHAR(100) NOT NULL,
  driver VARCHAR(100) NOT NULL,
  external_account_id VARCHAR(255),
  display_name VARCHAR(255),
  avatar_url TEXT,
  status plugin_connections_status NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  public_payload JSONB DEFAULT '{}',
  secret_payload JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_connections_installation ON plugin_connections(installation_id, created_at DESC);
CREATE INDEX idx_plugin_connections_binding ON plugin_connections(binding_key, created_at DESC);

CREATE TABLE plugin_source_refs (
  installation_id UUID PRIMARY KEY REFERENCES plugin_installations(id) ON DELETE CASCADE,
  source_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  source_catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  sync_mode plugin_source_refs_sync_mode NOT NULL DEFAULT 'manual_merge',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Relay Runtime ============
CREATE TABLE relay_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  device_type relay_devices_device_type NOT NULL DEFAULT 'desktop_computer',
  platform VARCHAR(40),
  authorization_mode relay_authorization_mode NOT NULL DEFAULT 'server_trust',
  conversation_type_mask_override INT
    CHECK (conversation_type_mask_override IS NULL OR (conversation_type_mask_override > 0 AND conversation_type_mask_override <= 31)),
  public_key TEXT NOT NULL,
  public_key_fingerprint VARCHAR(128) NOT NULL UNIQUE,
  trust_status relay_devices_trust_status NOT NULL DEFAULT 'pending',
  last_seen_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_catalog_changed_at TIMESTAMPTZ,
  automation_lifecycle_state relay_devices_automation_lifecycle_state,
  automation_lifecycle_grace_until TIMESTAMPTZ,
  automation_lifecycle_event_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relay_devices_workspace ON relay_devices(workspace_id, created_at DESC);
CREATE INDEX idx_relay_devices_automation_lifecycle_due
  ON relay_devices(automation_lifecycle_grace_until)
  WHERE automation_lifecycle_grace_until IS NOT NULL;

CREATE TABLE relay_pairing_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  device_id UUID REFERENCES relay_devices(id) ON DELETE SET NULL,
  server_base_url TEXT NOT NULL,
  requested_title VARCHAR(255),
  requested_description TEXT,
  requested_device_type relay_devices_device_type,
  requested_authorization_mode relay_authorization_mode,
  pairing_code VARCHAR(32) NOT NULL UNIQUE,
  verification_uri TEXT NOT NULL,
  verification_uri_complete TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  status relay_pairing_sessions_status NOT NULL DEFAULT 'pending',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE relay_device_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  protocol_version INT NOT NULL DEFAULT 2,
  client_version VARCHAR(64),
  authorization_mode relay_authorization_mode NOT NULL DEFAULT 'server_trust',
  status relay_device_sessions_status NOT NULL DEFAULT 'connecting',
  transport relay_device_sessions_transport NOT NULL DEFAULT 'websocket',
  remote_addr TEXT,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  last_heartbeat_at TIMESTAMPTZ,
  close_reason TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE relay_sync_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  source_kind relay_sync_sources_source_kind NOT NULL,
  source_key VARCHAR(255) NOT NULL,
  config_path TEXT,
  sync_mode relay_sync_sources_sync_mode NOT NULL DEFAULT 'follow',
  status relay_sync_sources_status NOT NULL DEFAULT 'unknown',
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, source_key)
);

CREATE TABLE relay_exposures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  sync_source_id UUID REFERENCES relay_sync_sources(id) ON DELETE SET NULL,
  stable_key VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT,
  transport relay_exposures_transport NOT NULL,
  runtime_status relay_exposures_runtime_status NOT NULL DEFAULT 'discovered',
  last_seen_at TIMESTAMPTZ,
  last_healthy_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, stable_key)
);

CREATE TABLE relay_capabilities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  exposure_id UUID NOT NULL UNIQUE REFERENCES relay_exposures(id) ON DELETE CASCADE,
  status relay_capabilities_status NOT NULL DEFAULT 'active',
  conversation_type_mask_override INT
    CHECK (conversation_type_mask_override IS NULL OR (conversation_type_mask_override > 0 AND conversation_type_mask_override <= 31)),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relay_capabilities_workspace ON relay_capabilities(workspace_id, created_at DESC);

-- Keep resource access bindings here so every resource and subject foreign key
-- can be declared inline instead of being patched in later.
CREATE TABLE resource_access_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type resource_access_binding_resource_type NOT NULL,
  installed_skill_id UUID REFERENCES installed_skills(id) ON DELETE CASCADE,
  plugin_installation_id UUID REFERENCES plugin_installations(id) ON DELETE CASCADE,
  relay_capability_id UUID REFERENCES relay_capabilities(id) ON DELETE CASCADE,
  target_type resource_access_bindings_target_type NOT NULL,
  subject_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE CASCADE,
  subject_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  subject_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  subject_conversation_actor_context_id UUID REFERENCES conversation_actor_contexts(id) ON DELETE CASCADE,
  conversation_type_mask_override INT
    CHECK (conversation_type_mask_override IS NULL OR (conversation_type_mask_override > 0 AND conversation_type_mask_override <= 31)),
  granted_permissions TEXT[] NOT NULL DEFAULT '{}',
  status resource_access_bindings_status NOT NULL DEFAULT 'active',
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_resource_access_bindings_resource CHECK (
    (resource_type = 'installed_skill' AND installed_skill_id IS NOT NULL AND plugin_installation_id IS NULL AND relay_capability_id IS NULL) OR
    (resource_type = 'plugin_installation' AND installed_skill_id IS NULL AND plugin_installation_id IS NOT NULL AND relay_capability_id IS NULL) OR
    (resource_type = 'relay_capability' AND installed_skill_id IS NULL AND plugin_installation_id IS NULL AND relay_capability_id IS NOT NULL)
  ),
  CONSTRAINT chk_resource_access_bindings_target CHECK (
    (target_type = 'workspace' AND subject_workspace_id IS NOT NULL AND subject_workspace_member_id IS NULL AND subject_actor_id IS NULL AND subject_conversation_id IS NULL) OR
    (target_type = 'conversation' AND subject_workspace_id IS NULL AND subject_workspace_member_id IS NULL AND subject_actor_id IS NULL AND subject_conversation_id IS NOT NULL AND subject_conversation_actor_context_id IS NULL) OR
    (target_type = 'actor' AND subject_workspace_id IS NULL AND subject_workspace_member_id IS NULL AND subject_actor_id IS NOT NULL AND subject_conversation_id IS NULL) OR
    (target_type = 'actor_in_conversation' AND subject_workspace_id IS NULL AND subject_workspace_member_id IS NULL AND subject_actor_id IS NULL AND subject_conversation_id IS NULL AND subject_conversation_actor_context_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_resource_access_bindings_active
  ON resource_access_bindings(
    resource_type,
    COALESCE(installed_skill_id::text, ''),
    COALESCE(plugin_installation_id::text, ''),
    COALESCE(relay_capability_id::text, ''),
    target_type,
    COALESCE(subject_workspace_id::text, ''),
    COALESCE(subject_workspace_member_id::text, ''),
    COALESCE(subject_actor_id::text, ''),
    COALESCE(subject_conversation_id::text, ''),
    COALESCE(subject_conversation_actor_context_id::text, '')
  )
  WHERE status = 'active';
CREATE INDEX idx_resource_access_bindings_workspace
  ON resource_access_bindings(workspace_id, created_at DESC);
CREATE INDEX idx_resource_access_bindings_installed_skill
  ON resource_access_bindings(installed_skill_id, created_at DESC)
  WHERE installed_skill_id IS NOT NULL;
CREATE INDEX idx_resource_access_bindings_plugin_installation
  ON resource_access_bindings(plugin_installation_id, created_at DESC)
  WHERE plugin_installation_id IS NOT NULL;
CREATE INDEX idx_resource_access_bindings_relay_capability
  ON resource_access_bindings(relay_capability_id, created_at DESC)
  WHERE relay_capability_id IS NOT NULL;
CREATE INDEX idx_resource_access_bindings_subject_lookup
  ON resource_access_bindings(
    target_type,
    subject_workspace_id,
    subject_workspace_member_id,
    subject_actor_id,
    subject_conversation_id,
    subject_conversation_actor_context_id,
    created_at DESC
  );
CREATE INDEX idx_resource_access_bindings_target_lookup
  ON resource_access_bindings(
    target_type,
    subject_conversation_actor_context_id,
    subject_conversation_id,
    subject_actor_id,
    subject_workspace_member_id,
    subject_workspace_id,
    created_at DESC
  );

CREATE TABLE relay_catalog_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  revision_seq BIGINT NOT NULL,
  schema_hash VARCHAR(128) NOT NULL,
  status relay_catalog_revisions_status NOT NULL DEFAULT 'active',
  activated_at TIMESTAMPTZ DEFAULT NOW(),
  invalidated_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(exposure_id, revision_seq)
);

CREATE TABLE relay_tools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  stable_key VARCHAR(255) NOT NULL,
  latest_revision_id UUID,
  current_name VARCHAR(255) NOT NULL,
  status relay_tools_status NOT NULL DEFAULT 'active',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(exposure_id, stable_key)
);

CREATE TABLE relay_tool_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_id UUID NOT NULL REFERENCES relay_tools(id) ON DELETE CASCADE,
  catalog_revision_id UUID NOT NULL REFERENCES relay_catalog_revisions(id) ON DELETE CASCADE,
  tool_name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_schema JSONB NOT NULL DEFAULT '{}',
  annotations JSONB NOT NULL DEFAULT '{}',
  definition_hash VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tool_id, catalog_revision_id)
);

ALTER TABLE relay_tools
  ADD CONSTRAINT fk_relay_tools_latest_revision
  FOREIGN KEY (latest_revision_id) REFERENCES relay_tool_revisions(id) ON DELETE SET NULL;

CREATE TABLE relay_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  requested_by_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  requested_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  requested_by_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  task_id UUID REFERENCES tool_call_tasks(id) ON DELETE SET NULL,
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  catalog_revision_id UUID NOT NULL REFERENCES relay_catalog_revisions(id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES relay_tools(id) ON DELETE CASCADE,
  tool_revision_id UUID NOT NULL REFERENCES relay_tool_revisions(id) ON DELETE CASCADE,
  visible_tool_name VARCHAR(255) NOT NULL,
  runtime_session_id VARCHAR(255),
  delivery_policy relay_operations_delivery_policy NOT NULL DEFAULT 'online_only',
  status relay_operations_status NOT NULL DEFAULT 'created',
  input_payload JSONB NOT NULL DEFAULT '{}',
  authorization_payload JSONB NOT NULL DEFAULT '{}',
  input_hash VARCHAR(128) NOT NULL,
  operation_timeout_ms INT,
  expires_at TIMESTAMPTZ,
  result_hash VARCHAR(128),
  error_code VARCHAR(100),
  error_message TEXT,
  requires_replan BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE relay_operation_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id UUID NOT NULL REFERENCES relay_operations(id) ON DELETE CASCADE,
  relay_session_id UUID REFERENCES relay_device_sessions(id) ON DELETE SET NULL,
  delivery_seq BIGINT NOT NULL,
  status relay_operation_deliveries_status NOT NULL DEFAULT 'queued',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  UNIQUE(operation_id, delivery_seq)
);

CREATE TABLE relay_operation_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_id UUID NOT NULL UNIQUE REFERENCES relay_operations(id) ON DELETE CASCADE,
  output_payload JSONB NOT NULL DEFAULT '{}',
  output_preview TEXT,
  result_hash VARCHAR(128),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relay_operations_device_status
  ON relay_operations(device_id, status, created_at DESC);
CREATE INDEX idx_relay_operations_task
  ON relay_operations(task_id)
  WHERE task_id IS NOT NULL;
CREATE INDEX idx_relay_operations_runtime_session
  ON relay_operations(runtime_session_id)
  WHERE runtime_session_id IS NOT NULL;

CREATE TABLE interaction_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tool_call_tasks(id) ON DELETE CASCADE,
  conversation_item_id UUID UNIQUE REFERENCES conversation_items(id) ON DELETE SET NULL,
  requester_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  requester_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  requester_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  kind interaction_requests_kind NOT NULL,
  status interaction_requests_status NOT NULL DEFAULT 'pending',
  target_member_id UUID REFERENCES conversation_members(id) ON DELETE RESTRICT,
  target_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE RESTRICT,
  resolved_by_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  resolved_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT interaction_requests_target_requirement_chk CHECK (
    (
      kind = 'question_choice'
      AND target_member_id IS NOT NULL
      AND target_workspace_member_id IS NOT NULL
    )
    OR (
      kind = 'runtime_authorization'
      AND target_member_id IS NULL
      AND target_workspace_member_id IS NULL
    )
  )
);

CREATE TABLE interaction_question_requests (
  interaction_id UUID PRIMARY KEY REFERENCES interaction_requests(id) ON DELETE CASCADE,
  prompt_payload JSONB NOT NULL DEFAULT '{}',
  resolution_payload JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE interaction_runtime_authorization_requests (
  interaction_id UUID PRIMARY KEY REFERENCES interaction_requests(id) ON DELETE CASCADE,
  relay_device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  relay_capability_id UUID NOT NULL REFERENCES relay_capabilities(id) ON DELETE CASCADE,
  relay_exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  relay_tool_stable_key TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  requested_effect JSONB NOT NULL DEFAULT '{}',
  display_payload JSONB NOT NULL DEFAULT '{}',
  request_payload JSONB NOT NULL DEFAULT '{}',
  resolution_payload JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE runtime_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relay_device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  relay_capability_id UUID NOT NULL REFERENCES relay_capabilities(id) ON DELETE CASCADE,
  relay_exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  created_by_workspace_member_id UUID REFERENCES workspace_members(id) ON DELETE SET NULL,
  source_interaction_id UUID REFERENCES interaction_requests(id) ON DELETE SET NULL,
  source_task_id UUID REFERENCES tool_call_tasks(id) ON DELETE SET NULL,
  scope runtime_grants_scope NOT NULL,
  retention runtime_grants_retention NOT NULL,
  status runtime_grants_status NOT NULL DEFAULT 'active',
  relay_tool_stable_key TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  source_retry_nonce TEXT,
  source_runtime_session_id TEXT,
  source_request_args JSONB NOT NULL DEFAULT '{}',
  source_request_hash TEXT,
  effect JSONB NOT NULL DEFAULT '{}',
  display_payload JSONB NOT NULL DEFAULT '{}',
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_interaction_requests_conversation
  ON interaction_requests(conversation_id, created_at DESC);
CREATE INDEX idx_interaction_requests_task
  ON interaction_requests(task_id);
CREATE INDEX idx_interaction_requests_target
  ON interaction_requests(target_workspace_member_id, status, created_at DESC);
CREATE INDEX idx_interaction_runtime_authorization_requests_device
  ON interaction_runtime_authorization_requests(relay_device_id, interaction_id);
CREATE INDEX idx_runtime_grants_exposure
  ON runtime_grants(relay_capability_id, status, scope, created_at DESC);
CREATE INDEX idx_runtime_grants_actor
  ON runtime_grants(actor_id, relay_capability_id, status, created_at DESC);
CREATE INDEX idx_runtime_grants_conversation
  ON runtime_grants(conversation_id, relay_capability_id, status, created_at DESC);
