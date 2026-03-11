-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============ Users ============
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============ Workspaces ============
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_model_group_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_slug ON workspaces(slug);

-- ============ Workspace Members ============
CREATE TABLE workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trust_level VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (trust_level IN ('owner', 'admin', 'member', 'guest')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

-- ============ Workspace Invites ============
CREATE TABLE workspace_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token VARCHAR(12) UNIQUE NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trust_level VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (trust_level IN ('admin', 'member', 'guest')),
  max_uses INT,
  use_count INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_revoked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspace_invites_token ON workspace_invites(token);
CREATE INDEX idx_workspace_invites_workspace ON workspace_invites(workspace_id);

-- ============ Actors ============
CREATE TABLE actors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'specialist'
    CHECK (role IN ('secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant')),
  title VARCHAR(255) NOT NULL,
  charter TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  capabilities TEXT[] DEFAULT '{}',
  skills JSONB DEFAULT '[]',
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  memory_version BIGINT DEFAULT 0,
  max_concurrent_sessions INT DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_actors_workspace ON actors(workspace_id);
CREATE INDEX idx_actors_parent ON actors(parent_id);
CREATE INDEX idx_actors_role ON actors(workspace_id, role);

-- ============ Actor Versions ============
CREATE TABLE actor_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  version INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  charter TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  skills JSONB DEFAULT '[]',
  config JSONB DEFAULT '{}',
  capabilities TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(actor_id, version)
);

CREATE INDEX idx_actor_versions_actor_time ON actor_versions(actor_id, created_at);

-- ============ Actor Collaborations ============
CREATE TABLE actor_collaborations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  relationship VARCHAR(50) NOT NULL DEFAULT 'peer',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(actor_id, collaborator_id)
);

CREATE INDEX idx_actor_collabs_actor ON actor_collaborations(actor_id);

-- ============ Work Items ============
CREATE TABLE work_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'assigned', 'accepted', 'in_progress', 'review', 'completed', 'escalated', 'blocked', 'rework', 'cancelled', 'failed')),
  priority VARCHAR(10) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  parent_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  created_by UUID NOT NULL,
  assigned_to UUID REFERENCES actors(id) ON DELETE SET NULL,
  accountable_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  source_type VARCHAR(30) NOT NULL DEFAULT 'user_message'
    CHECK (source_type IN ('user_message', 'delegation', 'standing_order', 'escalation', 'collaboration')),
  source_id UUID,
  due_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_work_items_workspace ON work_items(workspace_id);
CREATE INDEX idx_work_items_status ON work_items(workspace_id, status);
CREATE INDEX idx_work_items_assigned ON work_items(assigned_to);
CREATE INDEX idx_work_items_parent ON work_items(parent_id);

-- ============ Work Item Participants ============
CREATE TABLE work_item_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'executor'
    CHECK (role IN ('owner', 'accountable', 'executor', 'reviewer', 'watcher')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(work_item_id, actor_id, role)
);

CREATE INDEX idx_work_item_participants_item ON work_item_participants(work_item_id);
CREATE INDEX idx_work_item_participants_actor ON work_item_participants(actor_id);

-- ============ Legacy Work Messages ============
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  type VARCHAR(30) NOT NULL
    CHECK (type IN ('assign', 'accept', 'reject', 'info_request', 'info_response', 'progress', 'escalate', 'assist_request', 'assist_response', 'transfer', 'complete', 'feedback', 'rework', 'user_message', 'secretary_response')),
  from_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  to_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_workspace ON messages(workspace_id);
CREATE INDEX idx_messages_work_item ON messages(work_item_id);
CREATE INDEX idx_messages_created ON messages(workspace_id, created_at DESC);

-- ============ Memories ============
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  category VARCHAR(20) NOT NULL DEFAULT 'knowledge'
    CHECK (category IN ('working', 'experiential', 'knowledge', 'procedural', 'relational')),
  scope VARCHAR(20) NOT NULL DEFAULT 'private'
    CHECK (scope IN ('private', 'team', 'workspace')),
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT[] DEFAULT '{}',
  source_work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  importance REAL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  embedding VECTOR(1536),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memories_workspace ON memories(workspace_id);
CREATE INDEX idx_memories_actor ON memories(actor_id);
CREATE INDEX idx_memories_category ON memories(actor_id, category);
CREATE INDEX idx_memories_tags ON memories USING GIN(tags);
CREATE INDEX idx_memories_content_trgm ON memories USING GIN(content gin_trgm_ops);

