import { query } from '../../infrastructure/database/index.js';
import { encryptSensitiveFields } from '../../infrastructure/crypto/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { incrementMcpVersion } from './instance-manager.js';
import { nowISO } from '@synapse/shared';
import type { McpValidationRule } from '@synapse/shared';
import { builtinSeeds } from './builtin-plugins/index.js';

export class McpPluginError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// ============ Organizations ============

export async function createOrganization(data: {
  slug: string;
  displayName: string;
  description?: string;
  logoUrl?: string;
  isBuiltin?: boolean;
  isVerified?: boolean;
  ownerUserId?: string;
}) {
  const result = await query(
    `INSERT INTO mcp_organizations (slug, display_name, description, logo_url, is_builtin, is_verified, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.slug,
      data.displayName,
      data.description || '',
      data.logoUrl || null,
      data.isBuiltin || false,
      data.isVerified || false,
      data.ownerUserId || null,
    ]
  );
  return result.rows[0];
}

export async function listOrganizations() {
  const result = await query(
    'SELECT * FROM mcp_organizations ORDER BY is_builtin DESC, display_name',
    []
  );
  return result.rows;
}

export async function getOrganization(id: string) {
  const result = await query('SELECT * FROM mcp_organizations WHERE id = $1', [id]);
  if (result.rows.length === 0) throw new McpPluginError(404, 'Organization not found');
  return result.rows[0];
}

export async function getOrganizationBySlug(slug: string) {
  const result = await query('SELECT * FROM mcp_organizations WHERE slug = $1', [slug]);
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// ============ Plugins ============

export async function createPlugin(data: {
  orgId: string;
  slug: string;
  displayName: string;
  description?: string;
  longDescription?: string;
  iconUrl?: string;
  version?: string;
  transport: string;
  entryPoint?: string;
  lifecycleScope?: string;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  toolsManifest?: unknown[];
  tags?: string[];
  isBuiltin?: boolean;
}) {
  const result = await query(
    `INSERT INTO mcp_plugins (org_id, slug, display_name, description, long_description, icon_url,
       version, transport, entry_point, lifecycle_scope, config_schema, default_config,
       tools_manifest, tags, is_builtin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (org_id, slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       long_description = EXCLUDED.long_description,
       icon_url = EXCLUDED.icon_url,
       version = EXCLUDED.version,
       transport = EXCLUDED.transport,
       entry_point = EXCLUDED.entry_point,
       lifecycle_scope = EXCLUDED.lifecycle_scope,
       config_schema = EXCLUDED.config_schema,
       default_config = EXCLUDED.default_config,
       tools_manifest = EXCLUDED.tools_manifest,
       tags = EXCLUDED.tags,
       is_builtin = EXCLUDED.is_builtin
     RETURNING *`,
    [
      data.orgId,
      data.slug,
      data.displayName,
      data.description || '',
      data.longDescription || '',
      data.iconUrl || null,
      data.version || '1.0.0',
      data.transport,
      data.entryPoint || '',
      data.lifecycleScope || 'session',
      JSON.stringify(data.configSchema || {}),
      JSON.stringify(data.defaultConfig || {}),
      JSON.stringify(data.toolsManifest || []),
      data.tags || [],
      data.isBuiltin || false,
    ]
  );
  return result.rows[0];
}

export async function listPlugins(filters?: { orgId?: string; transport?: string; search?: string; tags?: string[] }) {
  let where = 'p.is_active = TRUE';
  const values: unknown[] = [];
  let idx = 1;

  if (filters?.orgId) { where += ` AND p.org_id = $${idx++}`; values.push(filters.orgId); }
  if (filters?.transport) { where += ` AND p.transport = $${idx++}`; values.push(filters.transport); }
  if (filters?.search) { where += ` AND (p.display_name ILIKE $${idx} OR p.description ILIKE $${idx})`; values.push(`%${filters.search}%`); idx++; }
  if (filters?.tags && filters.tags.length > 0) { where += ` AND p.tags && $${idx++}`; values.push(filters.tags); }

  const result = await query(
    `SELECT p.*, o.slug as org_slug, o.display_name as org_display_name
     FROM mcp_plugins p
     JOIN mcp_organizations o ON o.id = p.org_id
     WHERE ${where}
     ORDER BY p.is_builtin DESC, p.download_count DESC, p.display_name`,
    values
  );
  return result.rows;
}

export async function getPlugin(id: string) {
  const result = await query(
    `SELECT p.*, o.slug as org_slug, o.display_name as org_display_name
     FROM mcp_plugins p
     JOIN mcp_organizations o ON o.id = p.org_id
     WHERE p.id = $1`,
    [id]
  );
  if (result.rows.length === 0) throw new McpPluginError(404, 'Plugin not found');
  return result.rows[0];
}

// ============ Unified Installations ============

export function validateLifecycleHierarchy(scopeType: string, lifecycleScope: string): boolean {
  switch (scopeType) {
    case 'workspace': return ['workspace', 'actor', 'session'].includes(lifecycleScope);
    case 'user':      return ['user', 'actor', 'session'].includes(lifecycleScope);
    case 'actor':     return ['actor', 'session'].includes(lifecycleScope);
    default:          return false;
  }
}

export async function installPluginUnified(data: {
  workspaceId: string;
  pluginId: string;
  scopeType: string;
  scopeId: string;
  lifecycleScope?: string;
  configData?: Record<string, unknown>;
  installedBy?: string;
}) {
  const lifecycleScope = data.lifecycleScope || 'session';

  if (!validateLifecycleHierarchy(data.scopeType, lifecycleScope)) {
    throw new McpPluginError(400, `Lifecycle scope '${lifecycleScope}' is not valid for install scope '${data.scopeType}'`);
  }

  // Encrypt sensitive config
  const plugin = await getPlugin(data.pluginId);
  const encrypted = data.configData ? encryptSensitiveFields(data.configData, plugin.config_schema || {}) : {};

  const result = await query(
    `INSERT INTO mcp_installations (workspace_id, plugin_id, scope_type, scope_id, lifecycle_scope, config_data, installed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (plugin_id, scope_type, scope_id) DO UPDATE SET
       is_enabled = TRUE,
       config_data = EXCLUDED.config_data,
       lifecycle_scope = EXCLUDED.lifecycle_scope,
       installed_by = EXCLUDED.installed_by
     RETURNING *`,
    [data.workspaceId, data.pluginId, data.scopeType, data.scopeId, lifecycleScope, JSON.stringify(encrypted), data.installedBy || null]
  );

  // Increment download count
  await query('UPDATE mcp_plugins SET download_count = download_count + 1 WHERE id = $1', [data.pluginId]);

  // Notify active sessions that MCP tools have changed
  await incrementMcpVersion(data.workspaceId);

  return result.rows[0];
}

export async function uninstallPluginUnified(installId: string) {
  // Capture workspace_id before deletion for version bump
  const existing = await query('SELECT workspace_id FROM mcp_installations WHERE id = $1', [installId]);

  const result = await query(
    'DELETE FROM mcp_installations WHERE id = $1 RETURNING *',
    [installId]
  );
  if (result.rows.length === 0) throw new McpPluginError(404, 'Installation not found');

  // Notify active sessions that MCP tools have changed
  if (existing.rows[0]?.workspace_id) {
    await incrementMcpVersion(existing.rows[0].workspace_id);
  }

  return result.rows[0];
}

export async function getInstallations(workspaceId: string, filters?: { scopeType?: string; scopeId?: string; pluginId?: string }) {
  let where = 'i.workspace_id = $1';
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.scopeType) { where += ` AND i.scope_type = $${idx++}`; values.push(filters.scopeType); }
  if (filters?.scopeId) { where += ` AND i.scope_id = $${idx++}`; values.push(filters.scopeId); }
  if (filters?.pluginId) { where += ` AND i.plugin_id = $${idx++}`; values.push(filters.pluginId); }

  const result = await query(
    `SELECT i.*, p.slug as plugin_slug, p.display_name as plugin_display_name,
            p.description as plugin_description, p.transport, p.lifecycle_scope as plugin_lifecycle_scope,
            p.tools_manifest, p.icon_url as plugin_icon_url, p.version as plugin_version,
            p.config_schema, p.is_builtin,
            p.validation_rules as plugin_validation_rules, p.setup_steps as plugin_setup_steps,
            o.id as org_id, o.slug as org_slug, o.display_name as org_display_name
     FROM mcp_installations i
     JOIN mcp_plugins p ON p.id = i.plugin_id
     JOIN mcp_organizations o ON o.id = p.org_id
     WHERE ${where}
     ORDER BY i.created_at DESC`,
    values
  );
  return result.rows;
}

export async function updateInstallation(installId: string, data: { isEnabled?: boolean; configData?: Record<string, unknown>; lifecycleScope?: string }) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.isEnabled !== undefined) { sets.push(`is_enabled = $${idx++}`); values.push(data.isEnabled); }

  if (data.lifecycleScope !== undefined) {
    // Validate hierarchy before updating
    const install = await query('SELECT scope_type FROM mcp_installations WHERE id = $1', [installId]);
    if (install.rows.length > 0 && !validateLifecycleHierarchy(install.rows[0].scope_type, data.lifecycleScope)) {
      throw new McpPluginError(400, `Lifecycle scope '${data.lifecycleScope}' is not valid for install scope '${install.rows[0].scope_type}'`);
    }
    sets.push(`lifecycle_scope = $${idx++}`);
    values.push(data.lifecycleScope);
  }

  if (data.configData !== undefined) {
    const install = await query('SELECT plugin_id, workspace_id FROM mcp_installations WHERE id = $1', [installId]);
    if (install.rows.length > 0) {
      const plugin = await getPlugin(install.rows[0].plugin_id);
      const encrypted = encryptSensitiveFields(data.configData, plugin.config_schema || {});
      sets.push(`config_data = $${idx++}`);
      values.push(JSON.stringify(encrypted));
    }
  }

  if (sets.length === 0) throw new McpPluginError(400, 'No fields to update');

  values.push(installId);
  const result = await query(
    `UPDATE mcp_installations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new McpPluginError(404, 'Installation not found');

  // Bump version for any change (enable/disable, config, lifecycle scope)
  const row = result.rows[0];
  await incrementMcpVersion(row.workspace_id);

  // Emit config change event for WebSocket frontend notification (backward compat)
  if (data.configData !== undefined) {
    await emitEvent({
      type: 'mcp.config.changed',
      workspaceId: row.workspace_id,
      payload: { pluginId: row.plugin_id, workspaceId: row.workspace_id },
      timestamp: nowISO(),
    });
  }

  return result.rows[0];
}

// ============ Config Validation ============

export function validateConfig(
  config: Record<string, unknown>,
  rules: McpValidationRule[]
): { valid: boolean; errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];

  for (const rule of rules) {
    const value = config[rule.field];

    switch (rule.rule) {
      case 'required':
        if (value === undefined || value === null || value === '') {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case 'pattern':
        if (typeof value === 'string' && rule.value && !new RegExp(rule.value as string).test(value)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case 'url':
        if (typeof value === 'string' && value) {
          try { new URL(value); } catch { errors.push({ field: rule.field, message: rule.message }); }
        }
        break;
      case 'min_length':
        if (typeof value === 'string' && value.length < (rule.value as number)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case 'max_length':
        if (typeof value === 'string' && value.length > (rule.value as number)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case 'prefix':
        if (typeof value === 'string' && !value.startsWith(rule.value as string)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case 'enum':
        if (Array.isArray(rule.value) && !rule.value.includes(value as string)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============ Seed Builtin MCP Plugins ============

async function cleanOldBuiltinPlugins() {
  // Wipe all builtin installations, plugins, and orgs so seed is always fresh
  await query(`DELETE FROM mcp_installations WHERE plugin_id IN (SELECT id FROM mcp_plugins WHERE is_builtin = TRUE)`, []);
  await query(`DELETE FROM mcp_plugins WHERE is_builtin = TRUE`, []);
  await query(`DELETE FROM mcp_organizations WHERE is_builtin = TRUE`, []);
  console.log('[MCP] Cleaned old builtin data');
}

export async function seedBuiltinMcpPlugins() {
  await cleanOldBuiltinPlugins();
  for (const seed of builtinSeeds) {
    // Create or find the organization
    let org = await getOrganizationBySlug(seed.slug);
    if (!org) {
      org = await createOrganization({
        slug: seed.slug,
        displayName: seed.displayName,
        description: seed.description,
        isBuiltin: true,
        isVerified: true,
      });
      console.log(`[MCP] Created ${seed.slug} organization`);
    }

    // Seed each plugin under the org
    for (const pluginSeed of seed.plugins) {
      const plugin = await createPlugin({
        orgId: org.id,
        slug: pluginSeed.slug,
        displayName: pluginSeed.displayName,
        description: pluginSeed.description,
        longDescription: pluginSeed.longDescription,
        transport: pluginSeed.transport,
        entryPoint: pluginSeed.entryPoint,
        lifecycleScope: pluginSeed.lifecycleScope,
        tags: pluginSeed.tags,
        isBuiltin: true,
        toolsManifest: pluginSeed.toolsManifest,
        configSchema: pluginSeed.configSchema,
        defaultConfig: pluginSeed.defaultConfig,
      });

      // Update plugin-level validation rules and setup steps
      if (pluginSeed.validationRules?.length || pluginSeed.setupSteps?.length) {
        await query(
          `UPDATE mcp_plugins SET validation_rules = $1, setup_steps = $2 WHERE id = $3`,
          [
            JSON.stringify(pluginSeed.validationRules || []),
            JSON.stringify(pluginSeed.setupSteps || []),
            plugin.id,
          ]
        );
      }
    }

    console.log(`[MCP] Seeded ${seed.slug} builtin plugins (${seed.plugins.map(p => p.slug).join(', ')})`);
  }
}
