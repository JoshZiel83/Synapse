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
  avatar_file_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============ Auth Sessions ============
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_type VARCHAR(20) NOT NULL DEFAULT 'web'
    CHECK (client_type IN ('web', 'android', 'windows', 'ios', 'cli', 'api')),
  transport VARCHAR(20) NOT NULL DEFAULT 'cookie'
    CHECK (transport IN ('cookie', 'token')),
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
  status VARCHAR(32) NOT NULL DEFAULT 'pending_scan'
    CHECK (status IN ('pending_scan', 'pending_confirm', 'approved', 'rejected', 'expired', 'consumed')),
  browser_ip_address VARCHAR(120),
  browser_user_agent TEXT,
  browser_label VARCHAR(160) NOT NULL,
  approved_session_persistence VARCHAR(20)
    CHECK (approved_session_persistence IN ('persistent', 'temporary')),
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
  default_model_group_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
CREATE INDEX idx_workspaces_slug ON workspaces(slug);

CREATE TABLE platform_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  default_model_group_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE platform_access_bindings (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key VARCHAR(30) NOT NULL
    CHECK (access_key IN ('super_admin', 'workspace_admin', 'model_admin', 'support', 'auditor')),
  source VARCHAR(20) NOT NULL DEFAULT 'manual'
    CHECK (source IN ('config', 'manual')),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, access_key)
);

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

CREATE TABLE workspace_access_bindings (
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  access_key VARCHAR(30) NOT NULL
    CHECK (access_key IN ('model_admin', 'actor_admin', 'skill_admin', 'plugin_admin', 'memory_admin', 'relay_admin', 'conversation_admin')),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, access_key),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

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

-- ============ Conversations ============
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL
    CHECK (kind IN ('group', 'direct', 'a2a_virtual')),
  title VARCHAR(500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conversations_workspace ON conversations(workspace_id, created_at DESC);
CREATE INDEX idx_conversations_workspace_kind ON conversations(workspace_id, kind);

-- ============ Blob Storage ============
CREATE TABLE blobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  sha256 VARCHAR(64) NOT NULL,
  media_type VARCHAR(255),
  size_bytes INT NOT NULL DEFAULT 0,
  storage_backend VARCHAR(30) NOT NULL DEFAULT 'database'
    CHECK (storage_backend IN ('database', 'object_storage', 'filesystem')),
  storage_key TEXT,
  text_content TEXT,
  binary_content BYTEA,
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (text_content IS NOT NULL OR binary_content IS NOT NULL OR storage_key IS NOT NULL)
);

CREATE INDEX idx_blobs_workspace ON blobs(workspace_id, created_at DESC);
CREATE INDEX idx_blobs_sha256 ON blobs(sha256);

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
  category VARCHAR(30) DEFAULT 'general'
    CHECK (category IN ('general', 'chat_attachment', 'plugin_output', 'plugin_asset')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_files_workspace ON files(workspace_id, created_at DESC);
CREATE INDEX idx_files_uploader ON files(uploader_user_id, created_at DESC);

ALTER TABLE users
  ADD CONSTRAINT users_avatar_file_id_fkey
  FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;

-- ============ Access Core ============
CREATE TABLE access_bindings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type VARCHAR(60) NOT NULL,
  resource_id TEXT NOT NULL,
  relation VARCHAR(60) NOT NULL,
  subject_type VARCHAR(60) NOT NULL,
  subject_id TEXT NOT NULL,
  subject_relation VARCHAR(60),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_access_bindings_active
  ON access_bindings(resource_type, resource_id, relation, subject_type, subject_id, COALESCE(subject_relation, ''))
  WHERE status = 'active';
CREATE INDEX idx_access_bindings_workspace ON access_bindings(workspace_id, created_at DESC);
CREATE INDEX idx_access_bindings_resource ON access_bindings(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_access_bindings_subject ON access_bindings(subject_type, subject_id, created_at DESC);
CREATE INDEX idx_access_bindings_primary_resource
  ON access_bindings(resource_type, resource_id, created_at DESC)
  WHERE status = 'active'
    AND COALESCE((metadata->>'isPrimary')::boolean, FALSE) = TRUE;

CREATE TABLE authz_outbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation VARCHAR(10) NOT NULL CHECK (operation IN ('touch', 'delete')),
  resource_type VARCHAR(60) NOT NULL,
  resource_id TEXT NOT NULL,
  relation VARCHAR(60) NOT NULL,
  subject_type VARCHAR(60) NOT NULL,
  subject_id TEXT NOT NULL,
  subject_relation VARCHAR(60),
  metadata JSONB DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'applied', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  zed_token TEXT,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_authz_outbox_status ON authz_outbox(status, created_at);
CREATE INDEX idx_authz_outbox_resource ON authz_outbox(resource_type, resource_id, created_at DESC);

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
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE catalog_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug VARCHAR(100) NOT NULL,
  item_kind VARCHAR(30) NOT NULL
    CHECK (item_kind IN ('actor_template', 'skill_package', 'plugin_package')),
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
  item_kind VARCHAR(30) NOT NULL
    CHECK (item_kind IN ('actor_template', 'skill_package', 'plugin_package')),
  slug VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  summary TEXT DEFAULT '',
  long_description TEXT DEFAULT '',
  icon_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  source_kind VARCHAR(30) NOT NULL DEFAULT 'official'
    CHECK (source_kind IN ('builtin', 'official', 'workspace', 'user', 'relay')),
  visibility VARCHAR(20) NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'workspace', 'private')),
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
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  changelog TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(catalog_item_id, version)
);

