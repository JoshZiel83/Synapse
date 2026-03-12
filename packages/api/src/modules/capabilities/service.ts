import type {
  CapabilityAvailableSkill,
  CapabilityAuthorizationManifest,
  CapabilityAsset,
  CapabilityBinding,
  CapabilityBindingInstallMode,
  CapabilityBindingScope,
  CapabilityGrant,
  CapabilityGrantScope,
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
  McpSetupStep,
  McpValidationRule,
} from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';

export class CapabilityError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type JsonMap = Record<string, unknown>;

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

function isPermissionSubset(requiredPermissions: string[], grantedPermissions: string[]) {
  return requiredPermissions.every((permission) => grantedPermissions.includes(permission));
}

function grantCoversRuntimeTarget(grant: CapabilityGrant, target: {
  actorId?: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
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
        target.userCount === 1 &&
        grant.userId === target.userId,
      );
    default:
      return false;
  }
}

function bindingMatchesRuntimeTarget(binding: CapabilityBinding, target: {
  actorId?: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
}) {
  switch (binding.bindingScope) {
    case 'platform':
      return true;
    case 'workspace':
      return true;
    case 'conversation':
      return Boolean(target.conversationId && binding.conversationId === target.conversationId);
    case 'actor_global':
      return Boolean(target.actorId && binding.actorId === target.actorId);
    case 'actor_conversation':
      return Boolean(
        target.actorId &&
        target.conversationId &&
        binding.actorId === target.actorId &&
        binding.conversationId === target.conversationId,
      );
    case 'user':
      return Boolean(
        target.userId &&
        target.userCount === 1 &&
        binding.userId === target.userId,
      );
    default:
      return false;
  }
}

