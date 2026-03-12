import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  CapabilityAssetKind,
  CapabilityAvailableSkill,
  CapabilityBinding,
  CapabilityBindingScope,
  CapabilityInstallPlan,
  CapabilityRequirementKind,
  CapabilityReuseScope,
} from '@synapse/shared';
import {
  buildCapabilityGrantPlan,
  CapabilityError,
  bindingToAvailableSkill,
  createCapabilityBinding,
  createCapabilityPackage,
  createCapabilityPublisher,
  createCapabilityRevision,
  dedupeVisibleBindings,
  deleteCapabilityBinding,
  ensureDefaultCapabilityGrant,
  evaluateCapabilityRequirements,
  getCapabilityAssetByPath,
  getCapabilityPackage,
  listCapabilityAssets,
  listCapabilityBindings,
  listCapabilityPackages,
  listAuthorizedCapabilityBindings,
  replaceRevisionRequirements,
  updateCapabilityBinding,
} from '../capabilities/service.js';

type JsonMap = Record<string, unknown>;

export class SkillError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

type SkillUploadFile = {
  path: string;
  content?: string;
  binaryBase64?: string;
  mediaType?: string;
};

type CapabilityRequirementInput = {
  requirementKind: CapabilityRequirementKind;
  targetKind: 'package' | 'tag';
  targetPackageKind?: 'plugin' | 'skill';
  targetPublisherSlug?: string;
  targetPackageSlug?: string;
  targetTag?: string;
  acceptableBindingScopes?: CapabilityBindingScope[];
  acceptableReuseScopes?: CapabilityReuseScope[];
  description?: string;
  configPredicate?: JsonMap;
  metadata?: JsonMap;
};

type ParsedFrontmatter = {
  frontmatter: Record<string, string>;
  metadata: JsonMap;
  body: string;
};

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
    .slice(0, 64);
}

function normalizePath(assetPath: string) {
  const value = assetPath.replace(/\\/g, '/').trim();
  if (!value || value.startsWith('/') || value.includes('\0')) {
    throw new SkillError(400, `Invalid skill asset path: ${assetPath}`);
  }
  const segments = value.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new SkillError(400, `Invalid skill asset path: ${assetPath}`);
  }
  return segments.join('/');
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripTrailingCommas(value: string) {
  return value.replace(/,(\s*[}\]])/g, '$1');
}

function extractBalancedBlock(lines: string[], startIndex: number, initial: string) {
  const collected = [initial];
  let depth = 0;

  const countDelta = (chunk: string) => {
    const open = (chunk.match(/{/g) || []).length;
    const close = (chunk.match(/}/g) || []).length;
    return open - close;
  };

  depth += countDelta(initial);
  let index = startIndex;
  while (depth > 0 && index + 1 < lines.length) {
    index += 1;
    const line = lines[index];
    collected.push(line);
    depth += countDelta(line);
  }

  return { raw: collected.join('\n'), endIndex: index };
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---\n')) {
    return { frontmatter: {}, metadata: {}, body: content };
  }

  const endFence = content.indexOf('\n---', 4);
  if (endFence === -1) {
    return { frontmatter: {}, metadata: {}, body: content };
  }

  const frontmatterText = content.slice(4, endFence).trimEnd();
  const body = content.slice(endFence + 4).replace(/^\n/, '');
  const lines = frontmatterText.split('\n');
  const frontmatter: Record<string, string> = {};
  let metadata: JsonMap = {};

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const match = rawLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const [, rawKey, rawValue = ''] = match;
    const key = rawKey.trim();
    const value = rawValue.trim();

    if (key === 'metadata') {
      let blockRaw = value;
      if (!blockRaw) {
        let j = i + 1;
        while (j < lines.length && (/^\s/.test(lines[j]) || lines[j].trim() === '')) {
          blockRaw += `${blockRaw ? '\n' : ''}${lines[j]}`;
          j += 1;
        }
        i = j - 1;
      } else if (blockRaw.includes('{')) {
        const block = extractBalancedBlock(lines, i, blockRaw);
        blockRaw = block.raw;
        i = block.endIndex;
      }

      const trimmed = blockRaw.trim();
      if (trimmed) {
        const normalized = stripTrailingCommas(trimmed);
        try {
          metadata = JSON.parse(normalized);
        } catch {
          metadata = {};
        }
      }
      continue;
    }

    frontmatter[key] = stripQuotes(value);
  }

  return { frontmatter, metadata, body };
}

