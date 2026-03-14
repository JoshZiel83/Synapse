import type {
  CapabilityAvailableSkill,
  CapabilityAttachmentType,
  CapabilityAuthProviderDefinition,
  CapabilityAuthorizationManifest,
  CapabilityAsset,
  CapabilityCategory,
  CapabilityConfigFieldDefinition,
  CapabilityGrant,
  CapabilityGrantScope,
  CapabilityInstance,
  CapabilityInstanceInstallMode,
  CapabilityInstallFlow,
  CapabilityInstallStep,
  CapabilityPackage,
  CapabilityPackageKind,
  CapabilityPackageRevision,
  CapabilityRequirement,
  CapabilityRequirementCheck,
  CapabilityRequirementKind,
  CapabilityTransport,
  CapabilityReuseScope,
  CapabilitySourceType,
  CapabilityPublisher,
  LocalizedText,
  McpSetupStep,
  McpValidationRule,
} from '@synapse/shared';
import {
  AUTHZ_PLATFORM_ID,
  authzEnabled,
  buildActorConversationContextId,
  diffAuthzRelationships,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchActorConversationContext,
  lookupResources,
  touchRelation,
  type AuthzObjectType,
  type AuthzRelationMutation,
} from '../../infrastructure/authz/index.js';
import { query } from '../../infrastructure/database/index.js';

export class CapabilityError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type JsonMap = Record<string, unknown>;

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonMap;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asLocalizedText(value: unknown, fallback?: string): LocalizedText | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { en: value.trim() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback ? { en: fallback } : undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([locale, text]) => [locale, text.trim()] as const);

  if (entries.length === 0) {
    return fallback ? { en: fallback } : undefined;
  }

  return Object.fromEntries(entries);
}

function asGrantScope(value: unknown): CapabilityGrantScope | undefined {
  if (
    value === 'platform' ||
    value === 'workspace' ||
    value === 'conversation' ||
    value === 'actor_global' ||
    value === 'actor_conversation' ||
    value === 'user'
  ) {
    return value;
  }
  return undefined;
}

function extractAuthorizationManifest(manifestValue: unknown): CapabilityAuthorizationManifest | undefined {
  const manifest = asObject(manifestValue);
  const authorization = asObject(manifest.authorization);
  const requiredPermissions = asStringArray(authorization.requiredPermissions);
  if (requiredPermissions.length === 0) return undefined;

  return {
    requiredPermissions,
    defaultGrantScope: asGrantScope(authorization.defaultGrantScope),
    reason: typeof authorization.reason === 'string' && authorization.reason.trim().length > 0
      ? authorization.reason.trim()
      : undefined,
  };
}

function extractConfigFields(manifestValue: unknown, configSchemaValue: unknown, defaultConfigValue: unknown): CapabilityConfigFieldDefinition[] {
  const manifest = asObject(manifestValue);
  const configFields = asArray<CapabilityConfigFieldDefinition>(manifest.configFields);
  if (configFields.length > 0) {
    return configFields.map((field) => ({
      key: field.key,
      type: field.type,
      titleI18n: asLocalizedText(field.titleI18n, field.key) || { en: field.key },
      descriptionI18n: asLocalizedText(field.descriptionI18n),
      placeholderI18n: asLocalizedText(field.placeholderI18n),
      required: Boolean(field.required),
      defaultValue: field.defaultValue,
      options: asArray(field.options),
      secret: Boolean(field.secret),
      serverManaged: Boolean(field.serverManaged),
      authProviderKey: typeof field.authProviderKey === 'string' ? field.authProviderKey : undefined,
      validation: asObject(field.validation),
      metadata: asObject(field.metadata),
    }));
  }

  const schema = asObject(configSchemaValue);
  const properties = asObject(schema.properties);
  const required = new Set(asStringArray(schema.required));
  const defaultConfig = asObject(defaultConfigValue);

  return Object.entries(properties).map(([key, raw]) => {
    const property = asObject(raw);
    const schemaType = typeof property.type === 'string' ? property.type : 'text';
    let type: CapabilityConfigFieldDefinition['type'] = 'text';
    if (property.sensitive === true) type = 'secret';
    else if (schemaType === 'boolean') type = 'boolean';
    else if (schemaType === 'number' || schemaType === 'integer') type = 'number';
    else if (Array.isArray(property.enum)) type = 'select';
    else if (schemaType === 'string' && property.format === 'multiline') type = 'textarea';

    return {
      key,
      type,
      titleI18n: asLocalizedText(property.title, key) || { en: key },
      descriptionI18n: asLocalizedText(property.description),
      placeholderI18n: asLocalizedText(property.placeholder),
      required: required.has(key),
      defaultValue: defaultConfig[key],
      options: Array.isArray(property.enum)
        ? property.enum
            .filter((item): item is string => typeof item === 'string')
            .map((value) => ({ value, labelI18n: { en: value } }))
        : undefined,
      secret: property.sensitive === true,
      serverManaged: property.serverManaged === true,
      authProviderKey: typeof property.authProviderKey === 'string' ? property.authProviderKey : undefined,
      validation: {},
      metadata: {},
    } satisfies CapabilityConfigFieldDefinition;
  });
}

function normalizeInstallStep(raw: McpSetupStep | CapabilityInstallStep): CapabilityInstallStep {
  const legacy = raw as McpSetupStep;
  const step = raw as CapabilityInstallStep;
  return {
    id: raw.id,
    kind: raw.kind || (raw.action?.kind === 'oauth_authorize' ? 'oauth' : 'form'),
    titleI18n: asLocalizedText(step.titleI18n || legacy.title, raw.id) || { en: raw.id },
    descriptionI18n: asLocalizedText(step.descriptionI18n || legacy.description),
    scope: raw.scope,
    fields: asStringArray(raw.fields),
    optional: Boolean(raw.optional),
    helpUrl: raw.helpUrl,
    helpTextI18n: asLocalizedText(step.helpTextI18n || legacy.helpText),
    action: raw.action,
    metadata: asObject(raw.metadata),
  };
}

function extractInstallFlow(manifestValue: unknown, setupStepsValue: unknown): CapabilityInstallFlow | undefined {
  const manifest = asObject(manifestValue);
  const flow = asObject(manifest.installFlow);
  const steps = asArray<CapabilityInstallStep>(flow.steps);
  if (steps.length > 0) {
    return { steps: steps.map(normalizeInstallStep) };
  }
  const legacy = asArray<McpSetupStep>(setupStepsValue);
  if (legacy.length > 0) {
    return { steps: legacy.map(normalizeInstallStep) };
  }
  return undefined;
}

