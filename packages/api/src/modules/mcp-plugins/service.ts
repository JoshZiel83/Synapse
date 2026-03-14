import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { nowISO } from '@synapse/shared';
import type {
  CapabilityAttachmentType,
  CapabilityAuthProviderDefinition,
  CapabilityCategory,
  CapabilityConfigFieldDefinition,
  CapabilityConfigFieldState,
  CapabilityInstallFlow,
  CapabilityReuseScope,
  McpSetupStep,
  McpValidationRule,
} from '@synapse/shared';
import { encryptSensitiveFields, isEncrypted } from '../../infrastructure/crypto/index.js';
import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import {
  assignCapabilityPackageCategories,
  buildCapabilityGrantPlan,
  CapabilityError,
  createCapabilityInstance,
  createCapabilityCategory,
  ensureDefaultCapabilityInstanceGrant,
  createCapabilityPackage,
  createCapabilityPublisher,
  createCapabilityRevision,
  deleteCapabilityInstance,
  evaluateCapabilityRequirements,
  getCapabilityInstance,
  getCapabilityPackage,
  getCapabilityPublisher,
  listCapabilityInstances,
  listCapabilityCategories,
  listCapabilityPackages,
  listCapabilityPublishers,
  updateCapabilityInstance,
} from '../capabilities/service.js';
import { saveFromBuffer } from '../../infrastructure/storage/file-io.js';
import { attachAuthConnectionsToConfig } from './auth-service.js';
import { incrementMcpVersion } from './instance-manager.js';
import { builtinCapabilityCategories } from './builtin-plugins/categories.js';
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
    display_name_i18n: pkg.displayNameI18n || { en: pkg.displayName },
    description: pkg.description,
    description_i18n: pkg.descriptionI18n || { en: pkg.description },
    long_description: pkg.longDescription,
    long_description_i18n: pkg.longDescriptionI18n || (pkg.longDescription ? { en: pkg.longDescription } : undefined),
    summary_i18n: pkg.summaryI18n || undefined,
    default_locale: pkg.defaultLocale || 'en',
    icon_url: pkg.iconUrl || null,
    version: revision.version || '1.0.0',
    transport: revision.transport || 'builtin',
    entry_point: revision.entryPoint || '',
    lifecycle_scope: pkg.defaultReuseScope,
    default_instance_scope: pkg.defaultInstanceScope,
    config_schema: revision.configSchema || {},
    config_fields: revision.configFields || [],
    default_config: revision.defaultConfig || {},
    tools_manifest: revision.toolsManifest || [],
    validation_rules: revision.validationRules || [],
    setup_steps: revision.setupSteps || [],
    install_flow: revision.installFlow || { steps: revision.setupSteps || [] },
    auth_providers: revision.authProviders || [],
    authorization: revision.authorization || { requiredPermissions: [] },
    tags: pkg.tags || [],
    categories: pkg.categories || [],
    category_slugs: Array.isArray(pkg.categories) ? pkg.categories.map((category: CapabilityCategory) => category.slug) : [],
    is_active: pkg.isActive,
    is_builtin: pkg.isBuiltin,
    download_count: pkg.downloadCount || 0,
    created_at: pkg.createdAt,
    updated_at: pkg.updatedAt,
    org_slug: pkg.publisher?.slug,
    org_display_name: pkg.publisher?.displayName,
  };
}

