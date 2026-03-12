import { nowISO } from '@synapse/shared';
import type {
  CapabilityBindingScope,
  CapabilityReuseScope,
  McpSetupStep,
  McpValidationRule,
} from '@synapse/shared';
import { encryptSensitiveFields } from '../../infrastructure/crypto/index.js';
import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import {
  buildCapabilityGrantPlan,
  CapabilityError,
  createCapabilityBinding,
  ensureDefaultCapabilityGrant,
  createCapabilityPackage,
  createCapabilityPublisher,
  createCapabilityRevision,
  deleteCapabilityBinding,
  evaluateCapabilityRequirements,
  getCapabilityPackage,
  getCapabilityPublisher,
  listCapabilityBindings,
  listCapabilityPackages,
  listCapabilityPublishers,
  updateCapabilityBinding,
} from '../capabilities/service.js';
import { incrementMcpVersion } from './instance-manager.js';
import { builtinSeeds } from './builtin-plugins/index.js';

export class McpPluginError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function wrapCapabilityError(error: unknown): never {
  if (error instanceof CapabilityError) {
    throw new McpPluginError(error.statusCode, error.message);
  }
  throw error;
}

function mapPackageToPluginView(pkg: any) {
  const revision = pkg.latestRevision || {};
  return {
    id: pkg.id,
    org_id: pkg.publisherId,
    slug: pkg.slug,
    display_name: pkg.displayName,
    description: pkg.description,
    long_description: pkg.longDescription,
    icon_url: pkg.iconUrl || null,
    version: revision.version || '1.0.0',
    transport: revision.transport || 'builtin',
    entry_point: revision.entryPoint || '',
    lifecycle_scope: pkg.defaultReuseScope,
    default_binding_scope: pkg.defaultBindingScope,
    config_schema: revision.configSchema || {},
    default_config: revision.defaultConfig || {},
    tools_manifest: revision.toolsManifest || [],
    validation_rules: revision.validationRules || [],
    setup_steps: revision.setupSteps || [],
    authorization: revision.authorization || { requiredPermissions: [] },
    tags: pkg.tags || [],
    is_active: pkg.isActive,
    is_builtin: pkg.isBuiltin,
    download_count: pkg.downloadCount || 0,
    created_at: pkg.createdAt,
    updated_at: pkg.updatedAt,
    org_slug: pkg.publisher?.slug,
    org_display_name: pkg.publisher?.displayName,
  };
}

function mapBindingToInstallationView(binding: any) {
  const plugin: any = binding.package ? mapPackageToPluginView(binding.package) : {};
  const scopeId =
    binding.bindingScope === 'workspace'
      ? binding.workspaceId
      : binding.bindingScope === 'conversation'
        ? binding.conversationId
        : binding.bindingScope === 'actor_global'
          ? binding.actorId
          : binding.bindingScope === 'user'
            ? binding.userId
            : `${binding.actorId}:${binding.conversationId}`;

  return {
    id: binding.id,
    workspace_id: binding.workspaceId,
    plugin_id: binding.packageId,
    scope_type: binding.bindingScope,
    scope_id: scopeId,
    actor_id: binding.actorId || null,
    conversation_id: binding.conversationId || null,
    user_id: binding.userId || null,
    lifecycle_scope: binding.reuseScope,
    is_enabled: binding.isEnabled,
    config_data: binding.configData || {},
    installed_by: binding.installedBy || null,
    metadata: binding.metadata || {},
    created_at: binding.createdAt,
    updated_at: binding.updatedAt,
    plugin_slug: plugin.slug,
    plugin_display_name: plugin.display_name,
    plugin_description: plugin.description,
    transport: plugin.transport,
    plugin_lifecycle_scope: plugin.lifecycle_scope,
    tools_manifest: plugin.tools_manifest,
    plugin_icon_url: plugin.icon_url,
    plugin_version: plugin.version,
    config_schema: plugin.config_schema,
    is_builtin: plugin.is_builtin,
    plugin_validation_rules: plugin.validation_rules,
    plugin_setup_steps: plugin.setup_steps,
    org_id: plugin.org_id,
    org_slug: plugin.org_slug,
    org_display_name: plugin.org_display_name,
  };
}

