-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============ Users ============
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Workspaces ============
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_model_group_id UUID, -- FK added after model_groups table
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

-- ============ Workspace Members ============
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trust_level VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (trust_level IN ('owner', 'admin', 'member', 'guest')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- ============ Workspace Invites ============
CREATE TABLE IF NOT EXISTS workspace_invites (
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

CREATE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id);

-- ============ Actors (Digital Employees) ============
CREATE TABLE IF NOT EXISTS actors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'specialist' CHECK (role IN ('secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant')),
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

CREATE INDEX IF NOT EXISTS idx_actors_workspace ON actors(workspace_id);
CREATE INDEX IF NOT EXISTS idx_actors_parent ON actors(parent_id);
CREATE INDEX IF NOT EXISTS idx_actors_role ON actors(workspace_id, role);

-- ============ Actor Versions (append-only history) ============
CREATE TABLE IF NOT EXISTS actor_versions (
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

CREATE INDEX IF NOT EXISTS idx_actor_versions_actor_time ON actor_versions(actor_id, created_at);

-- ============ Actor Collaborations ============
CREATE TABLE IF NOT EXISTS actor_collaborations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  relationship VARCHAR(50) NOT NULL DEFAULT 'peer',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(actor_id, collaborator_id)
);

CREATE INDEX IF NOT EXISTS idx_actor_collabs_actor ON actor_collaborations(actor_id);

-- ============ Work Items ============
CREATE TABLE IF NOT EXISTS work_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'assigned', 'accepted', 'in_progress', 'review', 'completed', 'escalated', 'blocked', 'rework', 'cancelled', 'failed')),
  priority VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  parent_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  created_by UUID NOT NULL,
  assigned_to UUID REFERENCES actors(id) ON DELETE SET NULL,
  accountable_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  source_type VARCHAR(30) NOT NULL DEFAULT 'user_message' CHECK (source_type IN ('user_message', 'delegation', 'standing_order', 'escalation', 'collaboration')),
  source_id UUID,
  due_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_items_workspace ON work_items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_work_items_assigned ON work_items(assigned_to);
CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_id);

-- ============ Work Item Participants ============
CREATE TABLE IF NOT EXISTS work_item_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'executor' CHECK (role IN ('owner', 'accountable', 'executor', 'reviewer', 'watcher')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(work_item_id, actor_id, role)
);

CREATE INDEX IF NOT EXISTS idx_work_item_participants_item ON work_item_participants(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_item_participants_actor ON work_item_participants(actor_id);

-- ============ Messages ============
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID REFERENCES work_items(id) ON DELETE SET NULL,
  type VARCHAR(30) NOT NULL CHECK (type IN ('assign', 'accept', 'reject', 'info_request', 'info_response', 'progress', 'escalate', 'assist_request', 'assist_response', 'transfer', 'complete', 'feedback', 'rework', 'user_message', 'secretary_response')),
  from_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  to_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_workspace ON messages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_work_item ON messages(work_item_id);
CREATE INDEX IF NOT EXISTS idx_messages_from_actor ON messages(from_actor_id);
CREATE INDEX IF NOT EXISTS idx_messages_to_actor ON messages(to_actor_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(workspace_id, created_at DESC);

-- ============ Memories ============
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  category VARCHAR(20) NOT NULL DEFAULT 'knowledge' CHECK (category IN ('working', 'experiential', 'knowledge', 'procedural', 'relational')),
  scope VARCHAR(20) NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'team', 'workspace')),
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

CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memories_actor ON memories(actor_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(actor_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING GIN(content gin_trgm_ops);

-- ============ Standing Orders ============
CREATE TABLE IF NOT EXISTS standing_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  trigger_type VARCHAR(20) NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('cron', 'event', 'condition')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  instruction TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standing_orders_workspace ON standing_orders(workspace_id);
CREATE INDEX IF NOT EXISTS idx_standing_orders_actor ON standing_orders(actor_id);

-- ============ Audit Logs ============
CREATE TABLE IF NOT EXISTS audit_logs (
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

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- ============ Model Groups ============
CREATE TABLE IF NOT EXISTS model_groups (
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

CREATE INDEX IF NOT EXISTS idx_model_groups_workspace ON model_groups(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_groups_default_platform
  ON model_groups ((1)) WHERE workspace_id IS NULL AND is_default = TRUE AND is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_groups_default_workspace
  ON model_groups (workspace_id) WHERE workspace_id IS NOT NULL AND is_default = TRUE AND is_active = TRUE;

-- FK: workspaces.default_model_group_id → model_groups (deferred, both tables now exist)
ALTER TABLE workspaces ADD CONSTRAINT fk_workspaces_default_model_group
  FOREIGN KEY (default_model_group_id) REFERENCES model_groups(id) ON DELETE SET NULL;

-- ============ Model Group Items ============
CREATE TABLE IF NOT EXISTS model_group_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  current_config_id UUID, -- FK added after model_item_configs table
  display_name VARCHAR(255) NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  is_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_group_items_group ON model_group_items(group_id);

-- ============ Model Item Configs (append-only, immutable) ============
CREATE TABLE IF NOT EXISTS model_item_configs (
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

CREATE INDEX IF NOT EXISTS idx_model_item_configs_item ON model_item_configs(item_id);

-- FK: model_group_items.current_config_id → model_item_configs (deferred, both tables now exist)
ALTER TABLE model_group_items ADD CONSTRAINT fk_current_config
  FOREIGN KEY (current_config_id) REFERENCES model_item_configs(id) ON DELETE SET NULL;

-- ============ Actor Model Groups (failover chain) ============
CREATE TABLE IF NOT EXISTS actor_model_groups (
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (actor_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_actor_model_groups_actor ON actor_model_groups(actor_id);

-- ============ Groups (chat groups) ============
CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_workspace ON groups(workspace_id);

-- ============ Sessions ============
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  channel_type VARCHAR(30) NOT NULL DEFAULT 'web' CHECK (channel_type IN ('web', 'api')),
  trigger VARCHAR(50) NOT NULL DEFAULT 'user_message',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sleeping', 'completed', 'failed', 'cancelled', 'timed_out')),
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_actor_status ON sessions(actor_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id);

-- ============ Group Members ============
CREATE TABLE IF NOT EXISTS group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, actor_id),
  UNIQUE(group_id, user_id),
  CHECK (
    (actor_id IS NOT NULL AND user_id IS NULL) OR
    (actor_id IS NULL AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_actor ON group_members(actor_id);
CREATE INDEX IF NOT EXISTS idx_group_members_session ON group_members(session_id);

-- ============ Group Member Events (membership history log) ============
CREATE TABLE IF NOT EXISTS group_member_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('joined', 'kicked', 'left')),
  batch_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (actor_id IS NOT NULL AND user_id IS NULL) OR
    (actor_id IS NULL AND user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_gme_group_time ON group_member_events(group_id, created_at);

-- ============ Group Messages ============
CREATE TABLE IF NOT EXISTS group_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('user', 'actor', 'system')),
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  sender_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  target_actor_ids UUID[] DEFAULT '{}',
  target_user_ids UUID[] DEFAULT '{}',
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id, created_at);

-- ============ User Group Reads (unread tracking) ============
CREATE TABLE IF NOT EXISTS user_group_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

-- ============ AI Request Logs ============
CREATE TABLE IF NOT EXISTS ai_request_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  round INT DEFAULT 1,
  group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL,
  item_id UUID REFERENCES model_group_items(id) ON DELETE SET NULL,
  config_id UUID REFERENCES model_item_configs(id) ON DELETE SET NULL,
  request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('actor_think', 'ai_complete')),
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cost_micros BIGINT DEFAULT 0,
  latency_ms INT DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error', 'timeout')),
  error_message TEXT,
  request_body JSONB,
  response_body JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_request_logs_workspace ON ai_request_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_request_logs_actor ON ai_request_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_ai_request_logs_session ON ai_request_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_request_logs_turn ON ai_request_logs(turn_id);
CREATE INDEX IF NOT EXISTS idx_ai_request_logs_group ON ai_request_logs(group_id);

-- ============ Session Messages ============
CREATE TABLE IF NOT EXISTS session_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool_result', 'child_result')),
  content TEXT NOT NULL,
  from_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, created_at ASC);

-- ============ Session Interrupts ============
CREATE TABLE IF NOT EXISTS session_interrupts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN ('progress_check', 'memory_changed', 'priority_override')),
  content TEXT NOT NULL,
  from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  is_consumed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_interrupts_target ON session_interrupts(target_session_id) WHERE is_consumed = FALSE;

-- (user_session_reads removed — replaced by user_group_reads above)

-- ============ MCP Organizations (publisher groups) ============
CREATE TABLE IF NOT EXISTS mcp_organizations (
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
CREATE TABLE IF NOT EXISTS mcp_plugins (
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

CREATE INDEX IF NOT EXISTS idx_mcp_plugins_org ON mcp_plugins(org_id);
CREATE INDEX IF NOT EXISTS idx_mcp_plugins_transport ON mcp_plugins(transport);
CREATE INDEX IF NOT EXISTS idx_mcp_plugins_tags ON mcp_plugins USING GIN(tags);

-- ============ MCP Installations (unified) ============
CREATE TABLE IF NOT EXISTS mcp_installations (
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

CREATE INDEX IF NOT EXISTS idx_mcp_inst_workspace ON mcp_installations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_mcp_inst_plugin ON mcp_installations(plugin_id);
CREATE INDEX IF NOT EXISTS idx_mcp_inst_scope ON mcp_installations(scope_type, scope_id);

-- ============ MCP Relay Agents ============
CREATE TABLE IF NOT EXISTS mcp_relays (
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

CREATE INDEX IF NOT EXISTS idx_mcp_relays_user ON mcp_relays(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_relays_workspace ON mcp_relays(workspace_id);

-- ============ MCP Relay Servers ============
CREATE TABLE IF NOT EXISTS mcp_relay_servers (
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

CREATE INDEX IF NOT EXISTS idx_mcp_relay_servers_relay ON mcp_relay_servers(relay_id);

-- ============ MCP Tool Call Logs ============
CREATE TABLE IF NOT EXISTS mcp_tool_call_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  round INT,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  plugin_id UUID REFERENCES mcp_plugins(id) ON DELETE CASCADE,
  relay_id UUID REFERENCES mcp_relays(id) ON DELETE SET NULL,
  tool_name VARCHAR(255) NOT NULL,
  tool_type VARCHAR(20) DEFAULT 'mcp_plugin',
  input JSONB DEFAULT '{}',
  output TEXT,
  is_error BOOLEAN DEFAULT FALSE,
  error_message TEXT,
  duration_ms INT,
  transport VARCHAR(20),
  instance_key VARCHAR(512),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_logs_ws_created ON mcp_tool_call_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_logs_session ON mcp_tool_call_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_logs_turn ON mcp_tool_call_logs(turn_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_logs_plugin ON mcp_tool_call_logs(plugin_id);

-- ============ MCP Event Logs ============
CREATE TABLE IF NOT EXISTS mcp_event_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  plugin_id UUID REFERENCES mcp_plugins(id) ON DELETE SET NULL,
  relay_id UUID REFERENCES mcp_relays(id) ON DELETE SET NULL,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_event_logs_ws_type ON mcp_event_logs(workspace_id, event_type);
CREATE INDEX IF NOT EXISTS idx_mcp_event_logs_created ON mcp_event_logs(created_at DESC);

-- ============ Files ============
CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  uploader_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  original_name VARCHAR(500) NOT NULL,
  stored_name VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  category VARCHAR(30) DEFAULT 'general' CHECK (category IN ('general', 'chat_attachment', 'plugin_output')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id);

-- ============ A2A Apps ============
CREATE TABLE IF NOT EXISTS a2a_apps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  api_key_hash VARCHAR(255) NOT NULL,
  api_key_prefix VARCHAR(8) NOT NULL,
  rate_limit_rpm INT DEFAULT 60,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_a2a_apps_workspace ON a2a_apps(workspace_id);
CREATE INDEX IF NOT EXISTS idx_a2a_apps_prefix ON a2a_apps(api_key_prefix);

CREATE TABLE IF NOT EXISTS a2a_app_actors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id UUID NOT NULL REFERENCES a2a_apps(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_app_actors_app ON a2a_app_actors(app_id);

CREATE TABLE IF NOT EXISTS a2a_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id UUID NOT NULL REFERENCES a2a_apps(id) ON DELETE CASCADE,
  context_id VARCHAR(255),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_app ON a2a_tasks(app_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_session ON a2a_tasks(session_id);

-- ============ Updated at trigger (must be after all tables) ============
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
  FOR tbl IN SELECT unnest(ARRAY['users', 'workspaces', 'workspace_invites', 'actors', 'work_items', 'memories', 'standing_orders', 'model_groups', 'model_group_items', 'sessions', 'mcp_organizations', 'mcp_plugins', 'mcp_installations', 'mcp_relays', 'mcp_relay_servers', 'a2a_apps', 'groups'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', tbl);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', tbl);
  END LOOP;
END;
$$;