function inferMimeTypeForAsset(assetPath: string) {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function ensureBuiltinPluginIcon(seedSlug: string, pluginSlug: string, relativeAssetPath: string) {
  const assetUrl = new URL(`./builtin-plugins/${relativeAssetPath}`, import.meta.url);
  const buffer = await fs.readFile(assetUrl);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = `${seedSlug}/${pluginSlug}`;

  const existing = await query(
    `SELECT id, stored_name, original_name, mime_type, size_bytes
     FROM files
     WHERE workspace_id IS NULL
       AND category = 'plugin_asset'
       AND metadata->>'builtin_plugin_icon_key' = $1
       AND metadata->>'sha256' = $2
     LIMIT 1`,
    [key, sha256],
  );

  if (existing.rows.length > 0) {
    return {
      id: existing.rows[0].id,
      iconUrl: `/files/${existing.rows[0].stored_name}`,
    };
  }

  const originalName = relativeAssetPath.split('/').pop() || `${pluginSlug}.svg`;
  const file = await saveFromBuffer(
    buffer,
    originalName,
    inferMimeTypeForAsset(relativeAssetPath),
    null,
    null,
    'plugin_asset',
    {
      builtin_plugin_icon_key: key,
      sha256,
      source: 'builtin_plugin_icon',
    },
  );
  return {
    id: file.id,
    iconUrl: file.url,
  };
}

function isSecretConfigField(field: CapabilityConfigFieldDefinition | undefined, schemaProperties: Record<string, any>, key: string) {
  return Boolean(field?.secret || field?.type === 'secret' || schemaProperties[key]?.sensitive === true);
}

function sanitizeInstallationConfig(binding: any, configFields: CapabilityConfigFieldDefinition[], authProviders: CapabilityAuthProviderDefinition[]) {
  const rawConfig = binding.configData || {};
  const schema = binding.revision?.configSchema || {};
  const schemaProperties = (schema as any).properties || {};
  const fieldMap = new Map(configFields.map((field) => [field.key, field]));
  const providerMap = new Map(authProviders.map((provider) => [provider.key, provider]));
  const sanitizedConfig: Record<string, unknown> = {};
  const configState: CapabilityConfigFieldState[] = [];

  for (const [key, value] of Object.entries(rawConfig)) {
    const field = fieldMap.get(key);
    if (field?.type === 'oauth_connection' && value && typeof value === 'object' && !Array.isArray(value)) {
      const ref = value as Record<string, unknown>;
      configState.push({
        key,
        isConfigured: Boolean(ref.connectionId),
        authConnectionId: typeof ref.connectionId === 'string' ? ref.connectionId : undefined,
        accountDisplayName: typeof ref.accountDisplayName === 'string' ? ref.accountDisplayName : undefined,
        updatedAt: typeof ref.updatedAt === 'string' ? ref.updatedAt : binding.updatedAt,
      });
      sanitizedConfig[key] = {
        providerKey: typeof ref.providerKey === 'string' ? ref.providerKey : field.authProviderKey,
        accountDisplayName: typeof ref.accountDisplayName === 'string' ? ref.accountDisplayName : undefined,
        connectionId: typeof ref.connectionId === 'string' ? ref.connectionId : undefined,
      };
      continue;
    }

    if (isSecretConfigField(field, schemaProperties, key)) {
      const masked = typeof value === 'string'
        ? isEncrypted(value)
          ? '••••configured'
          : value.length > 4
            ? `${'•'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`
            : '••••'
        : undefined;
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== '',
        maskedValue: masked,
        updatedAt: binding.updatedAt,
      });
      continue;
    }

    if (field?.serverManaged) {
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== '',
        updatedAt: binding.updatedAt,
      });
      continue;
    }

    sanitizedConfig[key] = value;
  }

  for (const field of configFields) {
    if (!configState.find((state) => state.key === field.key) && (field.secret || field.type === 'oauth_connection' || field.serverManaged)) {
      const provider = field.authProviderKey ? providerMap.get(field.authProviderKey) : undefined;
      configState.push({
        key: field.key,
        isConfigured: false,
        accountDisplayName: provider ? Object.values(provider.displayNameI18n || {})[0] : undefined,
      });
    }
  }

  return { sanitizedConfig, configState };
}

function mergeConfigForUpdate(existingConfig: Record<string, unknown>, incomingConfig: Record<string, unknown>, configFields: CapabilityConfigFieldDefinition[]) {
  const merged: Record<string, unknown> = { ...existingConfig, ...incomingConfig };
  for (const field of configFields) {
    if (!field.secret) continue;
    const incoming = incomingConfig[field.key];
    if ((incoming === undefined || incoming === null || incoming === '') && existingConfig[field.key] !== undefined) {
      merged[field.key] = existingConfig[field.key];
    }
  }
  return merged;
}