function classifyAssetKind(assetPath: string, file: SkillUploadFile): CapabilityAssetKind {
  const normalized = assetPath.toLowerCase();
  if (normalized === 'skill.md') return 'skill_markdown';
  if (normalized.endsWith('.md')) return 'reference_markdown';
  if (/\.(js|mjs|cjs|ts|py|sh|bash|rb|pl)$/i.test(normalized)) return 'script';
  if (normalized.endsWith('.json')) return 'json';
  if (file.binaryBase64) return 'binary';
  return 'text';
}

function hashText(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function hashBinary(content: Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

function parseRequirementItems(
  items: unknown,
  requirementKind: CapabilityRequirementKind,
  targetPackageKind: 'plugin' | 'skill',
): CapabilityRequirementInput[] {
  if (!Array.isArray(items)) return [];

  const results: CapabilityRequirementInput[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      results.push({
        requirementKind,
        targetKind: 'package' as const,
        targetPackageKind,
        targetPackageSlug: item,
        description: '',
      });
      continue;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const targetTag = typeof obj.tag === 'string' ? obj.tag : undefined;
    if (targetTag) {
      results.push({
        requirementKind,
        targetKind: 'tag' as const,
        targetTag,
        description: typeof obj.description === 'string' ? obj.description : '',
        acceptableBindingScopes: Array.isArray(obj.bindingScopes) ? obj.bindingScopes.filter((v): v is CapabilityBindingScope => typeof v === 'string') : [],
        acceptableReuseScopes: Array.isArray(obj.reuseScopes) ? obj.reuseScopes.filter((v): v is CapabilityReuseScope => typeof v === 'string') : [],
        configPredicate: typeof obj.configPredicate === 'object' && obj.configPredicate && !Array.isArray(obj.configPredicate)
          ? obj.configPredicate as JsonMap
          : {},
        metadata: typeof obj.metadata === 'object' && obj.metadata && !Array.isArray(obj.metadata)
          ? obj.metadata as JsonMap
          : {},
      });
      continue;
    }

    const targetPackageSlug =
      typeof obj.packageSlug === 'string' ? obj.packageSlug :
      typeof obj.slug === 'string' ? obj.slug :
      undefined;

    if (!targetPackageSlug) continue;

    results.push({
      requirementKind,
      targetKind: 'package' as const,
      targetPackageKind,
      targetPublisherSlug:
        typeof obj.publisherSlug === 'string' ? obj.publisherSlug :
        typeof obj.publisher === 'string' ? obj.publisher :
        undefined,
      targetPackageSlug,
      acceptableBindingScopes: Array.isArray(obj.bindingScopes) ? obj.bindingScopes.filter((v): v is CapabilityBindingScope => typeof v === 'string') : [],
      acceptableReuseScopes: Array.isArray(obj.reuseScopes) ? obj.reuseScopes.filter((v): v is CapabilityReuseScope => typeof v === 'string') : [],
      description: typeof obj.description === 'string' ? obj.description : '',
      configPredicate: typeof obj.configPredicate === 'object' && obj.configPredicate && !Array.isArray(obj.configPredicate)
        ? obj.configPredicate as JsonMap
        : {},
      metadata: typeof obj.metadata === 'object' && obj.metadata && !Array.isArray(obj.metadata)
        ? obj.metadata as JsonMap
        : {},
    });
  }

  return results;
}

function extractSynapseRequirements(metadata: JsonMap) {
  const synapse = metadata.synapse;
  if (!synapse || typeof synapse !== 'object' || Array.isArray(synapse)) return [];
  const synapseObj = synapse as Record<string, unknown>;

  const collect = (requirementKind: CapabilityRequirementKind, sectionKey: 'requires' | 'recommends' | 'conflictsWith') => {
    const section = synapseObj[sectionKey];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return [];
    const sectionObj = section as Record<string, unknown>;
    return [
      ...parseRequirementItems(sectionObj.plugins, requirementKind, 'plugin'),
      ...parseRequirementItems(sectionObj.skills, requirementKind, 'skill'),
    ];
  };

  return [
    ...collect('required', 'requires'),
    ...collect('recommended', 'recommends'),
    ...collect('conflicts_with', 'conflictsWith'),
  ] satisfies CapabilityRequirementInput[];
}

function extractSkillAuthorization(metadata: JsonMap) {
  const synapse = metadata.synapse;
  if (!synapse || typeof synapse !== 'object' || Array.isArray(synapse)) return undefined;
  const authorization = (synapse as Record<string, unknown>).authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) return undefined;
  const obj = authorization as Record<string, unknown>;
  const requiredPermissions = Array.isArray(obj.requiredPermissions)
    ? obj.requiredPermissions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (requiredPermissions.length === 0) return undefined;

  const defaultGrantScope =
    obj.defaultGrantScope === 'workspace' ||
    obj.defaultGrantScope === 'conversation' ||
    obj.defaultGrantScope === 'actor_global' ||
    obj.defaultGrantScope === 'actor_conversation'
      ? obj.defaultGrantScope
      : undefined;

  return {
    requiredPermissions,
    defaultGrantScope,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
  };
}

async function ensureWorkspacePublisher(workspaceId: string) {
  return createCapabilityPublisher({
    slug: `workspace-${workspaceId}`,
    displayName: 'Workspace Uploads',
    description: 'Workspace-local uploaded capabilities',
  });
}

function assertSkillVisible(workspaceId: string, skill: Awaited<ReturnType<typeof getCapabilityPackage>>) {
  if (skill.kind !== 'skill') throw new SkillError(404, 'Skill not found');
  if (skill.workspaceId && skill.workspaceId !== workspaceId) {
    throw new SkillError(404, 'Skill not found');
  }
}

export async function createSkill(input: {
  workspaceId: string;
  uploadedBy?: string;
  slug?: string;
  version?: string;
  displayName?: string;
  description?: string;
  longDescription?: string;
  iconUrl?: string;
  tags?: string[];
  metadata?: JsonMap;
  files: SkillUploadFile[];
}) {
  const normalizedFiles = input.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));
  const skillFile = normalizedFiles.find((file) => file.path === 'SKILL.md');
  if (!skillFile?.content) {
    throw new SkillError(400, 'Skill upload must include SKILL.md with text content');
  }

  const parsed = parseFrontmatter(skillFile.content);
  const derivedName = input.displayName || parsed.frontmatter.name || input.slug;
  if (!derivedName) {
    throw new SkillError(400, 'Skill name is required in SKILL.md frontmatter or request body');
  }

  const slug = sanitizeSlug(input.slug || parsed.frontmatter.name || derivedName);
  if (!slug) throw new SkillError(400, 'Unable to derive a valid skill slug');

  const description = input.description || parsed.frontmatter.description || '';
  if (!description) {
    throw new SkillError(400, 'Skill description is required in SKILL.md frontmatter or request body');
  }

  const publisher = await ensureWorkspacePublisher(input.workspaceId);
  const pkg = await createCapabilityPackage({
    publisherId: publisher.id,
    workspaceId: input.workspaceId,
    kind: 'skill',
    slug,
    displayName: derivedName,
    description,
    longDescription: input.longDescription || '',
    iconUrl: input.iconUrl,
    sourceType: 'workspace_upload',
    tags: input.tags || [],
    defaultBindingScope: 'workspace',
    defaultReuseScope: 'workspace',
    requiresHandshake: false,
    metadata: {
      ...(input.metadata || {}),
      homepage: parsed.frontmatter.homepage || undefined,
    },
  });

  const assets = normalizedFiles.map((file) => {
    const assetKind = classifyAssetKind(file.path, file);
    if (file.binaryBase64) {
      const binary = Buffer.from(file.binaryBase64, 'base64');
      return {
        path: file.path,
        assetKind,
        mediaType: file.mediaType,
        binaryContent: binary,
        sizeBytes: binary.length,
        sha256: hashBinary(binary),
        metadata: {},
      };
    }

    const textContent = file.content || '';
    return {
      path: file.path,
      assetKind,
      mediaType: file.mediaType,
      textContent,
      sizeBytes: Buffer.byteLength(textContent, 'utf8'),
      sha256: hashText(textContent),
      metadata: {},
    };
  });

  const manifest = {
    kind: 'skill',
    standard: 'anthropic-skill',
    frontmatter: parsed.frontmatter,
    metadata: parsed.metadata,
    authorization: extractSkillAuthorization(parsed.metadata),
  };

  const revision = await createCapabilityRevision({
    packageId: pkg.id,
    version: input.version || '1.0.0',
    status: 'active',
    transport: 'filesystem',
    entryPoint: 'SKILL.md',
    manifest,
    metadata: {
      bodyLength: parsed.body.length,
    },
    createdBy: input.uploadedBy,
    assets,
    setLatest: true,
  });

  const requirements = extractSynapseRequirements(parsed.metadata);
  await replaceRevisionRequirements(revision.id, requirements);

  const created = await getCapabilityPackage(pkg.id);
  return created;
}