function extractAuthProviders(manifestValue: unknown): CapabilityAuthProviderDefinition[] {
  const manifest = asObject(manifestValue);
  return asArray<CapabilityAuthProviderDefinition>(manifest.authProviders).map((provider) => ({
    key: provider.key,
    kind: provider.kind,
    displayNameI18n: asLocalizedText(provider.displayNameI18n, provider.key) || { en: provider.key },
    descriptionI18n: asLocalizedText(provider.descriptionI18n),
    authorizeUrl: provider.authorizeUrl,
    tokenUrl: provider.tokenUrl,
    userInfoUrl: typeof provider.userInfoUrl === 'string' ? provider.userInfoUrl : undefined,
    scopes: asStringArray(provider.scopes),
    clientId: typeof provider.clientId === 'string' ? provider.clientId : undefined,
    clientSecret: typeof provider.clientSecret === 'string' ? provider.clientSecret : undefined,
    clientIdEnv: typeof provider.clientIdEnv === 'string' ? provider.clientIdEnv : undefined,
    clientSecretEnv: typeof provider.clientSecretEnv === 'string' ? provider.clientSecretEnv : undefined,
    audience: typeof provider.audience === 'string' ? provider.audience : undefined,
    extraAuthorizeParams: Object.fromEntries(
      Object.entries(asObject(provider.extraAuthorizeParams)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    extraTokenParams: Object.fromEntries(
      Object.entries(asObject(provider.extraTokenParams)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    profileIdPath: typeof provider.profileIdPath === 'string' ? provider.profileIdPath : undefined,
    profileDisplayNamePath: typeof provider.profileDisplayNamePath === 'string' ? provider.profileDisplayNamePath : undefined,
    profileAvatarUrlPath: typeof provider.profileAvatarUrlPath === 'string' ? provider.profileAvatarUrlPath : undefined,
    reusable: provider.reusable !== false,
    configFieldKey: typeof provider.configFieldKey === 'string' ? provider.configFieldKey : undefined,
    metadata: asObject(provider.metadata),
  }));
}

function isPermissionSubset(requiredPermissions: string[], grantedPermissions: string[]) {
  return requiredPermissions.every((permission) => grantedPermissions.includes(permission));
}

function grantCoversRuntimeTarget(grant: CapabilityGrant, target: {
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  switch (grant.grantScope) {
    case 'platform':
      return true;
    case 'workspace':
      return true;
    case 'conversation':
      return Boolean(target.conversationId && grant.conversationId === target.conversationId);
    case 'actor_global':
      return Boolean(target.actorId && grant.actorId === target.actorId);
    case 'actor_conversation':
      return Boolean(
        target.actorId &&
        target.conversationId &&
        grant.actorId === target.actorId &&
        grant.conversationId === target.conversationId,
      );
    case 'user':
      return Boolean(
        target.userId &&
        grant.userId === target.userId,
      );
    default:
      return false;
  }
}

function inferDefaultGrantScope(instance: CapabilityInstance): CapabilityGrantScope {
  const requested = instance.revision?.authorization?.defaultGrantScope;
  if (requested && validateGrantHierarchy(instance.attachmentType, requested)) {
    if (requested === 'workspace') return requested;
    if (requested === 'platform') return requested;
    if (requested === 'conversation' && instance.conversationId) return requested;
    if (requested === 'actor_global' && instance.actorId) return requested;
    if (requested === 'actor_conversation' && instance.actorId && instance.conversationId) return requested;
    if (requested === 'user' && instance.userId) return requested;
  }

  switch (instance.attachmentType) {
    case 'platform':
      return 'platform';
    case 'workspace':
      return 'workspace';
    case 'conversation':
      return 'conversation';
    case 'actor_global':
      return 'actor_global';
    case 'actor_conversation':
      return 'actor_conversation';
    case 'user':
      return 'user';
    default:
      return 'workspace';
  }
}

function mapPublisher(row: any): CapabilityPublisher {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description || '',
    logoUrl: row.logo_url || undefined,
    isBuiltin: Boolean(row.is_builtin),
    isVerified: Boolean(row.is_verified),
    ownerUserId: row.owner_user_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategory(row: any): CapabilityCategory {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    slug: row.slug,
    targetKind: row.target_kind,
    displayName: row.display_name,
    displayNameI18n: asLocalizedText(metadata.displayNameI18n, row.display_name),
    description: row.description || '',
    descriptionI18n: asLocalizedText(metadata.descriptionI18n, row.description || ''),
    iconUrl: row.icon_url || undefined,
    defaultLocale: typeof metadata.defaultLocale === 'string' ? metadata.defaultLocale : undefined,
    sortOrder: Number(row.sort_order || 0),
    isBuiltin: Boolean(row.is_builtin),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRevision(row: any): CapabilityPackageRevision {
  const manifest = asObject(row.manifest);
  const installFlow = extractInstallFlow(manifest, row.setup_steps);
  const configFields = extractConfigFields(manifest, row.config_schema, row.default_config);
  return {
    id: row.revision_id ?? row.id,
    packageId: row.package_id,
    version: row.version,
    status: row.status,
    manifest,
    authorization: extractAuthorizationManifest(manifest),
    configSchema: asObject(row.config_schema),
    configFields,
    defaultConfig: asObject(row.default_config),
    transport: row.transport || undefined,
    entryPoint: row.entry_point || undefined,
    toolsManifest: asArray(row.tools_manifest),
    validationRules: asArray<McpValidationRule>(row.validation_rules),
    setupSteps: installFlow?.steps || [],
    installFlow,
    authProviders: extractAuthProviders(manifest),
    metadata: asObject(row.metadata),
    createdBy: row.created_by || undefined,
    createdAt: row.created_at,
  };
}

function mapPackage(row: any): CapabilityPackage {
  const publisher = row.publisher_id || row.publisher_slug
    ? {
        id: row.publisher_id,
        slug: row.publisher_slug,
        displayName: row.publisher_display_name,
        description: row.publisher_description || '',
        logoUrl: row.publisher_logo_url || undefined,
        isBuiltin: Boolean(row.publisher_is_builtin),
        isVerified: Boolean(row.publisher_is_verified),
        ownerUserId: row.publisher_owner_user_id || undefined,
        createdAt: row.publisher_created_at,
        updatedAt: row.publisher_updated_at,
      } satisfies CapabilityPublisher
    : undefined;

  const latestRevision = row.revision_id
    ? mapRevision({
        revision_id: row.revision_id,
        package_id: row.id,
        version: row.revision_version,
        status: row.revision_status,
        manifest: row.revision_manifest,
        config_schema: row.revision_config_schema,
        default_config: row.revision_default_config,
        transport: row.revision_transport,
        entry_point: row.revision_entry_point,
        tools_manifest: row.revision_tools_manifest,
        validation_rules: row.revision_validation_rules,
        setup_steps: row.revision_setup_steps,
        metadata: row.revision_metadata,
        created_by: row.revision_created_by,
        created_at: row.revision_created_at,
      })
    : undefined;

  return {
    id: row.id,
    publisherId: row.publisher_id,
    workspaceId: row.package_workspace_id || row.workspace_id || undefined,
    kind: row.kind,
    slug: row.slug,
    displayName: row.display_name,
    displayNameI18n: asLocalizedText(asObject(row.metadata).displayNameI18n, row.display_name),
    description: row.description || '',
    descriptionI18n: asLocalizedText(asObject(row.metadata).descriptionI18n, row.description || ''),
    longDescription: row.long_description || '',
    longDescriptionI18n: asLocalizedText(asObject(row.metadata).longDescriptionI18n, row.long_description || ''),
    summaryI18n: asLocalizedText(asObject(row.metadata).summaryI18n),
    defaultLocale: typeof asObject(row.metadata).defaultLocale === 'string' ? String(asObject(row.metadata).defaultLocale) : undefined,
    iconUrl: row.icon_url || undefined,
    sourceType: row.source_type,
    tags: asArray<string>(row.tags),
    isActive: Boolean(row.is_active),
    isBuiltin: Boolean(row.is_builtin),
    downloadCount: Number(row.download_count || 0),
    latestRevisionId: row.latest_revision_id || undefined,
    defaultInstanceScope: row.default_instance_scope,
    defaultReuseScope: row.default_reuse_scope,
    defaultIdleTtlMs: row.default_idle_ttl_ms ?? undefined,
    defaultMaxAgeMs: row.default_max_age_ms ?? undefined,
    requiresHandshake: Boolean(row.requires_handshake),
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categories: [],
    publisher,
    latestRevision,
  };
}

async function loadCapabilityCategoriesForPackages(packageIds: string[]) {
  if (packageIds.length === 0) {
    return new Map<string, CapabilityCategory[]>();
  }

  const result = await query(
    `SELECT
        pc.package_id,
        c.*
     FROM capability_package_categories pc
     JOIN capability_categories c ON c.id = pc.category_id
     WHERE pc.package_id = ANY($1::uuid[])
     ORDER BY c.sort_order ASC, c.display_name ASC`,
    [packageIds],
  );

  const byPackageId = new Map<string, CapabilityCategory[]>();
  for (const row of result.rows) {
    const categories = byPackageId.get(row.package_id) || [];
    categories.push(mapCategory(row));
    byPackageId.set(row.package_id, categories);
  }
  return byPackageId;
}

async function hydratePackageCategories<T extends CapabilityPackage>(packages: T[]): Promise<T[]> {
  if (packages.length === 0) return packages;
  const packageIds = [...new Set(packages.map((pkg) => pkg.id))];
  const categoriesByPackageId = await loadCapabilityCategoriesForPackages(packageIds);
  return packages.map((pkg) => ({
    ...pkg,
    categories: categoriesByPackageId.get(pkg.id) || [],
  }));
}

async function hydrateInstancePackageCategories<T extends CapabilityInstance>(instances: T[]): Promise<T[]> {
  const packages = instances
    .map((instance) => instance.package)
    .filter((pkg): pkg is CapabilityPackage => Boolean(pkg));
  if (packages.length === 0) return instances;

  const hydratedPackages = await hydratePackageCategories(packages);
  const packageMap = new Map(hydratedPackages.map((pkg) => [pkg.id, pkg]));
  return instances.map((instance) => (
    instance.package
      ? { ...instance, package: packageMap.get(instance.package.id) || instance.package }
      : instance
  ));
}

function mapAsset(row: any): CapabilityAsset {
  return {
    id: row.id,
    revisionId: row.revision_id,
    path: row.path,
    assetKind: row.asset_kind,
    mediaType: row.media_type || undefined,
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256,
    textContent: row.text_content || undefined,
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
  };
}

function resolveInstanceAttachmentId(instance: {
  workspaceId: string;
  attachmentType: CapabilityAttachmentType;
  conversationId?: string;
  actorId?: string;
  userId?: string;
}) {
  switch (instance.attachmentType) {
    case 'workspace':
      return instance.workspaceId;
    case 'conversation':
      return instance.conversationId;
    case 'actor_global':
      return instance.actorId;
    case 'user':
      return instance.userId;
    case 'actor_conversation':
      return instance.actorId && instance.conversationId
        ? `${instance.actorId}:${instance.conversationId}`
        : undefined;
    default:
      return undefined;
  }
}

function mapInstance(row: any): CapabilityInstance {
  const pkg = row.package_id ? mapPackage(row) : undefined;
  const revision = row.instance_revision_id || row.binding_revision_id
    ? mapRevision({
        revision_id: row.instance_revision_id || row.binding_revision_id,
        package_id: row.package_id,
        version: row.instance_revision_version || row.binding_revision_version,
        status: row.instance_revision_status || row.binding_revision_status,
        manifest: row.instance_revision_manifest || row.binding_revision_manifest,
        config_schema: row.instance_revision_config_schema || row.binding_revision_config_schema,
        default_config: row.instance_revision_default_config || row.binding_revision_default_config,
        transport: row.instance_revision_transport || row.binding_revision_transport,
        entry_point: row.instance_revision_entry_point || row.binding_revision_entry_point,
        tools_manifest: row.instance_revision_tools_manifest || row.binding_revision_tools_manifest,
        validation_rules: row.instance_revision_validation_rules || row.binding_revision_validation_rules,
        setup_steps: row.instance_revision_setup_steps || row.binding_revision_setup_steps,
        metadata: row.instance_revision_metadata || row.binding_revision_metadata,
        created_by: row.instance_revision_created_by || row.binding_revision_created_by,
        created_at: row.instance_revision_created_at || row.binding_revision_created_at,
      })
    : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.package_id,
    revisionId: row.revision_id,
    attachmentType: row.attachment_type,
    attachmentId: resolveInstanceAttachmentId({
      workspaceId: row.workspace_id,
      attachmentType: row.attachment_type,
      conversationId: row.conversation_id || undefined,
      actorId: row.actor_id || undefined,
      userId: row.user_id || undefined,
    }),
    attachmentConversationId: row.attachment_conversation_id || row.conversation_id || undefined,
    attachmentActorId: row.attachment_actor_id || row.actor_id || undefined,
    attachmentUserId: row.attachment_user_id || row.user_id || undefined,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
    userId: row.user_id || undefined,
    installMode: row.install_mode,
    reuseScope: row.reuse_scope,
    idleTtlMs: row.idle_ttl_ms ?? undefined,
    maxAgeMs: row.max_age_ms ?? undefined,
    requiresHandshake: Boolean(row.requires_handshake),
    isEnabled: Boolean(row.is_enabled),
    configData: asObject(row.config_data),
    configState: [],
    installedBy: row.installed_by || undefined,
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    package: pkg,
    revision,
  };
}

function capabilityInstanceAuthzObjectType(kind?: CapabilityPackageKind): Extract<AuthzObjectType, 'plugin_instance' | 'skill_instance'> | null {
  if (kind === 'plugin') return 'plugin_instance';
  if (kind === 'skill') return 'skill_instance';
  return null;
}

function buildCapabilityScopeRelations(params: {
  objectType: Extract<AuthzObjectType, 'plugin_instance' | 'skill_instance'>;
  instanceId: string;
  scope: CapabilityAttachmentType | CapabilityGrantScope;
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  enabled?: boolean;
}): AuthzRelationMutation[] {
  if (params.enabled === false) {
    return [];
  }

  switch (params.scope) {
    case 'platform':
      return [
        touchRelation(params.objectType, params.instanceId, 'use_platform', 'platform', AUTHZ_PLATFORM_ID),
      ];
    case 'workspace':
      return [
        touchRelation(params.objectType, params.instanceId, 'use_workspace', 'workspace', params.workspaceId),
      ];
    case 'conversation':
      return params.conversationId
        ? [touchRelation(params.objectType, params.instanceId, 'use_conversation', 'conversation', params.conversationId)]
        : [];
    case 'actor_global':
      return params.actorId
        ? [touchRelation(params.objectType, params.instanceId, 'use_principal', 'actor', params.actorId)]
        : [];
    case 'actor_conversation':
      return params.actorId && params.conversationId
        ? [
            ...touchActorConversationContext(params.actorId, params.conversationId),
            touchRelation(
              params.objectType,
              params.instanceId,
              'use_actor_conversation',
              'actor_conversation',
              buildActorConversationContextId(params.actorId, params.conversationId),
            ),
          ]
        : [];
    case 'user':
      return params.userId
        ? [touchRelation(params.objectType, params.instanceId, 'use_principal', 'user', params.userId)]
        : [];
    default:
      return [];
  }
}

function buildCapabilityInstanceAuthzRelations(instance: CapabilityInstance): AuthzRelationMutation[] {
  const objectType = capabilityInstanceAuthzObjectType(instance.package?.kind);
  if (!objectType) {
    return [];
  }

  return [
    touchRelation(objectType, instance.id, 'workspace', 'workspace', instance.workspaceId),
    ...(instance.installedBy
      ? [touchRelation(objectType, instance.id, 'owner', 'user', instance.installedBy)]
      : []),
  ];
}

function buildCapabilityGrantAuthzRelations(
  instance: CapabilityInstance,
  grants: CapabilityGrant[],
): AuthzRelationMutation[] {
  const objectType = capabilityInstanceAuthzObjectType(instance.package?.kind);
  if (!objectType || !instance.isEnabled) {
    return [];
  }

  return grants
    .filter((grant) => grant.status === 'active')
    .flatMap((grant) =>
      buildCapabilityScopeRelations({
        objectType,
        instanceId: instance.id,
        scope: grant.grantScope,
        workspaceId: instance.workspaceId,
        actorId: grant.actorId,
        conversationId: grant.conversationId,
        userId: grant.userId,
        enabled: true,
      }),
    );
}

function mapRequirement(row: any): CapabilityRequirement {
  return {
    id: row.id,
    revisionId: row.revision_id,
    requirementKind: row.requirement_kind,
    targetKind: row.target_kind,
    targetPackageKind: row.target_package_kind || undefined,
    targetPublisherSlug: row.target_publisher_slug || undefined,
    targetPackageSlug: row.target_package_slug || undefined,
    targetTag: row.target_tag || undefined,
    acceptableInstanceScopes: asArray<CapabilityAttachmentType>(row.acceptable_instance_scopes),
    acceptableReuseScopes: asArray<CapabilityReuseScope>(row.acceptable_reuse_scopes),
    description: row.description || '',
    configPredicate: asObject(row.config_predicate),
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
  };
}

function configPredicateSatisfied(config: JsonMap, predicate: JsonMap): boolean {
  const requiredKeys = asArray<string>(predicate.requiredKeys);
  const truthyKeys = asArray<string>(predicate.truthyKeys);
  return requiredKeys.every((key) => key in config) && truthyKeys.every((key) => Boolean(config[key]));
}

function targetMatchesInstance(requirement: CapabilityRequirement, instance: CapabilityInstance): boolean {
  if (!instance.package) return false;
  if (requirement.targetKind === 'tag') {
    return Boolean(requirement.targetTag && instance.package.tags.includes(requirement.targetTag));
  }
  if (requirement.targetPackageKind && instance.package.kind !== requirement.targetPackageKind) {
    return false;
  }
  if (requirement.targetPublisherSlug && instance.package.publisher?.slug !== requirement.targetPublisherSlug) {
    return false;
  }
  return instance.package.slug === requirement.targetPackageSlug;
}

export async function createCapabilityPublisher(data: {
  slug: string;
  displayName: string;
  description?: string;
  logoUrl?: string;
  isBuiltin?: boolean;
  isVerified?: boolean;
  ownerUserId?: string;
}): Promise<CapabilityPublisher> {
  const result = await query(
    `INSERT INTO capability_publishers (slug, display_name, description, logo_url, is_builtin, is_verified, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       logo_url = EXCLUDED.logo_url,
       is_builtin = EXCLUDED.is_builtin,
       is_verified = EXCLUDED.is_verified,
       owner_user_id = EXCLUDED.owner_user_id
     RETURNING *`,
    [
      data.slug,
      data.displayName,
      data.description || '',
      data.logoUrl || null,
      data.isBuiltin || false,
      data.isVerified || false,
      data.ownerUserId || null,
    ],
  );
  return mapPublisher(result.rows[0]);
}

export async function createCapabilityCategory(input: {
  slug: string;
  targetKind: CapabilityPackageKind;
  displayName: string;
  description?: string;
  iconUrl?: string;
  sortOrder?: number;
  isBuiltin?: boolean;
  metadata?: JsonMap;
}) {
  const existing = await query(
    `SELECT * FROM capability_categories WHERE slug = $1 AND target_kind = $2 LIMIT 1`,
    [input.slug, input.targetKind],
  );

  if (existing.rows.length > 0) {
    const updated = await query(
      `UPDATE capability_categories
       SET display_name = $1,
           description = $2,
           icon_url = $3,
           sort_order = $4,
           is_builtin = $5,
           metadata = $6,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        input.displayName,
        input.description || '',
        input.iconUrl || null,
        input.sortOrder ?? 0,
        input.isBuiltin ?? false,
        JSON.stringify(input.metadata || {}),
        existing.rows[0].id,
      ],
    );
    return mapCategory(updated.rows[0]);
  }

  const result = await query(
    `INSERT INTO capability_categories (
       slug, target_kind, display_name, description, icon_url, sort_order, is_builtin, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.slug,
      input.targetKind,
      input.displayName,
      input.description || '',
      input.iconUrl || null,
      input.sortOrder ?? 0,
      input.isBuiltin ?? false,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return mapCategory(result.rows[0]);
}

export async function listCapabilityCategories(filters?: {
  targetKind?: CapabilityPackageKind;
  builtinOnly?: boolean;
}) {
  const where: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters?.targetKind) {
    where.push(`target_kind = $${idx++}`);
    values.push(filters.targetKind);
  }
  if (filters?.builtinOnly) {
    where.push(`is_builtin = TRUE`);
  }

  const result = await query(
    `SELECT *
     FROM capability_categories
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY sort_order ASC, display_name ASC`,
    values,
  );
  return result.rows.map(mapCategory);
}

export async function assignCapabilityPackageCategories(packageId: string, categorySlugs: string[], targetKind?: CapabilityPackageKind) {
  const pkg = await getCapabilityPackage(packageId);
  const effectiveKind = targetKind || pkg.kind;
  const normalizedSlugs = [...new Set(categorySlugs.map((slug) => slug.trim()).filter(Boolean))];

  await query(`DELETE FROM capability_package_categories WHERE package_id = $1`, [packageId]);
  if (normalizedSlugs.length === 0) return [];

  const categories = await query(
    `SELECT id, slug
     FROM capability_categories
     WHERE target_kind = $1
       AND slug = ANY($2::text[])`,
    [effectiveKind, normalizedSlugs],
  );

  const foundSlugs = new Set(categories.rows.map((row) => row.slug));
  const missing = normalizedSlugs.filter((slug) => !foundSlugs.has(slug));
  if (missing.length > 0) {
    throw new CapabilityError(400, `Capability categories not found: ${missing.join(', ')}`);
  }

  for (const row of categories.rows) {
    await query(
      `INSERT INTO capability_package_categories (package_id, category_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [packageId, row.id],
    );
  }

  const refreshed = await getCapabilityPackage(packageId);
  return refreshed.categories || [];
}

export async function listCapabilityPublishers() {
  const result = await query(
    `SELECT * FROM capability_publishers ORDER BY is_builtin DESC, display_name`,
    [],
  );
  return result.rows.map(mapPublisher);
}

export async function getCapabilityPublisher(id: string) {
  const result = await query(`SELECT * FROM capability_publishers WHERE id = $1`, [id]);
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability publisher not found');
  return mapPublisher(result.rows[0]);
}

export async function createCapabilityPackage(input: {
  publisherId: string;
  workspaceId?: string;
  kind: CapabilityPackageKind;
  slug: string;
  displayName: string;
  description?: string;
  longDescription?: string;
  iconUrl?: string;
  sourceType?: CapabilitySourceType;
  tags?: string[];
  isBuiltin?: boolean;
  isActive?: boolean;
  defaultInstanceScope?: CapabilityAttachmentType;
  defaultReuseScope?: CapabilityReuseScope;
  defaultIdleTtlMs?: number;
  defaultMaxAgeMs?: number;
  requiresHandshake?: boolean;
  metadata?: JsonMap;
}) {
  const existing = await query(
    `SELECT *
     FROM capability_packages
     WHERE publisher_id = $1
       AND kind = $2
       AND slug = $3
       AND (
         ($4::uuid IS NULL AND workspace_id IS NULL) OR
         workspace_id = $4::uuid
       )
     LIMIT 1`,
    [input.publisherId, input.kind, input.slug, input.workspaceId || null],
  );

  if (existing.rows.length > 0) {
    const updated = await query(
      `UPDATE capability_packages
       SET workspace_id = $1,
           display_name = $2,
           description = $3,
           long_description = $4,
           icon_url = $5,
           source_type = $6,
           tags = $7,
           is_builtin = $8,
           is_active = $9,
           default_instance_scope = $10,
           default_reuse_scope = $11,
           default_idle_ttl_ms = $12,
           default_max_age_ms = $13,
           requires_handshake = $14,
           metadata = $15,
           updated_at = NOW()
       WHERE id = $16
       RETURNING *`,
      [
        input.workspaceId || null,
        input.displayName,
        input.description || '',
        input.longDescription || '',
        input.iconUrl || null,
        input.sourceType || 'official',
        input.tags || [],
        input.isBuiltin || false,
        input.isActive ?? true,
        input.defaultInstanceScope || 'workspace',
        input.defaultReuseScope || 'conversation',
        input.defaultIdleTtlMs ?? null,
        input.defaultMaxAgeMs ?? null,
        input.requiresHandshake || false,
        JSON.stringify(input.metadata || {}),
        existing.rows[0].id,
      ],
    );
    return mapPackage(updated.rows[0]);
  }

  const result = await query(
    `INSERT INTO capability_packages (
       publisher_id, workspace_id, kind, slug, display_name, description, long_description, icon_url,
       source_type, tags, is_builtin, is_active, default_instance_scope, default_reuse_scope,
       default_idle_ttl_ms, default_max_age_ms, requires_handshake, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      input.publisherId,
      input.workspaceId || null,
      input.kind,
      input.slug,
      input.displayName,
      input.description || '',
      input.longDescription || '',
      input.iconUrl || null,
      input.sourceType || 'official',
      input.tags || [],
      input.isBuiltin || false,
      input.isActive ?? true,
      input.defaultInstanceScope || 'workspace',
      input.defaultReuseScope || 'conversation',
      input.defaultIdleTtlMs ?? null,
      input.defaultMaxAgeMs ?? null,
      input.requiresHandshake || false,
      JSON.stringify(input.metadata || {}),
    ],
  );
  return mapPackage(result.rows[0]);
}

export async function createCapabilityRevision(input: {
  packageId: string;
  version: string;
  status?: 'draft' | 'active' | 'deprecated' | 'archived';
  manifest?: JsonMap;
  configSchema?: JsonMap;
  defaultConfig?: JsonMap;
  transport?: CapabilityTransport;
  entryPoint?: string;
  toolsManifest?: unknown[];
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  metadata?: JsonMap;
  createdBy?: string;
  assets?: Array<{
    path: string;
    assetKind: CapabilityAsset['assetKind'];
    mediaType?: string;
    textContent?: string;
    binaryContent?: Buffer;
    sizeBytes?: number;
    sha256: string;
    metadata?: JsonMap;
  }>;
  setLatest?: boolean;
}) {
  const revisionResult = await query(
    `INSERT INTO capability_package_revisions (
       package_id, version, status, manifest, config_schema, default_config,
       transport, entry_point, tools_manifest, validation_rules, setup_steps, metadata, created_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (package_id, version) DO UPDATE SET
       status = EXCLUDED.status,
       manifest = EXCLUDED.manifest,
       config_schema = EXCLUDED.config_schema,
       default_config = EXCLUDED.default_config,
       transport = EXCLUDED.transport,
       entry_point = EXCLUDED.entry_point,
       tools_manifest = EXCLUDED.tools_manifest,
       validation_rules = EXCLUDED.validation_rules,
       setup_steps = EXCLUDED.setup_steps,
       metadata = EXCLUDED.metadata
     RETURNING *`,
    [
      input.packageId,
      input.version,
      input.status || 'active',
      JSON.stringify(input.manifest || {}),
      JSON.stringify(input.configSchema || {}),
      JSON.stringify(input.defaultConfig || {}),
      input.transport || null,
      input.entryPoint || null,
      JSON.stringify(input.toolsManifest || []),
      JSON.stringify(input.validationRules || []),
      JSON.stringify(input.setupSteps || []),
      JSON.stringify(input.metadata || {}),
      input.createdBy || null,
    ],
  );

  const revision = mapRevision(revisionResult.rows[0]);

  if (input.assets) {
    await query(`DELETE FROM capability_assets WHERE revision_id = $1`, [revision.id]);
    for (const asset of input.assets) {
      await query(
        `INSERT INTO capability_assets (
           revision_id, path, asset_kind, media_type, size_bytes, sha256,
           text_content, binary_content, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          revision.id,
          asset.path,
          asset.assetKind,
          asset.mediaType || null,
          asset.sizeBytes ?? (asset.textContent ? Buffer.byteLength(asset.textContent, 'utf8') : asset.binaryContent?.length || 0),
          asset.sha256,
          asset.textContent || null,
          asset.binaryContent || null,
          JSON.stringify(asset.metadata || {}),
        ],
      );
    }
  }

  if (input.setLatest ?? true) {
    await query(`UPDATE capability_packages SET latest_revision_id = $1 WHERE id = $2`, [revision.id, input.packageId]);
  }

  return revision;
}

export async function listCapabilityPackages(filters?: {
  workspaceId?: string;
  includeGlobal?: boolean;
  kind?: CapabilityPackageKind;
  publisherId?: string;
  transport?: CapabilityTransport;
  search?: string;
  tags?: string[];
}) {
  const where: string[] = ['p.is_active = TRUE'];
  const values: unknown[] = [];
  let idx = 1;

  if (filters?.workspaceId) {
    if (filters.includeGlobal === false) {
      where.push(`p.workspace_id = $${idx++}`);
      values.push(filters.workspaceId);
    } else {
      where.push(`(p.workspace_id IS NULL OR p.workspace_id = $${idx++})`);
      values.push(filters.workspaceId);
    }
  } else {
    where.push('p.workspace_id IS NULL');
  }

  if (filters?.kind) {
    where.push(`p.kind = $${idx++}`);
    values.push(filters.kind);
  }
  if (filters?.publisherId) {
    where.push(`p.publisher_id = $${idx++}`);
    values.push(filters.publisherId);
  }
  if (filters?.transport) {
    where.push(`r.transport = $${idx++}`);
    values.push(filters.transport);
  }
  if (filters?.search) {
    where.push(`(p.display_name ILIKE $${idx} OR p.description ILIKE $${idx})`);
    values.push(`%${filters.search}%`);
    idx += 1;
  }
  if (filters?.tags && filters.tags.length > 0) {
    where.push(`p.tags && $${idx++}`);
    values.push(filters.tags);
  }

  const result = await query(
    `SELECT
        p.*,
        pub.slug AS publisher_slug,
        pub.display_name AS publisher_display_name,
        pub.description AS publisher_description,
        pub.logo_url AS publisher_logo_url,
        pub.is_builtin AS publisher_is_builtin,
        pub.is_verified AS publisher_is_verified,
        pub.owner_user_id AS publisher_owner_user_id,
        pub.created_at AS publisher_created_at,
        pub.updated_at AS publisher_updated_at,
        r.id AS revision_id,
        r.version AS revision_version,
        r.status AS revision_status,
        r.manifest AS revision_manifest,
        r.config_schema AS revision_config_schema,
        r.default_config AS revision_default_config,
        r.transport AS revision_transport,
        r.entry_point AS revision_entry_point,
        r.tools_manifest AS revision_tools_manifest,
        r.validation_rules AS revision_validation_rules,
        r.setup_steps AS revision_setup_steps,
        r.metadata AS revision_metadata,
        r.created_by AS revision_created_by,
        r.created_at AS revision_created_at
     FROM capability_packages p
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     LEFT JOIN capability_package_revisions r ON r.id = p.latest_revision_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.is_builtin DESC, p.download_count DESC, p.display_name`,
    values,
  );
  return hydratePackageCategories(result.rows.map(mapPackage));
}

export async function getCapabilityPackage(id: string) {
  const result = await query(
    `SELECT
        p.*,
        pub.slug AS publisher_slug,
        pub.display_name AS publisher_display_name,
        pub.description AS publisher_description,
        pub.logo_url AS publisher_logo_url,
        pub.is_builtin AS publisher_is_builtin,
        pub.is_verified AS publisher_is_verified,
        pub.owner_user_id AS publisher_owner_user_id,
        pub.created_at AS publisher_created_at,
        pub.updated_at AS publisher_updated_at,
        r.id AS revision_id,
        r.version AS revision_version,
        r.status AS revision_status,
        r.manifest AS revision_manifest,
        r.config_schema AS revision_config_schema,
        r.default_config AS revision_default_config,
        r.transport AS revision_transport,
        r.entry_point AS revision_entry_point,
        r.tools_manifest AS revision_tools_manifest,
        r.validation_rules AS revision_validation_rules,
        r.setup_steps AS revision_setup_steps,
        r.metadata AS revision_metadata,
        r.created_by AS revision_created_by,
        r.created_at AS revision_created_at
     FROM capability_packages p
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     LEFT JOIN capability_package_revisions r ON r.id = p.latest_revision_id
     WHERE p.id = $1
     LIMIT 1`,
    [id],
  );
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability package not found');
  const [pkg] = await hydratePackageCategories([mapPackage(result.rows[0])]);
  return pkg;
}

export async function getCapabilityPackageBySlug(input: {
  publisherSlug?: string;
  workspaceId?: string;
  kind: CapabilityPackageKind;
  slug: string;
}) {
  const values: unknown[] = [input.kind, input.slug];
  const where: string[] = ['p.kind = $1', 'p.slug = $2'];
  let idx = 3;

  if (input.publisherSlug) {
    where.push(`pub.slug = $${idx++}`);
    values.push(input.publisherSlug);
  }

  if (input.workspaceId) {
    where.push(`(p.workspace_id IS NULL OR p.workspace_id = $${idx++})`);
    values.push(input.workspaceId);
  } else {
    where.push('p.workspace_id IS NULL');
  }

  const result = await query(
    `SELECT
        p.*,
        pub.slug AS publisher_slug,
        pub.display_name AS publisher_display_name,
        pub.description AS publisher_description,
        pub.logo_url AS publisher_logo_url,
        pub.is_builtin AS publisher_is_builtin,
        pub.is_verified AS publisher_is_verified,
        pub.owner_user_id AS publisher_owner_user_id,
        pub.created_at AS publisher_created_at,
        pub.updated_at AS publisher_updated_at,
        r.id AS revision_id,
        r.version AS revision_version,
        r.status AS revision_status,
        r.manifest AS revision_manifest,
        r.config_schema AS revision_config_schema,
        r.default_config AS revision_default_config,
        r.transport AS revision_transport,
        r.entry_point AS revision_entry_point,
        r.tools_manifest AS revision_tools_manifest,
        r.validation_rules AS revision_validation_rules,
        r.setup_steps AS revision_setup_steps,
        r.metadata AS revision_metadata,
        r.created_by AS revision_created_by,
        r.created_at AS revision_created_at
     FROM capability_packages p
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     LEFT JOIN capability_package_revisions r ON r.id = p.latest_revision_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE WHEN p.workspace_id IS NULL THEN 1 ELSE 0 END, p.created_at DESC
     LIMIT 1`,
    values,
  );

  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability package not found');
  const [pkg] = await hydratePackageCategories([mapPackage(result.rows[0])]);
  return pkg;
}

export async function getCapabilityRevision(revisionId: string) {
  const result = await query(
    `SELECT * FROM capability_package_revisions WHERE id = $1 LIMIT 1`,
    [revisionId],
  );
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability revision not found');
  return mapRevision(result.rows[0]);
}

export async function listCapabilityAssets(revisionId: string) {
  const result = await query(
    `SELECT * FROM capability_assets WHERE revision_id = $1 ORDER BY path`,
    [revisionId],
  );
  return result.rows.map(mapAsset);
}

export async function getCapabilityAssetByPath(revisionId: string, assetPath: string) {
  const result = await query(
    `SELECT * FROM capability_assets WHERE revision_id = $1 AND path = $2 LIMIT 1`,
    [revisionId, assetPath],
  );
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability asset not found');
  return mapAsset(result.rows[0]);
}

export async function listCapabilityInstances(workspaceId: string, filters?: {
  packageId?: string;
  attachmentType?: CapabilityAttachmentType;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  kind?: CapabilityPackageKind;
}) {
  const where: string[] = ['b.workspace_id = $1'];
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.packageId) {
    where.push(`b.package_id = $${idx++}`);
    values.push(filters.packageId);
  }
  if (filters?.attachmentType) {
    where.push(`b.attachment_type = $${idx++}`);
    values.push(filters.attachmentType);
  }
  if (filters?.conversationId) {
    where.push(`b.attachment_conversation_id = $${idx++}`);
    values.push(filters.conversationId);
  }
  if (filters?.actorId) {
    where.push(`b.attachment_actor_id = $${idx++}`);
    values.push(filters.actorId);
  }
  if (filters?.userId) {
    where.push(`b.attachment_user_id = $${idx++}`);
    values.push(filters.userId);
  }
  if (filters?.kind) {
    where.push(`p.kind = $${idx++}`);
    values.push(filters.kind);
  }

  const result = await query(
    `SELECT
        b.*,
        b.attachment_type AS attachment_type,
        b.attachment_conversation_id AS conversation_id,
        b.attachment_actor_id AS actor_id,
        b.attachment_user_id AS user_id,
        p.id AS package_id,
        p.workspace_id AS package_workspace_id,
        p.publisher_id,
        p.kind,
        p.slug,
        p.display_name,
        p.description,
        p.long_description,
        p.icon_url,
        p.source_type,
        p.tags,
        p.is_active,
        p.is_builtin,
        p.download_count,
        p.latest_revision_id,
        p.default_instance_scope,
        p.default_reuse_scope,
        p.default_idle_ttl_ms,
        p.default_max_age_ms,
        p.requires_handshake AS package_requires_handshake,
        p.metadata AS package_metadata,
        p.created_at AS package_created_at,
        p.updated_at AS package_updated_at,
        pub.slug AS publisher_slug,
        pub.display_name AS publisher_display_name,
        pub.description AS publisher_description,
        pub.logo_url AS publisher_logo_url,
        pub.is_builtin AS publisher_is_builtin,
        pub.is_verified AS publisher_is_verified,
        pub.owner_user_id AS publisher_owner_user_id,
        pub.created_at AS publisher_created_at,
        pub.updated_at AS publisher_updated_at,
        r.id AS instance_revision_id,
        r.version AS instance_revision_version,
        r.status AS instance_revision_status,
        r.manifest AS instance_revision_manifest,
        r.config_schema AS instance_revision_config_schema,
        r.default_config AS instance_revision_default_config,
        r.transport AS instance_revision_transport,
        r.entry_point AS instance_revision_entry_point,
        r.tools_manifest AS instance_revision_tools_manifest,
        r.validation_rules AS instance_revision_validation_rules,
        r.setup_steps AS instance_revision_setup_steps,
        r.metadata AS instance_revision_metadata,
        r.created_by AS instance_revision_created_by,
        r.created_at AS instance_revision_created_at
     FROM capability_instances b
     JOIN capability_packages p ON p.id = b.package_id
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC`,
    values,
  );
  return hydrateInstancePackageCategories(result.rows.map(mapInstance));
}

export async function getCapabilityInstance(instanceId: string) {
  const result = await query(
    `SELECT
        b.*,
        b.attachment_type AS attachment_type,
        b.attachment_conversation_id AS conversation_id,
        b.attachment_actor_id AS actor_id,
        b.attachment_user_id AS user_id,
        p.id AS package_id,
        p.publisher_id,
        p.workspace_id AS package_workspace_id,
        p.kind,
        p.slug,
        p.display_name,
        p.description,
        p.long_description,
        p.icon_url,
        p.source_type,
        p.tags,
        p.is_active,
        p.is_builtin,
        p.download_count,
        p.latest_revision_id,
        p.default_instance_scope,
        p.default_reuse_scope,
        p.default_idle_ttl_ms,
        p.default_max_age_ms,
        p.requires_handshake AS package_requires_handshake,
        p.metadata AS package_metadata,
        p.created_at AS package_created_at,
        p.updated_at AS package_updated_at,
        pub.slug AS publisher_slug,
        pub.display_name AS publisher_display_name,
        pub.description AS publisher_description,
        pub.logo_url AS publisher_logo_url,
        pub.is_builtin AS publisher_is_builtin,
        pub.is_verified AS publisher_is_verified,
        pub.owner_user_id AS publisher_owner_user_id,
        pub.created_at AS publisher_created_at,
        pub.updated_at AS publisher_updated_at,
        r.id AS instance_revision_id,
        r.version AS instance_revision_version,
        r.status AS instance_revision_status,
        r.manifest AS instance_revision_manifest,
        r.config_schema AS instance_revision_config_schema,
        r.default_config AS instance_revision_default_config,
        r.transport AS instance_revision_transport,
        r.entry_point AS instance_revision_entry_point,
        r.tools_manifest AS instance_revision_tools_manifest,
        r.validation_rules AS instance_revision_validation_rules,
        r.setup_steps AS instance_revision_setup_steps,
        r.metadata AS instance_revision_metadata,
        r.created_by AS instance_revision_created_by,
        r.created_at AS instance_revision_created_at
     FROM capability_instances b
     JOIN capability_packages p ON p.id = b.package_id
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE b.id = $1
     LIMIT 1`,
    [instanceId],
  );

  if (result.rows.length === 0) {
    throw new CapabilityError(404, 'Capability instance not found');
  }

  const [instance] = await hydrateInstancePackageCategories([mapInstance(result.rows[0])]);
  return instance;
}

export function validateGrantHierarchy(attachmentType: CapabilityAttachmentType, grantScope: CapabilityGrantScope): boolean {
  void attachmentType;
  return ['platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user'].includes(grantScope);
}

export async function createCapabilityInstance(input: {
  workspaceId: string;
  packageId: string;
  revisionId?: string;
  attachmentType: CapabilityAttachmentType;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  installMode?: CapabilityInstanceInstallMode;
  reuseScope?: CapabilityReuseScope;
  idleTtlMs?: number;
  maxAgeMs?: number;
  requiresHandshake?: boolean;
  configData?: JsonMap;
  installedBy?: string;
  metadata?: JsonMap;
}) {
  const pkg = await getCapabilityPackage(input.packageId);
  if (!pkg) throw new CapabilityError(404, 'Capability package not found');
  const revisionId = input.revisionId || pkg.latestRevisionId;
  if (!revisionId) throw new CapabilityError(400, 'Capability package has no active revision');

  const existing = await listCapabilityInstances(input.workspaceId, {
    packageId: input.packageId,
    attachmentType: input.attachmentType,
    conversationId: input.conversationId,
    actorId: input.actorId,
    userId: input.userId,
  });
  const duplicate = existing.find((instance) =>
    instance.revisionId === revisionId &&
    JSON.stringify(instance.configData || {}) === JSON.stringify(input.configData || {}) &&
    instance.reuseScope === (input.reuseScope || pkg.defaultReuseScope || 'conversation') &&
    (instance.idleTtlMs ?? null) === (input.idleTtlMs ?? pkg.defaultIdleTtlMs ?? null) &&
    (instance.maxAgeMs ?? null) === (input.maxAgeMs ?? pkg.defaultMaxAgeMs ?? null) &&
    instance.requiresHandshake === (input.requiresHandshake ?? pkg.requiresHandshake),
  );
  if (duplicate) {
    return duplicate;
  }

  const result = await query(
    `INSERT INTO capability_instances (
       workspace_id, package_id, revision_id, attachment_type, attachment_conversation_id, attachment_actor_id, attachment_user_id,
       install_mode, is_enabled, config_data, reuse_scope, idle_ttl_ms, max_age_ms,
       requires_handshake, installed_by, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      input.workspaceId,
      input.packageId,
      revisionId,
      input.attachmentType,
      input.conversationId || null,
      input.actorId || null,
      input.userId || null,
      input.installMode || 'manual',
      JSON.stringify(input.configData || {}),
      input.reuseScope || pkg.defaultReuseScope || 'conversation',
      input.idleTtlMs ?? pkg.defaultIdleTtlMs ?? null,
      input.maxAgeMs ?? pkg.defaultMaxAgeMs ?? null,
      input.requiresHandshake ?? pkg.requiresHandshake,
      input.installedBy || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  const instances = await listCapabilityInstances(input.workspaceId, { packageId: input.packageId });
  const instance = instances.find((candidate) => candidate.id === result.rows[0].id)!;
  const authzEntryIds = await enqueueAuthzRelationships(
    buildCapabilityInstanceAuthzRelations(instance),
    {
      source: 'capability_instance.create',
      instanceId: instance.id,
      packageId: instance.packageId,
      packageKind: instance.package?.kind,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'capability_instance.create');
  return instance;
}

export async function updateCapabilityInstance(instanceId: string, data: {
  isEnabled?: boolean;
  configData?: JsonMap;
  attachmentType?: CapabilityAttachmentType;
  conversationId?: string | null;
  actorId?: string | null;
  userId?: string | null;
  reuseScope?: CapabilityReuseScope;
  idleTtlMs?: number | null;
  maxAgeMs?: number | null;
  requiresHandshake?: boolean;
  metadata?: JsonMap;
}) {
  const previousInstance = await getCapabilityInstance(instanceId);
  const previousGrants = await listCapabilityGrants(instanceId);
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.isEnabled !== undefined) {
    sets.push(`is_enabled = $${idx++}`);
    values.push(data.isEnabled);
  }
  if (data.attachmentType !== undefined) {
    sets.push(`attachment_type = $${idx++}`);
    values.push(data.attachmentType);
  }
  if (data.conversationId !== undefined) {
    sets.push(`attachment_conversation_id = $${idx++}`);
    values.push(data.conversationId);
  }
  if (data.actorId !== undefined) {
    sets.push(`attachment_actor_id = $${idx++}`);
    values.push(data.actorId);
  }
  if (data.userId !== undefined) {
    sets.push(`attachment_user_id = $${idx++}`);
    values.push(data.userId);
  }
  if (data.configData !== undefined) {
    sets.push(`config_data = $${idx++}`);
    values.push(JSON.stringify(data.configData));
  }
  if (data.reuseScope !== undefined) {
    sets.push(`reuse_scope = $${idx++}`);
    values.push(data.reuseScope);
  }
  if (data.idleTtlMs !== undefined) {
    sets.push(`idle_ttl_ms = $${idx++}`);
    values.push(data.idleTtlMs);
  }
  if (data.maxAgeMs !== undefined) {
    sets.push(`max_age_ms = $${idx++}`);
    values.push(data.maxAgeMs);
  }
  if (data.requiresHandshake !== undefined) {
    sets.push(`requires_handshake = $${idx++}`);
    values.push(data.requiresHandshake);
  }
  if (data.metadata !== undefined) {
    sets.push(`metadata = $${idx++}`);
    values.push(JSON.stringify(data.metadata));
  }

  if (sets.length === 0) throw new CapabilityError(400, 'No fields to update');

  values.push(instanceId);
  const result = await query(
    `UPDATE capability_instances
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );

  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability instance not found');
  const workspaceId = result.rows[0].workspace_id;
  const instances = await listCapabilityInstances(workspaceId, { packageId: result.rows[0].package_id });
  const instance = instances.find((candidate) => candidate.id === instanceId)!;
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      [
        ...buildCapabilityInstanceAuthzRelations(previousInstance),
        ...buildCapabilityGrantAuthzRelations(previousInstance, previousGrants),
      ],
      [
        ...buildCapabilityInstanceAuthzRelations(instance),
        ...buildCapabilityGrantAuthzRelations(instance, previousGrants),
      ],
    ),
    {
      source: 'capability_instance.update',
      instanceId: instance.id,
      packageId: instance.packageId,
      packageKind: instance.package?.kind,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'capability_instance.update');
  return instance;
}

export async function deleteCapabilityInstance(instanceId: string) {
  const instance = await getCapabilityInstance(instanceId);
  const grants = await listCapabilityGrants(instanceId);
  const result = await query(`DELETE FROM capability_instances WHERE id = $1 RETURNING *`, [instanceId]);
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability instance not found');
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      [
        ...buildCapabilityInstanceAuthzRelations(instance),
        ...buildCapabilityGrantAuthzRelations(instance, grants),
      ],
      [],
    ),
    {
      source: 'capability_instance.delete',
      instanceId,
      packageId: instance.packageId,
      packageKind: instance.package?.kind,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'capability_instance.delete');
  return result.rows[0];
}

export async function listRevisionRequirements(revisionId: string) {
  const result = await query(
    `SELECT * FROM capability_requirements WHERE revision_id = $1 ORDER BY created_at`,
    [revisionId],
  );
  return result.rows.map(mapRequirement);
}

export async function replaceRevisionRequirements(revisionId: string, requirements: Array<{
  requirementKind: CapabilityRequirementKind;
  targetKind: 'package' | 'tag';
  targetPackageKind?: CapabilityPackageKind;
  targetPublisherSlug?: string;
  targetPackageSlug?: string;
  targetTag?: string;
  acceptableInstanceScopes?: CapabilityAttachmentType[];
  acceptableReuseScopes?: CapabilityReuseScope[];
  description?: string;
  configPredicate?: JsonMap;
  metadata?: JsonMap;
}>) {
  await query(`DELETE FROM capability_requirements WHERE revision_id = $1`, [revisionId]);
  for (const requirement of requirements) {
    await query(
      `INSERT INTO capability_requirements (
         revision_id, requirement_kind, target_kind, target_package_kind,
         target_publisher_slug, target_package_slug, target_tag, acceptable_instance_scopes,
         acceptable_reuse_scopes, description, config_predicate, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        revisionId,
        requirement.requirementKind,
        requirement.targetKind,
        requirement.targetPackageKind || null,
        requirement.targetPublisherSlug || null,
        requirement.targetPackageSlug || null,
        requirement.targetTag || null,
        requirement.acceptableInstanceScopes || [],
        requirement.acceptableReuseScopes || [],
        requirement.description || '',
        JSON.stringify(requirement.configPredicate || {}),
        JSON.stringify(requirement.metadata || {}),
      ],
    );
  }
}

export async function evaluateCapabilityRequirements(input: {
  workspaceId: string;
  revisionId: string;
}) {
  const [requirements, instances] = await Promise.all([
    listRevisionRequirements(input.revisionId),
    listCapabilityInstances(input.workspaceId),
  ]);

  const checks: CapabilityRequirementCheck[] = requirements.map((requirement) => {
    const matchedInstances = instances.filter((instance) => targetMatchesInstance(requirement, instance));
    const scopeCompatible = matchedInstances.filter((instance) =>
      requirement.acceptableInstanceScopes.length === 0 ||
      requirement.acceptableInstanceScopes.includes(instance.attachmentType),
    );
    const reuseCompatible = scopeCompatible.filter((instance) =>
      requirement.acceptableReuseScopes.length === 0 ||
      requirement.acceptableReuseScopes.includes(instance.reuseScope),
    );
    const configCompatible = reuseCompatible.filter((instance) =>
      configPredicateSatisfied(instance.configData, requirement.configPredicate),
    );

    if (configCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'satisfied',
        message: requirement.description || 'Requirement satisfied',
        matchedInstanceIds: configCompatible.map((instance) => instance.id),
      };
    }

    if (reuseCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'config_incomplete',
        message: requirement.description || 'Instance exists but configuration is incomplete',
        matchedInstanceIds: reuseCompatible.map((instance) => instance.id),
      };
    }

    if (scopeCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'scope_mismatch',
        message: requirement.description || 'Instance exists but reuse policy does not match',
        matchedInstanceIds: scopeCompatible.map((instance) => instance.id),
      };
    }

    if (matchedInstances.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'scope_mismatch',
        message: requirement.description || 'Instance exists but attachment does not match',
        matchedInstanceIds: matchedInstances.map((instance) => instance.id),
      };
    }

    const missingStatus = requirement.requirementKind === 'recommended' ? 'missing_recommended' : 'missing_required';
    return {
      requirementId: requirement.id,
      requirementKind: requirement.requirementKind,
      status: missingStatus,
      message: requirement.description || 'Requirement is not installed',
      matchedInstanceIds: [],
      missingPublisherSlug: requirement.targetPublisherSlug,
      missingPackageSlug: requirement.targetPackageSlug,
      missingTag: requirement.targetTag,
    };
  });

  return checks;
}

export async function listCapabilityGrants(instanceId: string) {
  const result = await query(
    `SELECT * FROM capability_instance_grants WHERE instance_id = $1 ORDER BY created_at DESC`,
    [instanceId],
  );
  return result.rows.map((row: any): CapabilityGrant => ({
    id: row.id,
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    grantScope: row.grant_scope,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
    userId: row.user_id || undefined,
    permissions: asArray<string>(row.permissions),
    status: row.status,
    grantedBy: row.granted_by || undefined,
    reason: row.reason || undefined,
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  }));
}

export async function listCapabilityInstanceGrants(instanceId: string) {
  return listCapabilityGrants(instanceId);
}

export async function issueCapabilityInstanceGrant(input: {
  instanceId: string;
  workspaceId: string;
  grantScope?: CapabilityGrantScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  permissions?: string[];
  grantedBy?: string;
  reason?: string;
  metadata?: JsonMap;
}) {
  const instance = await getCapabilityInstance(input.instanceId);
  if (instance.workspaceId !== input.workspaceId) {
    throw new CapabilityError(404, 'Capability instance not found');
  }

  const requiredPermissions = instance.revision?.authorization?.requiredPermissions || [];
  const permissions = (input.permissions && input.permissions.length > 0)
    ? Array.from(new Set(input.permissions))
    : requiredPermissions;

  const grantScope = input.grantScope || inferDefaultGrantScope(instance);
  if (!validateGrantHierarchy(instance.attachmentType, grantScope)) {
    throw new CapabilityError(400, `Grant scope '${grantScope}' is not valid for attachment type '${instance.attachmentType}'`);
  }

  let conversationId = input.conversationId;
  let actorId = input.actorId;
  let userId = input.userId;

  if (grantScope === 'conversation') {
    conversationId = conversationId || instance.conversationId;
    if (!conversationId) {
      throw new CapabilityError(400, 'conversationId is required for conversation grants');
    }
    actorId = undefined;
    userId = undefined;
  } else if (grantScope === 'actor_global') {
    actorId = actorId || instance.actorId;
    if (!actorId) {
      throw new CapabilityError(400, 'actorId is required for actor_global grants');
    }
    conversationId = undefined;
    userId = undefined;
  } else if (grantScope === 'actor_conversation') {
    actorId = actorId || instance.actorId;
    conversationId = conversationId || instance.conversationId;
    if (!actorId || !conversationId) {
      throw new CapabilityError(400, 'actorId and conversationId are required for actor_conversation grants');
    }
    userId = undefined;
  } else if (grantScope === 'user') {
    userId = userId || instance.userId;
    if (!userId) {
      throw new CapabilityError(400, 'userId is required for user grants');
    }
    actorId = undefined;
    conversationId = undefined;
  } else if (grantScope === 'platform') {
    actorId = undefined;
    conversationId = undefined;
    userId = undefined;
  } else {
    conversationId = undefined;
    actorId = undefined;
    userId = undefined;
  }

  const existingGrants = await listCapabilityGrants(instance.id);
  const existing = existingGrants.find((grant) =>
    grant.status === 'active' &&
    grant.grantScope === grantScope &&
    grant.conversationId === conversationId &&
    grant.actorId === actorId &&
    grant.userId === userId &&
    permissions.every((permission: string) => grant.permissions.includes(permission)),
  );
  if (existing) {
    return existing;
  }

  const result = await query(
    `INSERT INTO capability_instance_grants (
       instance_id, workspace_id, grant_scope, conversation_id, actor_id, user_id,
       permissions, status, granted_by, reason, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10)
     RETURNING *`,
    [
      instance.id,
      input.workspaceId,
      grantScope,
      conversationId || null,
      actorId || null,
      userId || null,
      permissions,
      input.grantedBy || null,
      input.reason || instance.revision?.authorization?.reason || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  const grants = await listCapabilityGrants(instance.id);
  const issued = grants.find((grant) => grant.id === result.rows[0].id)!;
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildCapabilityGrantAuthzRelations(instance, existingGrants),
      buildCapabilityGrantAuthzRelations(instance, grants),
    ),
    {
      source: 'capability_instance_grant.issue',
      instanceId: instance.id,
      grantId: issued.id,
      packageKind: instance.package?.kind,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'capability_instance_grant.issue');
  return issued;
}

export async function revokeCapabilityGrant(grantId: string, workspaceId: string) {
  const currentGrantResult = await query(
    `SELECT * FROM capability_instance_grants WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [grantId, workspaceId],
  );
  if (currentGrantResult.rows.length === 0) {
    throw new CapabilityError(404, 'Capability grant not found');
  }
  const currentGrantRow = currentGrantResult.rows[0];
  const instance = await getCapabilityInstance(currentGrantRow.instance_id);
  const previousGrants = await listCapabilityGrants(instance.id);
  const result = await query(
    `UPDATE capability_instance_grants
     SET status = 'revoked', revoked_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'active'
     RETURNING *`,
    [grantId, workspaceId],
  );

  if (result.rows.length === 0) {
    throw new CapabilityError(404, 'Capability grant not found');
  }

  const row = result.rows[0];
  const nextGrants = await listCapabilityGrants(instance.id);
  const authzEntryIds = await enqueueAuthzRelationships(
    diffAuthzRelationships(
      buildCapabilityGrantAuthzRelations(instance, previousGrants),
      buildCapabilityGrantAuthzRelations(instance, nextGrants),
    ),
    {
      source: 'capability_instance_grant.revoke',
      instanceId: instance.id,
      grantId,
      packageKind: instance.package?.kind,
    },
  );
  await flushQueuedAuthzEntries(authzEntryIds, 'capability_instance_grant.revoke');

  return {
    id: row.id,
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    grantScope: row.grant_scope,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
    userId: row.user_id || undefined,
    permissions: asArray<string>(row.permissions),
    status: row.status,
    grantedBy: row.granted_by || undefined,
    reason: row.reason || undefined,
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  } satisfies CapabilityGrant;
}

export async function getCapabilityInstanceAuthorizationSummary(input: {
  instanceId: string;
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const instance = await getCapabilityInstance(input.instanceId);
  if (instance.workspaceId !== input.workspaceId) {
    throw new CapabilityError(404, 'Capability instance not found');
  }

  const grants = await listCapabilityGrants(instance.id);
  const activeGrants = grants.filter((grant) => grant.status === 'active');
  const requiredPermissions = instance.revision?.authorization?.requiredPermissions || [];
  const hasConcreteRuntimeTarget = Boolean(
    input.actorId ||
    input.conversationId ||
    input.userId,
  );
  const matchingGrants = hasConcreteRuntimeTarget
    ? activeGrants.filter((grant) =>
        grantCoversRuntimeTarget(grant, {
          actorId: input.actorId,
          conversationId: input.conversationId,
          userId: input.userId,
        }),
      )
    : activeGrants;
  const effectivePermissions = Array.from(new Set(matchingGrants.flatMap((grant) => grant.permissions)));
  const matchingGrantIds = matchingGrants
    .filter((grant) => requiredPermissions.length === 0 || isPermissionSubset(requiredPermissions, effectivePermissions))
    .map((grant) => grant.id);

  return {
    instance,
    requiredPermissions,
    suggestedGrantScope: requiredPermissions.length > 0 ? inferDefaultGrantScope(instance) : undefined,
    reason: instance.revision?.authorization?.reason,
    grants,
    effectivePermissions,
    isVisible: matchingGrants.length > 0,
    isAuthorized:
      (requiredPermissions.length === 0 && matchingGrants.length > 0) ||
      (requiredPermissions.length > 0 && isPermissionSubset(requiredPermissions, effectivePermissions)),
    matchingGrantIds,
  };
}

export async function ensureDefaultCapabilityInstanceGrant(input: {
  instanceId: string;
  workspaceId: string;
  grantedBy?: string;
}) {
  const instance = await getCapabilityInstance(input.instanceId);
  if (instance.workspaceId !== input.workspaceId) {
    throw new CapabilityError(404, 'Capability instance not found');
  }

  return issueCapabilityInstanceGrant({
    instanceId: input.instanceId,
    workspaceId: input.workspaceId,
    grantScope: inferDefaultGrantScope(instance),
    permissions: instance.revision?.authorization?.requiredPermissions || [],
    grantedBy: input.grantedBy,
    reason: instance.revision?.authorization?.reason,
  });
}

export function buildCapabilityGrantPlan(input: {
  revision?: CapabilityPackageRevision;
  attachmentType: CapabilityAttachmentType;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const authorization = input.revision?.authorization;
  const requiredPermissions = authorization?.requiredPermissions || [];
  if (requiredPermissions.length === 0) {
    return {
      requiresGrant: false,
      requiredPermissions: [],
    };
  }

  let suggestedGrantScope = authorization?.defaultGrantScope;
  if (!suggestedGrantScope || !validateGrantHierarchy(input.attachmentType, suggestedGrantScope)) {
    suggestedGrantScope = input.attachmentType;
  }

  if (suggestedGrantScope === 'platform') {
    return {
      requiresGrant: true,
      requiredPermissions,
      suggestedGrantScope,
      reason: authorization?.reason,
    };
  }

  if (suggestedGrantScope === 'conversation' && !input.conversationId) {
    suggestedGrantScope = input.attachmentType;
  }
  if (suggestedGrantScope === 'actor_global' && !input.actorId) {
    suggestedGrantScope = input.attachmentType;
  }
  if (suggestedGrantScope === 'actor_conversation' && (!input.actorId || !input.conversationId)) {
    suggestedGrantScope = input.attachmentType;
  }
  if (suggestedGrantScope === 'user' && !input.userId) {
    suggestedGrantScope = input.attachmentType;
  }

  return {
    requiresGrant: true,
    requiredPermissions,
    suggestedGrantScope,
    reason: authorization?.reason,
  };
}

export async function listAuthorizedCapabilityInstances(input: {
  workspaceId: string;
  kind?: CapabilityPackageKind;
  conversationId?: string;
  actorId?: string;
  userId?: string;
}) {
  const instances = await listCapabilityInstances(input.workspaceId, {
    kind: input.kind,
  });
  let candidateInstances = instances;

  const authzObjectType = capabilityInstanceAuthzObjectType(input.kind);
  if (authzEnabled() && authzObjectType && (input.actorId || input.userId)) {
    const authorizedIds = new Set<string>();

    if (input.actorId) {
      const actorIds = await lookupResources({
        resourceType: authzObjectType,
        permission: 'use',
        subject: { type: 'actor', id: input.actorId },
      });
      for (const id of actorIds) authorizedIds.add(id);
    }

    if (!input.actorId && input.userId) {
      const userIds = await lookupResources({
        resourceType: authzObjectType,
        permission: 'use',
        subject: { type: 'user', id: input.userId },
      });
      for (const id of userIds) authorizedIds.add(id);
    }

    if (authorizedIds.size === 0) {
      return [];
    }

    candidateInstances = instances.filter((instance) => authorizedIds.has(instance.id));
  }

  const candidates: Array<{ instance: CapabilityInstance; grantScore: number; attachmentScore: number; sortTime: number }> = [];

  for (const instance of candidateInstances) {
    const requiredPermissions = instance.revision?.authorization?.requiredPermissions || [];
    const grants = await listCapabilityGrants(instance.id);
    const runtimeTarget = input.actorId
      ? {
          actorId: input.actorId,
          conversationId: input.conversationId,
        }
      : {
          conversationId: input.conversationId,
          userId: input.userId,
        };

    const matchingGrants = grants.filter((grant) =>
      grant.status === 'active' &&
      grantCoversRuntimeTarget(grant, runtimeTarget),
    );
    const effectivePermissions = Array.from(new Set(matchingGrants.flatMap((grant) => grant.permissions)));
    const isAuthorized = requiredPermissions.length === 0
      ? matchingGrants.length > 0
      : isPermissionSubset(requiredPermissions, effectivePermissions);

    if (isAuthorized) {
      const bestGrantScore = Math.max(
        0,
        ...matchingGrants.map((grant) => {
          switch (grant.grantScope) {
            case 'actor_conversation': return 5;
            case 'conversation': return 4;
            case 'actor_global': return 3;
            case 'user': return 2;
            case 'workspace': return 1;
            default: return 0;
          }
        }),
      );
      const attachmentScore = (() => {
        switch (instance.attachmentType) {
          case 'actor_conversation': return 5;
          case 'conversation': return 4;
          case 'actor_global': return 3;
          case 'user': return 2;
          case 'workspace': return 1;
          default: return 0;
        }
      })();
      candidates.push({
        instance,
        grantScore: bestGrantScore,
        attachmentScore,
        sortTime: new Date(instance.updatedAt).getTime(),
      });
    }
  }

  return candidates
    .sort((left, right) =>
      right.grantScore - left.grantScore ||
      right.attachmentScore - left.attachmentScore ||
      right.sortTime - left.sortTime,
    )
    .map((entry) => entry.instance);
}

export async function listVisibleCapabilityInstances(input: {
  workspaceId: string;
  kind?: CapabilityPackageKind;
  conversationId?: string;
  actorId?: string;
  userId?: string;
}) {
  return listAuthorizedCapabilityInstances(input);
}

export function dedupeVisibleInstances<T extends CapabilityInstance>(
  instances: T[],
  keySelector: (instance: T) => string,
) {
  const deduped = new Map<string, T>();
  for (const instance of instances) {
    const key = keySelector(instance);
    if (!deduped.has(key)) {
      deduped.set(key, instance);
    }
  }
  return Array.from(deduped.values());
}

export function instanceToAvailableSkill(instance: CapabilityInstance): CapabilityAvailableSkill | null {
  if (!instance.package || !instance.revision || instance.package.kind !== 'skill') return null;
  const frontmatter = asObject(asObject(instance.revision.manifest).frontmatter);
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
    ? frontmatter.name.trim()
    : instance.package.slug;
  const description = typeof frontmatter.description === 'string' && frontmatter.description.trim().length > 0
    ? frontmatter.description.trim()
    : instance.package.description;
  return {
    instanceId: instance.id,
    packageId: instance.packageId,
    revisionId: instance.revisionId,
    slug: instance.package.slug,
    name,
    description,
    version: instance.revision.version,
    attachmentType: instance.attachmentType,
    actorId: instance.actorId,
    conversationId: instance.conversationId,
    userId: instance.userId,
    entryPoint: instance.revision.entryPoint || undefined,
  };
}