function mapBindingToInstallationView(binding: any) {
  const plugin: any = binding.package ? mapPackageToPluginView(binding.package) : {};
  const { sanitizedConfig, configState } = sanitizeInstallationConfig(
    binding,
    plugin.config_fields || [],
    plugin.auth_providers || [],
  );
  const attachmentType = binding.attachmentType;
  const attachmentId =
    binding.attachmentId ||
    (attachmentType === 'workspace'
      ? binding.workspaceId
      : attachmentType === 'conversation'
        ? binding.attachmentConversationId || binding.conversationId
        : attachmentType === 'actor_global'
          ? binding.attachmentActorId || binding.actorId
          : attachmentType === 'user'
            ? binding.attachmentUserId || binding.userId
            : `${binding.attachmentActorId || binding.actorId}:${binding.attachmentConversationId || binding.conversationId}`);

  return {
    id: binding.id,
    workspace_id: binding.workspaceId,
    plugin_id: binding.packageId,
    attachment_type: attachmentType,
    attachment_id: attachmentId,
    attachment_actor_id: binding.attachmentActorId || binding.actorId || null,
    attachment_conversation_id: binding.attachmentConversationId || binding.conversationId || null,
    attachment_user_id: binding.attachmentUserId || binding.userId || null,
    lifecycle_scope: binding.reuseScope,
    is_enabled: binding.isEnabled,
    config_data: sanitizedConfig,
    config_state: configState,
    installed_by: binding.installedBy || null,
    metadata: binding.metadata || {},
    created_at: binding.createdAt,
    updated_at: binding.updatedAt,
    plugin_slug: plugin.slug,
    plugin_display_name: plugin.display_name,
    plugin_description: plugin.description,
    plugin_display_name_i18n: plugin.display_name_i18n,
    plugin_description_i18n: plugin.description_i18n,
    plugin_long_description_i18n: plugin.long_description_i18n,
    plugin_summary_i18n: plugin.summary_i18n,
    default_locale: plugin.default_locale,
    transport: plugin.transport,
    plugin_lifecycle_scope: plugin.lifecycle_scope,
    tools_manifest: plugin.tools_manifest,
    plugin_icon_url: plugin.icon_url,
    plugin_categories: plugin.categories || [],
    plugin_category_slugs: plugin.category_slugs || [],
    plugin_version: plugin.version,
    config_schema: plugin.config_schema,
    config_fields: plugin.config_fields,
    install_flow: plugin.install_flow,
    auth_providers: plugin.auth_providers,
    is_builtin: plugin.is_builtin,
    plugin_validation_rules: plugin.validation_rules,
    plugin_setup_steps: plugin.setup_steps,
    org_id: plugin.org_id,
    org_slug: plugin.org_slug,
    org_display_name: plugin.org_display_name,
  };
}