export async function listSkills(workspaceId: string) {
  return listCapabilityPackages({
    workspaceId,
    includeGlobal: true,
    kind: 'skill',
  });
}

export async function getSkill(workspaceId: string, skillId: string) {
  const skill = await getCapabilityPackage(skillId);
  assertSkillVisible(workspaceId, skill);
  return skill;
}

export async function listSkillAssets(workspaceId: string, skillId: string) {
  const skill = await getSkill(workspaceId, skillId);
  if (!skill.latestRevisionId) throw new SkillError(400, 'Skill has no active revision');
  return listCapabilityAssets(skill.latestRevisionId);
}

export async function getSkillAsset(workspaceId: string, skillId: string, assetPath: string) {
  const skill = await getSkill(workspaceId, skillId);
  if (!skill.latestRevisionId) throw new SkillError(400, 'Skill has no active revision');
  return getCapabilityAssetByPath(skill.latestRevisionId, normalizePath(assetPath));
}

export async function listSkillInstallations(workspaceId: string, filters?: {
  scopeType?: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  skillId?: string;
}) {
  return listCapabilityBindings(workspaceId, {
    kind: 'skill',
    packageId: filters?.skillId,
    bindingScope: filters?.scopeType,
    actorId: filters?.actorId,
    conversationId: filters?.conversationId,
    userId: filters?.userId,
  });
}