CREATE INDEX idx_catalog_versions_item ON catalog_versions(catalog_item_id, created_at DESC);

ALTER TABLE catalog_items
  ADD CONSTRAINT fk_catalog_items_latest_version
  FOREIGN KEY (latest_version_id) REFERENCES catalog_versions(id) ON DELETE SET NULL;

CREATE TABLE catalog_lineages (
  downstream_item_id UUID PRIMARY KEY REFERENCES catalog_items(id) ON DELETE CASCADE,
  upstream_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE RESTRICT,
  upstream_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  lineage_kind VARCHAR(30) NOT NULL DEFAULT 'installed_copy'
    CHECK (lineage_kind IN ('installed_copy', 'fork', 'share', 'relay_projection')),
  sync_mode VARCHAR(30) NOT NULL DEFAULT 'manual_merge'
    CHECK (sync_mode IN ('notify', 'manual_merge', 'follow_upstream', 'detached')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (downstream_item_id <> upstream_item_id)
);

CREATE TABLE catalog_version_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  catalog_version_id UUID NOT NULL REFERENCES catalog_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  file_role VARCHAR(20) NOT NULL
    CHECK (file_role IN ('document', 'reference', 'script', 'image', 'json', 'binary')),
  media_type VARCHAR(255),
  blob_id UUID REFERENCES blobs(id) ON DELETE SET NULL,
  text_content TEXT,
  content_blocks JSONB DEFAULT '[]',
  sha256 VARCHAR(64) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(catalog_version_id, path),
  CHECK (blob_id IS NOT NULL OR text_content IS NOT NULL)
);

CREATE INDEX idx_catalog_version_files_version ON catalog_version_files(catalog_version_id, path);