-- ============ Standing Orders ============
CREATE TABLE standing_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger_type VARCHAR(20) NOT NULL DEFAULT 'cron'
    CHECK (trigger_type IN ('cron', 'event', 'condition')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  instruction TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_standing_orders_workspace ON standing_orders(workspace_id);
CREATE INDEX idx_standing_orders_actor ON standing_orders(actor_id);

-- ============ Audit Logs ============
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID,
  details JSONB DEFAULT '{}',
  ip_address INET,
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
  category VARCHAR(30) DEFAULT 'general'
    CHECK (category IN ('general', 'chat_attachment', 'plugin_output')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_workspace ON files(workspace_id);

-- ============ Model Groups ============
CREATE TABLE model_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  routing_strategy VARCHAR(30) NOT NULL DEFAULT 'priority_failover'
    CHECK (routing_strategy IN ('weighted_random', 'round_robin', 'priority_failover')),
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_model_groups_workspace ON model_groups(workspace_id);
CREATE UNIQUE INDEX idx_model_groups_default_platform
  ON model_groups ((1)) WHERE workspace_id IS NULL AND is_default = TRUE AND is_active = TRUE;
CREATE UNIQUE INDEX idx_model_groups_default_workspace
  ON model_groups (workspace_id) WHERE workspace_id IS NOT NULL AND is_default = TRUE AND is_active = TRUE;

ALTER TABLE workspaces ADD CONSTRAINT fk_workspaces_default_model_group
  FOREIGN KEY (default_model_group_id) REFERENCES model_groups(id) ON DELETE SET NULL;

-- ============ Model Group Items ============
CREATE TABLE model_group_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  current_config_id UUID,
  display_name VARCHAR(255) NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  is_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_model_group_items_group ON model_group_items(group_id);

-- ============ Model Item Configs ============
CREATE TABLE model_item_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES model_group_items(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  provider_type VARCHAR(30) NOT NULL CHECK (provider_type IN ('anthropic', 'openai')),
  api_key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name VARCHAR(255) NOT NULL,
  max_tokens INT NOT NULL DEFAULT 4096,
  input_token_cost_micros BIGINT DEFAULT 0,
  output_token_cost_micros BIGINT DEFAULT 0,
  capability_tags TEXT[] DEFAULT '{}',
  extra_config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(item_id, version)
);

CREATE INDEX idx_model_item_configs_item ON model_item_configs(item_id);

ALTER TABLE model_group_items ADD CONSTRAINT fk_current_config
  FOREIGN KEY (current_config_id) REFERENCES model_item_configs(id) ON DELETE SET NULL;

-- ============ Actor Model Groups ============
CREATE TABLE actor_model_groups (
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (actor_id, group_id)
);

CREATE INDEX idx_actor_model_groups_actor ON actor_model_groups(actor_id);

-- ============ Conversations ============
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('group', 'direct', 'a2a_virtual')),
  title VARCHAR(500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_workspace_kind ON conversations(workspace_id, kind);

-- ============ Sessions ============
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_type VARCHAR(30) NOT NULL DEFAULT 'web' CHECK (channel_type IN ('web', 'api', 'bridge')),
  trigger VARCHAR(50) NOT NULL DEFAULT 'user_message',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'sleeping', 'completed', 'failed', 'cancelled', 'timed_out')),
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

-- ============ Conversation Members ============
CREATE TABLE conversation_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_type VARCHAR(20) NOT NULL CHECK (member_type IN ('actor', 'user', 'remote_agent', 'system')),
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(255),
  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'left', 'kicked')),
  metadata JSONB DEFAULT '{}',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  CHECK (
    (member_type = 'actor' AND actor_id IS NOT NULL AND user_id IS NULL) OR
    (member_type = 'user' AND actor_id IS NULL AND user_id IS NOT NULL) OR
    (member_type IN ('remote_agent', 'system') AND actor_id IS NULL AND user_id IS NULL)
  )
);

