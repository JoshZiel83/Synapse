import crypto from 'node:crypto';
import {
  normalizeCanonicalContentBlocks,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  type CapabilityAvailableSkill,
  type CapabilityAttachmentType,
  type CapabilityAsset,
  type CapabilityInstance,
  type CapabilityPackage,
  type InstalledSkill,
  type SkillAttachmentFile,
  type SkillMarketplaceEntry,
  type SkillMarketplaceWorkspaceInstallation,
  type SkillMarketplaceVersion,
  type SkillUseScope,
} from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import {
  CapabilityError,
  createCapabilityInstance,
  createCapabilityPackage,
  createCapabilityPublisher,
  createCapabilityRevision,
  deleteCapabilityInstance,
  getCapabilityInstance,
  getCapabilityPackage,
  instanceToAvailableSkill,
  issueCapabilityInstanceGrant,
  listCapabilityAssets,
  listCapabilityInstances,
  listCapabilityPackages,
  listVisibleCapabilityInstances,
  updateCapabilityInstance,
  updateCapabilityPackage,
  upsertCapabilityPackageLineage,
} from '../capabilities/service.js';

type JsonMap = Record<string, unknown>;

const SKILL_DESCRIPTION_ASSET_PATH = '(description)';

type SkillAttachmentInput = {
  path: string;
  contentBlocks: CanonicalContentBlockInput[];
};

type SkillDefinition = {
  canonicalSlug: string;
  name: string;
  description: CanonicalContentBlock;
};

type SkillSourceLink = {
  sourcePackageId?: string;
  sourceRevisionId?: string;
  sourceVersion?: string;
  sourcePublisherId?: string;
  sourcePublisherSlug?: string;
  sourceDisplayName?: string;
  sourceSlug?: string;
  syncMode?: 'manual_merge' | 'follow_upstream' | 'notify' | 'detached';
};

export class SkillError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function wrapCapabilityError(error: unknown): never {
  if (error instanceof CapabilityError) {
    throw new SkillError(error.statusCode, error.message);
  }
  throw error;
}

function sanitizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizePath(assetPath: string) {
  const value = assetPath.replace(/\\/g, '/').trim();
  if (!value || value.startsWith('/') || value.includes('\0')) {
    throw new SkillError(400, `Invalid skill file path: ${assetPath}`);
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new SkillError(400, `Invalid skill file path: ${assetPath}`);
  }
  return segments.join('/');
}

function normalizeSkillDescription(description?: CanonicalContentBlockInput) {
  const normalized = normalizeCanonicalContentBlocks(
    description
      ? [description]
      : [
          {
            type: 'text',
            text: '',
          },
        ],
  );

  const [first] = normalized;
  if (!first) {
    throw new SkillError(400, 'Skill description is required');
  }

  return first;
}

function normalizeSkillAttachments(files?: SkillAttachmentInput[]) {
  if (!Array.isArray(files) || files.length === 0) {
    return [] as Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>;
  }

  const normalized = files.map((file) => ({
    path: normalizePath(file.path),
    contentBlocks: normalizeCanonicalContentBlocks(Array.isArray(file.contentBlocks) ? file.contentBlocks : []),
  }));

  const seen = new Set<string>();
  for (const file of normalized) {
    if (seen.has(file.path)) {
      throw new SkillError(400, `Duplicate skill file path: ${file.path}`);
    }
    seen.add(file.path);
  }

  return normalized;
}

function normalizeScopeTarget(input: {
  useScope: SkillUseScope;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}) {
  switch (input.useScope) {
    case 'workspace':
      return {
        actorId: null,
        conversationId: null,
        userId: null,
      };
    case 'conversation':
      if (!input.conversationId) {
        throw new SkillError(400, 'conversationId is required for conversation scope');
      }
      return {
        actorId: null,
        conversationId: input.conversationId,
        userId: null,
      };
    case 'actor_global':
      if (!input.actorId) {
        throw new SkillError(400, 'actorId is required for actor_global scope');
      }
      return {
        actorId: input.actorId,
        conversationId: null,
        userId: null,
      };
    case 'actor_conversation':
      if (!input.actorId || !input.conversationId) {
        throw new SkillError(400, 'actorId and conversationId are required for actor_conversation scope');
      }
      return {
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: null,
      };
    case 'user':
      if (!input.userId) {
        throw new SkillError(400, 'userId is required for user scope');
      }
      return {
        actorId: null,
        conversationId: null,
        userId: input.userId,
      };
    default:
      throw new SkillError(400, `Unsupported skill scope: ${String(input.useScope)}`);
  }
}

function renderSkillBlocksToText(blocks: CanonicalContentBlock[]) {
  return blocks
    .map((block) =>
      block.type === 'text'
        ? block.text
        : `[File: ${block.originalName} | ${block.mimeType} | ${block.url}]`,
    )
    .filter((chunk) => chunk.trim().length > 0)
    .join('\n');
}