function attachmentColumns(attachmentType: CapabilityAttachmentType, actorId?: string | null, conversationId?: string | null, userId?: string | null) {
  switch (attachmentType) {
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
      throw new McpPluginError(400, `Unsupported attachment type: ${attachmentType}`);
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
  configFields?: CapabilityConfigFieldDefinition[];
  defaultConfig?: Record<string, unknown>;
  toolsManifest?: unknown[];
  tags?: string[];
  categorySlugs?: string[];
  isBuiltin?: boolean;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  installFlow?: CapabilityInstallFlow;
  authProviders?: CapabilityAuthProviderDefinition[];
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  longDescriptionI18n?: Record<string, string>;
  summaryI18n?: Record<string, string>;
  defaultLocale?: string;
  defaultInstanceScope?: CapabilityAttachmentType;
  requiresHandshake?: boolean;
  authorization?: {
    requiredPermissions?: string[];
    defaultGrantScope?: CapabilityAttachmentType;
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
      metadata: {
        displayNameI18n: data.displayNameI18n || { en: data.displayName },
        descriptionI18n: data.descriptionI18n || { en: data.description },
        longDescriptionI18n: data.longDescriptionI18n || (data.longDescription ? { en: data.longDescription } : undefined),
        summaryI18n: data.summaryI18n,
        defaultLocale: data.defaultLocale || 'en',
      },
      sourceType: data.transport === 'relay'
        ? 'relay_derived'
        : data.isBuiltin
          ? 'builtin'
          : 'official',
      tags: data.tags,
      isBuiltin: data.isBuiltin,
      defaultInstanceScope: data.defaultInstanceScope || 'workspace',
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
        configFields: data.configFields || [],
        installFlow: data.installFlow || { steps: data.setupSteps || [] },
        authProviders: data.authProviders || [],
      },
      setLatest: true,
    });

    await assignCapabilityPackageCategories(pkg.id, data.categorySlugs || [], 'plugin');

    const created = await getCapabilityPackage(pkg.id);
    return mapPackageToPluginView(created);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listPlugins(filters?: {
  orgId?: string;
  transport?: string;
  search?: string;
  tags?: string[];
  categorySlugs?: string[];
}) {
  try {
    const packages = await listCapabilityPackages({
      kind: 'plugin',
      publisherId: filters?.orgId,
      transport: filters?.transport as any,
      search: filters?.search,
      tags: filters?.tags,
    });
    const filtered = filters?.categorySlugs && filters.categorySlugs.length > 0
      ? packages.filter((pkg) => {
          const packageCategorySlugs = new Set((pkg.categories || []).map((category) => category.slug));
          return filters.categorySlugs!.some((slug) => packageCategorySlugs.has(slug));
        })
      : packages;
    return filtered.map(mapPackageToPluginView);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listPluginCategories() {
  try {
    return await listCapabilityCategories({ targetKind: 'plugin', builtinOnly: true });
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

export function validateLifecycleHierarchy(attachmentType: CapabilityAttachmentType, lifecycleScope: CapabilityReuseScope): boolean {
  switch (attachmentType) {
    case 'workspace':
      return ['workspace', 'conversation', 'actor_global', 'actor_conversation', 'user', 'turn'].includes(lifecycleScope);
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
  attachmentType: CapabilityAttachmentType;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  lifecycleScope?: CapabilityReuseScope;
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
  installedBy?: string;
}) {
  const lifecycleScope = data.lifecycleScope || 'conversation';
  if (!validateLifecycleHierarchy(data.attachmentType, lifecycleScope)) {
    throw new McpPluginError(400, `Reuse scope '${lifecycleScope}' is not valid for attachment '${data.attachmentType}'`);
  }

  try {
    const plugin = await getCapabilityPackage(data.pluginId);
    if (plugin.kind !== 'plugin') throw new McpPluginError(404, 'Plugin not found');
    const normalizedConfig = await attachAuthConnectionsToConfig({
      workspaceId: data.workspaceId,
      userId: data.installedBy || data.userId || '',
      revision: plugin.latestRevision,
      configData: data.configData,
      authSessionIds: data.authSessionIds,
    });
    const encrypted = Object.keys(normalizedConfig).length > 0
      ? encryptSensitiveFields(normalizedConfig, plugin.latestRevision?.configSchema || {})
      : {};
    const attachment = attachmentColumns(data.attachmentType, data.actorId, data.conversationId, data.userId);
    const instance = await createCapabilityInstance({
      workspaceId: data.workspaceId,
      packageId: data.pluginId,
      revisionId: plugin.latestRevisionId,
      attachmentType: data.attachmentType,
      actorId: attachment.actorId || undefined,
      conversationId: attachment.conversationId || undefined,
      userId: attachment.userId || undefined,
      installMode: 'manual',
      reuseScope: lifecycleScope,
      requiresHandshake: plugin.requiresHandshake,
      configData: encrypted,
      installedBy: data.installedBy,
    });

    try {
      await ensureDefaultCapabilityInstanceGrant({
        instanceId: instance.id,
        workspaceId: data.workspaceId,
        grantedBy: data.installedBy,
      });
      await query('UPDATE capability_packages SET download_count = download_count + 1 WHERE id = $1', [data.pluginId]);
      await incrementMcpVersion(data.workspaceId);
      return mapBindingToInstallationView(instance);
    } catch (error) {
      await deleteCapabilityInstance(instance.id).catch(() => {});
      throw error;
    }
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function uninstallPluginUnified(installId: string) {
  try {
    const deleted = await deleteCapabilityInstance(installId);
    await incrementMcpVersion(deleted.workspace_id);
    return deleted;
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getInstallations(workspaceId: string, filters?: {
  attachmentType?: CapabilityAttachmentType;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  pluginId?: string;
}) {
  try {
    const instances = await listCapabilityInstances(workspaceId, {
      kind: 'plugin',
      packageId: filters?.pluginId,
      attachmentType: filters?.attachmentType,
      conversationId: filters?.conversationId,
      actorId: filters?.actorId,
      userId: filters?.userId,
    });
    return instances.map(mapBindingToInstallationView);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getInstallation(workspaceId: string, installId: string) {
  try {
    const instance = await getCapabilityInstance(installId);
    if (instance.workspaceId !== workspaceId || instance.package?.kind !== 'plugin') {
      throw new McpPluginError(404, 'Installation not found');
    }
    return mapBindingToInstallationView(instance);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function updateInstallation(installId: string, data: {
  isEnabled?: boolean;
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
  lifecycleScope?: CapabilityReuseScope;
  attachmentType?: CapabilityAttachmentType;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  updatedBy?: string;
}) {
  try {
    const existingResult = await query(
      `SELECT b.workspace_id, b.package_id, b.config_data, r.config_schema, b.revision_id
       FROM capability_instances b
       JOIN capability_package_revisions r ON r.id = b.revision_id
       WHERE b.id = $1`,
      [installId],
    );
    if (existingResult.rows.length === 0) throw new McpPluginError(404, 'Installation not found');
    const existing = existingResult.rows[0];

    const attachmentType = data.attachmentType;
    if (attachmentType && data.lifecycleScope && !validateLifecycleHierarchy(attachmentType, data.lifecycleScope)) {
      throw new McpPluginError(400, `Reuse scope '${data.lifecycleScope}' is not valid for attachment '${attachmentType}'`);
    }

    const attachment = attachmentType ? attachmentColumns(attachmentType, data.actorId ?? undefined, data.conversationId ?? undefined, data.userId ?? undefined) : null;
    const plugin = await getCapabilityPackage(existing.package_id);
    const mergedConfig = data.configData
      ? mergeConfigForUpdate(existing.config_data || {}, data.configData, plugin.latestRevision?.configFields || [])
      : undefined;
    const withAuthRefs = mergedConfig
      ? await attachAuthConnectionsToConfig({
          workspaceId: existing.workspace_id,
          userId: data.updatedBy || data.userId || '',
          revision: plugin.latestRevision,
          existingConfig: existing.config_data || {},
          configData: mergedConfig,
          authSessionIds: data.authSessionIds,
        })
      : undefined;
    const encrypted = withAuthRefs
      ? encryptSensitiveFields(withAuthRefs, existing.config_schema || {})
      : undefined;

    const updated = await updateCapabilityInstance(installId, {
      isEnabled: data.isEnabled,
      configData: encrypted,
      attachmentType,
      actorId: attachment ? attachment.actorId : undefined,
      conversationId: attachment ? attachment.conversationId : undefined,
      userId: attachment ? attachment.userId : undefined,
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
  attachmentType: CapabilityAttachmentType;
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
      attachmentType: input.attachmentType,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
      checks,
      grantPlan: buildCapabilityGrantPlan({
        revision: plugin.latestRevision,
        attachmentType: input.attachmentType,
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
  await seedBuiltinPluginCategories();

  for (const seed of builtinSeeds) {
    const publisher = await createOrganization({
      slug: seed.slug,
      displayName: seed.displayName,
      description: seed.description,
      isBuiltin: true,
      isVerified: true,
    });

    for (const pluginSeed of seed.plugins) {
      const icon = pluginSeed.iconAssetPath
        ? await ensureBuiltinPluginIcon(seed.slug, pluginSeed.slug, pluginSeed.iconAssetPath)
        : null;
      await createPlugin({
        orgId: publisher.id,
        slug: pluginSeed.slug,
        displayName: pluginSeed.displayName,
        description: pluginSeed.description,
        longDescription: pluginSeed.longDescription,
        iconUrl: icon?.iconUrl,
        transport: pluginSeed.transport,
        entryPoint: pluginSeed.entryPoint,
        lifecycleScope: pluginSeed.defaultReuseScope,
        defaultInstanceScope: pluginSeed.defaultInstanceScope,
        requiresHandshake: pluginSeed.requiresHandshake,
        tags: pluginSeed.tags,
        categorySlugs: pluginSeed.categorySlugs,
        isBuiltin: true,
        toolsManifest: pluginSeed.toolsManifest,
        configSchema: pluginSeed.configSchema,
        configFields: pluginSeed.configFields,
        defaultConfig: pluginSeed.defaultConfig,
        validationRules: pluginSeed.validationRules,
        setupSteps: pluginSeed.setupSteps,
        installFlow: pluginSeed.installFlow,
        authProviders: pluginSeed.authProviders,
        displayNameI18n: pluginSeed.displayNameI18n,
        descriptionI18n: pluginSeed.descriptionI18n,
        longDescriptionI18n: pluginSeed.longDescriptionI18n,
        summaryI18n: pluginSeed.summaryI18n,
        defaultLocale: pluginSeed.defaultLocale,
        authorization: pluginSeed.authorization,
      });
    }

    console.log(`[MCP] Seeded ${seed.slug} builtin plugins (${seed.plugins.map((plugin) => plugin.slug).join(', ')})`);
  }
}

export async function seedBuiltinPluginCategories() {
  for (const category of builtinCapabilityCategories) {
    await createCapabilityCategory({
      slug: category.slug,
      targetKind: category.targetKind,
      displayName: category.displayName,
      description: category.description,
      sortOrder: category.sortOrder,
      isBuiltin: true,
      metadata: {
        displayNameI18n: category.displayNameI18n || { en: category.displayName },
        descriptionI18n: category.descriptionI18n || (category.description ? { en: category.description } : undefined),
        defaultLocale: category.defaultLocale || 'en',
      },
    });
  }
}