CREATE INDEX idx_conversation_members_conversation ON conversation_members(conversation_id, state);
CREATE INDEX idx_conversation_members_actor ON conversation_members(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_actor
  ON conversation_members(conversation_id, actor_id) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_user
  ON conversation_members(conversation_id, user_id) WHERE user_id IS NOT NULL;

-- ============ Conversation Items ============
CREATE TABLE conversation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  scope VARCHAR(20) NOT NULL CHECK (scope IN ('shared', 'private')),
  surface VARCHAR(20) NOT NULL CHECK (surface IN ('visible', 'internal')),
  item_type VARCHAR(30) NOT NULL
    CHECK (item_type IN ('message', 'event', 'summary', 'control')),
  subtype VARCHAR(50) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  author_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  bundle_id UUID,
  reply_to_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  caused_by_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
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

-- ============ Conversation Item Parts ============
CREATE TABLE conversation_item_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type VARCHAR(20) NOT NULL CHECK (part_type IN ('text', 'file_ref', 'json')),
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

-- ============ Conversation Item Targets ============
CREATE TABLE conversation_item_targets (
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  target_member_id UUID NOT NULL REFERENCES conversation_members(id) ON DELETE CASCADE,
  target_kind VARCHAR(20) NOT NULL DEFAULT 'to'
    CHECK (target_kind IN ('to', 'cc', 'visible')),
  PRIMARY KEY (item_id, target_member_id, target_kind)
);

CREATE INDEX idx_conversation_item_targets_member ON conversation_item_targets(target_member_id, item_id);

-- ============ Conversation Reads ============
CREATE TABLE conversation_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

-- ============ Turns ============
CREATE TABLE turns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  trigger_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  trigger_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
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
  content_type VARCHAR(20) NOT NULL CHECK (content_type IN ('json', 'text')),
  json_body JSONB,
  text_body TEXT,
  byte_size INT NOT NULL DEFAULT 0,
  retention_class VARCHAR(20) NOT NULL DEFAULT 'audit'
    CHECK (retention_class IN ('ephemeral', 'debug', 'audit')),
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
  provider_type VARCHAR(30) NOT NULL CHECK (provider_type IN ('anthropic', 'openai')),
  request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('actor_think', 'ai_complete')),
  model_group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL,
  model_item_id UUID REFERENCES model_group_items(id) ON DELETE SET NULL,
  model_config_id UUID REFERENCES model_item_configs(id) ON DELETE SET NULL,
  model_name VARCHAR(255) NOT NULL,
  capabilities_snapshot JSONB DEFAULT '{}',
  request_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  response_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  stop_reason VARCHAR(50),
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cost_micros BIGINT DEFAULT 0,
  latency_ms INT DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'error', 'timeout')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(turn_id, step_index)
);

CREATE INDEX idx_provider_steps_turn ON provider_steps(turn_id, step_index);
CREATE INDEX idx_provider_steps_config ON provider_steps(model_config_id);

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
  tool_kind VARCHAR(30) NOT NULL
    CHECK (tool_kind IN ('builtin', 'callable', 'action', 'mcp_plugin', 'mcp_relay', 'provider_builtin', 'a2a_proxy')),
  tool_name VARCHAR(255) NOT NULL,
  plugin_id UUID,
  relay_id UUID,
  normalized_input JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id, created_at);
CREATE INDEX idx_tool_calls_bundle ON tool_calls(bundle_id);
CREATE INDEX idx_tool_calls_provider_step ON tool_calls(provider_step_id);

-- ============ Tool Execution Attempts ============
CREATE TABLE tool_execution_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool_call_id UUID NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  attempt_no INT NOT NULL,
  executor_kind VARCHAR(30) NOT NULL
    CHECK (executor_kind IN ('builtin', 'callable', 'action', 'mcp_plugin', 'mcp_relay', 'provider_builtin', 'a2a_proxy')),
  plugin_id UUID,
  relay_id UUID,
  transport VARCHAR(30),
  instance_key VARCHAR(512),
  request_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  response_payload_blob_id UUID REFERENCES payload_blobs(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'error', 'timeout')),
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
  part_type VARCHAR(20) NOT NULL CHECK (part_type IN ('text', 'file_ref', 'json')),
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

-- ============ Context Archive Points ============
CREATE TABLE context_archive_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  chain_scope VARCHAR(20) NOT NULL
    CHECK (chain_scope IN ('shared', 'private')),
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