function renderSkillDescriptionToText(description: CanonicalContentBlock) {
  return renderSkillBlocksToText([description]);
}

function hashValue(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deriveSkillAssetKind(assetPath: string): CapabilityAsset['assetKind'] {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith('.md')) return 'reference_markdown';
  return 'text';
}

function toAttachmentType(useScope: SkillUseScope): CapabilityAttachmentType {
  return useScope;
}

function asObject(value: unknown): JsonMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonMap;
}

function requiredPermissionsForRevision(revision?: {
  access?: { requiredPermissions?: string[] };
  authorization?: { requiredPermissions?: string[] };
}) {
  return revision?.access?.requiredPermissions || revision?.authorization?.requiredPermissions || [];
}

function grantReasonForRevision(revision?: {
  access?: { reason?: string };
  authorization?: { reason?: string };
}) {
  return revision?.access?.reason || revision?.authorization?.reason || undefined;
}

function buildSkillManifest(input: {
  canonicalSlug: string;
  name: string;
  description: CanonicalContentBlock;
}) {
  const descriptionText = renderSkillBlocksToText([input.description]);
  return {
    kind: 'skill',
    definition: {
      slug: input.canonicalSlug,
      name: input.name,
      description: input.description,
    },
    frontmatter: {
      slug: input.canonicalSlug,
      name: input.name,
      description: descriptionText,
    },
  } satisfies JsonMap;
}

function buildSkillAssets(files: ReturnType<typeof normalizeSkillAttachments>) {
  return files.map((file) => ({
    path: file.path,
    assetKind: deriveSkillAssetKind(file.path),
    mediaType: 'text/markdown',
    textContent: renderSkillBlocksToText(file.contentBlocks),
    sha256: hashValue({
      path: file.path,
      contentBlocks: file.contentBlocks,
    }),
    metadata: {
      contentBlocks: file.contentBlocks,
    },
  })) satisfies Array<{
    path: string;
    assetKind: CapabilityAsset['assetKind'];
    mediaType?: string;
    textContent?: string;
    sha256: string;
    metadata?: JsonMap;
  }>;
}

function mapAssetToSkillAttachment(asset: CapabilityAsset): SkillAttachmentFile {
  const metadata = asObject(asset.metadata);
  const contentBlocks = normalizeCanonicalContentBlocks(
    Array.isArray(metadata.contentBlocks)
      ? metadata.contentBlocks
      : asset.textContent
        ? [{ type: 'text', text: asset.textContent }]
        : [],
  );

  return {
    id: asset.id,
    path: asset.path,
    contentBlocks,
    createdAt: asset.createdAt,
    updatedAt: asset.createdAt,
  };
}

async function listRevisionAttachments(revisionId: string): Promise<SkillAttachmentFile[]> {
  const assets = await listCapabilityAssets(revisionId);
  return assets.map(mapAssetToSkillAttachment);
}

function fallbackSkillDescription(text?: string) {
  return normalizeSkillDescription({
    type: 'text',
    text: text || '',
  });
}

function readSkillDefinition(input: {
  pkg?: CapabilityPackage;
  revision?: CapabilityPackage['latestRevision'] | CapabilityInstance['revision'];
}) : SkillDefinition {
  const revision = input.revision;
  const manifest = asObject(revision?.manifest);
  const definition = asObject(manifest.definition);
  const frontmatter = asObject(manifest.frontmatter);
  const packageMetadata = asObject(input.pkg?.metadata);
  const canonicalSlug = typeof definition.slug === 'string' && definition.slug.trim().length > 0
    ? definition.slug.trim()
    : typeof frontmatter.slug === 'string' && frontmatter.slug.trim().length > 0
      ? frontmatter.slug.trim()
      : typeof packageMetadata.canonicalSlug === 'string' && packageMetadata.canonicalSlug.trim().length > 0
        ? packageMetadata.canonicalSlug.trim()
        : input.pkg?.slug || '';
  const name = typeof definition.name === 'string' && definition.name.trim().length > 0
    ? definition.name.trim()
    : typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
      ? frontmatter.name.trim()
      : input.pkg?.displayName || canonicalSlug;
  const descriptionValue = definition.description;
  const description =
    descriptionValue && typeof descriptionValue === 'object' && !Array.isArray(descriptionValue)
      ? normalizeSkillDescription(descriptionValue as CanonicalContentBlockInput)
      : fallbackSkillDescription(
          typeof frontmatter.description === 'string'
            ? frontmatter.description
            : input.pkg?.description,
        );

  return {
    canonicalSlug,
    name,
    description,
  };
}

