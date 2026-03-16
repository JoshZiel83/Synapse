import {
  normalizeCanonicalContentBlocks,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  type CapabilityAvailableSkill,
  type InstalledSkill,
  type SkillAssetFile,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  type SkillUseScope,
} from '@synapse/shared';
import { query, transaction } from '../../infrastructure/database/index.js';

type JsonMap = Record<string, unknown>;

type DbClient = {
  query: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

type SkillFileInput = {
  path: string;
  contentBlocks: CanonicalContentBlockInput[];
};

export class SkillError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
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

function normalizeSkillFiles(files: SkillFileInput[], entryPath: string) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new SkillError(400, 'Skill files are required');
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

  if (!seen.has(entryPath)) {
    throw new SkillError(400, `Entry file "${entryPath}" is required`);
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

function mapSkillFile(row: any): SkillAssetFile {
  return {
    id: row.id,
    path: row.path,
    contentBlocks: normalizeCanonicalContentBlocks(Array.isArray(row.content_blocks) ? row.content_blocks : []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildMarketplaceVersion(row: any): SkillMarketplaceVersion | undefined {
  if (!row.latest_version_id) return undefined;
  return {
    id: row.latest_version_id,
    skillId: row.id,
    version: row.latest_version,
    changelog: row.latest_changelog || '',
    entryPath: row.latest_entry_path || 'SKILL.md',
    createdBy: row.latest_created_by || undefined,
    createdByName: row.latest_created_by_name || undefined,
    createdAt: row.latest_created_at,
    files: undefined,
  };
}

function mapMarketplaceEntry(row: any): SkillMarketplaceEntry {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary || '',
    iconUrl: row.icon_url || undefined,
    tags: Array.isArray(row.tags) ? row.tags : [],
    authorUserId: row.author_user_id || undefined,
    authorName: row.author_name || undefined,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestVersionId: row.latest_version_id || undefined,
    latestVersion: buildMarketplaceVersion(row),
  };
}

function mapInstalledSkill(row: any): InstalledSkill {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary || '',
    iconUrl: row.icon_url || undefined,
    tags: Array.isArray(row.tags) ? row.tags : [],
    entryPath: row.entry_path || 'SKILL.md',
    useScope: row.use_scope,
    actorId: row.actor_id || undefined,
    conversationId: row.conversation_id || undefined,
    userId: row.user_id || undefined,
    isEnabled: Boolean(row.is_enabled),
    isCustomized: Boolean(row.is_customized),
    installedBy: row.installed_by || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceSkillId: row.source_skill_id || undefined,
    sourceVersionId: row.source_version_id || undefined,
    sourceVersion: row.source_version || undefined,
    upgradeAvailable:
      Boolean(row.source_skill_id) &&
      Boolean(row.source_latest_version_id) &&
      row.source_latest_version_id !== row.source_version_id,
    latestSourceVersion: row.latest_source_version || undefined,
    files: undefined,
  };
}

async function listMarketplaceFiles(versionId: string): Promise<SkillAssetFile[]> {
  const result = await query(
    `SELECT id, path, content_blocks, created_at, updated_at
     FROM skill_market_files
     WHERE version_id = $1
     ORDER BY path ASC`,
    [versionId],
  );
  return result.rows.map(mapSkillFile);
}

async function listInstalledSkillFiles(installedSkillId: string): Promise<SkillAssetFile[]> {
  const result = await query(
    `SELECT id, path, content_blocks, created_at, updated_at
     FROM installed_skill_files
     WHERE installed_skill_id = $1
     ORDER BY path ASC`,
    [installedSkillId],
  );
  return result.rows.map(mapSkillFile);
}

async function saveMarketplaceFiles(client: DbClient, versionId: string, files: ReturnType<typeof normalizeSkillFiles>) {
  await client.query(`DELETE FROM skill_market_files WHERE version_id = $1`, [versionId]);
  for (const file of files) {
    await client.query(
      `INSERT INTO skill_market_files (version_id, path, content_blocks)
       VALUES ($1, $2, $3::jsonb)`,
      [versionId, file.path, JSON.stringify(file.contentBlocks)],
    );
  }
}

async function saveInstalledFiles(client: DbClient, installedSkillId: string, files: SkillAssetFile[] | ReturnType<typeof normalizeSkillFiles>) {
  await client.query(`DELETE FROM installed_skill_files WHERE installed_skill_id = $1`, [installedSkillId]);
  for (const file of files) {
    await client.query(
      `INSERT INTO installed_skill_files (installed_skill_id, path, content_blocks)
       VALUES ($1, $2, $3::jsonb)`,
      [installedSkillId, file.path, JSON.stringify(file.contentBlocks)],
    );
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

async function getMarketplaceSkillRow(skillId: string) {
  const result = await query(
    `SELECT
        s.*,
        author.name AS author_name,
        latest.id AS latest_version_id,
        latest.version AS latest_version,
        latest.entry_path AS latest_entry_path,
        latest.changelog AS latest_changelog,
        latest.created_by AS latest_created_by,
        latest.created_at AS latest_created_at,
        creator.name AS latest_created_by_name
     FROM skill_market_skills s
     LEFT JOIN users author ON author.id = s.author_user_id
     LEFT JOIN skill_market_versions latest ON latest.id = s.latest_version_id
     LEFT JOIN users creator ON creator.id = latest.created_by
     WHERE s.id = $1
     LIMIT 1`,
    [skillId],
  );
  if (result.rows.length === 0) {
    throw new SkillError(404, 'Skill not found');
  }
  return result.rows[0];
}

async function getInstalledSkillRow(workspaceId: string, installedSkillId: string) {
  const result = await query(
    `SELECT
        i.*,
        src.latest_version_id AS source_latest_version_id,
        latest.version AS latest_source_version
     FROM installed_skills i
     LEFT JOIN skill_market_skills src ON src.id = i.source_skill_id
     LEFT JOIN skill_market_versions latest ON latest.id = src.latest_version_id
     WHERE i.workspace_id = $1
       AND i.id = $2
     LIMIT 1`,
    [workspaceId, installedSkillId],
  );
  if (result.rows.length === 0) {
    throw new SkillError(404, 'Installed skill not found');
  }
  return result.rows[0];
}

export async function listMarketplaceSkills(filters?: {
  search?: string;
  tags?: string[];
}) {
  const where: string[] = ['s.is_active = TRUE'];
  const values: unknown[] = [];
  let idx = 1;

  if (filters?.search?.trim()) {
    where.push(`(
      s.name ILIKE $${idx}
      OR s.slug ILIKE $${idx}
      OR s.summary ILIKE $${idx}
    )`);
    values.push(`%${filters.search.trim()}%`);
    idx += 1;
  }

  if (filters?.tags && filters.tags.length > 0) {
    where.push(`s.tags && $${idx++}::text[]`);
    values.push(filters.tags);
  }

  const result = await query(
    `SELECT
        s.*,
        author.name AS author_name,
        latest.id AS latest_version_id,
        latest.version AS latest_version,
        latest.entry_path AS latest_entry_path,
        latest.changelog AS latest_changelog,
        latest.created_by AS latest_created_by,
        latest.created_at AS latest_created_at,
        creator.name AS latest_created_by_name
     FROM skill_market_skills s
     LEFT JOIN users author ON author.id = s.author_user_id
     LEFT JOIN skill_market_versions latest ON latest.id = s.latest_version_id
     LEFT JOIN users creator ON creator.id = latest.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY s.updated_at DESC, s.name ASC`,
    values,
  );

  return result.rows.map(mapMarketplaceEntry);
}

export async function getMarketplaceSkill(skillId: string) {
  const row = await getMarketplaceSkillRow(skillId);
  const skill = mapMarketplaceEntry(row);
  if (skill.latestVersionId) {
    skill.latestVersion = {
      ...skill.latestVersion!,
      files: await listMarketplaceFiles(skill.latestVersionId),
    };
  }
  return skill;
}

export async function publishMarketplaceSkill(input: {
  skillId?: string;
  slug: string;
  name: string;
  summary?: string;
  iconUrl?: string;
  tags?: string[];
  version: string;
  entryPath?: string;
  changelog?: string;
  files: SkillFileInput[];
  authorUserId?: string;
  isActive?: boolean;
  metadata?: JsonMap;
}) {
  const slug = sanitizeSlug(input.slug || input.name);
  if (!slug) {
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

  const entryPath = normalizePath(input.entryPath || 'SKILL.md');
  const files = normalizeSkillFiles(input.files, entryPath);

  const skillId = await transaction(async (client) => {
    const existing = input.skillId
      ? await client.query<{ id: string }>(
          `SELECT id
           FROM skill_market_skills
           WHERE id = $1
           LIMIT 1`,
          [input.skillId],
        )
      : await client.query<{ id: string }>(
          `SELECT id
           FROM skill_market_skills
           WHERE slug = $1
           LIMIT 1`,
          [slug],
        );

    let nextSkillId: string;
    if (existing.rows.length > 0) {
      nextSkillId = existing.rows[0]!.id;
      await client.query(
        `UPDATE skill_market_skills
         SET slug = $1,
             name = $2,
             summary = $3,
             icon_url = $4,
             tags = $5,
             author_user_id = COALESCE($6, author_user_id),
             is_active = $7,
             metadata = $8::jsonb,
             updated_at = NOW()
         WHERE id = $9`,
        [
          slug,
          name,
          input.summary || '',
          input.iconUrl || null,
          input.tags || [],
          input.authorUserId || null,
          input.isActive ?? true,
          JSON.stringify(input.metadata || {}),
          nextSkillId,
        ],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO skill_market_skills (
           slug, name, summary, icon_url, tags, author_user_id, is_active, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [
          slug,
          name,
          input.summary || '',
          input.iconUrl || null,
          input.tags || [],
          input.authorUserId || null,
          input.isActive ?? true,
          JSON.stringify(input.metadata || {}),
        ],
      );
      nextSkillId = inserted.rows[0]!.id;
    }

    const versionResult = await client.query<{ id: string }>(
      `INSERT INTO skill_market_versions (
         skill_id, version, entry_path, changelog, metadata, created_by
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (skill_id, version) DO UPDATE SET
         entry_path = EXCLUDED.entry_path,
         changelog = EXCLUDED.changelog,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        nextSkillId,
        version,
        entryPath,
        input.changelog || '',
        JSON.stringify(input.metadata || {}),
        input.authorUserId || null,
      ],
    );
    const versionId = versionResult.rows[0]!.id;

    await saveMarketplaceFiles(client, versionId, files);
    await client.query(
      `UPDATE skill_market_skills
       SET latest_version_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [versionId, nextSkillId],
    );

    return nextSkillId;
  });

  return getMarketplaceSkill(skillId);
}

export async function listInstalledSkills(workspaceId: string, filters?: {
  useScope?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  sourceSkillId?: string;
}) {
  const where: string[] = ['i.workspace_id = $1'];
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.useScope) {
    where.push(`i.use_scope = $${idx++}`);
    values.push(filters.useScope);
  }
  if (filters?.actorId) {
    where.push(`i.actor_id = $${idx++}`);
    values.push(filters.actorId);
  }
  if (filters?.conversationId) {
    where.push(`i.conversation_id = $${idx++}`);
    values.push(filters.conversationId);
  }
  if (filters?.userId) {
    where.push(`i.user_id = $${idx++}`);
    values.push(filters.userId);
  }
  if (filters?.sourceSkillId) {
    where.push(`i.source_skill_id = $${idx++}`);
    values.push(filters.sourceSkillId);
  }

  const result = await query(
    `SELECT
        i.*,
        src.latest_version_id AS source_latest_version_id,
        latest.version AS latest_source_version
     FROM installed_skills i
     LEFT JOIN skill_market_skills src ON src.id = i.source_skill_id
     LEFT JOIN skill_market_versions latest ON latest.id = src.latest_version_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.updated_at DESC, i.name ASC`,
    values,
  );

  return result.rows.map(mapInstalledSkill);
}

export async function getInstalledSkill(workspaceId: string, installedSkillId: string) {
  const row = await getInstalledSkillRow(workspaceId, installedSkillId);
  const skill = mapInstalledSkill(row);
  skill.files = await listInstalledSkillFiles(installedSkillId);
  return skill;
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
  const source = await getMarketplaceSkill(input.marketSkillId);
  if (!source.latestVersion || !source.latestVersion.files) {
    throw new SkillError(400, 'Marketplace skill has no published version');
  }
  const latestVersion = source.latestVersion;
  const latestFiles = latestVersion.files!;

  const target = normalizeScopeTarget({
    useScope: input.useScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });

  const existing = await query<{ id: string }>(
    `SELECT id
     FROM installed_skills
     WHERE workspace_id = $1
       AND source_skill_id = $2
       AND use_scope = $3
       AND COALESCE(actor_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND COALESCE(conversation_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($6::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     LIMIT 1`,
    [
      input.workspaceId,
      input.marketSkillId,
      input.useScope,
      target.actorId,
      target.conversationId,
      target.userId,
    ],
  );

  if (existing.rows.length > 0) {
    return getInstalledSkill(input.workspaceId, existing.rows[0]!.id);
  }

  const installedSkillId = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO installed_skills (
         workspace_id, source_skill_id, source_version_id, source_version,
         slug, name, summary, icon_url, tags, entry_path,
         use_scope, conversation_id, actor_id, user_id,
         is_enabled, is_customized, installed_by, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE, FALSE, $15, '{}'::jsonb)
       RETURNING id`,
      [
        input.workspaceId,
        source.id,
        latestVersion.id,
        latestVersion.version,
        source.slug,
        source.name,
        source.summary,
        source.iconUrl || null,
        source.tags,
        latestVersion.entryPath,
        input.useScope,
        target.conversationId,
        target.actorId,
        target.userId,
        input.installedBy || null,
      ],
    );
    const nextInstalledSkillId = inserted.rows[0]!.id;
    await saveInstalledFiles(client, nextInstalledSkillId, latestFiles);
    return nextInstalledSkillId;
  });

  return getInstalledSkill(input.workspaceId, installedSkillId);
}

export async function updateInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
  name?: string;
  summary?: string;
  iconUrl?: string | null;
  tags?: string[];
  entryPath?: string;
  useScope?: SkillUseScope;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  isEnabled?: boolean;
  files?: SkillFileInput[];
}) {
  const current = await getInstalledSkill(input.workspaceId, input.installedSkillId);
  const nextUseScope = input.useScope || current.useScope;
  const target = normalizeScopeTarget({
    useScope: nextUseScope,
    actorId: input.actorId ?? current.actorId ?? null,
    conversationId: input.conversationId ?? current.conversationId ?? null,
    userId: input.userId ?? current.userId ?? null,
  });

  const nextEntryPath = normalizePath(input.entryPath || current.entryPath);
  const normalizedFiles = input.files ? normalizeSkillFiles(input.files, nextEntryPath) : null;
  const touchesContent =
    input.name !== undefined ||
    input.summary !== undefined ||
    input.iconUrl !== undefined ||
    input.tags !== undefined ||
    input.entryPath !== undefined ||
    input.files !== undefined;

  await transaction(async (client) => {
    await client.query(
      `UPDATE installed_skills
       SET name = $1,
           summary = $2,
           icon_url = $3,
           tags = $4,
           entry_path = $5,
           use_scope = $6,
           conversation_id = $7,
           actor_id = $8,
           user_id = $9,
           is_enabled = COALESCE($10, is_enabled),
           is_customized = CASE WHEN $11 THEN TRUE ELSE is_customized END,
           updated_at = NOW()
       WHERE workspace_id = $12
         AND id = $13`,
      [
        input.name?.trim() || current.name,
        input.summary ?? current.summary,
        input.iconUrl === undefined ? current.iconUrl || null : input.iconUrl,
        input.tags ?? current.tags,
        nextEntryPath,
        nextUseScope,
        target.conversationId,
        target.actorId,
        target.userId,
        input.isEnabled,
        touchesContent,
        input.workspaceId,
        input.installedSkillId,
      ],
    );

    if (normalizedFiles) {
      await saveInstalledFiles(client, input.installedSkillId, normalizedFiles);
    }
  });

  return getInstalledSkill(input.workspaceId, input.installedSkillId);
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
}) {
  const current = await getInstalledSkill(input.workspaceId, input.installedSkillId);
  if (!current.sourceSkillId) {
    throw new SkillError(400, 'Installed skill has no marketplace source');
  }

  const source = await getMarketplaceSkill(current.sourceSkillId);
  if (!source.latestVersion || !source.latestVersion.files) {
    throw new SkillError(400, 'Marketplace source has no latest version');
  }
  const latestVersion = source.latestVersion;
  const latestFiles = latestVersion.files!;

  await transaction(async (client) => {
    await client.query(
      `UPDATE installed_skills
       SET slug = $1,
           name = $2,
           summary = $3,
           icon_url = $4,
           tags = $5,
           entry_path = $6,
           source_version_id = $7,
           source_version = $8,
           is_customized = FALSE,
           updated_at = NOW()
       WHERE workspace_id = $9
         AND id = $10`,
      [
        source.slug,
        source.name,
        source.summary,
        source.iconUrl || null,
        source.tags,
        latestVersion.entryPath,
        latestVersion.id,
        latestVersion.version,
        input.workspaceId,
        input.installedSkillId,
      ],
    );
    await saveInstalledFiles(client, input.installedSkillId, latestFiles);
  });

  return getInstalledSkill(input.workspaceId, input.installedSkillId);
}

export async function uninstallInstalledSkill(workspaceId: string, installedSkillId: string) {
  const result = await query<{ id: string }>(
    `DELETE FROM installed_skills
     WHERE workspace_id = $1
       AND id = $2
     RETURNING id`,
    [workspaceId, installedSkillId],
  );
  if (result.rows.length === 0) {
    throw new SkillError(404, 'Installed skill not found');
  }
  return true;
}

function runtimeScopeMatches(skill: InstalledSkill, input: {
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  if (!skill.isEnabled) return false;

  switch (skill.useScope) {
    case 'workspace':
      return true;
    case 'conversation':
      return Boolean(skill.conversationId && input.conversationId && skill.conversationId === input.conversationId);
    case 'actor_global':
      return Boolean(skill.actorId && input.actorId && skill.actorId === input.actorId);
    case 'actor_conversation':
      return Boolean(
        skill.actorId &&
        skill.conversationId &&
        input.actorId &&
        input.conversationId &&
        skill.actorId === input.actorId &&
        skill.conversationId === input.conversationId,
      );
    case 'user':
      return Boolean(skill.userId && input.userId && skill.userId === input.userId);
    default:
      return false;
  }
}

export async function listVisibleSkills(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const installed = await listInstalledSkills(input.workspaceId);
  const visible = installed.filter((skill) => runtimeScopeMatches(skill, input));
  const deduped = new Map<string, InstalledSkill>();

  for (const skill of visible) {
    if (!deduped.has(skill.slug)) {
      deduped.set(skill.slug, skill);
    }
  }

  return Array.from(deduped.values()).map((skill): CapabilityAvailableSkill => ({
    instanceId: skill.id,
    packageId: skill.sourceSkillId || skill.id,
    revisionId: skill.sourceVersionId || skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.summary,
    version: skill.sourceVersion || 'workspace-copy',
    attachmentType: skill.useScope,
    actorId: skill.actorId,
    conversationId: skill.conversationId,
    userId: skill.userId,
    entryPoint: skill.entryPath,
  }));
}

export async function readVisibleSkill(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  skillName: string;
  assetPath?: string;
}) {
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

  const skill = await getInstalledSkill(input.workspaceId, match.instanceId);
  const targetPath = normalizePath(input.assetPath || skill.entryPath);
  const asset = (skill.files || []).find((file) => file.path === targetPath);
  if (!asset) {
    throw new SkillError(404, `Skill file "${targetPath}" not found`);
  }

  return {
    skill: match,
    asset: {
      path: asset.path,
      textContent: renderSkillBlocksToText(asset.contentBlocks),
      contentBlocks: asset.contentBlocks,
    },
  };
}