-- ============ Context Archive Frames ============
CREATE TABLE context_archive_frames (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  archive_point_id UUID NOT NULL REFERENCES context_archive_points(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  frame_type VARCHAR(50) NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,
  source_item_ids UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  UNIQUE(archive_point_id, ordinal)
);

CREATE INDEX idx_context_archive_frames_point
  ON context_archive_frames(archive_point_id, ordinal);

-- ============ Context Archive Frame Parts ============
CREATE TABLE context_archive_frame_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  archive_frame_id UUID NOT NULL REFERENCES context_archive_frames(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type VARCHAR(20) NOT NULL CHECK (part_type IN ('text', 'file_ref', 'json')),
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

-- ============ Context Compaction Runs ============
CREATE TABLE context_compaction_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  chain_scope VARCHAR(20) NOT NULL
    CHECK (chain_scope IN ('shared', 'private')),
  strategy_key VARCHAR(255) NOT NULL,
  base_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  output_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
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

-- ============ Context Compaction Run Inputs ============
CREATE TABLE context_compaction_run_inputs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES context_compaction_runs(id) ON DELETE CASCADE,
  input_kind VARCHAR(20) NOT NULL
    CHECK (input_kind IN ('archive_point', 'sequence_range', 'item')),
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

-- ============ Conversation Context State ============
CREATE TABLE conversation_context_states (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  active_shared_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Session Context State ============
CREATE TABLE session_context_states (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  active_private_archive_point_id UUID REFERENCES context_archive_points(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Session Interrupts ============
CREATE TABLE session_interrupts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN ('progress_check', 'memory_changed', 'priority_override')),
  content TEXT NOT NULL,
  from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  is_consumed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_interrupts_target
  ON session_interrupts(target_session_id) WHERE is_consumed = FALSE;

-- ============ MCP Organizations ============
CREATE TABLE mcp_organizations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  logo_url TEXT,
  is_builtin BOOLEAN DEFAULT FALSE,
  is_verified BOOLEAN DEFAULT FALSE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ MCP Plugins ============
CREATE TABLE mcp_plugins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES mcp_organizations(id) ON DELETE CASCADE,
  slug VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  long_description TEXT DEFAULT '',
  icon_url TEXT,
  version VARCHAR(50) DEFAULT '1.0.0',
  transport VARCHAR(20) NOT NULL DEFAULT 'builtin'
    CHECK (transport IN ('builtin', 'stdio', 'http', 'relay')),
  entry_point TEXT NOT NULL DEFAULT '',
  lifecycle_scope VARCHAR(20) NOT NULL DEFAULT 'session'
    CHECK (lifecycle_scope IN ('workspace', 'user', 'actor', 'group', 'session')),
  config_schema JSONB DEFAULT '{}',
  default_config JSONB DEFAULT '{}',
  tools_manifest JSONB DEFAULT '[]',
  validation_rules JSONB DEFAULT '[]',
  setup_steps JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  is_builtin BOOLEAN DEFAULT FALSE,
  download_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, slug)
);

CREATE INDEX idx_mcp_plugins_org ON mcp_plugins(org_id);
CREATE INDEX idx_mcp_plugins_transport ON mcp_plugins(transport);
CREATE INDEX idx_mcp_plugins_tags ON mcp_plugins USING GIN(tags);

-- ============ MCP Installations ============
CREATE TABLE mcp_installations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id UUID NOT NULL REFERENCES mcp_plugins(id) ON DELETE CASCADE,
  scope_type VARCHAR(20) NOT NULL CHECK (scope_type IN ('workspace', 'user', 'actor', 'group')),
  scope_id UUID NOT NULL,
  lifecycle_scope VARCHAR(20) NOT NULL DEFAULT 'session'
    CHECK (lifecycle_scope IN ('workspace', 'user', 'actor', 'group', 'session')),
  is_enabled BOOLEAN DEFAULT TRUE,
  config_data JSONB DEFAULT '{}',
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (plugin_id, scope_type, scope_id),
  CONSTRAINT chk_lifecycle_hierarchy CHECK (
    (scope_type = 'workspace' AND lifecycle_scope IN ('workspace', 'group', 'user', 'actor', 'session')) OR
    (scope_type = 'user'      AND lifecycle_scope IN ('user', 'actor', 'session')) OR
    (scope_type = 'actor'     AND lifecycle_scope IN ('actor', 'session')) OR
    (scope_type = 'group'     AND lifecycle_scope IN ('group', 'actor', 'session'))
  )
);

CREATE INDEX idx_mcp_inst_workspace ON mcp_installations(workspace_id);
CREATE INDEX idx_mcp_inst_plugin ON mcp_installations(plugin_id);
CREATE INDEX idx_mcp_inst_scope ON mcp_installations(scope_type, scope_id);

-- ============ MCP Relay Agents ============
CREATE TABLE mcp_relays (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  auth_token VARCHAR(255) UNIQUE NOT NULL,
  is_connected BOOLEAN DEFAULT FALSE,
  last_connected_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcp_relays_user ON mcp_relays(user_id);
CREATE INDEX idx_mcp_relays_workspace ON mcp_relays(workspace_id);

-- ============ MCP Relay Servers ============
CREATE TABLE mcp_relay_servers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relay_id UUID NOT NULL REFERENCES mcp_relays(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  transport VARCHAR(20) NOT NULL CHECK (transport IN ('stdio', 'http')),
  command TEXT,
  endpoint TEXT,
  env_vars JSONB DEFAULT '{}',
  tools_manifest JSONB DEFAULT '[]',
  is_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_mcp_relay_servers_relay ON mcp_relay_servers(relay_id);

ALTER TABLE tool_calls ADD CONSTRAINT fk_tool_calls_plugin
  FOREIGN KEY (plugin_id) REFERENCES mcp_plugins(id) ON DELETE SET NULL;
ALTER TABLE tool_calls ADD CONSTRAINT fk_tool_calls_relay
  FOREIGN KEY (relay_id) REFERENCES mcp_relays(id) ON DELETE SET NULL;
ALTER TABLE tool_execution_attempts ADD CONSTRAINT fk_tool_execution_attempts_plugin
  FOREIGN KEY (plugin_id) REFERENCES mcp_plugins(id) ON DELETE SET NULL;
ALTER TABLE tool_execution_attempts ADD CONSTRAINT fk_tool_execution_attempts_relay
  FOREIGN KEY (relay_id) REFERENCES mcp_relays(id) ON DELETE SET NULL;

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
  source VARCHAR(30) NOT NULL CHECK (source IN ('conversation', 'provider', 'tool', 'relay', 'a2a', 'system')),
  level VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event_type VARCHAR(50) NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_runtime_events_workspace_time ON runtime_events(workspace_id, created_at DESC);
CREATE INDEX idx_runtime_events_turn_time ON runtime_events(turn_id, created_at DESC) WHERE turn_id IS NOT NULL;
CREATE INDEX idx_runtime_events_tool_call_time ON runtime_events(tool_call_id, created_at DESC) WHERE tool_call_id IS NOT NULL;

-- ============ A2A Apps ============
CREATE TABLE a2a_apps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  api_key_hash VARCHAR(255) NOT NULL,
  api_key_prefix VARCHAR(16) NOT NULL,
  rate_limit_rpm INT DEFAULT 60,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_a2a_apps_workspace ON a2a_apps(workspace_id);
CREATE INDEX idx_a2a_apps_prefix ON a2a_apps(api_key_prefix);

CREATE TABLE a2a_app_actors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id UUID NOT NULL REFERENCES a2a_apps(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, actor_id)
);

CREATE INDEX idx_a2a_app_actors_app ON a2a_app_actors(app_id);

CREATE TABLE a2a_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id UUID NOT NULL REFERENCES a2a_apps(id) ON DELETE CASCADE,
  context_id VARCHAR(255),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, session_id)
);