function inferDefaultGrantScope(binding: CapabilityBinding): CapabilityGrantScope {
  const requested = binding.revision?.authorization?.defaultGrantScope;
  if (requested && validateGrantHierarchy(binding.bindingScope, requested)) {
    if (requested === 'workspace') return requested;
    if (requested === 'platform') return requested;
    if (requested === 'conversation' && binding.conversationId) return requested;
    if (requested === 'actor_global' && binding.actorId) return requested;
    if (requested === 'actor_conversation' && binding.actorId && binding.conversationId) return requested;
    if (requested === 'user' && binding.userId) return requested;
  }

  switch (binding.bindingScope) {
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

function mapRevision(row: any): CapabilityPackageRevision {
  const manifest = asObject(row.manifest);
  return {
    id: row.revision_id ?? row.id,
    packageId: row.package_id,
    version: row.version,
    status: row.status,
    manifest,
    authorization: extractAuthorizationManifest(manifest),
    configSchema: asObject(row.config_schema),
    defaultConfig: asObject(row.default_config),
    transport: row.transport || undefined,
    entryPoint: row.entry_point || undefined,
    toolsManifest: asArray(row.tools_manifest),
    validationRules: asArray<McpValidationRule>(row.validation_rules),
    setupSteps: asArray<McpSetupStep>(row.setup_steps),
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
    description: row.description || '',
    longDescription: row.long_description || '',
    iconUrl: row.icon_url || undefined,
    sourceType: row.source_type,
    tags: asArray<string>(row.tags),
    isActive: Boolean(row.is_active),
    isBuiltin: Boolean(row.is_builtin),
    downloadCount: Number(row.download_count || 0),
    latestRevisionId: row.latest_revision_id || undefined,
    defaultBindingScope: row.default_binding_scope,
    defaultReuseScope: row.default_reuse_scope,
    defaultIdleTtlMs: row.default_idle_ttl_ms ?? undefined,
    defaultMaxAgeMs: row.default_max_age_ms ?? undefined,
    requiresHandshake: Boolean(row.requires_handshake),
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publisher,
    latestRevision,
  };
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

function mapBinding(row: any): CapabilityBinding {
  const pkg = row.package_id ? mapPackage(row) : undefined;
  const revision = row.binding_revision_id
    ? mapRevision({
        revision_id: row.binding_revision_id,
        package_id: row.package_id,
        version: row.binding_revision_version,
        status: row.binding_revision_status,
        manifest: row.binding_revision_manifest,
        config_schema: row.binding_revision_config_schema,
        default_config: row.binding_revision_default_config,
        transport: row.binding_revision_transport,
        entry_point: row.binding_revision_entry_point,
        tools_manifest: row.binding_revision_tools_manifest,
        validation_rules: row.binding_revision_validation_rules,
        setup_steps: row.binding_revision_setup_steps,
        metadata: row.binding_revision_metadata,
        created_by: row.binding_revision_created_by,
        created_at: row.binding_revision_created_at,
      })
    : undefined;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.package_id,
    revisionId: row.revision_id,
    bindingScope: row.binding_scope,
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
    installedBy: row.installed_by || undefined,
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    package: pkg,
    revision,
  };
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
    acceptableBindingScopes: asArray<CapabilityBindingScope>(row.acceptable_binding_scopes),
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

function targetMatchesBinding(requirement: CapabilityRequirement, binding: CapabilityBinding): boolean {
  if (!binding.package) return false;
  if (requirement.targetKind === 'tag') {
    return Boolean(requirement.targetTag && binding.package.tags.includes(requirement.targetTag));
  }
  if (requirement.targetPackageKind && binding.package.kind !== requirement.targetPackageKind) {
    return false;
  }
  if (requirement.targetPublisherSlug && binding.package.publisher?.slug !== requirement.targetPublisherSlug) {
    return false;
  }
  return binding.package.slug === requirement.targetPackageSlug;
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
  defaultBindingScope?: CapabilityBindingScope;
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
           default_binding_scope = $10,
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
        input.defaultBindingScope || 'workspace',
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
       source_type, tags, is_builtin, is_active, default_binding_scope, default_reuse_scope,
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
      input.defaultBindingScope || 'workspace',
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
  return result.rows.map(mapPackage);
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
  return mapPackage(result.rows[0]);
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
  return mapPackage(result.rows[0]);
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

export async function listCapabilityBindings(workspaceId: string, filters?: {
  packageId?: string;
  bindingScope?: CapabilityBindingScope;
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
  if (filters?.bindingScope) {
    where.push(`b.binding_scope = $${idx++}`);
    values.push(filters.bindingScope);
  }
  if (filters?.conversationId) {
    where.push(`b.conversation_id = $${idx++}`);
    values.push(filters.conversationId);
  }
  if (filters?.actorId) {
    where.push(`b.actor_id = $${idx++}`);
    values.push(filters.actorId);
  }
  if (filters?.userId) {
    where.push(`b.user_id = $${idx++}`);
    values.push(filters.userId);
  }
  if (filters?.kind) {
    where.push(`p.kind = $${idx++}`);
    values.push(filters.kind);
  }

  const result = await query(
    `SELECT
        b.*,
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
        p.default_binding_scope,
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
        r.id AS binding_revision_id,
        r.version AS binding_revision_version,
        r.status AS binding_revision_status,
        r.manifest AS binding_revision_manifest,
        r.config_schema AS binding_revision_config_schema,
        r.default_config AS binding_revision_default_config,
        r.transport AS binding_revision_transport,
        r.entry_point AS binding_revision_entry_point,
        r.tools_manifest AS binding_revision_tools_manifest,
        r.validation_rules AS binding_revision_validation_rules,
        r.setup_steps AS binding_revision_setup_steps,
        r.metadata AS binding_revision_metadata,
        r.created_by AS binding_revision_created_by,
        r.created_at AS binding_revision_created_at
     FROM capability_bindings b
     JOIN capability_packages p ON p.id = b.package_id
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC`,
    values,
  );
  return result.rows.map(mapBinding);
}

export async function getCapabilityBinding(bindingId: string) {
  const result = await query(
    `SELECT
        b.*,
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
        p.default_binding_scope,
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
        r.id AS binding_revision_id,
        r.version AS binding_revision_version,
        r.status AS binding_revision_status,
        r.manifest AS binding_revision_manifest,
        r.config_schema AS binding_revision_config_schema,
        r.default_config AS binding_revision_default_config,
        r.transport AS binding_revision_transport,
        r.entry_point AS binding_revision_entry_point,
        r.tools_manifest AS binding_revision_tools_manifest,
        r.validation_rules AS binding_revision_validation_rules,
        r.setup_steps AS binding_revision_setup_steps,
        r.metadata AS binding_revision_metadata,
        r.created_by AS binding_revision_created_by,
        r.created_at AS binding_revision_created_at
     FROM capability_bindings b
     JOIN capability_packages p ON p.id = b.package_id
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE b.id = $1
     LIMIT 1`,
    [bindingId],
  );

  if (result.rows.length === 0) {
    throw new CapabilityError(404, 'Capability binding not found');
  }

  return mapBinding(result.rows[0]);
}

export function validateGrantHierarchy(bindingScope: CapabilityBindingScope, grantScope: CapabilityGrantScope): boolean {
  void bindingScope;
  return ['platform', 'workspace', 'conversation', 'actor_global', 'actor_conversation', 'user'].includes(grantScope);
}

export async function createCapabilityBinding(input: {
  workspaceId: string;
  packageId: string;
  revisionId?: string;
  bindingScope: CapabilityBindingScope;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  installMode?: CapabilityBindingInstallMode;
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

  const existing = await listCapabilityBindings(input.workspaceId, {
    packageId: input.packageId,
    bindingScope: input.bindingScope,
    conversationId: input.conversationId,
    actorId: input.actorId,
    userId: input.userId,
  });
  const duplicate = existing.find((binding) =>
    binding.revisionId === revisionId &&
    JSON.stringify(binding.configData || {}) === JSON.stringify(input.configData || {}) &&
    binding.reuseScope === (input.reuseScope || pkg.defaultReuseScope || 'conversation') &&
    (binding.idleTtlMs ?? null) === (input.idleTtlMs ?? pkg.defaultIdleTtlMs ?? null) &&
    (binding.maxAgeMs ?? null) === (input.maxAgeMs ?? pkg.defaultMaxAgeMs ?? null) &&
    binding.requiresHandshake === (input.requiresHandshake ?? pkg.requiresHandshake),
  );
  if (duplicate) {
    return duplicate;
  }

  const result = await query(
    `INSERT INTO capability_bindings (
       workspace_id, package_id, revision_id, binding_scope, conversation_id, actor_id, user_id,
       install_mode, is_enabled, config_data, reuse_scope, idle_ttl_ms, max_age_ms,
       requires_handshake, installed_by, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      input.workspaceId,
      input.packageId,
      revisionId,
      input.bindingScope,
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

  const bindings = await listCapabilityBindings(input.workspaceId, { packageId: input.packageId });
  return bindings.find((binding) => binding.id === result.rows[0].id)!;
}

export async function updateCapabilityBinding(bindingId: string, data: {
  isEnabled?: boolean;
  configData?: JsonMap;
  bindingScope?: CapabilityBindingScope;
  conversationId?: string | null;
  actorId?: string | null;
  userId?: string | null;
  reuseScope?: CapabilityReuseScope;
  idleTtlMs?: number | null;
  maxAgeMs?: number | null;
  requiresHandshake?: boolean;
  metadata?: JsonMap;
}) {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.isEnabled !== undefined) {
    sets.push(`is_enabled = $${idx++}`);
    values.push(data.isEnabled);
  }
  if (data.bindingScope !== undefined) {
    sets.push(`binding_scope = $${idx++}`);
    values.push(data.bindingScope);
  }
  if (data.conversationId !== undefined) {
    sets.push(`conversation_id = $${idx++}`);
    values.push(data.conversationId);
  }
  if (data.actorId !== undefined) {
    sets.push(`actor_id = $${idx++}`);
    values.push(data.actorId);
  }
  if (data.userId !== undefined) {
    sets.push(`user_id = $${idx++}`);
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

  values.push(bindingId);
  const result = await query(
    `UPDATE capability_bindings
     SET ${sets.join(', ')}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );

  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability binding not found');
  const workspaceId = result.rows[0].workspace_id;
  const bindings = await listCapabilityBindings(workspaceId, { packageId: result.rows[0].package_id });
  return bindings.find((binding) => binding.id === bindingId)!;
}

export async function deleteCapabilityBinding(bindingId: string) {
  const result = await query(`DELETE FROM capability_bindings WHERE id = $1 RETURNING *`, [bindingId]);
  if (result.rows.length === 0) throw new CapabilityError(404, 'Capability binding not found');
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
  acceptableBindingScopes?: CapabilityBindingScope[];
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
         target_publisher_slug, target_package_slug, target_tag, acceptable_binding_scopes,
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
        requirement.acceptableBindingScopes || [],
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
  const [requirements, bindings] = await Promise.all([
    listRevisionRequirements(input.revisionId),
    listCapabilityBindings(input.workspaceId),
  ]);

  const checks: CapabilityRequirementCheck[] = requirements.map((requirement) => {
    const matchedBindings = bindings.filter((binding) => targetMatchesBinding(requirement, binding));
    const scopeCompatible = matchedBindings.filter((binding) =>
      requirement.acceptableBindingScopes.length === 0 ||
      requirement.acceptableBindingScopes.includes(binding.bindingScope),
    );
    const reuseCompatible = scopeCompatible.filter((binding) =>
      requirement.acceptableReuseScopes.length === 0 ||
      requirement.acceptableReuseScopes.includes(binding.reuseScope),
    );
    const configCompatible = reuseCompatible.filter((binding) =>
      configPredicateSatisfied(binding.configData, requirement.configPredicate),
    );

    if (configCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'satisfied',
        message: requirement.description || 'Requirement satisfied',
        matchedBindingIds: configCompatible.map((binding) => binding.id),
      };
    }

    if (reuseCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'config_incomplete',
        message: requirement.description || 'Binding exists but configuration is incomplete',
        matchedBindingIds: reuseCompatible.map((binding) => binding.id),
      };
    }

    if (scopeCompatible.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'scope_mismatch',
        message: requirement.description || 'Binding exists but reuse policy does not match',
        matchedBindingIds: scopeCompatible.map((binding) => binding.id),
      };
    }

    if (matchedBindings.length > 0) {
      return {
        requirementId: requirement.id,
        requirementKind: requirement.requirementKind,
        status: 'scope_mismatch',
        message: requirement.description || 'Binding exists but scope does not match',
        matchedBindingIds: matchedBindings.map((binding) => binding.id),
      };
    }

    const missingStatus = requirement.requirementKind === 'recommended' ? 'missing_recommended' : 'missing_required';
    return {
      requirementId: requirement.id,
      requirementKind: requirement.requirementKind,
      status: missingStatus,
      message: requirement.description || 'Requirement is not installed',
      matchedBindingIds: [],
      missingPublisherSlug: requirement.targetPublisherSlug,
      missingPackageSlug: requirement.targetPackageSlug,
      missingTag: requirement.targetTag,
    };
  });

  return checks;
}

export async function listCapabilityGrants(bindingId: string) {
  const result = await query(
    `SELECT * FROM capability_grants WHERE binding_id = $1 ORDER BY created_at DESC`,
    [bindingId],
  );
  return result.rows.map((row: any): CapabilityGrant => ({
    id: row.id,
    bindingId: row.binding_id,
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

export async function issueCapabilityGrant(input: {
  bindingId: string;
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
  const binding = await getCapabilityBinding(input.bindingId);
  if (binding.workspaceId !== input.workspaceId) {
    throw new CapabilityError(404, 'Capability binding not found');
  }

  const requiredPermissions = binding.revision?.authorization?.requiredPermissions || [];
  const permissions = (input.permissions && input.permissions.length > 0)
    ? Array.from(new Set(input.permissions))
    : requiredPermissions;

  const grantScope = input.grantScope || inferDefaultGrantScope(binding);
  if (!validateGrantHierarchy(binding.bindingScope, grantScope)) {
    throw new CapabilityError(400, `Grant scope '${grantScope}' is not valid for binding scope '${binding.bindingScope}'`);
  }

  let conversationId = input.conversationId;
  let actorId = input.actorId;
  let userId = input.userId;

  if (grantScope === 'conversation') {
    conversationId = conversationId || binding.conversationId;
    if (!conversationId) {
      throw new CapabilityError(400, 'conversationId is required for conversation grants');
    }
    actorId = undefined;
    userId = undefined;
  } else if (grantScope === 'actor_global') {
    actorId = actorId || binding.actorId;
    if (!actorId) {
      throw new CapabilityError(400, 'actorId is required for actor_global grants');
    }
    conversationId = undefined;
    userId = undefined;
  } else if (grantScope === 'actor_conversation') {
    actorId = actorId || binding.actorId;
    conversationId = conversationId || binding.conversationId;
    if (!actorId || !conversationId) {
      throw new CapabilityError(400, 'actorId and conversationId are required for actor_conversation grants');
    }
    userId = undefined;
  } else if (grantScope === 'user') {
    userId = userId || binding.userId;
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

  const existingGrants = await listCapabilityGrants(binding.id);
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
    `INSERT INTO capability_grants (
       binding_id, workspace_id, grant_scope, conversation_id, actor_id, user_id,
       permissions, status, granted_by, reason, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10)
     RETURNING *`,
    [
      binding.id,
      input.workspaceId,
      grantScope,
      conversationId || null,
      actorId || null,
      userId || null,
      permissions,
      input.grantedBy || null,
      input.reason || binding.revision?.authorization?.reason || null,
      JSON.stringify(input.metadata || {}),
    ],
  );

  return listCapabilityGrants(binding.id).then((grants) => grants.find((grant) => grant.id === result.rows[0].id)!);
}

export async function revokeCapabilityGrant(grantId: string, workspaceId: string) {
  const result = await query(
    `UPDATE capability_grants
     SET status = 'revoked', revoked_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'active'
     RETURNING *`,
    [grantId, workspaceId],
  );

  if (result.rows.length === 0) {
    throw new CapabilityError(404, 'Capability grant not found');
  }

  const row = result.rows[0];
  return {
    id: row.id,
    bindingId: row.binding_id,
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

export async function getCapabilityAuthorizationSummary(input: {
  bindingId: string;
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
}) {
  const binding = await getCapabilityBinding(input.bindingId);
  if (binding.workspaceId !== input.workspaceId) {
    throw new CapabilityError(404, 'Capability binding not found');
  }

  const grants = await listCapabilityGrants(binding.id);
  const activeGrants = grants.filter((grant) => grant.status === 'active');
  const requiredPermissions = binding.revision?.authorization?.requiredPermissions || [];
  const matchingGrants = activeGrants.filter((grant) =>
    grantCoversRuntimeTarget(grant, {
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
      userCount: input.userCount,
    }),
  );
  const effectivePermissions = Array.from(new Set(matchingGrants.flatMap((grant) => grant.permissions)));
  const matchingGrantIds = matchingGrants
    .filter((grant) => requiredPermissions.length === 0 || isPermissionSubset(requiredPermissions, effectivePermissions))
    .map((grant) => grant.id);
  const visibleByBinding = bindingMatchesRuntimeTarget(binding, {
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    userCount: input.userCount,
  });

  return {
    binding,
    requiredPermissions,
    suggestedGrantScope: requiredPermissions.length > 0 ? inferDefaultGrantScope(binding) : undefined,
    reason: binding.revision?.authorization?.reason,
    grants,
    effectivePermissions,
    isVisible: visibleByBinding || matchingGrantIds.length > 0,
    isAuthorized:
      (requiredPermissions.length === 0 && (visibleByBinding || matchingGrantIds.length > 0)) ||
      (requiredPermissions.length > 0 && isPermissionSubset(requiredPermissions, effectivePermissions)),
    matchingGrantIds,
  };
}

export async function ensureDefaultCapabilityGrant(input: {
  bindingId: string;
  workspaceId: string;
  grantedBy?: string;
}) {
  const summary = await getCapabilityAuthorizationSummary({
    bindingId: input.bindingId,
    workspaceId: input.workspaceId,
  });

  if (summary.requiredPermissions.length === 0 || summary.isAuthorized) {
    return null;
  }

  return issueCapabilityGrant({
    bindingId: input.bindingId,
    workspaceId: input.workspaceId,
    grantScope: summary.suggestedGrantScope,
    permissions: summary.requiredPermissions,
    grantedBy: input.grantedBy,
    reason: summary.reason,
  });
}

export function buildCapabilityGrantPlan(input: {
  revision?: CapabilityPackageRevision;
  bindingScope: CapabilityBindingScope;
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
  if (!suggestedGrantScope || !validateGrantHierarchy(input.bindingScope, suggestedGrantScope)) {
    suggestedGrantScope = input.bindingScope;
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
    suggestedGrantScope = input.bindingScope;
  }
  if (suggestedGrantScope === 'actor_global' && !input.actorId) {
    suggestedGrantScope = input.bindingScope;
  }
  if (suggestedGrantScope === 'actor_conversation' && (!input.actorId || !input.conversationId)) {
    suggestedGrantScope = input.bindingScope;
  }
  if (suggestedGrantScope === 'user' && !input.userId) {
    suggestedGrantScope = input.bindingScope;
  }

  return {
    requiresGrant: true,
    requiredPermissions,
    suggestedGrantScope,
    reason: authorization?.reason,
  };
}

export async function listAuthorizedCapabilityBindings(input: {
  workspaceId: string;
  kind?: CapabilityPackageKind;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  userCount?: number;
}) {
  const bindings = await listCapabilityBindings(input.workspaceId, {
    kind: input.kind,
  });
  const candidates: Array<{ binding: CapabilityBinding; grantScore: number; bindingScore: number; sortTime: number }> = [];

  for (const binding of bindings) {
    const requiredPermissions = binding.revision?.authorization?.requiredPermissions || [];
    const grants = await listCapabilityGrants(binding.id);
    const matchingGrants = grants.filter((grant) =>
      grant.status === 'active' &&
      grantCoversRuntimeTarget(grant, {
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: input.userId,
        userCount: input.userCount,
      }),
    );
    const effectivePermissions = Array.from(new Set(matchingGrants.flatMap((grant) => grant.permissions)));
    const visibleByBinding = bindingMatchesRuntimeTarget(binding, {
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
      userCount: input.userCount,
    });
    const isVisible = visibleByBinding || matchingGrants.length > 0;
    const isAuthorized = requiredPermissions.length === 0
      ? isVisible
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
      const bindingScore = (() => {
        switch (binding.bindingScope) {
          case 'actor_conversation': return 5;
          case 'conversation': return 4;
          case 'actor_global': return 3;
          case 'user': return 2;
          case 'workspace': return 1;
          default: return 0;
        }
      })();
      candidates.push({
        binding,
        grantScore: bestGrantScore,
        bindingScore,
        sortTime: new Date(binding.updatedAt).getTime(),
      });
    }
  }

  return candidates
    .sort((left, right) =>
      right.grantScore - left.grantScore ||
      right.bindingScore - left.bindingScore ||
      right.sortTime - left.sortTime,
    )
    .map((entry) => entry.binding);
}

export async function listVisibleCapabilityBindings(input: {
  workspaceId: string;
  kind?: CapabilityPackageKind;
  conversationId?: string;
  actorId?: string;
  userId?: string;
  userCount?: number;
}) {
  const values: unknown[] = [input.workspaceId];
  let idx = 2;
  const where = ['b.workspace_id = $1', 'b.is_enabled = TRUE', 'p.is_active = TRUE'];

  if (input.kind) {
    where.push(`p.kind = $${idx++}`);
    values.push(input.kind);
  }

  if (input.actorId && input.conversationId) {
    where.push(
      `(b.binding_scope = 'workspace'
        OR (b.binding_scope = 'conversation' AND b.conversation_id = $${idx})
        OR (b.binding_scope = 'actor_global' AND b.actor_id = $${idx + 1})
        OR (b.binding_scope = 'actor_conversation' AND b.conversation_id = $${idx} AND b.actor_id = $${idx + 1})
        OR (b.binding_scope = 'user' AND $${idx + 2}::uuid IS NOT NULL AND $${idx + 3}::int = 1 AND b.user_id = $${idx + 2}))`,
    );
    values.push(input.conversationId, input.actorId, input.userId || null, input.userCount ?? 0);
    idx += 4;
  } else if (input.conversationId) {
    where.push(
      `(b.binding_scope = 'workspace'
        OR (b.binding_scope = 'conversation' AND b.conversation_id = $${idx})
        OR (b.binding_scope = 'user' AND $${idx + 1}::uuid IS NOT NULL AND $${idx + 2}::int = 1 AND b.user_id = $${idx + 1}))`,
    );
    values.push(input.conversationId, input.userId || null, input.userCount ?? 0);
    idx += 3;
  } else if (input.actorId) {
    where.push(
      `(b.binding_scope = 'workspace'
        OR (b.binding_scope = 'actor_global' AND b.actor_id = $${idx})
        OR (b.binding_scope = 'user' AND $${idx + 1}::uuid IS NOT NULL AND $${idx + 2}::int = 1 AND b.user_id = $${idx + 1}))`,
    );
    values.push(input.actorId, input.userId || null, input.userCount ?? 0);
    idx += 3;
  } else if (input.userId && input.userCount === 1) {
    where.push(
      `(b.binding_scope = 'workspace' OR (b.binding_scope = 'user' AND b.user_id = $${idx}))`,
    );
    values.push(input.userId);
    idx += 1;
  } else {
    where.push(`b.binding_scope = 'workspace'`);
  }

  const result = await query(
    `SELECT
        b.*,
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
        p.default_binding_scope,
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
        r.id AS binding_revision_id,
        r.version AS binding_revision_version,
        r.status AS binding_revision_status,
        r.manifest AS binding_revision_manifest,
        r.config_schema AS binding_revision_config_schema,
        r.default_config AS binding_revision_default_config,
        r.transport AS binding_revision_transport,
        r.entry_point AS binding_revision_entry_point,
        r.tools_manifest AS binding_revision_tools_manifest,
        r.validation_rules AS binding_revision_validation_rules,
        r.setup_steps AS binding_revision_setup_steps,
        r.metadata AS binding_revision_metadata,
        r.created_by AS binding_revision_created_by,
        r.created_at AS binding_revision_created_at
     FROM capability_bindings b
     JOIN capability_packages p ON p.id = b.package_id
     JOIN capability_publishers pub ON pub.id = p.publisher_id
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC`,
    values,
  );
  return result.rows.map(mapBinding);
}

export function dedupeVisibleBindings<T extends CapabilityBinding>(
  bindings: T[],
  keySelector: (binding: T) => string,
) {
  const deduped = new Map<string, T>();
  for (const binding of bindings) {
    const key = keySelector(binding);
    if (!deduped.has(key)) {
      deduped.set(key, binding);
    }
  }
  return Array.from(deduped.values());
}

export function bindingToAvailableSkill(binding: CapabilityBinding): CapabilityAvailableSkill | null {
  if (!binding.package || !binding.revision || binding.package.kind !== 'skill') return null;
  const frontmatter = asObject(asObject(binding.revision.manifest).frontmatter);
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
    ? frontmatter.name.trim()
    : binding.package.slug;
  const description = typeof frontmatter.description === 'string' && frontmatter.description.trim().length > 0
    ? frontmatter.description.trim()
    : binding.package.description;
  return {
    bindingId: binding.id,
    packageId: binding.packageId,
    revisionId: binding.revisionId,
    slug: binding.package.slug,
    name,
    description,
    version: binding.revision.version,
    bindingScope: binding.bindingScope,
    actorId: binding.actorId,
    conversationId: binding.conversationId,
    userId: binding.userId,
    entryPoint: binding.revision.entryPoint || undefined,
  };
}