function extractSkillSourceLink(pkg: CapabilityPackage): SkillSourceLink {
  const metadata = asObject(pkg.metadata);
  return {
    sourcePackageId: pkg.sourceLink?.upstreamPackageId || (typeof metadata.sourcePackageId === 'string' ? metadata.sourcePackageId : undefined),
    sourceRevisionId: pkg.sourceLink?.upstreamRevisionId || (typeof metadata.sourceRevisionId === 'string' ? metadata.sourceRevisionId : undefined),
    sourceVersion: typeof metadata.sourceVersion === 'string' ? metadata.sourceVersion : undefined,
    sourcePublisherId: typeof metadata.sourcePublisherId === 'string' ? metadata.sourcePublisherId : undefined,
    sourcePublisherSlug: typeof metadata.sourcePublisherSlug === 'string' ? metadata.sourcePublisherSlug : undefined,
    sourceDisplayName: typeof metadata.sourceDisplayName === 'string' ? metadata.sourceDisplayName : undefined,
    sourceSlug: typeof metadata.sourceSlug === 'string' ? metadata.sourceSlug : undefined,
    syncMode: pkg.sourceLink?.syncMode || (typeof metadata.syncMode === 'string' ? metadata.syncMode as SkillSourceLink['syncMode'] : undefined),
  };
}

function resolveCanonicalSkillSlug(pkg: CapabilityPackage): string {
  return readSkillDefinition({
    pkg,
    revision: pkg.latestRevision,
  }).canonicalSlug || pkg.slug;
}

async function ensureMarketplacePublisher(userId?: string) {
  const slug = userId ? `user-${userId}` : 'synapse-skill-market';
  const displayName = userId ? `User ${userId.slice(0, 8)}` : 'Synapse Skill Market';
  return createCapabilityPublisher({
    slug,
    displayName,
    description: userId
      ? `User-owned package publisher for ${userId}.`
      : 'Default publisher for skill marketplace packages.',
    ownerUserId: userId,
    isBuiltin: !userId,
    isVerified: !userId,
  });
}

async function ensureWorkspaceLocalPublisher(workspaceId: string, ownerUserId?: string) {
  return createCapabilityPublisher({
    slug: `workspace-${workspaceId}`,
    displayName: `Workspace ${workspaceId.slice(0, 8)}`,
    description: `Workspace-local package publisher for ${workspaceId}.`,
    ownerUserId,
    isBuiltin: false,
    isVerified: false,
  });
}

function buildLocalSkillPackageSlug(sourceSlug: string) {
  const parts = [sourceSlug, 'copy'];
  parts.push(crypto.randomUUID().slice(0, 8));
  return sanitizeSlug(parts.join('-'));
}

async function getSkillPackage(skillId: string) {
  const pkg = await getCapabilityPackage(skillId);
  if (pkg.kind !== 'skill') {
    throw new SkillError(404, 'Skill not found');
  }
  return pkg;
}

function buildMarketplaceVersion(pkg: CapabilityPackage): SkillMarketplaceVersion | undefined {
  if (!pkg.latestRevision) return undefined;
  const definition = readSkillDefinition({
    pkg,
    revision: pkg.latestRevision,
  });
  return {
    id: pkg.latestRevision.id,
    skillId: pkg.id,
    version: pkg.latestRevision.version,
    changelog: typeof pkg.latestRevision.metadata.changelog === 'string' ? pkg.latestRevision.metadata.changelog : '',
    description: definition.description,
    createdBy: pkg.latestRevision.createdBy,
    createdByName: pkg.publisher?.displayName,
    createdAt: pkg.latestRevision.createdAt,
    attachmentFiles: undefined,
  };
}

function resolveInstalledSkillSource(instance: CapabilityInstance) {
  if (!instance.package || !instance.revision || instance.package.kind !== 'skill') {
    throw new SkillError(404, 'Installed skill not found');
  }

  const pkg = instance.package;
  const sourceLink = extractSkillSourceLink(pkg);
  const sourcePackageId = sourceLink.sourcePackageId || (!pkg.workspaceId ? pkg.id : undefined);
  const sourceRevisionId = sourceLink.sourceRevisionId || (!pkg.workspaceId ? instance.revisionId : undefined);
  const sourceVersion = sourceLink.sourceVersion || (!pkg.workspaceId ? instance.revision.version : undefined);
  const isCustomized = Boolean(sourceLink.sourcePackageId && sourceRevisionId && instance.revisionId !== sourceRevisionId);

  return {
    pkg,
    revision: instance.revision,
    sourceLink,
    sourcePackageId,
    sourceRevisionId,
    sourceVersion,
    isCustomized,
  };
}