export async function installSkill(input: {
  workspaceId: string;
  skillId: string;
  scopeType: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  installedBy?: string;
}) {
  const skill = await getSkill(input.workspaceId, input.skillId);
  if (!skill.latestRevisionId) throw new SkillError(400, 'Skill has no active revision');
  const binding = await createCapabilityBinding({
    workspaceId: input.workspaceId,
    packageId: skill.id,
    revisionId: skill.latestRevisionId,
    bindingScope: input.scopeType,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    installMode: 'manual',
    reuseScope: skill.defaultReuseScope || 'workspace',
    installedBy: input.installedBy,
    requiresHandshake: false,
    configData: {},
  });

  try {
    await ensureDefaultCapabilityGrant({
      bindingId: binding.id,
      workspaceId: input.workspaceId,
      grantedBy: input.installedBy,
    });
    return binding;
  } catch (error) {
    await deleteCapabilityBinding(binding.id).catch(() => {});
    throw error;
  }
}

export async function updateSkillInstallation(bindingId: string, data: {
  isEnabled?: boolean;
  scopeType?: CapabilityBindingScope;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}) {
  return updateCapabilityBinding(bindingId, {
    isEnabled: data.isEnabled,
    bindingScope: data.scopeType,
    actorId: data.actorId,
    conversationId: data.conversationId,
    userId: data.userId,
  });
}

export async function uninstallSkill(bindingId: string) {
  return deleteCapabilityBinding(bindingId);
}

export async function createSkillInstallPlan(input: {
  workspaceId: string;
  skillId: string;
  bindingScope: CapabilityBindingScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}): Promise<CapabilityInstallPlan> {
  const skill = await getSkill(input.workspaceId, input.skillId);
  if (!skill.latestRevisionId) throw new SkillError(400, 'Skill has no active revision');
  const checks = await evaluateCapabilityRequirements({
    workspaceId: input.workspaceId,
    revisionId: skill.latestRevisionId,
  });
  return {
    packageId: skill.id,
    revisionId: skill.latestRevisionId,
    workspaceId: input.workspaceId,
    bindingScope: input.bindingScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    checks,
    grantPlan: buildCapabilityGrantPlan({
      revision: skill.latestRevision,
      bindingScope: input.bindingScope,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
    }),
  };
}

export async function listVisibleSkills(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
}) {
  const bindings = await listAuthorizedCapabilityBindings({
    workspaceId: input.workspaceId,
    kind: 'skill',
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    userCount: input.userCount,
  });

  return dedupeVisibleBindings(bindings, (binding) => binding.package?.slug || binding.packageId)
    .map(bindingToAvailableSkill)
    .filter((skill): skill is CapabilityAvailableSkill => Boolean(skill));
}

export async function readVisibleSkill(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  userCount?: number;
  skillName: string;
  assetPath?: string;
}) {
  const visibleSkills = await listVisibleSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    userCount: input.userCount,
  });

  const normalizedName = input.skillName.trim().toLowerCase();
  const match = visibleSkills.find((skill) =>
    skill.slug.toLowerCase() === normalizedName ||
    skill.name.toLowerCase() === normalizedName,
  );
  if (!match) {
    throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
  }

  const asset = await getCapabilityAssetByPath(match.revisionId, normalizePath(input.assetPath || match.entryPoint || 'SKILL.md'));
  if (!asset.textContent) {
    throw new SkillError(400, `Skill asset "${asset.path}" is not a text asset`);
  }

  return {
    skill: match,
    asset,
  };
}