-- ============ Catalog Specs ============
CREATE TABLE actor_template_version_specs (
  catalog_version_id UUID PRIMARY KEY REFERENCES catalog_versions(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL
    CHECK (role IN ('secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant')),
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
  canonical_slug VARCHAR(120) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description_blocks JSONB NOT NULL DEFAULT '[]',
  summary_text TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE plugin_package_version_specs (
  catalog_version_id UUID PRIMARY KEY REFERENCES catalog_versions(id) ON DELETE CASCADE,
  transport VARCHAR(20) NOT NULL
    CHECK (transport IN ('builtin', 'stdio', 'http', 'relay')),
  entry_point TEXT,
  tool_manifest JSONB NOT NULL DEFAULT '[]',
  config_schema JSONB NOT NULL DEFAULT '{}',
  default_config JSONB NOT NULL DEFAULT '{}',
  install_flow JSONB NOT NULL DEFAULT '{}',
  auth_bindings JSONB NOT NULL DEFAULT '[]',
  default_mount_scope VARCHAR(20) NOT NULL DEFAULT 'workspace'
    CHECK (default_mount_scope IN ('workspace', 'conversation', 'actor', 'actor_conversation', 'user')),
  default_reuse_scope VARCHAR(20) NOT NULL DEFAULT 'conversation'
    CHECK (default_reuse_scope IN ('turn', 'workspace', 'conversation', 'actor', 'actor_conversation', 'user')),
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
  role VARCHAR(50) NOT NULL
    CHECK (role IN ('secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant')),
  title VARCHAR(255) NOT NULL,
  avatar_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  avatar_emoji VARCHAR(32),
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  specialties TEXT[] DEFAULT '{}',
  config JSONB DEFAULT '{}',
  current_version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (avatar_file_id IS NULL OR avatar_emoji IS NULL)
);

CREATE INDEX idx_actors_workspace ON actors(workspace_id, created_at DESC);
CREATE INDEX idx_actors_parent ON actors(parent_id);

CREATE TABLE workspace_user_preferences (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chief_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_user_preferences_actor ON workspace_user_preferences(chief_actor_id);

CREATE TABLE actor_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  version INT NOT NULL,
  previous_version_id UUID REFERENCES actor_versions(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  parent_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  can_represent_user BOOLEAN NOT NULL DEFAULT FALSE,
  specialties TEXT[] DEFAULT '{}',
  config JSONB DEFAULT '{}',
  version_delta JSONB,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source_type VARCHAR(20) NOT NULL DEFAULT 'system'
    CHECK (source_type IN ('user', 'actor', 'system', 'sync')),
  source_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
  visibility VARCHAR(20) NOT NULL DEFAULT 'always'
    CHECK (visibility IN ('always', 'solo_only', 'group_only', 'internal_only')),
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
  sync_mode VARCHAR(30) NOT NULL DEFAULT 'notify'
    CHECK (sync_mode IN ('notify', 'manual_merge', 'follow_upstream', 'detached')),
  baseline_actor_version INT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Model Routing ============
CREATE TABLE model_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type VARCHAR(20) NOT NULL
    CHECK (owner_type IN ('platform', 'workspace', 'user')),
  owner_workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
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
  CHECK (
    (owner_type = 'platform' AND owner_workspace_id IS NULL AND owner_user_id IS NULL) OR
    (owner_type = 'workspace' AND owner_workspace_id IS NOT NULL AND owner_user_id IS NULL) OR
    (owner_type = 'user' AND owner_workspace_id IS NULL AND owner_user_id IS NOT NULL)
  )
);

CREATE INDEX idx_model_groups_owner_workspace ON model_groups(owner_workspace_id, created_at DESC);
CREATE INDEX idx_model_groups_owner_user ON model_groups(owner_user_id, created_at DESC);
CREATE UNIQUE INDEX idx_model_groups_default_platform
  ON model_groups ((1)) WHERE owner_type = 'platform' AND is_default = TRUE AND is_enabled = TRUE;
CREATE UNIQUE INDEX idx_model_groups_default_workspace
  ON model_groups (owner_workspace_id) WHERE owner_type = 'workspace' AND owner_workspace_id IS NOT NULL AND is_default = TRUE AND is_enabled = TRUE;
CREATE UNIQUE INDEX idx_model_groups_default_user
  ON model_groups (owner_user_id) WHERE owner_type = 'user' AND owner_user_id IS NOT NULL AND is_default = TRUE AND is_enabled = TRUE;

ALTER TABLE workspaces ADD CONSTRAINT fk_workspaces_default_model_group
  FOREIGN KEY (default_model_group_id) REFERENCES model_groups(id) ON DELETE SET NULL;
ALTER TABLE platform_settings ADD CONSTRAINT fk_platform_settings_default_model_group
  FOREIGN KEY (default_model_group_id) REFERENCES model_groups(id) ON DELETE SET NULL;

CREATE TABLE model_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  display_name VARCHAR(255) NOT NULL,
  current_revision_id UUID,
  is_enabled BOOLEAN DEFAULT TRUE,
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
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
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, version)
);

CREATE INDEX idx_model_profile_revisions_profile ON model_profile_revisions(profile_id, version DESC);

ALTER TABLE model_profiles ADD CONSTRAINT fk_model_profiles_current_revision
  FOREIGN KEY (current_revision_id) REFERENCES model_profile_revisions(id) ON DELETE SET NULL;

CREATE TABLE model_group_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  grant_scope VARCHAR(30) NOT NULL
    CHECK (grant_scope IN ('platform', 'workspace', 'user', 'workspace_user', 'actor')),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_model_group_grants_target CHECK (
    (grant_scope = 'platform' AND workspace_id IS NULL AND user_id IS NULL AND actor_id IS NULL) OR
    (grant_scope = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL AND actor_id IS NULL) OR
    (grant_scope = 'user' AND workspace_id IS NULL AND user_id IS NOT NULL AND actor_id IS NULL) OR
    (grant_scope = 'workspace_user' AND workspace_id IS NOT NULL AND user_id IS NOT NULL AND actor_id IS NULL) OR
    (grant_scope = 'actor' AND workspace_id IS NOT NULL AND actor_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX idx_model_group_grants_group ON model_group_grants(group_id, created_at DESC);
CREATE INDEX idx_model_group_grants_workspace ON model_group_grants(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX idx_model_group_grants_actor ON model_group_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_model_group_grants_user ON model_group_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;

CREATE TABLE model_group_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES model_groups(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  weight INT NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 1000),
  is_enabled BOOLEAN DEFAULT TRUE,
  metadata JSONB DEFAULT '{}',
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
  channel_type VARCHAR(30) NOT NULL DEFAULT 'web'
    CHECK (channel_type IN ('web', 'api', 'bridge')),
  trigger VARCHAR(50) NOT NULL DEFAULT 'user_message',
  status VARCHAR(20) NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'queued', 'running', 'blocked', 'closed')),
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

CREATE TABLE conversation_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_type VARCHAR(20) NOT NULL
    CHECK (member_type IN ('actor', 'user', 'external', 'remote_agent', 'system')),
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  actor_join_version_id UUID REFERENCES actor_versions(id) ON DELETE SET NULL,
  display_name VARCHAR(255),
  state VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'left', 'kicked')),
  metadata JSONB DEFAULT '{}',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  CHECK (
    (member_type = 'actor' AND actor_id IS NOT NULL AND user_id IS NULL) OR
    (member_type = 'user' AND actor_id IS NULL AND user_id IS NOT NULL) OR
    (member_type IN ('external', 'remote_agent', 'system') AND actor_id IS NULL AND user_id IS NULL)
  )
);