async function buildMarketplaceInstallationMap(workspaceId: string) {
  const instances = await listCapabilityInstances(workspaceId, {
    kind: 'skill',
  });

  const map = new Map<string, SkillMarketplaceWorkspaceInstallation & { _updatedAt: string }>();
  for (const instance of instances) {
    if (!instance.package || instance.package.kind !== 'skill') continue;
    const source = resolveInstalledSkillSource(instance);
    if (!source.sourcePackageId) continue;

    const current = map.get(source.sourcePackageId);
    const nextCount = (current?.installedCount || 0) + 1;
    const shouldReplacePrimary =
      !current || new Date(instance.updatedAt).getTime() > new Date(current._updatedAt).getTime();

    map.set(source.sourcePackageId, {
      installed: true,
      installedSkillId: shouldReplacePrimary ? instance.id : current?.installedSkillId,
      installedCount: nextCount,
      _updatedAt: shouldReplacePrimary ? instance.updatedAt : current!._updatedAt,
    });
  }

  return map;
}

function mapMarketplaceEntry(
  pkg: CapabilityPackage,
  workspaceInstallation?: SkillMarketplaceWorkspaceInstallation,
): SkillMarketplaceEntry {
  const definition = readSkillDefinition({
    pkg,
    revision: pkg.latestRevision,
  });
  return {
    id: pkg.id,
    slug: definition.canonicalSlug,
    name: definition.name,
    description: definition.description,
    iconUrl: pkg.iconUrl || undefined,
    tags: pkg.tags || [],
    authorUserId: pkg.publisher?.ownerUserId,
    authorName: pkg.publisher?.displayName,
    isActive: pkg.isActive,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
    latestVersionId: pkg.latestRevisionId,
    latestVersion: buildMarketplaceVersion(pkg),
    workspaceInstallation,
  };
}

async function mapInstalledSkill(instance: CapabilityInstance, includeFiles = false): Promise<InstalledSkill> {
  const { pkg, revision, sourceLink, sourcePackageId, sourceRevisionId, sourceVersion, isCustomized } =
    resolveInstalledSkillSource(instance);

  let latestSourceVersion: string | undefined;
  let upgradeAvailable = false;
  if (sourceLink.sourcePackageId) {
    try {
      const sourcePkg = await getSkillPackage(sourceLink.sourcePackageId);
      latestSourceVersion = sourcePkg.latestRevision?.version;
      upgradeAvailable = Boolean(sourceRevisionId && sourcePkg.latestRevisionId && sourcePkg.latestRevisionId !== sourceRevisionId);
    } catch {
      latestSourceVersion = undefined;
    }
  } else if (!pkg.workspaceId) {
    latestSourceVersion = revision.version;
  }

  const definition = readSkillDefinition({
    pkg,
    revision,
  });
  const attachmentFiles = includeFiles ? await listRevisionAttachments(instance.revisionId) : undefined;

  return {
    id: instance.id,
    workspaceId: instance.workspaceId,
    slug: definition.canonicalSlug,
    name: definition.name,
    description: definition.description,
    iconUrl: pkg.iconUrl || undefined,
    tags: pkg.tags || [],
    useScope: instance.attachmentType as SkillUseScope,
    actorId: instance.actorId,
    conversationId: instance.conversationId,
    userId: instance.userId,
    isEnabled: instance.isEnabled,
    isCustomized,
    installedBy: instance.installedBy,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    sourceSkillId: sourcePackageId,
    sourceVersionId: sourceRevisionId,
    sourceVersion,
    upgradeAvailable,
    latestSourceVersion,
    attachmentFiles,
  };
}