function scopeColumns(scopeType: CapabilityBindingScope, actorId?: string | null, conversationId?: string | null, userId?: string | null) {
  switch (scopeType) {
    case 'workspace':
      return { actorId: null, conversationId: null, userId: null };
    case 'conversation':
      if (!conversationId) throw new McpPluginError(400, 'conversationId is required for conversation scope');
      return { actorId: null, conversationId, userId: null };
    case 'actor_global':
      if (!actorId) throw new McpPluginError(400, 'actorId is required for actor_global scope');
      return { actorId, conversationId: null, userId: null };
    case 'actor_conversation':
      if (!actorId || !conversationId) {
        throw new McpPluginError(400, 'actorId and conversationId are required for actor_conversation scope');
      }
      return { actorId, conversationId, userId: null };
    case 'user':
      if (!userId) throw new McpPluginError(400, 'userId is required for user scope');
      return { actorId: null, conversationId: null, userId };
    default:
      throw new McpPluginError(400, `Unsupported binding scope: ${scopeType}`);
  }
}

export async function createOrganization(data: {
  slug: string;
  displayName: string;
  description?: string;
  logoUrl?: string;
  isBuiltin?: boolean;
  isVerified?: boolean;
  ownerUserId?: string;
}) {
  try {
    return await createCapabilityPublisher(data);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listOrganizations() {
  try {
    return await listCapabilityPublishers();
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getOrganization(id: string) {
  try {
    return await getCapabilityPublisher(id);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getOrganizationBySlug(slug: string) {
  const result = await query(`SELECT * FROM capability_publishers WHERE slug = $1`, [slug]);
  return result.rows[0] || null;
}

export async function createPlugin(data: {
  orgId: string;
  workspaceId?: string;
  slug: string;
  displayName: string;
  description?: string;
  longDescription?: string;
  iconUrl?: string;
  version?: string;
  transport: string;
  entryPoint?: string;
  lifecycleScope?: CapabilityReuseScope;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  toolsManifest?: unknown[];
  tags?: string[];
  isBuiltin?: boolean;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  defaultBindingScope?: CapabilityBindingScope;
  requiresHandshake?: boolean;
  authorization?: {
    requiredPermissions?: string[];
    defaultGrantScope?: CapabilityBindingScope;
    reason?: string;
  };
}) {
  try {
    const pkg = await createCapabilityPackage({
      publisherId: data.orgId,
      workspaceId: data.workspaceId,
      kind: 'plugin',
      slug: data.slug,
      displayName: data.displayName,
      description: data.description,
      longDescription: data.longDescription,
      iconUrl: data.iconUrl,
      sourceType: data.transport === 'relay'
        ? 'relay_derived'
        : data.isBuiltin
          ? 'builtin'
          : 'official',
      tags: data.tags,
      isBuiltin: data.isBuiltin,
      defaultBindingScope: data.defaultBindingScope || 'workspace',
      defaultReuseScope: data.lifecycleScope || 'conversation',
      requiresHandshake: data.requiresHandshake ?? data.transport !== 'builtin',
    });

    await createCapabilityRevision({
      packageId: pkg.id,
      version: data.version || '1.0.0',
      transport: data.transport as any,
      entryPoint: data.entryPoint,
      toolsManifest: data.toolsManifest,
      configSchema: data.configSchema,
      defaultConfig: data.defaultConfig,
      validationRules: data.validationRules,
      setupSteps: data.setupSteps,
      manifest: {
        kind: 'plugin',
        authorization: {
          requiredPermissions: data.authorization?.requiredPermissions || [],
          defaultGrantScope: data.authorization?.defaultGrantScope,
          reason: data.authorization?.reason,
        },
      },
      setLatest: true,
    });

    const created = await getCapabilityPackage(pkg.id);
    return mapPackageToPluginView(created);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listPlugins(filters?: { orgId?: string; transport?: string; search?: string; tags?: string[] }) {
  try {
    const packages = await listCapabilityPackages({
      kind: 'plugin',
      publisherId: filters?.orgId,
      transport: filters?.transport as any,
      search: filters?.search,
      tags: filters?.tags,
    });
    return packages.map(mapPackageToPluginView);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getPlugin(id: string) {
  try {
    const pkg = await getCapabilityPackage(id);
    if (pkg.kind !== 'plugin') throw new McpPluginError(404, 'Plugin not found');
    return mapPackageToPluginView(pkg);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export function validateLifecycleHierarchy(scopeType: CapabilityBindingScope, lifecycleScope: CapabilityReuseScope): boolean {
  switch (scopeType) {
    case 'workspace':
      return ['workspace', 'conversation', 'actor_global', 'actor_conversation', 'turn'].includes(lifecycleScope);
    case 'conversation':
      return ['conversation', 'actor_conversation', 'turn'].includes(lifecycleScope);
    case 'actor_global':
      return ['actor_global', 'actor_conversation', 'turn'].includes(lifecycleScope);
    case 'actor_conversation':
      return ['actor_conversation', 'turn'].includes(lifecycleScope);
    case 'user':
      return ['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user', 'turn'].includes(lifecycleScope);
    default:
      return false;
  }
}

export async function installPluginUnified(data: {
  workspaceId: string;
  pluginId: string;
  scopeType: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  lifecycleScope?: CapabilityReuseScope;
  configData?: Record<string, unknown>;
  installedBy?: string;
}) {
  const lifecycleScope = data.lifecycleScope || 'conversation';
  if (!validateLifecycleHierarchy(data.scopeType, lifecycleScope)) {
    throw new McpPluginError(400, `Reuse scope '${lifecycleScope}' is not valid for binding scope '${data.scopeType}'`);
  }

  try {
    const plugin = await getCapabilityPackage(data.pluginId);
    if (plugin.kind !== 'plugin') throw new McpPluginError(404, 'Plugin not found');
    const encrypted = data.configData
      ? encryptSensitiveFields(data.configData, plugin.latestRevision?.configSchema || {})
      : {};
    const scoped = scopeColumns(data.scopeType, data.actorId, data.conversationId, data.userId);
    const binding = await createCapabilityBinding({
      workspaceId: data.workspaceId,
      packageId: data.pluginId,
      revisionId: plugin.latestRevisionId,
      bindingScope: data.scopeType,
      actorId: scoped.actorId || undefined,
      conversationId: scoped.conversationId || undefined,
      userId: scoped.userId || undefined,
      installMode: 'manual',
      reuseScope: lifecycleScope,
      requiresHandshake: plugin.requiresHandshake,
      configData: encrypted,
      installedBy: data.installedBy,
    });

    try {
      await ensureDefaultCapabilityGrant({
        bindingId: binding.id,
        workspaceId: data.workspaceId,
        grantedBy: data.installedBy,
      });
      await query('UPDATE capability_packages SET download_count = download_count + 1 WHERE id = $1', [data.pluginId]);
      await incrementMcpVersion(data.workspaceId);
      return mapBindingToInstallationView(binding);
    } catch (error) {
      await deleteCapabilityBinding(binding.id).catch(() => {});
      throw error;
    }
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function uninstallPluginUnified(installId: string) {
  try {
    const deleted = await deleteCapabilityBinding(installId);
    await incrementMcpVersion(deleted.workspace_id);
    return deleted;
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getInstallations(workspaceId: string, filters?: {
  scopeType?: CapabilityBindingScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  pluginId?: string;
}) {
  try {
    const bindings = await listCapabilityBindings(workspaceId, {
      kind: 'plugin',
      packageId: filters?.pluginId,
      bindingScope: filters?.scopeType,
      conversationId: filters?.conversationId,
      actorId: filters?.actorId,
      userId: filters?.userId,
    });
    return bindings.map(mapBindingToInstallationView);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function updateInstallation(installId: string, data: {
  isEnabled?: boolean;
  configData?: Record<string, unknown>;
  lifecycleScope?: CapabilityReuseScope;
  scopeType?: CapabilityBindingScope;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}) {
  try {
    const existingResult = await query(
      `SELECT b.workspace_id, b.package_id, r.config_schema
       FROM capability_bindings b
       JOIN capability_package_revisions r ON r.id = b.revision_id
       WHERE b.id = $1`,
      [installId],
    );
    if (existingResult.rows.length === 0) throw new McpPluginError(404, 'Installation not found');
    const existing = existingResult.rows[0];

    const scopeType = data.scopeType;
    if (scopeType && data.lifecycleScope && !validateLifecycleHierarchy(scopeType, data.lifecycleScope)) {
      throw new McpPluginError(400, `Reuse scope '${data.lifecycleScope}' is not valid for binding scope '${scopeType}'`);
    }

    const scoped = scopeType ? scopeColumns(scopeType, data.actorId ?? undefined, data.conversationId ?? undefined, data.userId ?? undefined) : null;
    const encrypted = data.configData
      ? encryptSensitiveFields(data.configData, existing.config_schema || {})
      : undefined;

    const updated = await updateCapabilityBinding(installId, {
      isEnabled: data.isEnabled,
      configData: encrypted,
      bindingScope: scopeType,
      actorId: scoped ? scoped.actorId : undefined,
      conversationId: scoped ? scoped.conversationId : undefined,
      userId: scoped ? scoped.userId : undefined,
      reuseScope: data.lifecycleScope,
    });

    await incrementMcpVersion(existing.workspace_id);

    if (data.configData !== undefined) {
      await emitEvent({
        type: 'mcp.config.changed',
        workspaceId: existing.workspace_id,
        payload: { pluginId: existing.package_id, workspaceId: existing.workspace_id },
        timestamp: nowISO(),
      });
    }

    return mapBindingToInstallationView(updated);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function createPluginInstallPlan(input: {
  workspaceId: string;
  pluginId: string;
  bindingScope: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  try {
    const plugin = await getCapabilityPackage(input.pluginId);
    if (plugin.kind !== 'plugin') throw new McpPluginError(404, 'Plugin not found');
    if (!plugin.latestRevisionId) throw new McpPluginError(400, 'Plugin has no active revision');
    const checks = await evaluateCapabilityRequirements({
      workspaceId: input.workspaceId,
      revisionId: plugin.latestRevisionId,
    });

    return {
      packageId: plugin.id,
      revisionId: plugin.latestRevisionId,
      workspaceId: input.workspaceId,
      bindingScope: input.bindingScope,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
      checks,
      grantPlan: buildCapabilityGrantPlan({
        revision: plugin.latestRevision,
        bindingScope: input.bindingScope,
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: input.userId,
      }),
    };
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export function validateConfig(
  config: Record<string, unknown>,
  rules: McpValidationRule[],
): { valid: boolean; errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];

  for (const rule of rules) {
    const value = config[rule.field];
    switch (rule.rule) {
      case 'required':
        if (value === undefined || value === null || value === '') errors.push({ field: rule.field, message: rule.message });
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
        if (typeof value === 'string' && value.length < (rule.value as number)) errors.push({ field: rule.field, message: rule.message });
        break;
      case 'max_length':
        if (typeof value === 'string' && value.length > (rule.value as number)) errors.push({ field: rule.field, message: rule.message });
        break;
      case 'prefix':
        if (typeof value === 'string' && !value.startsWith(rule.value as string)) errors.push({ field: rule.field, message: rule.message });
        break;
      case 'enum':
        if (Array.isArray(rule.value) && !rule.value.includes(value as string)) errors.push({ field: rule.field, message: rule.message });
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function seedBuiltinMcpPlugins() {
  for (const seed of builtinSeeds) {
    const publisher = await createOrganization({
      slug: seed.slug,
      displayName: seed.displayName,
      description: seed.description,
      isBuiltin: true,
      isVerified: true,
    });

    for (const pluginSeed of seed.plugins) {
      await createPlugin({
        orgId: publisher.id,
        slug: pluginSeed.slug,
        displayName: pluginSeed.displayName,
        description: pluginSeed.description,
        longDescription: pluginSeed.longDescription,
        transport: pluginSeed.transport,
        entryPoint: pluginSeed.entryPoint,
        lifecycleScope: pluginSeed.defaultReuseScope,
        defaultBindingScope: pluginSeed.defaultBindingScope,
        requiresHandshake: pluginSeed.requiresHandshake,
        tags: pluginSeed.tags,
        isBuiltin: true,
        toolsManifest: pluginSeed.toolsManifest,
        configSchema: pluginSeed.configSchema,
        defaultConfig: pluginSeed.defaultConfig,
        validationRules: pluginSeed.validationRules,
        setupSteps: pluginSeed.setupSteps,
        authorization: pluginSeed.authorization,
      });
    }

    console.log(`[MCP] Seeded ${seed.slug} builtin plugins (${seed.plugins.map((plugin) => plugin.slug).join(', ')})`);
  }
}