CREATE INDEX idx_conversation_members_conversation ON conversation_members(conversation_id, state);
CREATE INDEX idx_conversation_members_actor ON conversation_members(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_actor
  ON conversation_members(conversation_id, actor_id) WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX idx_conversation_members_unique_user
  ON conversation_members(conversation_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE transport_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transport_kind VARCHAR(20) NOT NULL
    CHECK (transport_kind IN ('feishu', 'weixin')),
  account_key VARCHAR(120) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  owner_scope VARCHAR(30) NOT NULL DEFAULT 'workspace'
    CHECK (owner_scope IN ('workspace', 'workspace_user')),
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  inbound_actor_mode VARCHAR(40) NOT NULL DEFAULT 'none'
    CHECK (inbound_actor_mode IN ('none', 'specified_actor', 'follow_owner_chief_actor')),
  inbound_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  connection_mode VARCHAR(30) NOT NULL
    CHECK (connection_mode IN ('webhook', 'long_connection')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  credentials JSONB NOT NULL DEFAULT '{}',
  config JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (owner_scope = 'workspace' AND owner_user_id IS NULL) OR
    (owner_scope = 'workspace_user' AND owner_user_id IS NOT NULL)
  ),
  CHECK (
    owner_scope = 'workspace_user' OR
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
CREATE INDEX idx_transport_accounts_owner_user
  ON transport_accounts(owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE TABLE transport_endpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  endpoint_type VARCHAR(20) NOT NULL
    CHECK (endpoint_type IN ('direct', 'group')),
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
  inbound_actor_mode VARCHAR(40) NOT NULL DEFAULT 'inherit_account'
    CHECK (inbound_actor_mode IN ('inherit_account', 'none', 'specified_actor')),
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
  transport_kind VARCHAR(20) NOT NULL
    CHECK (transport_kind IN ('feishu', 'weixin')),
  address_type VARCHAR(20) NOT NULL DEFAULT 'user'
    CHECK (address_type IN ('user', 'bot', 'system')),
  external_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(transport_account_id, address_type, external_id)
);

CREATE INDEX idx_transport_addresses_workspace
  ON transport_addresses(workspace_id, transport_kind, created_at DESC);
CREATE INDEX idx_transport_addresses_user
  ON transport_addresses(user_id, transport_kind, created_at DESC)
  WHERE user_id IS NOT NULL;

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
  permission VARCHAR(30) NOT NULL
    CHECK (permission IN ('send', 'moderate', 'manage', 'manage_members', 'attach_resources')),
  subject_type VARCHAR(20) NOT NULL
    CHECK (subject_type IN ('user', 'actor')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT chk_conversation_grants_target CHECK (
    (subject_type = 'user' AND user_id IS NOT NULL AND actor_id IS NULL) OR
    (subject_type = 'actor' AND actor_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX idx_conversation_grants_conversation ON conversation_grants(conversation_id, created_at DESC);
CREATE INDEX idx_conversation_grants_workspace ON conversation_grants(workspace_id, created_at DESC);
CREATE INDEX idx_conversation_grants_user ON conversation_grants(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_conversation_grants_actor ON conversation_grants(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

CREATE TABLE conversation_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id UUID,
  client_message_id UUID,
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

CREATE TABLE conversation_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_sequence BIGINT NOT NULL DEFAULT 0,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE TABLE realtime_feed_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  workspace_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  conversation_sequence BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_realtime_feed_events_item_unique ON realtime_feed_events(item_id);
CREATE UNIQUE INDEX idx_realtime_feed_events_workspace_sequence_unique
  ON realtime_feed_events(workspace_id, workspace_sequence);
CREATE INDEX idx_realtime_feed_events_workspace_created
  ON realtime_feed_events(workspace_id, workspace_sequence DESC);
CREATE INDEX idx_realtime_feed_events_conversation_created
  ON realtime_feed_events(conversation_id, conversation_sequence DESC);

CREATE TABLE transport_message_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES conversation_items(id) ON DELETE CASCADE,
  transport_account_id UUID NOT NULL REFERENCES transport_accounts(id) ON DELETE CASCADE,
  transport_endpoint_id UUID NOT NULL REFERENCES transport_endpoints(id) ON DELETE CASCADE,
  transport_kind VARCHAR(20) NOT NULL
    CHECK (transport_kind IN ('feishu', 'weixin')),
  direction VARCHAR(20) NOT NULL
    CHECK (direction IN ('inbound', 'outbound')),
  delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped')),
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
  provider_type VARCHAR(64) NOT NULL CHECK (provider_type ~ '^[a-z][a-z0-9_-]*$'),
  request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('actor_think', 'ai_complete')),
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
  status VARCHAR(20) NOT NULL DEFAULT 'success'
    CHECK (status IN ('success', 'error', 'timeout')),
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

CREATE TABLE session_wakeups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id UUID,
  source_type VARCHAR(50) NOT NULL
    CHECK (source_type IN ('user_message', 'actor_message', 'broadcast', 'invite', 'api_call', 'automation', 'system_interrupt', 'retry')),
  source_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  source_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  source_member_type VARCHAR(20)
    CHECK (source_member_type IN ('user', 'actor', 'external', 'system')),
  source_member_id UUID,
  source_name VARCHAR(255),
  summary TEXT NOT NULL,
  reason_text TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'attached', 'processed', 'dropped')),
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
  category VARCHAR(30) NOT NULL
    CHECK (category IN ('schedule', 'event_subscription')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'archived', 'completed', 'expired')),
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_kind VARCHAR(20) NOT NULL
    CHECK (created_by_kind IN ('user', 'session', 'system')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
  completion_status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (completion_status IN ('completed', 'archived')),
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
  provider_kind VARCHAR(20) NOT NULL
    CHECK (provider_kind IN ('relay', 'webhook', 'internal', 'integration')),
  provider_ref TEXT,
  webhook_endpoint_id UUID,
  integration_installation_id UUID,
  integration_provider VARCHAR(20)
    CHECK (integration_provider IS NULL OR integration_provider IN ('github', 'gitlab')),
  integration_ingress_kind VARCHAR(20)
    CHECK (integration_ingress_kind IS NULL OR integration_ingress_kind IN ('webhook', 'polling')),
  integration_target_kind VARCHAR(20)
    CHECK (integration_target_kind IS NULL OR integration_target_kind IN ('repository', 'project')),
  integration_target_id TEXT,
  integration_target_label VARCHAR(255),
  external_subscription_id VARCHAR(255),
  source_key VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  recommended_usage TEXT NOT NULL DEFAULT '',
  payload_schema JSONB NOT NULL DEFAULT '{}',
  example_payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deprecated', 'disabled', 'archived')),
  created_by_kind VARCHAR(20) NOT NULL
    CHECK (created_by_kind IN ('user', 'session', 'system')),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  created_by_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  last_triggered_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (
    (
      provider_kind = 'integration' AND
      integration_installation_id IS NOT NULL AND
      integration_provider IS NOT NULL AND
      integration_ingress_kind IS NOT NULL AND
      integration_target_kind IS NOT NULL AND
      integration_target_id IS NOT NULL AND
      integration_target_label IS NOT NULL
    ) OR (
      provider_kind <> 'integration' AND
      integration_installation_id IS NULL AND
      integration_provider IS NULL AND
      integration_ingress_kind IS NULL AND
      integration_target_kind IS NULL AND
      integration_target_id IS NULL AND
      integration_target_label IS NULL AND
      external_subscription_id IS NULL
    )
  ),
  CHECK (
    (
      provider_kind = 'integration' AND
      integration_ingress_kind = 'webhook' AND
      webhook_endpoint_id IS NOT NULL
    ) OR (
      provider_kind = 'integration' AND
      integration_ingress_kind = 'polling' AND
      webhook_endpoint_id IS NULL
    ) OR (
      provider_kind = 'webhook' AND
      webhook_endpoint_id IS NOT NULL
    ) OR (
      provider_kind IN ('relay', 'internal') AND
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
    integration_installation_id,
    integration_provider,
    integration_target_kind,
    integration_target_id,
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
CREATE INDEX idx_automation_event_sources_integration_installation
  ON automation_event_sources(integration_installation_id, created_at DESC)
  WHERE integration_installation_id IS NOT NULL;

CREATE TABLE automation_triggers (
  rule_id UUID PRIMARY KEY REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_kind VARCHAR(20) NOT NULL
    CHECK (trigger_kind IN ('schedule', 'event')),
  source_kind VARCHAR(20) NOT NULL
    CHECK (source_kind IN ('clock', 'relay', 'webhook', 'internal', 'integration')),
  event_source_id UUID REFERENCES automation_event_sources(id) ON DELETE RESTRICT,
  source_locator TEXT,
  match_key VARCHAR(255),
  matcher JSONB NOT NULL DEFAULT '{}',
  schedule_kind VARCHAR(20)
    CHECK (schedule_kind IN ('cron', 'at', 'interval')),
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
  delivery_mode VARCHAR(40) NOT NULL
    CHECK (delivery_mode IN ('wake_session', 'conversation_notice', 'create_conversation_once', 'create_conversation_each_time')),
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  reused_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  conversation_title VARCHAR(500),
  message_text TEXT NOT NULL DEFAULT '',
  wake_reason_text TEXT,
  message_blocks JSONB NOT NULL DEFAULT '[]',
  target_policy VARCHAR(20) NOT NULL DEFAULT 'all_members'
    CHECK (target_policy IN ('all_members', 'specified_members')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE automation_delivery_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_kind VARCHAR(20) NOT NULL CHECK (entity_kind IN ('actor', 'user')),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(rule_id, entity_kind, entity_id)
);

CREATE INDEX idx_automation_delivery_participants_rule
  ON automation_delivery_participants(rule_id, created_at);

CREATE TABLE automation_delivery_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  entity_kind VARCHAR(20) NOT NULL CHECK (entity_kind IN ('actor', 'user')),
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
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'archived')),
  path_token VARCHAR(64) UNIQUE NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_hint VARCHAR(16) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
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
  source_kind VARCHAR(20) NOT NULL
    CHECK (source_kind IN ('clock', 'relay', 'webhook', 'internal', 'integration')),
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
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
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
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_item_id UUID REFERENCES conversation_items(id) ON DELETE SET NULL,
  wakeup_id UUID REFERENCES session_wakeups(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
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
  source_item_id UUID,
  source_tool_call_id UUID,
  source_turn_id UUID,
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

-- ============ Context Runtime ============
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
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'archived')),
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
  checkpoint_kind VARCHAR(20) NOT NULL DEFAULT 'snapshot'
    CHECK (checkpoint_kind IN ('snapshot', 'compaction')),
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
  type VARCHAR(50) NOT NULL CHECK (type IN ('progress_check', 'priority_override')),
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
  source VARCHAR(30) NOT NULL CHECK (source IN ('conversation', 'provider', 'tool', 'relay', 'a2a', 'system')),
  level VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
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
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, slug)
);

CREATE INDEX idx_installed_skills_workspace ON installed_skills(workspace_id, created_at DESC);

CREATE TABLE skill_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  skill_id UUID NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
  version INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description_blocks JSONB NOT NULL DEFAULT '[]',
  summary_text TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_id, version)
);

CREATE TABLE skill_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  skill_version_id UUID NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  media_type VARCHAR(255),
  blob_id UUID REFERENCES blobs(id) ON DELETE SET NULL,
  text_content TEXT,
  content_blocks JSONB NOT NULL DEFAULT '[]',
  sha256 VARCHAR(64) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_version_id, path),
  CHECK (blob_id IS NOT NULL OR text_content IS NOT NULL)
);

