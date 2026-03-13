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
  default_model_route_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_slug ON workspaces(slug);

-- ============ Platform Settings ============
CREATE TABLE platform_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  default_model_route_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
  avatar_file_id UUID,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  docs JSONB NOT NULL DEFAULT '[]',
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  capabilities TEXT[] DEFAULT '{}',
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  current_version INT NOT NULL DEFAULT 1,
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
  avatar_file_id UUID,
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  docs JSONB NOT NULL DEFAULT '[]',
  config JSONB DEFAULT '{}',
  capabilities TEXT[] DEFAULT '{}',
  version_delta JSONB,
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
    CHECK (category IN ('general', 'chat_attachment', 'plugin_output', 'plugin_asset')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_workspace ON files(workspace_id);

ALTER TABLE actors ADD CONSTRAINT fk_actors_avatar_file
  FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;
ALTER TABLE actor_versions ADD CONSTRAINT fk_actor_versions_avatar_file
  FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;

-- ============ Model Routes ============
CREATE TABLE model_routes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  route_scope VARCHAR(30) NOT NULL
    CHECK (route_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  conversation_id UUID,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  routing_strategy VARCHAR(30) NOT NULL DEFAULT 'priority_failover'
    CHECK (routing_strategy IN ('weighted_random', 'round_robin', 'priority_failover')),
  attempt_policy JSONB DEFAULT '{}',
  is_default BOOLEAN DEFAULT FALSE,
  is_enabled BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_model_routes_target CHECK (
    (route_scope = 'platform' AND workspace_id IS NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (route_scope = 'workspace' AND workspace_id IS NOT NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (route_scope = 'conversation' AND workspace_id IS NOT NULL AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (route_scope = 'actor_global' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (route_scope = 'actor_conversation' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (route_scope = 'user' AND workspace_id IS NOT NULL AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_model_routes_workspace ON model_routes(workspace_id, created_at DESC);
CREATE INDEX idx_model_routes_scope ON model_routes(route_scope, created_at DESC);
CREATE UNIQUE INDEX idx_model_routes_default_platform
  ON model_routes ((1)) WHERE route_scope = 'platform' AND is_default = TRUE AND is_enabled = TRUE;
CREATE UNIQUE INDEX idx_model_routes_default_workspace
  ON model_routes (workspace_id) WHERE route_scope = 'workspace' AND workspace_id IS NOT NULL AND is_default = TRUE AND is_enabled = TRUE;

ALTER TABLE workspaces ADD CONSTRAINT fk_workspaces_default_model_route
  FOREIGN KEY (default_model_route_id) REFERENCES model_routes(id) ON DELETE SET NULL;
ALTER TABLE platform_settings ADD CONSTRAINT fk_platform_settings_default_model_route
  FOREIGN KEY (default_model_route_id) REFERENCES model_routes(id) ON DELETE SET NULL;

-- ============ Model Route Grants ============
CREATE TABLE model_route_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  grant_scope VARCHAR(30) NOT NULL
    CHECK (grant_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_model_route_grants_target CHECK (
    (grant_scope = 'platform' AND workspace_id IS NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'workspace' AND workspace_id IS NOT NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'conversation' AND workspace_id IS NOT NULL AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_global' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_conversation' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (grant_scope = 'user' AND workspace_id IS NOT NULL AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_model_route_grants_route ON model_route_grants(route_id, created_at DESC);
CREATE INDEX idx_model_route_grants_workspace ON model_route_grants(workspace_id, created_at DESC);
CREATE INDEX idx_model_route_grants_conversation ON model_route_grants(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_model_route_grants_actor ON model_route_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_model_route_grants_user ON model_route_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Model Bindings ============
CREATE TABLE model_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  binding_scope VARCHAR(30) NOT NULL
    CHECK (binding_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  conversation_id UUID,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(255) NOT NULL,
  current_revision_id UUID,
  is_enabled BOOLEAN DEFAULT TRUE,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_model_bindings_target CHECK (
    (binding_scope = 'platform' AND workspace_id IS NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'workspace' AND workspace_id IS NOT NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'conversation' AND workspace_id IS NOT NULL AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'actor_global' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'actor_conversation' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (binding_scope = 'user' AND workspace_id IS NOT NULL AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_model_bindings_workspace ON model_bindings(workspace_id, created_at DESC);
CREATE INDEX idx_model_bindings_scope ON model_bindings(binding_scope, created_at DESC);
CREATE INDEX idx_model_bindings_user ON model_bindings(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_model_bindings_actor ON model_bindings(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_model_bindings_conversation ON model_bindings(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;

-- ============ Model Binding Revisions ============
CREATE TABLE model_binding_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  binding_id UUID NOT NULL REFERENCES model_bindings(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 1,
  provider_type VARCHAR(30) NOT NULL CHECK (provider_type IN ('anthropic', 'openai')),
  api_key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name VARCHAR(255) NOT NULL,
  max_tokens INT NOT NULL DEFAULT 4096,
  capability_tags TEXT[] DEFAULT '{}',
  extra_config JSONB DEFAULT '{}',
  request_timeout_ms INT,
  max_retries INT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(binding_id, version)
);

CREATE INDEX idx_model_binding_revisions_binding ON model_binding_revisions(binding_id, version DESC);

ALTER TABLE model_bindings ADD CONSTRAINT fk_model_bindings_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES model_binding_revisions(id) ON DELETE SET NULL;

-- ============ Model Binding Grants ============
CREATE TABLE model_binding_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  binding_id UUID NOT NULL REFERENCES model_bindings(id) ON DELETE CASCADE,
  grant_scope VARCHAR(30) NOT NULL
    CHECK (grant_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_model_binding_grants_target CHECK (
    (grant_scope = 'platform' AND workspace_id IS NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'workspace' AND workspace_id IS NOT NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'conversation' AND workspace_id IS NOT NULL AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_global' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_conversation' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (grant_scope = 'user' AND workspace_id IS NOT NULL AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_model_binding_grants_binding ON model_binding_grants(binding_id, created_at DESC);
CREATE INDEX idx_model_binding_grants_workspace ON model_binding_grants(workspace_id, created_at DESC);
CREATE INDEX idx_model_binding_grants_conversation ON model_binding_grants(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_model_binding_grants_actor ON model_binding_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_model_binding_grants_user ON model_binding_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Model Route Items ============
CREATE TABLE model_route_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL REFERENCES model_bindings(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  is_enabled BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(route_id, binding_id)
);

CREATE INDEX idx_model_route_items_route ON model_route_items(route_id, priority, created_at DESC);

-- ============ Actor Model Routes ============
CREATE TABLE actor_model_routes (
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (actor_id, route_id)
);

CREATE INDEX idx_actor_model_routes_actor ON actor_model_routes(actor_id);

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

ALTER TABLE model_routes ADD CONSTRAINT fk_model_routes_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE model_route_grants ADD CONSTRAINT fk_model_route_grants_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE model_bindings ADD CONSTRAINT fk_model_bindings_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE model_binding_grants ADD CONSTRAINT fk_model_binding_grants_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;

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
  event_payload JSONB DEFAULT '{}',
  event_timeline_policy VARCHAR(20)
    CHECK (event_timeline_policy IN ('none', 'all_members', 'users_only', 'actors_only', 'targeted_members')),
  event_context_policy VARCHAR(20)
    CHECK (event_context_policy IN ('none', 'shared', 'actor_private', 'targeted_members')),
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

CREATE TABLE conversation_item_context_targets (
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  target_member_id UUID NOT NULL REFERENCES conversation_members(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, target_member_id)
);

CREATE INDEX idx_conversation_item_context_targets_member
  ON conversation_item_context_targets(target_member_id, item_id);

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
  model_route_id UUID REFERENCES model_routes(id) ON DELETE SET NULL,
  model_binding_id UUID REFERENCES model_bindings(id) ON DELETE SET NULL,
  model_revision_id UUID REFERENCES model_binding_revisions(id) ON DELETE SET NULL,
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
CREATE INDEX idx_provider_steps_binding ON provider_steps(model_binding_id);
CREATE INDEX idx_provider_steps_revision ON provider_steps(model_revision_id);

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

-- ============ Memory Entries ============
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_scope VARCHAR(30) NOT NULL
    CHECK (owner_scope IN ('workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  owner_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  owner_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  category VARCHAR(30) NOT NULL
    CHECK (category IN ('fact', 'preference', 'decision', 'relationship', 'procedure', 'artifact', 'summary')),
  status VARCHAR(20) NOT NULL DEFAULT 'established'
    CHECK (status IN ('candidate', 'established', 'superseded', 'retracted')),
  stability VARCHAR(20) NOT NULL DEFAULT 'durable'
    CHECK (stability IN ('ephemeral', 'durable')),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  tags TEXT[] DEFAULT '{}',
  text_digest TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  source_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  source_tool_call_id UUID REFERENCES tool_calls(id) ON DELETE SET NULL,
  source_turn_id UUID REFERENCES turns(id) ON DELETE SET NULL,
  supersedes_memory_id UUID REFERENCES memory_entries(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (owner_scope = 'workspace' AND owner_conversation_id IS NULL AND owner_actor_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'conversation' AND owner_conversation_id IS NOT NULL AND owner_actor_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'actor_global' AND owner_actor_id IS NOT NULL AND owner_conversation_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'actor_conversation' AND owner_actor_id IS NOT NULL AND owner_conversation_id IS NOT NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'user' AND owner_user_id IS NOT NULL AND owner_actor_id IS NULL AND owner_conversation_id IS NULL)
  )
);

CREATE INDEX idx_memory_entries_workspace ON memory_entries(workspace_id, created_at DESC);
CREATE INDEX idx_memory_entries_owner_actor ON memory_entries(owner_actor_id, created_at DESC) WHERE owner_actor_id IS NOT NULL;
CREATE INDEX idx_memory_entries_owner_conversation ON memory_entries(owner_conversation_id, created_at DESC) WHERE owner_conversation_id IS NOT NULL;
CREATE INDEX idx_memory_entries_owner_user ON memory_entries(owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_memory_entries_scope_status ON memory_entries(workspace_id, owner_scope, status, stability, created_at DESC);
CREATE INDEX idx_memory_entries_tags ON memory_entries USING GIN(tags);

-- ============ Memory Entry Parts ============
CREATE TABLE memory_entry_parts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_entry_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  part_type VARCHAR(20) NOT NULL CHECK (part_type IN ('text', 'file_ref', 'json')),
  text_value TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  json_value JSONB,
  mime_type VARCHAR(255),
  name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  UNIQUE(memory_entry_id, ordinal),
  CHECK (
    (part_type = 'text' AND text_value IS NOT NULL) OR
    (part_type = 'file_ref' AND file_id IS NOT NULL) OR
    (part_type = 'json' AND json_value IS NOT NULL)
  )
);

CREATE INDEX idx_memory_entry_parts_entry ON memory_entry_parts(memory_entry_id, ordinal);

-- ============ Memory Grants ============
CREATE TABLE memory_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_entry_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  grant_scope VARCHAR(30) NOT NULL
    CHECK (grant_scope IN ('workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CHECK (
    (grant_scope = 'workspace' AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'conversation' AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_global' AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_conversation' AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (grant_scope = 'user' AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_memory_grants_entry ON memory_grants(memory_entry_id, created_at DESC);
CREATE INDEX idx_memory_grants_workspace ON memory_grants(workspace_id, created_at DESC);
CREATE INDEX idx_memory_grants_actor ON memory_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_memory_grants_conversation ON memory_grants(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_memory_grants_user ON memory_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Memory Index Chunks ============
CREATE TABLE memory_index_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_entry_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_scope VARCHAR(30) NOT NULL
    CHECK (owner_scope IN ('workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  owner_actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  owner_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  search_text TEXT NOT NULL,
  embedding VECTOR(1536),
  token_count INT DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_entry_id, chunk_index),
  CHECK (
    (owner_scope = 'workspace' AND owner_conversation_id IS NULL AND owner_actor_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'conversation' AND owner_conversation_id IS NOT NULL AND owner_actor_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'actor_global' AND owner_actor_id IS NOT NULL AND owner_conversation_id IS NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'actor_conversation' AND owner_actor_id IS NOT NULL AND owner_conversation_id IS NOT NULL AND owner_user_id IS NULL) OR
    (owner_scope = 'user' AND owner_user_id IS NOT NULL AND owner_actor_id IS NULL AND owner_conversation_id IS NULL)
  )
);

CREATE INDEX idx_memory_index_chunks_entry ON memory_index_chunks(memory_entry_id, chunk_index);
CREATE INDEX idx_memory_index_chunks_scope ON memory_index_chunks(workspace_id, owner_scope, created_at DESC);
CREATE INDEX idx_memory_index_chunks_actor ON memory_index_chunks(owner_actor_id, created_at DESC) WHERE owner_actor_id IS NOT NULL;
CREATE INDEX idx_memory_index_chunks_conversation ON memory_index_chunks(owner_conversation_id, created_at DESC) WHERE owner_conversation_id IS NOT NULL;
CREATE INDEX idx_memory_index_chunks_user ON memory_index_chunks(owner_user_id, created_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX idx_memory_index_chunks_fts ON memory_index_chunks USING GIN(to_tsvector('simple', search_text));
CREATE INDEX idx_memory_index_chunks_trgm ON memory_index_chunks USING GIN(search_text gin_trgm_ops);

-- ============ Memory Recall Runs ============
CREATE TABLE memory_recall_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recall_type VARCHAR(20) NOT NULL
    CHECK (recall_type IN ('bootstrap', 'turn_recall', 'manual_search')),
  query_text TEXT NOT NULL DEFAULT '',
  query_blocks JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_memory_recall_runs_workspace ON memory_recall_runs(workspace_id, created_at DESC);
CREATE INDEX idx_memory_recall_runs_actor ON memory_recall_runs(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_memory_recall_runs_conversation ON memory_recall_runs(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_memory_recall_runs_user ON memory_recall_runs(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Memory Recall Run Results ============
CREATE TABLE memory_recall_run_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES memory_recall_runs(id) ON DELETE CASCADE,
  memory_entry_id UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  matched_chunk_id UUID REFERENCES memory_index_chunks(id) ON DELETE SET NULL,
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
CREATE INDEX idx_memory_recall_run_results_memory ON memory_recall_run_results(memory_entry_id, created_at DESC);

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
  type VARCHAR(50) NOT NULL CHECK (type IN ('progress_check', 'priority_override')),
  content TEXT NOT NULL,
  from_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  is_consumed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_interrupts_target
  ON session_interrupts(target_session_id) WHERE is_consumed = FALSE;

-- ============ Capability Publishers ============
CREATE TABLE capability_publishers (
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

-- ============ Capability Categories ============
CREATE TABLE capability_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) NOT NULL,
  target_kind VARCHAR(30) NOT NULL
    CHECK (target_kind IN ('plugin', 'skill', 'actor_template')),
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  icon_url TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_builtin BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(target_kind, slug)
);

CREATE INDEX idx_capability_categories_kind_order ON capability_categories(target_kind, sort_order, display_name);

-- ============ Capability Packages ============
CREATE TABLE capability_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  publisher_id UUID NOT NULL REFERENCES capability_publishers(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL
    CHECK (kind IN ('plugin', 'skill', 'actor_template')),
  slug VARCHAR(100) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  long_description TEXT DEFAULT '',
  icon_url TEXT,
  source_type VARCHAR(30) NOT NULL DEFAULT 'official'
    CHECK (source_type IN ('builtin', 'official', 'workspace_upload', 'user_upload', 'relay_derived')),
  tags TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  is_builtin BOOLEAN DEFAULT FALSE,
  download_count INT DEFAULT 0,
  latest_revision_id UUID,
  default_binding_scope VARCHAR(30) NOT NULL DEFAULT 'workspace'
    CHECK (default_binding_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  default_reuse_scope VARCHAR(30) NOT NULL DEFAULT 'conversation'
    CHECK (default_reuse_scope IN ('turn', 'platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  default_idle_ttl_ms INT,
  default_max_age_ms INT,
  requires_handshake BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_capability_packages_publisher ON capability_packages(publisher_id);
CREATE INDEX idx_capability_packages_workspace ON capability_packages(workspace_id, kind, created_at DESC);
CREATE INDEX idx_capability_packages_kind ON capability_packages(kind, created_at DESC);
CREATE INDEX idx_capability_packages_tags ON capability_packages USING GIN(tags);
CREATE UNIQUE INDEX uq_capability_packages_global_slug
  ON capability_packages(publisher_id, kind, slug)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX uq_capability_packages_workspace_slug
  ON capability_packages(publisher_id, workspace_id, kind, slug)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE capability_package_categories (
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES capability_categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (package_id, category_id)
);

CREATE INDEX idx_capability_package_categories_category ON capability_package_categories(category_id, package_id);

-- ============ Capability Revisions ============
CREATE TABLE capability_package_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  version VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  manifest JSONB DEFAULT '{}',
  config_schema JSONB DEFAULT '{}',
  default_config JSONB DEFAULT '{}',
  transport VARCHAR(20)
    CHECK (transport IN ('builtin', 'stdio', 'http', 'relay', 'filesystem')),
  entry_point TEXT,
  tools_manifest JSONB DEFAULT '[]',
  validation_rules JSONB DEFAULT '[]',
  setup_steps JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(package_id, version)
);

CREATE INDEX idx_capability_package_revisions_package
  ON capability_package_revisions(package_id, created_at DESC);

ALTER TABLE capability_packages
  ADD CONSTRAINT fk_capability_packages_latest_revision
  FOREIGN KEY (latest_revision_id) REFERENCES capability_package_revisions(id) ON DELETE SET NULL;

CREATE TABLE actor_template_links (
  actor_id UUID PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,
  template_package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE RESTRICT,
  imported_revision_id UUID NOT NULL REFERENCES capability_package_revisions(id) ON DELETE RESTRICT,
  baseline_actor_version INT NOT NULL DEFAULT 1,
  sync_mode VARCHAR(30) NOT NULL DEFAULT 'notify'
    CHECK (sync_mode IN ('notify', 'manual_merge')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_actor_template_links_template ON actor_template_links(template_package_id, created_at DESC);

-- ============ Capability Assets ============
CREATE TABLE capability_assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  revision_id UUID NOT NULL REFERENCES capability_package_revisions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  asset_kind VARCHAR(30) NOT NULL
    CHECK (asset_kind IN ('skill_markdown', 'reference_markdown', 'script', 'json', 'text', 'binary')),
  media_type VARCHAR(255),
  size_bytes INT NOT NULL DEFAULT 0,
  sha256 VARCHAR(64) NOT NULL,
  text_content TEXT,
  binary_content BYTEA,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(revision_id, path),
  CHECK (
    (asset_kind IN ('skill_markdown', 'reference_markdown', 'script', 'json', 'text') AND text_content IS NOT NULL) OR
    (asset_kind = 'binary' AND binary_content IS NOT NULL)
  )
);

CREATE INDEX idx_capability_assets_revision ON capability_assets(revision_id, path);

-- ============ Capability Bindings ============
CREATE TABLE capability_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES capability_package_revisions(id) ON DELETE CASCADE,
  binding_scope VARCHAR(30) NOT NULL
    CHECK (binding_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  install_mode VARCHAR(30) NOT NULL DEFAULT 'manual'
    CHECK (install_mode IN ('manual', 'seeded', 'relay_derived', 'template_required', 'template_recommended')),
  is_enabled BOOLEAN DEFAULT TRUE,
  config_data JSONB DEFAULT '{}',
  reuse_scope VARCHAR(30) NOT NULL DEFAULT 'conversation'
    CHECK (reuse_scope IN ('turn', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  idle_ttl_ms INT,
  max_age_ms INT,
  requires_handshake BOOLEAN DEFAULT FALSE,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_capability_binding_target CHECK (
    (binding_scope = 'platform' AND workspace_id IS NULL AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'workspace' AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'conversation' AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'actor_global' AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (binding_scope = 'actor_conversation' AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (binding_scope = 'user' AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_capability_bindings_workspace ON capability_bindings(workspace_id, created_at DESC);
CREATE INDEX idx_capability_bindings_package ON capability_bindings(package_id, created_at DESC);
CREATE INDEX idx_capability_bindings_conversation ON capability_bindings(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_capability_bindings_actor ON capability_bindings(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_capability_bindings_user ON capability_bindings(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Capability Grants ============
CREATE TABLE capability_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  binding_id UUID NOT NULL REFERENCES capability_bindings(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  grant_scope VARCHAR(30) NOT NULL
    CHECK (grant_scope IN ('platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT[] DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_capability_grant_target CHECK (
    (grant_scope = 'platform' AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'workspace' AND conversation_id IS NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'conversation' AND conversation_id IS NOT NULL AND actor_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_global' AND actor_id IS NOT NULL AND conversation_id IS NULL AND user_id IS NULL) OR
    (grant_scope = 'actor_conversation' AND actor_id IS NOT NULL AND conversation_id IS NOT NULL AND user_id IS NULL) OR
    (grant_scope = 'user' AND user_id IS NOT NULL AND actor_id IS NULL AND conversation_id IS NULL)
  )
);

CREATE INDEX idx_capability_grants_binding ON capability_grants(binding_id, created_at DESC);
CREATE INDEX idx_capability_grants_workspace ON capability_grants(workspace_id, created_at DESC);
CREATE INDEX idx_capability_grants_actor ON capability_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_capability_grants_conversation ON capability_grants(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_capability_grants_user ON capability_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ============ Capability Requirements ============
CREATE TABLE capability_requirements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  revision_id UUID NOT NULL REFERENCES capability_package_revisions(id) ON DELETE CASCADE,
  requirement_kind VARCHAR(20) NOT NULL
    CHECK (requirement_kind IN ('required', 'recommended', 'optional', 'conflicts_with')),
  target_kind VARCHAR(20) NOT NULL
    CHECK (target_kind IN ('package', 'tag')),
  target_package_kind VARCHAR(30)
    CHECK (target_package_kind IS NULL OR target_package_kind IN ('plugin', 'skill', 'actor_template')),
  target_publisher_slug VARCHAR(100),
  target_package_slug VARCHAR(100),
  target_tag VARCHAR(100),
  acceptable_binding_scopes TEXT[] DEFAULT '{}',
  acceptable_reuse_scopes TEXT[] DEFAULT '{}',
  description TEXT DEFAULT '',
  config_predicate JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (target_kind = 'package' AND target_package_kind IS NOT NULL AND target_package_slug IS NOT NULL AND target_tag IS NULL) OR
    (target_kind = 'tag' AND target_tag IS NOT NULL AND target_package_kind IS NULL AND target_package_slug IS NULL)
  )
);

CREATE INDEX idx_capability_requirements_revision ON capability_requirements(revision_id, created_at);

-- ============ Capability Runtime Leases ============
CREATE TABLE capability_runtime_leases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  binding_id UUID NOT NULL REFERENCES capability_bindings(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES capability_package_revisions(id) ON DELETE CASCADE,
  reuse_scope VARCHAR(30) NOT NULL
    CHECK (reuse_scope IN ('turn', 'platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user')),
  owner_key VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closing', 'closed', 'error')),
  handshake_state VARCHAR(20) NOT NULL DEFAULT 'not_required'
    CHECK (handshake_state IN ('pending', 'ready', 'error', 'not_required')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_capability_runtime_leases_binding ON capability_runtime_leases(binding_id, created_at DESC);
CREATE INDEX idx_capability_runtime_leases_owner ON capability_runtime_leases(owner_key, created_at DESC);

-- ============ Capability Auth Connections ============
CREATE TABLE capability_auth_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  provider_key VARCHAR(100) NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_account_id VARCHAR(255),
  display_name VARCHAR(255),
  avatar_url TEXT,
  scopes TEXT[] DEFAULT '{}',
  access_token TEXT,
  refresh_token TEXT,
  token_type VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ,
  profile JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_capability_auth_connections_workspace ON capability_auth_connections(workspace_id, created_at DESC);
CREATE INDEX idx_capability_auth_connections_package_provider ON capability_auth_connections(package_id, provider_key, created_at DESC);
CREATE INDEX idx_capability_auth_connections_owner ON capability_auth_connections(owner_user_id, created_at DESC);

-- ============ Capability Auth Sessions ============
CREATE TABLE capability_auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES capability_packages(id) ON DELETE CASCADE,
  revision_id UUID REFERENCES capability_package_revisions(id) ON DELETE SET NULL,
  provider_key VARCHAR(100) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'expired', 'consumed')),
  state VARCHAR(255) NOT NULL UNIQUE,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  authorize_url TEXT,
  error_code VARCHAR(100),
  error_message TEXT,
  result_preview JSONB DEFAULT '{}',
  auth_connection_id UUID REFERENCES capability_auth_connections(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_capability_auth_sessions_workspace ON capability_auth_sessions(workspace_id, created_at DESC);
CREATE INDEX idx_capability_auth_sessions_user ON capability_auth_sessions(user_id, created_at DESC);
CREATE INDEX idx_capability_auth_sessions_package_provider ON capability_auth_sessions(package_id, provider_key, created_at DESC);

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
  FOREIGN KEY (plugin_id) REFERENCES capability_packages(id) ON DELETE SET NULL;
ALTER TABLE tool_calls ADD CONSTRAINT fk_tool_calls_relay
  FOREIGN KEY (relay_id) REFERENCES mcp_relays(id) ON DELETE SET NULL;
ALTER TABLE tool_execution_attempts ADD CONSTRAINT fk_tool_execution_attempts_plugin
  FOREIGN KEY (plugin_id) REFERENCES capability_packages(id) ON DELETE SET NULL;
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
    'users', 'workspaces', 'workspace_invites', 'actors', 'work_items',
    'standing_orders', 'platform_settings', 'model_routes', 'model_bindings', 'model_binding_revisions', 'conversations', 'sessions',
    'memory_entries', 'memory_index_chunks',
    'capability_publishers', 'capability_packages', 'capability_bindings', 'mcp_relays', 'mcp_relay_servers',
    'a2a_apps', 'agent_endpoints', 'endpoint_agents', 'conversation_bridges'
  ])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', tbl);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', tbl);
  END LOOP;
END;
$$;