CREATE INDEX idx_a2a_tasks_app ON a2a_tasks(app_id);
CREATE INDEX idx_a2a_tasks_session ON a2a_tasks(session_id);

-- ============ Agent Endpoints ============
CREATE TABLE agent_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('local_a2a_app', 'remote_a2a_server')),
  display_name VARCHAR(255) NOT NULL,
  base_url TEXT,
  auth_config JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_endpoints_workspace ON agent_endpoints(workspace_id);

CREATE TABLE endpoint_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  endpoint_id UUID NOT NULL REFERENCES agent_endpoints(id) ON DELETE CASCADE,
  local_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  external_agent_id VARCHAR(255),
  display_name VARCHAR(255) NOT NULL,
  agent_card JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_endpoint_agents_endpoint ON endpoint_agents(endpoint_id);

CREATE TABLE conversation_bridges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES agent_endpoints(id) ON DELETE CASCADE,
  endpoint_agent_id UUID REFERENCES endpoint_agents(id) ON DELETE SET NULL,
  remote_task_id VARCHAR(255),
  remote_context_id VARCHAR(255),
  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'completed', 'failed', 'cancelled')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversation_bridges_conversation ON conversation_bridges(conversation_id);
CREATE INDEX idx_conversation_bridges_endpoint ON conversation_bridges(endpoint_id);

-- ============ Updated at trigger ============
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'users', 'workspaces', 'workspace_invites', 'actors', 'work_items', 'memories',
    'standing_orders', 'model_groups', 'model_group_items', 'conversations', 'sessions',
    'mcp_organizations', 'mcp_plugins', 'mcp_installations', 'mcp_relays', 'mcp_relay_servers',
    'a2a_apps', 'agent_endpoints', 'endpoint_agents', 'conversation_bridges'
  ])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', tbl);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', tbl);
  END LOOP;
END;
$$;