CREATE TABLE skill_source_refs (
  skill_id UUID PRIMARY KEY REFERENCES installed_skills(id) ON DELETE CASCADE,
  source_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  source_catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  sync_mode VARCHAR(30) NOT NULL DEFAULT 'manual_merge'
    CHECK (sync_mode IN ('notify', 'manual_merge', 'follow_upstream', 'detached')),
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
  config_data JSONB NOT NULL DEFAULT '{}',
  approved_runtime_permissions TEXT[] DEFAULT '{}',
  reuse_scope VARCHAR(20) NOT NULL DEFAULT 'conversation'
    CHECK (reuse_scope IN ('turn', 'workspace', 'conversation', 'actor', 'actor_conversation', 'user')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error', 'archived')),
  installed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_installations_workspace ON plugin_installations(workspace_id, created_at DESC);
CREATE INDEX idx_plugin_installations_item ON plugin_installations(catalog_item_id, created_at DESC);

ALTER TABLE automation_event_sources
  ADD CONSTRAINT fk_automation_event_sources_integration_installation
  FOREIGN KEY (integration_installation_id)
  REFERENCES plugin_installations(id)
  ON DELETE CASCADE;

CREATE TABLE plugin_auth_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  installation_id UUID REFERENCES plugin_installations(id) ON DELETE CASCADE,
  binding_key VARCHAR(100) NOT NULL,
  driver VARCHAR(100) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'expired', 'consumed')),
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
CREATE INDEX idx_plugin_auth_sessions_user ON plugin_auth_sessions(user_id, created_at DESC);

