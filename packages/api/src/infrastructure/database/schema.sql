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
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actors_workspace ON actors(workspace_id);
CREATE INDEX IF NOT EXISTS idx_actors_parent ON actors(parent_id);
CREATE INDEX IF NOT EXISTS idx_actors_role ON actors(workspace_id, role);

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

-- ============ Model Group Items ============
CREATE TABLE IF NOT EXISTS model_group_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  current_config_id UUID, -- filled after first config insert
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

-- Add FK from model_group_items to model_item_configs now that both tables exist
ALTER TABLE model_group_items DROP CONSTRAINT IF EXISTS fk_current_config;
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

-- ============ AI Request Logs ============
CREATE TABLE IF NOT EXISTS ai_request_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_ai_request_logs_group ON ai_request_logs(group_id);

-- ============ Add default_model_group_id to workspaces ============
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS default_model_group_id UUID REFERENCES model_groups(id) ON DELETE SET NULL;

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
  FOR tbl IN SELECT unnest(ARRAY['users', 'workspaces', 'actors', 'work_items', 'memories', 'standing_orders', 'model_groups', 'model_group_items'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %I', tbl);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', tbl);
  END LOOP;
END;
$$;