export async function listMarketplaceSkills(filters?: {
  search?: string;
  tags?: string[];
  workspaceId?: string;
}) {
  try {
    const packages = await listCapabilityPackages({
      kind: 'skill',
      search: filters?.search?.trim() || undefined,
      tags: filters?.tags,
    });
    const installationMap = filters?.workspaceId
      ? await buildMarketplaceInstallationMap(filters.workspaceId)
      : null;
    return packages
      .filter((pkg) => !pkg.workspaceId)
      .map((pkg) =>
        mapMarketplaceEntry(
          pkg,
          installationMap?.get(pkg.id) || (filters?.workspaceId ? { installed: false, installedCount: 0 } : undefined),
        ),
      );
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getMarketplaceSkill(skillId: string, workspaceId?: string) {
  try {
    const pkg = await getSkillPackage(skillId);
    if (pkg.workspaceId) {
      throw new SkillError(404, 'Skill not found');
    }
    const installationMap = workspaceId ? await buildMarketplaceInstallationMap(workspaceId) : null;
    const skill = mapMarketplaceEntry(
      pkg,
      installationMap?.get(pkg.id) || (workspaceId ? { installed: false, installedCount: 0 } : undefined),
    );
    if (skill.latestVersionId) {
      skill.latestVersion = {
        ...skill.latestVersion!,
        attachmentFiles: await listRevisionAttachments(skill.latestVersionId),
      };
    }
    return skill;
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function publishMarketplaceSkill(input: {
  skillId?: string;
  slug: string;
  name: string;
  description?: CanonicalContentBlockInput;
  iconUrl?: string;
  tags?: string[];
  version: string;
  changelog?: string;
  attachmentFiles?: SkillAttachmentInput[];
  authorUserId?: string;
  isActive?: boolean;
  metadata?: JsonMap;
}) {
  const canonicalSlug = sanitizeSlug(input.slug || input.name);
  if (!canonicalSlug) {
    throw new SkillError(400, 'Skill slug is required');
  }

  const name = input.name.trim();
  if (!name) {
    throw new SkillError(400, 'Skill name is required');
  }

  const version = input.version.trim();
  if (!version) {
    throw new SkillError(400, 'Skill version is required');
  }

  const description = normalizeSkillDescription(input.description);
  const descriptionText = renderSkillDescriptionToText(description);
  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);

  try {
    const existing = input.skillId ? await getSkillPackage(input.skillId) : null;
    const publisher = existing?.publisherId
      ? { id: existing.publisherId }
      : await ensureMarketplacePublisher(input.authorUserId);

    const pkg = existing
      ? await updateCapabilityPackage(existing.id, {
          slug: canonicalSlug,
          displayName: name,
          description: descriptionText,
          longDescription: descriptionText,
          iconUrl: input.iconUrl || null,
          tags: input.tags || [],
          isActive: input.isActive ?? true,
          metadata: {
            ...(existing.metadata || {}),
            canonicalSlug,
            ...(input.metadata || {}),
          },
        })
      : await createCapabilityPackage({
          publisherId: publisher.id,
          kind: 'skill',
          slug: canonicalSlug,
          displayName: name,
          description: descriptionText,
          longDescription: descriptionText,
          iconUrl: input.iconUrl || null,
          sourceType: 'official',
          tags: input.tags || [],
          isActive: input.isActive ?? true,
          defaultInstanceScope: 'workspace',
          defaultReuseScope: 'workspace',
          metadata: {
            canonicalSlug,
            ...(input.metadata || {}),
          },
        });

    await createCapabilityRevision({
      packageId: pkg.id,
      version,
      status: 'active',
      manifest: buildSkillManifest({
        canonicalSlug,
        name,
        description,
      }),
      metadata: {
        changelog: input.changelog || '',
        ...(input.metadata || {}),
      },
      createdBy: input.authorUserId,
      assets: buildSkillAssets(attachmentFiles),
      setLatest: true,
    });

    return getMarketplaceSkill(pkg.id);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function createWorkspaceSkill(input: {
  workspaceId: string;
  slug: string;
  name: string;
  description?: CanonicalContentBlockInput;
  iconUrl?: string;
  tags?: string[];
  attachmentFiles?: SkillAttachmentInput[];
  useScope: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  installedBy?: string;
}) {
  const canonicalSlug = sanitizeSlug(input.slug || input.name);
  if (!canonicalSlug) {
    throw new SkillError(400, 'Skill slug is required');
  }

  const name = input.name.trim();
  if (!name) {
    throw new SkillError(400, 'Skill name is required');
  }

  const description = normalizeSkillDescription(input.description);
  const descriptionText = renderSkillDescriptionToText(description);
  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);
  const target = normalizeScopeTarget({
    useScope: input.useScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });

  try {
    const localPublisher = await ensureWorkspaceLocalPublisher(input.workspaceId, input.installedBy);
    const pkg = await createCapabilityPackage({
      publisherId: localPublisher.id,
      workspaceId: input.workspaceId,
      kind: 'skill',
      slug: canonicalSlug,
      displayName: name,
      description: descriptionText,
      longDescription: descriptionText,
      iconUrl: input.iconUrl || null,
      sourceType: 'workspace_upload',
      tags: input.tags || [],
      isActive: true,
      defaultInstanceScope: 'workspace',
      defaultReuseScope: 'workspace',
      metadata: {
        canonicalSlug,
      },
    });

    const revision = await createCapabilityRevision({
      packageId: pkg.id,
      version: 'workspace-initial',
      status: 'active',
      manifest: buildSkillManifest({
        canonicalSlug,
        name,
        description,
      }),
      metadata: {
        createdAs: 'workspace_skill',
      },
      createdBy: input.installedBy,
      assets: buildSkillAssets(attachmentFiles),
      setLatest: true,
    });

    const instance = await createCapabilityInstance({
      workspaceId: input.workspaceId,
      packageId: pkg.id,
      revisionId: revision.id,
      attachmentType: 'workspace',
      reuseScope: 'workspace',
      installMode: 'manual',
      installedBy: input.installedBy,
    });

    await issueCapabilityInstanceGrant({
      instanceId: instance.id,
      workspaceId: input.workspaceId,
      grantScope: input.useScope,
      actorId: target.actorId || undefined,
      conversationId: target.conversationId || undefined,
      userId: target.userId || undefined,
      permissions: requiredPermissionsForRevision(revision),
      grantedBy: input.installedBy,
      reason: grantReasonForRevision(revision),
    });

    return getInstalledSkill(input.workspaceId, instance.id);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listInstalledSkills(workspaceId: string, filters?: {
  useScope?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  sourceSkillId?: string;
}) {
  try {
    const instances = await listCapabilityInstances(workspaceId, {
      kind: 'skill',
      attachmentType: filters?.useScope ? toAttachmentType(filters.useScope) : undefined,
      actorId: filters?.actorId,
      conversationId: filters?.conversationId,
      userId: filters?.userId,
    });

    const mapped = await Promise.all(instances.map((instance) => mapInstalledSkill(instance)));
    if (!filters?.sourceSkillId) return mapped;
    return mapped.filter((skill) => skill.sourceSkillId === filters.sourceSkillId);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function getInstalledSkill(workspaceId: string, installedSkillId: string) {
  try {
    const instance = await getCapabilityInstance(installedSkillId);
    if (instance.workspaceId !== workspaceId || instance.package?.kind !== 'skill') {
      throw new SkillError(404, 'Installed skill not found');
    }
    return mapInstalledSkill(instance, true);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

async function findExistingInstalledSkillInstance(input: {
  workspaceId: string;
  sourceSkillId: string;
}) {
  const instances = await listCapabilityInstances(input.workspaceId, {
    kind: 'skill',
  });

  return instances.find((instance) => {
    if (!instance.package || instance.package.kind !== 'skill') return false;
    const sourceLink = extractSkillSourceLink(instance.package);
    const effectiveSourceId = sourceLink.sourcePackageId || (!instance.package.workspaceId ? instance.package.id : undefined);
    return effectiveSourceId === input.sourceSkillId;
  }) || null;
}

export async function installMarketplaceSkill(input: {
  workspaceId: string;
  marketSkillId: string;
  useScope: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  installedBy?: string;
}) {
  const target = normalizeScopeTarget({
    useScope: input.useScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });

  try {
    const source = await getSkillPackage(input.marketSkillId);
    if (source.workspaceId) {
      throw new SkillError(400, 'Marketplace skill must be a global package');
    }
    if (!source.latestRevision) {
      throw new SkillError(400, 'Marketplace skill has no published version');
    }

    const existing = await findExistingInstalledSkillInstance({
      workspaceId: input.workspaceId,
      sourceSkillId: source.id,
    });
    if (existing) {
      await issueCapabilityInstanceGrant({
        instanceId: existing.id,
        workspaceId: input.workspaceId,
        grantScope: input.useScope,
        actorId: target.actorId || undefined,
        conversationId: target.conversationId || undefined,
        userId: target.userId || undefined,
        permissions: requiredPermissionsForRevision(existing.revision),
        grantedBy: input.installedBy,
        reason: grantReasonForRevision(existing.revision),
      });
      return getInstalledSkill(input.workspaceId, existing.id);
    }

    const localPublisher = await ensureWorkspaceLocalPublisher(input.workspaceId, input.installedBy);
    const localSlug = buildLocalSkillPackageSlug(resolveCanonicalSkillSlug(source));
    const localPackage = await createCapabilityPackage({
      publisherId: localPublisher.id,
      workspaceId: input.workspaceId,
      kind: 'skill',
      slug: localSlug,
      displayName: source.displayName,
      description: source.description,
      longDescription: source.longDescription,
      iconUrl: source.iconUrl,
      sourceType: 'workspace_upload',
      tags: source.tags,
      isActive: true,
      defaultInstanceScope: 'workspace',
      defaultReuseScope: 'workspace',
      metadata: {
        ...(source.metadata || {}),
        canonicalSlug: resolveCanonicalSkillSlug(source),
        sourceVersion: source.latestRevision.version,
        sourcePublisherId: source.publisherId,
        sourcePublisherSlug: source.publisher?.slug,
        sourceDisplayName: source.displayName,
        sourceSlug: resolveCanonicalSkillSlug(source),
      },
    });

    const assets = await listCapabilityAssets(source.latestRevision.id);
    const localRevision = await createCapabilityRevision({
      packageId: localPackage.id,
      version: source.latestRevision.version,
      status: 'active',
      manifest: source.latestRevision.manifest,
      configSchema: source.latestRevision.configSchema,
      defaultConfig: source.latestRevision.defaultConfig,
      metadata: {
        ...(source.latestRevision.metadata || {}),
        importedFromPackageId: source.id,
        importedFromRevisionId: source.latestRevision.id,
      },
      createdBy: input.installedBy,
      assets: assets.map((asset) => ({
        path: asset.path,
        assetKind: asset.assetKind,
        mediaType: asset.mediaType,
        textContent: asset.textContent,
        sha256: asset.sha256,
        metadata: asset.metadata,
      })),
      setLatest: true,
    });

    await upsertCapabilityPackageLineage({
      downstreamPackageId: localPackage.id,
      upstreamPackageId: source.id,
      upstreamRevisionId: source.latestRevision.id,
      lineageKind: 'installed_copy',
      syncMode: 'manual_merge',
      metadata: {
        installedFrom: 'marketplace',
      },
    });

    const instance = await createCapabilityInstance({
      workspaceId: input.workspaceId,
      packageId: localPackage.id,
      revisionId: localRevision.id,
      attachmentType: 'workspace',
      reuseScope: 'workspace',
      installMode: 'manual',
      installedBy: input.installedBy,
    });

    await issueCapabilityInstanceGrant({
      instanceId: instance.id,
      workspaceId: input.workspaceId,
      grantScope: input.useScope,
      actorId: target.actorId || undefined,
      conversationId: target.conversationId || undefined,
      userId: target.userId || undefined,
      permissions: requiredPermissionsForRevision(localRevision),
      grantedBy: input.installedBy,
      reason: grantReasonForRevision(localRevision),
    });

    await query(
      `UPDATE capability_packages
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [source.id],
    );

    return getInstalledSkill(input.workspaceId, instance.id);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function updateInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
  name?: string;
  description?: CanonicalContentBlockInput;
  iconUrl?: string | null;
  tags?: string[];
  isEnabled?: boolean;
  attachmentFiles?: SkillAttachmentInput[];
}) {
  try {
    const instance = await getCapabilityInstance(input.installedSkillId);
    if (instance.workspaceId !== input.workspaceId || instance.package?.kind !== 'skill' || !instance.package || !instance.revision) {
      throw new SkillError(404, 'Installed skill not found');
    }

    const currentAttachments = await listRevisionAttachments(instance.revisionId);
    const currentDefinition = readSkillDefinition({
      pkg: instance.package,
      revision: instance.revision,
    });
    const nextDescription = input.description
      ? normalizeSkillDescription(input.description)
      : currentDefinition.description;
    const normalizedAttachments = input.attachmentFiles
      ? normalizeSkillAttachments(input.attachmentFiles)
      : currentAttachments.map((file) => ({
          path: normalizePath(file.path),
          contentBlocks: normalizeCanonicalContentBlocks(file.contentBlocks),
        }));

    const touchesContent =
      input.name !== undefined ||
      input.description !== undefined ||
      input.iconUrl !== undefined ||
      input.tags !== undefined ||
      input.attachmentFiles !== undefined;

    let nextRevisionId = instance.revisionId;
    if (touchesContent) {
      if (!instance.package.workspaceId) {
        throw new SkillError(400, 'Linked marketplace skills must be copied locally before editing');
      }

      const canonicalSlug = resolveCanonicalSkillSlug(instance.package);
      const nextName = input.name?.trim() || currentDefinition.name;
      const nextDescriptionText = renderSkillDescriptionToText(nextDescription);

      await updateCapabilityPackage(instance.package.id, {
        displayName: nextName,
        description: nextDescriptionText,
        longDescription: nextDescriptionText,
        iconUrl: input.iconUrl === undefined ? instance.package.iconUrl || null : input.iconUrl,
        tags: input.tags ?? instance.package.tags,
        metadata: {
          ...(instance.package.metadata || {}),
          canonicalSlug,
        },
      });

      const nextRevision = await createCapabilityRevision({
        packageId: instance.package.id,
        version: `local-${Date.now()}`,
        status: 'active',
        manifest: buildSkillManifest({
          canonicalSlug,
          name: nextName,
          description: nextDescription,
        }),
        metadata: {
          ...(instance.revision.metadata || {}),
          lastEditedAt: new Date().toISOString(),
        },
        createdBy: instance.installedBy,
        assets: buildSkillAssets(normalizedAttachments),
        setLatest: true,
      });
      nextRevisionId = nextRevision.id;
    }

    await updateCapabilityInstance(input.installedSkillId, {
      revisionId: nextRevisionId !== instance.revisionId ? nextRevisionId : undefined,
      isEnabled: input.isEnabled,
    });

    return getInstalledSkill(input.workspaceId, input.installedSkillId);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
}) {
  try {
    const instance = await getCapabilityInstance(input.installedSkillId);
    if (instance.workspaceId !== input.workspaceId || instance.package?.kind !== 'skill' || !instance.package || !instance.revision) {
      throw new SkillError(404, 'Installed skill not found');
    }

    const sourceLink = extractSkillSourceLink(instance.package);
    if (!sourceLink.sourcePackageId) {
      throw new SkillError(400, 'Installed skill has no marketplace source');
    }

    const source = await getSkillPackage(sourceLink.sourcePackageId);
    if (!source.latestRevision) {
      throw new SkillError(400, 'Marketplace source has no latest version');
    }

    const assets = await listCapabilityAssets(source.latestRevision.id);
    const canonicalSlug = resolveCanonicalSkillSlug(source);
    await updateCapabilityPackage(instance.package.id, {
      displayName: source.displayName,
      description: source.description,
      longDescription: source.longDescription,
      iconUrl: source.iconUrl || null,
      tags: source.tags,
      metadata: {
        ...(instance.package.metadata || {}),
        canonicalSlug,
        sourceVersion: source.latestRevision.version,
        sourcePublisherId: source.publisherId,
        sourcePublisherSlug: source.publisher?.slug,
        sourceDisplayName: source.displayName,
        sourceSlug: canonicalSlug,
      },
    });

    const revision = await createCapabilityRevision({
      packageId: instance.package.id,
      version: source.latestRevision.version,
      status: 'active',
      manifest: source.latestRevision.manifest,
      configSchema: source.latestRevision.configSchema,
      defaultConfig: source.latestRevision.defaultConfig,
      metadata: {
        ...(source.latestRevision.metadata || {}),
        importedFromPackageId: source.id,
        importedFromRevisionId: source.latestRevision.id,
        upgradedAt: new Date().toISOString(),
      },
      createdBy: instance.installedBy,
      assets: assets.map((asset) => ({
        path: asset.path,
        assetKind: asset.assetKind,
        mediaType: asset.mediaType,
        textContent: asset.textContent,
        sha256: asset.sha256,
        metadata: asset.metadata,
      })),
      setLatest: true,
    });

    await upsertCapabilityPackageLineage({
      downstreamPackageId: instance.package.id,
      upstreamPackageId: source.id,
      upstreamRevisionId: source.latestRevision.id,
      lineageKind: 'installed_copy',
      syncMode: 'manual_merge',
      metadata: {
        upgradedAt: new Date().toISOString(),
      },
    });

    await updateCapabilityInstance(instance.id, {
      revisionId: revision.id,
    });

    return getInstalledSkill(input.workspaceId, input.installedSkillId);
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function uninstallInstalledSkill(workspaceId: string, installedSkillId: string) {
  try {
    const instance = await getCapabilityInstance(installedSkillId);
    if (instance.workspaceId !== workspaceId || instance.package?.kind !== 'skill' || !instance.package) {
      throw new SkillError(404, 'Installed skill not found');
    }

    await deleteCapabilityInstance(installedSkillId);

    if (instance.package.workspaceId) {
      const remaining = await query(
        `SELECT 1
         FROM capability_instances
         WHERE package_id = $1
         LIMIT 1`,
        [instance.package.id],
      );

      if (remaining.rows.length === 0) {
        await query(
          `DELETE FROM capability_packages
           WHERE id = $1
             AND workspace_id = $2`,
          [instance.package.id, workspaceId],
        );
      }
    }

    return true;
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function listVisibleSkills(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  try {
    const instances = await listVisibleCapabilityInstances({
      workspaceId: input.workspaceId,
      kind: 'skill',
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
    });

    const deduped = new Map<string, CapabilityAvailableSkill>();
    for (const instance of instances) {
      const available = instanceToAvailableSkill(instance);
      if (!available) continue;
      if (!deduped.has(available.slug)) {
        deduped.set(available.slug, available);
      }
    }

    return Array.from(deduped.values());
  } catch (error) {
    wrapCapabilityError(error);
  }
}

export async function readVisibleSkill(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  skillName: string;
  assetPath?: string;
}) {
  try {
    const visibleSkills = await listVisibleSkills({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
    });

    const normalizedName = input.skillName.trim().toLowerCase();
    const match = visibleSkills.find((skill) =>
      skill.slug.toLowerCase() === normalizedName ||
      skill.name.toLowerCase() === normalizedName,
    );
    if (!match) {
      throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
    }

    const instance = await getCapabilityInstance(match.instanceId);
    if (instance.workspaceId !== input.workspaceId || instance.package?.kind !== 'skill') {
      throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
    }

    const definition = readSkillDefinition({
      pkg: instance.package,
      revision: instance.revision,
    });

    if (!input.assetPath) {
      return {
        skill: match,
        asset: {
          path: SKILL_DESCRIPTION_ASSET_PATH,
          textContent: renderSkillDescriptionToText(definition.description),
          contentBlocks: [definition.description],
        },
      };
    }

    const targetPath = normalizePath(input.assetPath);
    const assets = await listRevisionAttachments(instance.revisionId);
    const asset = assets.find((file) => file.path === targetPath);
    if (!asset) {
      throw new SkillError(404, `Skill attachment "${targetPath}" not found`);
    }

    return {
      skill: match,
      asset: {
        path: asset.path,
        textContent: renderSkillBlocksToText(asset.contentBlocks),
        contentBlocks: asset.contentBlocks,
      },
    };
  } catch (error) {
    wrapCapabilityError(error);
  }
}
