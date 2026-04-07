# Catalog / Runtime Rebuild

This refactor rebuilds the backend around four layers instead of continuing the old `capability_*` abstraction.

## Layers

### 1. Catalog Core

Shared marketplace metadata for publishable assets:

- `publishers`
- `catalog_items`
- `catalog_versions`
- `catalog_lineages`
- `catalog_version_files`
- `blobs`

Item kinds are explicit:

- `actor_template`
- `skill_package`
- `plugin_package`

### 2. Domain Runtime

Runtime entities are no longer modeled as generic capability instances.

Actor runtime:

- `actors`
- `actor_versions`
- `actor_version_docs`
- `actor_source_refs`

Skill runtime:

- `installed_skills`
- `skill_versions`
- `skill_files`
- `skill_source_refs`
- `access_bindings` for `installed_skill.use_*`

Plugin runtime:

- `plugin_installations`
- `plugin_connections`
- `plugin_runtime_leases`
- `plugin_source_refs`
- `access_bindings` for `plugin_installation.use_*`

Relay runtime:

- `relay_devices`
- `relay_pairing_sessions`
- `relay_device_sessions`
- `relay_sync_sources`
- `relay_exposures`
- `relay_catalog_revisions`
- `relay_tools`
- `relay_tool_revisions`
- `relay_operations`
- `relay_operation_deliveries`
- `relay_operation_results`

### 3. Access Core

Authorization is shared by mechanism, not by reusing one domain's grant table.

- `resource_access_bindings` is the generic audit/share table
- access subjects are explicit per runtime object:
  - `workspace`
  - `conversation`
  - `actor`
  - `conversation_actor_context`

Workspace-level administration is split instead of hiding behind `capability_admin`:

- `skill_admin`
- `plugin_admin`

## Current Boot Surface

The API boots the modules that already fit the rebuilt schema:

- `auth`
- `workspace`
- `organization`
- `skills`
- `mcp-plugins`
- `platform`

## Migration Rule

When migrating a feature:

1. Move marketplace reads/writes to `catalog_*`.
2. Move runtime state to the domain-specific runtime tables.
3. Write explicit Postgres access rows for the runtime resource type.
4. Do not recreate generic `capability_instance` semantics under a new name.