CREATE TABLE plugin_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_scope VARCHAR(20) NOT NULL DEFAULT 'installation'
    CHECK (owner_scope IN ('installation', 'user', 'workspace')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  binding_key VARCHAR(100) NOT NULL,
  driver VARCHAR(100) NOT NULL,
  external_account_id VARCHAR(255),
  display_name VARCHAR(255),
  avatar_url TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ,
  public_payload JSONB DEFAULT '{}',
  secret_payload JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_plugin_connections_installation ON plugin_connections(installation_id, created_at DESC);
CREATE INDEX idx_plugin_connections_binding ON plugin_connections(binding_key, created_at DESC);

CREATE TABLE plugin_runtime_leases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  installation_id UUID NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  access_binding_id UUID REFERENCES access_bindings(id) ON DELETE SET NULL,
  reuse_scope VARCHAR(20) NOT NULL
    CHECK (reuse_scope IN ('turn', 'workspace', 'conversation', 'actor', 'actor_conversation', 'user')),
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

CREATE INDEX idx_plugin_runtime_leases_installation ON plugin_runtime_leases(installation_id, created_at DESC);
CREATE INDEX idx_plugin_runtime_leases_owner ON plugin_runtime_leases(owner_key, created_at DESC);

CREATE TABLE plugin_source_refs (
  installation_id UUID PRIMARY KEY REFERENCES plugin_installations(id) ON DELETE CASCADE,
  source_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  source_catalog_version_id UUID REFERENCES catalog_versions(id) ON DELETE SET NULL,
  sync_mode VARCHAR(30) NOT NULL DEFAULT 'manual_merge'
    CHECK (sync_mode IN ('notify', 'manual_merge', 'follow_upstream', 'detached')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ Relay Runtime ============
CREATE TABLE relay_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  display_name VARCHAR(255) NOT NULL,
  client_kind VARCHAR(40) NOT NULL DEFAULT 'desktop',
  platform VARCHAR(40),
  public_key TEXT NOT NULL,
  public_key_fingerprint VARCHAR(128) NOT NULL UNIQUE,
  trust_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (trust_status IN ('pending', 'active', 'revoked', 'blocked')),
  last_seen_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_catalog_changed_at TIMESTAMPTZ,
  automation_lifecycle_state VARCHAR(20)
    CHECK (automation_lifecycle_state IN ('online', 'offline')),
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
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES relay_devices(id) ON DELETE SET NULL,
  server_base_url TEXT NOT NULL,
  requested_display_name VARCHAR(255),
  pairing_code VARCHAR(32) NOT NULL UNIQUE,
  verification_uri TEXT NOT NULL,
  verification_uri_complete TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'consumed', 'expired', 'cancelled', 'rejected')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE relay_device_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  protocol_version INT NOT NULL DEFAULT 2,
  client_version VARCHAR(64),
  status VARCHAR(20) NOT NULL DEFAULT 'connecting'
    CHECK (status IN ('connecting', 'active', 'closing', 'closed', 'rejected')),
  transport VARCHAR(20) NOT NULL DEFAULT 'websocket'
    CHECK (transport IN ('websocket')),
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
  source_kind VARCHAR(30) NOT NULL
    CHECK (source_kind IN ('manual', 'claude_code', 'claude_desktop', 'codex', 'gemini', 'opencode', 'custom')),
  source_key VARCHAR(255) NOT NULL,
  config_path TEXT,
  sync_mode VARCHAR(20) NOT NULL DEFAULT 'follow'
    CHECK (sync_mode IN ('snapshot', 'follow')),
  status VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'idle', 'syncing', 'error', 'disabled')),
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
  transport VARCHAR(20) NOT NULL
    CHECK (transport IN ('builtin', 'stdio', 'http', 'sse', 'custom')),
  runtime_status VARCHAR(20) NOT NULL DEFAULT 'discovered'
    CHECK (runtime_status IN ('discovered', 'starting', 'healthy', 'degraded', 'failed', 'quarantined', 'offline')),
  projected_catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  last_healthy_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(device_id, stable_key)
);

CREATE TABLE relay_catalog_revisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  revision_seq BIGINT NOT NULL,
  schema_hash VARCHAR(128) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded')),
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
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
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
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  catalog_revision_id UUID NOT NULL REFERENCES relay_catalog_revisions(id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES relay_tools(id) ON DELETE CASCADE,
  tool_revision_id UUID NOT NULL REFERENCES relay_tool_revisions(id) ON DELETE CASCADE,
  visible_tool_name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'dispatched', 'received', 'started', 'completed', 'failed', 'aborted', 'expired')),
  input_payload JSONB NOT NULL DEFAULT '{}',
  input_hash VARCHAR(128) NOT NULL,
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
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'acked', 'nacked', 'timed_out', 'cancelled')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
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

CREATE TABLE interaction_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  conversation_item_id UUID UNIQUE REFERENCES conversation_items(id) ON DELETE SET NULL,
  requester_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  requester_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requester_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
  kind VARCHAR(40) NOT NULL
    CHECK (kind IN ('question_choice', 'relay_authorization')),
  status VARCHAR(40) NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'answered',
        'approved_pending_apply',
        'applied',
        'rejected',
        'expired',
        'apply_failed'
      )
    ),
  target_member_id UUID REFERENCES conversation_members(id) ON DELETE RESTRICT,
  target_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  resolved_by_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT interaction_requests_target_requirement_chk CHECK (
    (
      kind = 'question_choice'
      AND target_member_id IS NOT NULL
      AND target_user_id IS NOT NULL
    )
    OR (
      kind = 'relay_authorization'
      AND target_member_id IS NULL
      AND target_user_id IS NULL
    )
  )
);

CREATE TABLE interaction_question_requests (
  interaction_id UUID PRIMARY KEY REFERENCES interaction_requests(id) ON DELETE CASCADE,
  prompt_payload JSONB NOT NULL DEFAULT '{}',
  resolution_payload JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE interaction_relay_authorization_requests (
  interaction_id UUID PRIMARY KEY REFERENCES interaction_requests(id) ON DELETE CASCADE,
  relay_device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  relay_exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
  requested_effect JSONB NOT NULL DEFAULT '{}',
  resolution_payload JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_interaction_requests_conversation
  ON interaction_requests(conversation_id, created_at DESC);
CREATE INDEX idx_interaction_requests_target
  ON interaction_requests(target_user_id, status, created_at DESC);
CREATE INDEX idx_interaction_relay_authorization_requests_device
  ON interaction_relay_authorization_requests(relay_device_id, interaction_id);
