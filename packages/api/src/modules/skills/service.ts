import crypto from "node:crypto";
import type pg from "pg";
import {
  type AvailableSkillSummary,
  type InstalledSkill,
  normalizeCanonicalContentBlocks,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  type RuntimeBindingScope,
  type SkillAttachmentFile,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  type SkillUseScope,
} from "@synapse/shared";
import {
  buildActorConversationContextId,
  deleteRelation,
  flushAuthzOutboxEntries,
  lookupResources,
  queueAuthzRelationships,
  touchRelation,
  type AuthzRelationMutation,
  type AuthzSubject,
} from "../../infrastructure/authz/index.js";
import { query, transaction } from "../../infrastructure/database/index.js";
import {
  accessBindingMetadata,
  buildResourceAccessAuthzMutations,
  isPrimaryAccessBinding,
  mapAccessBindingToGrant,
  readAccessBindingTarget,
  resolveAccessGrantTarget,
  type AccessBindingRow,
} from "../access/bindings.js";

type QueryRow = pg.QueryResultRow;
type QueryResultLike<T extends QueryRow> = { rows: T[] };
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResultLike<T>>;

type JsonObject = Record<string, unknown>;

type SkillAttachmentInput = {
  path: string;
  contentBlocks: CanonicalContentBlockInput[];
};

type SkillScopeTarget = {
  bindScope: RuntimeBindingScope;
  useScope: SkillUseScope;
  actorId: string | null;
  conversationId: string | null;
  userId: string | null;
};

type SkillPackageRow = {
  item_id: string;
  item_slug: string;
  item_display_name: string;
  item_summary: string;
  item_long_description: string;
  item_tags: string[] | null;
  item_is_active: boolean;
  item_download_count: number;
  item_metadata: unknown;
  item_created_at: string;
  item_updated_at: string;
  latest_version_id: string | null;
  latest_version_value: string | null;
  latest_version_changelog: string | null;
  latest_version_created_by: string | null;
  latest_version_created_at: string | null;
  spec_canonical_slug: string | null;
  spec_name: string | null;
  spec_description_blocks: unknown;
  spec_summary_text: string | null;
  publisher_id: string;
  publisher_slug: string;
  publisher_display_name: string;
  publisher_owner_user_id: string | null;
};

type CatalogFileRow = {
  id: string;
  catalog_version_id: string;
  path: string;
  content_blocks: unknown;
  created_at: string;
};

type InstalledSkillRow = {
  skill_id: string;
  workspace_id: string;
  slug: string;
  name: string;
  tags: string[] | null;
  current_version: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  current_skill_version_id: string;
  version_name: string;
  version_description_blocks: unknown;
  version_summary_text: string | null;
  version_metadata: unknown;
  source_catalog_item_id: string | null;
  source_catalog_version_id: string | null;
  source_sync_mode: "notify" | "manual_merge" | "follow_upstream" | "detached" | null;
  source_is_customized: boolean | null;
  source_slug: string | null;
  source_latest_version_id: string | null;
  source_version_value: string | null;
  latest_source_version: string | null;
};

type SkillFileRow = {
  id: string;
  skill_version_id: string;
  path: string;
  content_blocks: unknown;
  created_at: string;
  updated_at: string;
};

type SkillAccessRow = AccessBindingRow & {
  skill_id: string;
  bind_scope: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  user_id: string | null;
};

type VisibleSkillRow = {
  access_binding_id: string;
  skill_id: string;
  access_bind_scope: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  user_id: string | null;
  slug: string;
  name: string;
  current_version: number;
  current_skill_version_id: string;
  description_blocks: unknown;
  source_version_value: string | null;
  access_created_at: string;
};

type InstallationSummary = {
  installed: boolean;
  installedCount: number;
  installedSkillId?: string;
};

const DEFAULT_MARKETPLACE_PUBLISHER_SLUG = "synapse-official";
const DEFAULT_MARKETPLACE_PUBLISHER_NAME = "Synapse Official";
const SKILL_DESCRIPTION_ASSET_PATH = "(description)";

const MARKETPLACE_SKILL_SELECT = `
  SELECT
    item.id AS item_id,
    item.slug AS item_slug,
    item.display_name AS item_display_name,
    item.summary AS item_summary,
    item.long_description AS item_long_description,
    item.tags AS item_tags,
    item.is_active AS item_is_active,
    item.download_count AS item_download_count,
    item.metadata AS item_metadata,
    item.created_at AS item_created_at,
    item.updated_at AS item_updated_at,
    version.id AS latest_version_id,
    version.version AS latest_version_value,
    version.changelog AS latest_version_changelog,
    version.created_by AS latest_version_created_by,
    version.created_at AS latest_version_created_at,
    spec.canonical_slug AS spec_canonical_slug,
    spec.name AS spec_name,
    spec.description_blocks AS spec_description_blocks,
    spec.summary_text AS spec_summary_text,
    publisher.id AS publisher_id,
    publisher.slug AS publisher_slug,
    publisher.display_name AS publisher_display_name,
    publisher.owner_user_id AS publisher_owner_user_id
  FROM catalog_items item
  JOIN publishers publisher
    ON publisher.id = item.publisher_id
  LEFT JOIN catalog_versions version
    ON version.id = item.latest_version_id
  LEFT JOIN skill_package_version_specs spec
    ON spec.catalog_version_id = version.id
  WHERE item.item_kind = 'skill_package'
    AND item.workspace_id IS NULL
`;

const INSTALLED_SKILL_SELECT = `
  SELECT
    skill.id AS skill_id,
    skill.workspace_id,
    skill.slug,
    skill.name,
    skill.tags,
    skill.current_version,
    skill.is_active,
    skill.created_by,
    skill.created_at,
    skill.updated_at,
    version_row.id AS current_skill_version_id,
    version_row.name AS version_name,
    version_row.description_blocks AS version_description_blocks,
    version_row.summary_text AS version_summary_text,
    version_row.metadata AS version_metadata,
    source_ref.source_catalog_item_id,
    source_ref.source_catalog_version_id,
    source_ref.sync_mode AS source_sync_mode,
    source_ref.is_customized AS source_is_customized,
    source_item.slug AS source_slug,
    source_item.latest_version_id AS source_latest_version_id,
    imported_version.version AS source_version_value,
    latest_version.version AS latest_source_version
  FROM installed_skills skill
  JOIN skill_versions version_row
    ON version_row.skill_id = skill.id
   AND version_row.version = skill.current_version
  LEFT JOIN skill_source_refs source_ref
    ON source_ref.skill_id = skill.id
  LEFT JOIN catalog_items source_item
    ON source_item.id = source_ref.source_catalog_item_id
  LEFT JOIN catalog_versions imported_version
    ON imported_version.id = source_ref.source_catalog_version_id
  LEFT JOIN catalog_versions latest_version
    ON latest_version.id = source_item.latest_version_id
`;

export class SkillError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sanitizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizePath(assetPath: string) {
  const value = assetPath.replace(/\\/g, "/").trim();
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new SkillError(400, `Invalid skill file path: ${assetPath}`);
  }

  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new SkillError(400, `Invalid skill file path: ${assetPath}`);
  }

  return segments.join("/");
}

function defaultDescriptionBlock(): CanonicalContentBlock {
  return {
    id: crypto.randomUUID(),
    type: "text",
    text: "",
  };
}

function normalizeSkillDescription(description?: CanonicalContentBlockInput) {
  const normalized = normalizeCanonicalContentBlocks(
    description
      ? [description]
      : [defaultDescriptionBlock()],
  );

  return normalized[0] || defaultDescriptionBlock();
}

function normalizeSkillAttachments(files?: SkillAttachmentInput[]) {
  if (!Array.isArray(files) || files.length === 0) {
    return [] as Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>;
  }

  const normalized = files.map((file) => ({
    path: normalizePath(file.path),
    contentBlocks: normalizeCanonicalContentBlocks(
      Array.isArray(file.contentBlocks) ? file.contentBlocks : [],
    ),
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
}): SkillScopeTarget {
  switch (input.useScope) {
    case "workspace":
      return {
        bindScope: "workspace",
        useScope: "workspace",
        actorId: null,
        conversationId: null,
        userId: null,
      };
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(400, "conversationId is required for conversation scope");
      }
      return {
        bindScope: "conversation",
        useScope: "conversation",
        actorId: null,
        conversationId: input.conversationId,
        userId: null,
      };
    case "actor_global":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor_global scope");
      }
      return {
        bindScope: "actor",
        useScope: "actor_global",
        actorId: input.actorId,
        conversationId: null,
        userId: null,
      };
    case "actor_conversation":
      if (!input.actorId || !input.conversationId) {
        throw new SkillError(400, "actorId and conversationId are required for actor_conversation scope");
      }
      return {
        bindScope: "actor_conversation",
        useScope: "actor_conversation",
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: null,
      };
    case "user":
      if (!input.userId) {
        throw new SkillError(400, "userId is required for user scope");
      }
      return {
        bindScope: "user",
        useScope: "user",
        actorId: null,
        conversationId: null,
        userId: input.userId,
      };
    default:
      throw new SkillError(400, `Unsupported skill scope: ${String(input.useScope)}`);
  }
}

function parseJsonObject(value: unknown): JsonObject {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonObject;
    } catch {
      return {};
    }
  }

  return typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeStoredBlocks(value: unknown) {
  const blocks = normalizeCanonicalContentBlocks(
    parseJsonArray<CanonicalContentBlockInput>(value),
  );
  return blocks;
}

function descriptionBlockFromStored(value: unknown) {
  return normalizeStoredBlocks(value)[0] || defaultDescriptionBlock();
}

function renderSkillBlocksToText(blocks: CanonicalContentBlock[]) {
  return blocks
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[File: ${block.originalName} | ${block.mimeType} | ${block.url}]`,
    )
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");
}

function hashSkillBlocks(blocks: CanonicalContentBlock[]) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(blocks))
    .digest("hex");
}

function inferMediaType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".txt")) return "text/plain";
  return "text/plain";
}

function iconUrlFromMetadata(value: unknown) {
  const metadata = parseJsonObject(value);
  return typeof metadata.iconUrl === "string" && metadata.iconUrl.trim()
    ? metadata.iconUrl
    : undefined;
}

function metadataWithIconUrl(base: unknown, iconUrl: string | null | undefined) {
  const metadata = parseJsonObject(base);
  if (iconUrl && iconUrl.trim()) {
    metadata.iconUrl = iconUrl.trim();
  } else {
    delete metadata.iconUrl;
  }
  return metadata;
}

function buildSkillAttachmentFromCatalogFile(row: CatalogFileRow): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    contentBlocks: normalizeStoredBlocks(row.content_blocks),
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

function buildSkillAttachmentFromSkillFile(row: SkillFileRow): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    contentBlocks: normalizeStoredBlocks(row.content_blocks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolvePublicUseScope(bindScope: RuntimeBindingScope): SkillUseScope {
  switch (bindScope) {
    case "actor":
      return "actor_global";
    case "workspace":
    case "conversation":
    case "actor_conversation":
    case "user":
      return bindScope;
  }
}

function compareBindingPriority(left: SkillAccessRow, right: SkillAccessRow) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  };
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor_conversation: 0,
    actor: 1,
    conversation: 2,
    user: 3,
    workspace: 4,
  };

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status];
  }
  if (isPrimaryAccessBinding(left) !== isPrimaryAccessBinding(right)) {
    return isPrimaryAccessBinding(left) ? -1 : 1;
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope];
  }
  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
}

function compareVisibleBindingPriority(left: SkillAccessRow, right: SkillAccessRow) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  };
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor_conversation: 0,
    actor: 1,
    conversation: 2,
    user: 3,
    workspace: 4,
  };

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status];
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope];
  }
  if (isPrimaryAccessBinding(left) !== isPrimaryAccessBinding(right)) {
    return isPrimaryAccessBinding(left) ? -1 : 1;
  }
  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
}

function matchesScopeTarget(binding: SkillAccessRow, filter?: SkillScopeTarget) {
  if (!filter) {
    return true;
  }
  return (
    binding.bind_scope === filter.bindScope &&
    binding.actor_id === filter.actorId &&
    binding.conversation_id === filter.conversationId &&
    binding.user_id === filter.userId
  );
}

function mapMarketplaceVersion(
  row: SkillPackageRow,
  attachmentFiles?: SkillAttachmentFile[],
): SkillMarketplaceVersion | undefined {
  if (!row.latest_version_id || !row.latest_version_value) {
    return undefined;
  }

  return {
    id: row.latest_version_id,
    skillId: row.item_id,
    version: row.latest_version_value,
    changelog: row.latest_version_changelog || "",
    description: descriptionBlockFromStored(row.spec_description_blocks),
    createdBy: row.latest_version_created_by || undefined,
    createdAt: row.latest_version_created_at || row.item_updated_at,
    attachmentFiles,
  };
}

function mapMarketplaceEntry(
  row: SkillPackageRow,
  installation?: InstallationSummary,
  attachmentFiles?: SkillAttachmentFile[],
): SkillMarketplaceEntry {
  return {
    id: row.item_id,
    slug: row.spec_canonical_slug || row.item_slug,
    name: row.spec_name || row.item_display_name,
    description: descriptionBlockFromStored(row.spec_description_blocks),
    iconUrl: iconUrlFromMetadata(row.item_metadata),
    tags: row.item_tags || [],
    authorUserId: row.publisher_owner_user_id || undefined,
    authorName: row.publisher_display_name || undefined,
    isActive: Boolean(row.item_is_active),
    createdAt: row.item_created_at,
    updatedAt: row.item_updated_at,
    latestVersionId: row.latest_version_id || undefined,
    latestVersion: mapMarketplaceVersion(row, attachmentFiles),
    workspaceInstallation: installation,
  };
}

function buildInstalledSkillPayload(
  row: InstalledSkillRow,
  binding: SkillAccessRow | undefined,
  attachmentFiles?: SkillAttachmentFile[],
): InstalledSkill {
  const chosenBinding = binding;
  const useScope = chosenBinding
    ? resolvePublicUseScope(chosenBinding.bind_scope)
    : ("workspace" as SkillUseScope);

  return {
    id: row.skill_id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: descriptionBlockFromStored(row.version_description_blocks),
    iconUrl: iconUrlFromMetadata(row.version_metadata),
    tags: row.tags || [],
    useScope,
    actorId: chosenBinding?.actor_id || undefined,
    conversationId: chosenBinding?.conversation_id || undefined,
    userId: chosenBinding?.user_id || undefined,
    isEnabled: Boolean(row.is_active),
    isCustomized: Boolean(row.source_catalog_item_id && row.source_is_customized),
    installedBy: row.created_by || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceSkillId: row.source_catalog_item_id || undefined,
    sourceVersionId: row.source_catalog_version_id || undefined,
    sourceVersion: row.source_version_value || undefined,
    upgradeAvailable:
      Boolean(row.source_catalog_item_id) &&
      Boolean(row.source_catalog_version_id) &&
      Boolean(row.source_latest_version_id) &&
      row.source_catalog_version_id !== row.source_latest_version_id,
    latestSourceVersion: row.latest_source_version || undefined,
    attachmentFiles,
  };
}

function buildAvailableSkillPayload(
  row: VisibleSkillRow,
): AvailableSkillSummary {
  const description = renderSkillBlocksToText(
    [descriptionBlockFromStored(row.description_blocks)],
  );

  return {
    instanceId: row.skill_id,
    packageId: row.skill_id,
    revisionId: row.current_skill_version_id,
    slug: row.slug,
    name: row.name,
    description,
    version: row.source_version_value || `local-${row.current_version}`,
    attachmentType: resolvePublicUseScope(row.access_bind_scope),
    actorId: row.actor_id || undefined,
    conversationId: row.conversation_id || undefined,
    userId: row.user_id || undefined,
  };
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;
  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source}:`, error);
  }
}

function buildInstalledSkillAuthzMutations(params: {
  skillId: string;
  workspaceId: string;
  ownerUserId?: string | null;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [
    mutate(
      "installed_skill",
      params.skillId,
      "workspace",
      "workspace",
      params.workspaceId,
    ),
  ];

  if (params.ownerUserId) {
    relations.push(
      mutate(
        "installed_skill",
        params.skillId,
        "owner",
        "user",
        params.ownerUserId,
      ),
    );
  }

  return relations;
}

async function ensureMarketplacePublisher(
  run: QueryRunner,
  ownerUserId?: string,
) {
  const result = await run<{ id: string }>(
    `INSERT INTO publishers (
       slug,
       display_name,
       description,
       owner_user_id,
       workspace_id,
       is_verified,
       metadata
     )
     VALUES ($1, $2, 'Official marketplace publisher', $3, NULL, TRUE, '{}'::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
       is_verified = TRUE,
       updated_at = NOW()
     RETURNING id`,
    [
      DEFAULT_MARKETPLACE_PUBLISHER_SLUG,
      DEFAULT_MARKETPLACE_PUBLISHER_NAME,
      ownerUserId || null,
    ],
  );

  return result.rows[0]!.id;
}

async function assertWorkspaceSkillSlugAvailable(
  run: QueryRunner,
  workspaceId: string,
  slug: string,
) {
  const existing = await run(
    `SELECT 1
     FROM installed_skills
     WHERE workspace_id = $1
       AND slug = $2
     LIMIT 1`,
    [workspaceId, slug],
  );

  if (existing.rows.length > 0) {
    throw new SkillError(409, `Skill slug "${slug}" already exists in this workspace`);
  }
}

async function allocateInstalledSkillSlug(
  run: QueryRunner,
  workspaceId: string,
  preferredSlug: string,
) {
  let candidate = preferredSlug;
  let index = 2;
  while (true) {
    const existing = await run(
      `SELECT 1
       FROM installed_skills
       WHERE workspace_id = $1
         AND slug = $2
       LIMIT 1`,
      [workspaceId, candidate],
    );
    if (existing.rows.length === 0) {
      return candidate;
    }
    candidate = `${preferredSlug}-${index}`;
    index += 1;
  }
}

async function upsertCatalogVersionFiles(
  run: QueryRunner,
  versionId: string,
  attachments: Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>,
) {
  await run(
    `DELETE FROM catalog_version_files
     WHERE catalog_version_id = $1`,
    [versionId],
  );

  for (const attachment of attachments) {
    const textContent = renderSkillBlocksToText(attachment.contentBlocks);
    await run(
      `INSERT INTO catalog_version_files (
         catalog_version_id,
         path,
         file_role,
         media_type,
         text_content,
         content_blocks,
         sha256,
         size_bytes,
         metadata
       )
       VALUES ($1, $2, 'reference', $3, $4, $5::jsonb, $6, $7, '{}'::jsonb)`,
      [
        versionId,
        attachment.path,
        inferMediaType(attachment.path),
        textContent,
        JSON.stringify(attachment.contentBlocks),
        hashSkillBlocks(attachment.contentBlocks),
        Buffer.byteLength(textContent, "utf8"),
      ],
    );
  }
}

async function insertSkillFiles(
  run: QueryRunner,
  skillVersionId: string,
  attachments: Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>,
) {
  for (const attachment of attachments) {
    const textContent = renderSkillBlocksToText(attachment.contentBlocks);
    await run(
      `INSERT INTO skill_files (
         skill_version_id,
         path,
         media_type,
         text_content,
         content_blocks,
         sha256,
         size_bytes,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, '{}'::jsonb)`,
      [
        skillVersionId,
        attachment.path,
        inferMediaType(attachment.path),
        textContent,
        JSON.stringify(attachment.contentBlocks),
        hashSkillBlocks(attachment.contentBlocks),
        Buffer.byteLength(textContent, "utf8"),
      ],
    );
  }
}

async function loadCatalogVersionFilesMap(
  versionIds: string[],
) {
  if (versionIds.length === 0) return new Map<string, SkillAttachmentFile[]>();

  const result = await query<CatalogFileRow>(
    `SELECT id, catalog_version_id, path, content_blocks, created_at
     FROM catalog_version_files
     WHERE catalog_version_id = ANY($1::uuid[])
     ORDER BY path ASC`,
    [versionIds],
  );

  const filesByVersionId = new Map<string, SkillAttachmentFile[]>();
  for (const row of result.rows) {
    const files = filesByVersionId.get(row.catalog_version_id) || [];
    files.push(buildSkillAttachmentFromCatalogFile(row));
    filesByVersionId.set(row.catalog_version_id, files);
  }

  return filesByVersionId;
}

async function loadSkillFilesMap(
  skillVersionIds: string[],
) {
  if (skillVersionIds.length === 0) return new Map<string, SkillAttachmentFile[]>();

  const result = await query<SkillFileRow>(
    `SELECT id, skill_version_id, path, content_blocks, created_at, updated_at
     FROM skill_files
     WHERE skill_version_id = ANY($1::uuid[])
     ORDER BY path ASC`,
    [skillVersionIds],
  );

  const filesByVersionId = new Map<string, SkillAttachmentFile[]>();
  for (const row of result.rows) {
    const files = filesByVersionId.get(row.skill_version_id) || [];
    files.push(buildSkillAttachmentFromSkillFile(row));
    filesByVersionId.set(row.skill_version_id, files);
  }

  return filesByVersionId;
}

async function buildMarketplaceInstallationMap(workspaceId: string) {
  const result = await query<{
    source_catalog_item_id: string;
    skill_id: string;
    installed_count: string;
  }>(
    `SELECT DISTINCT ON (source_ref.source_catalog_item_id)
       source_ref.source_catalog_item_id,
       source_ref.skill_id,
       COUNT(*) OVER (PARTITION BY source_ref.source_catalog_item_id) AS installed_count
     FROM skill_source_refs source_ref
     JOIN installed_skills skill
       ON skill.id = source_ref.skill_id
     WHERE skill.workspace_id = $1
       AND source_ref.source_catalog_item_id IS NOT NULL
     ORDER BY source_ref.source_catalog_item_id, skill.updated_at DESC`,
    [workspaceId],
  );

  const map = new Map<string, InstallationSummary>();
  for (const row of result.rows) {
    map.set(row.source_catalog_item_id, {
      installed: true,
      installedCount: Number(row.installed_count || 0),
      installedSkillId: row.skill_id,
    });
  }
  return map;
}

async function getMarketplaceRowById(
  skillId: string,
  run: QueryRunner = query,
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.id = $1
     LIMIT 1`,
    [skillId],
  );

  return result.rows[0] || null;
}

async function getMarketplaceRowBySlug(
  publisherId: string,
  slug: string,
  run: QueryRunner,
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.publisher_id = $1
      AND item.slug = $2
     LIMIT 1`,
    [publisherId, slug],
  );

  return result.rows[0] || null;
}

async function loadInstalledSkillRows(
  params: {
    workspaceId: string;
    skillIds?: string[];
    sourceSkillId?: string;
  },
) {
  const values: unknown[] = [params.workspaceId];
  const conditions = [`skill.workspace_id = $1`];

  if (params.skillIds && params.skillIds.length > 0) {
    values.push(params.skillIds);
    conditions.push(`skill.id = ANY($${values.length}::uuid[])`);
  }

  if (params.sourceSkillId) {
    values.push(params.sourceSkillId);
    conditions.push(`source_ref.source_catalog_item_id = $${values.length}`);
  }

  const result = await query<InstalledSkillRow>(
    `${INSTALLED_SKILL_SELECT}
     WHERE ${conditions.join(" AND ")}
     ORDER BY skill.updated_at DESC`,
    values,
  );

  return result.rows;
}

function buildSkillAccessRow(row: AccessBindingRow): SkillAccessRow {
  const target = readAccessBindingTarget(row);
  return {
    ...row,
    skill_id: row.resource_id,
    bind_scope: target.bindScope,
    conversation_id: target.conversationId,
    actor_id: target.actorId,
    user_id: target.userId,
  };
}

async function loadAccessBindingsBySkillIds(
  skillIds: string[],
  includeRevoked = false,
) {
  if (skillIds.length === 0) return new Map<string, SkillAccessRow[]>();

  const result = await query<AccessBindingRow>(
    `SELECT
       id,
       workspace_id,
       resource_type,
       resource_id,
       relation,
       subject_type,
       subject_id,
       subject_relation,
       status,
       created_by,
       reason,
       metadata,
       created_at,
       revoked_at
     FROM access_bindings
     WHERE resource_type = 'installed_skill'
       AND resource_id = ANY($1::text[])
       ${includeRevoked ? "" : "AND status = 'active'"}
     ORDER BY resource_id, created_at DESC`,
    [skillIds],
  );

  const map = new Map<string, SkillAccessRow[]>();
  for (const rawRow of result.rows) {
    const row = buildSkillAccessRow(rawRow);
    const existing = map.get(row.skill_id) || [];
    existing.push(row);
    map.set(row.skill_id, existing);
  }
  return map;
}

async function listSkillAccessRows(
  skillId: string,
  includeRevoked = false,
) {
  const rows = await loadAccessBindingsBySkillIds([skillId], includeRevoked);
  return rows.get(skillId) || [];
}

function mapSkillAccessRowToGrant(row: SkillAccessRow) {
  return mapAccessBindingToGrant(row, ["use"]);
}

async function loadInstalledSkillForUpdate(
  workspaceId: string,
  skillId: string,
) {
  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: [skillId],
  });
  return rows[0] || null;
}

async function chooseBindingMap(
  skillIds: string[],
  filters?: {
    useScope?: SkillUseScope;
    actorId?: string;
    conversationId?: string;
    userId?: string;
  },
) {
  const bindingsBySkillId = await loadAccessBindingsBySkillIds(skillIds);
  const preferredTarget = filters?.useScope
    ? normalizeScopeTarget({
        useScope: filters.useScope,
        actorId: filters.actorId,
        conversationId: filters.conversationId,
        userId: filters.userId,
      })
    : undefined;

  const map = new Map<string, SkillAccessRow | undefined>();
  for (const skillId of skillIds) {
    const candidates = bindingsBySkillId.get(skillId) || [];
    const matching = preferredTarget
      ? candidates.filter((binding) => matchesScopeTarget(binding, preferredTarget))
      : candidates;
    const chosen = [...(matching.length > 0 ? matching : candidates)].sort(compareBindingPriority)[0];
    map.set(skillId, chosen);
  }

  return map;
}

async function findSkillIdsByBindingFilter(params: {
  workspaceId: string;
  useScope?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  if (!params.useScope && !params.actorId && !params.conversationId && !params.userId) {
    return null;
  }

  const target = params.useScope
    ? resolveAccessGrantTarget({
        workspaceId: params.workspaceId,
        grantScope: params.useScope,
        actorId: params.actorId,
        conversationId: params.conversationId,
        userId: params.userId,
      })
    : null;

  const values: unknown[] = [params.workspaceId];
  const conditions = [
    `workspace_id = $1`,
    `resource_type = 'installed_skill'`,
    `status = 'active'`,
  ];

  if (target) {
    values.push(target.relation);
    conditions.push(`relation = $${values.length}`);
    values.push(target.subjectType);
    conditions.push(`subject_type = $${values.length}`);
    values.push(target.subjectId);
    conditions.push(`subject_id = $${values.length}`);
  } else {
    if (params.actorId) {
      values.push(params.actorId);
      conditions.push(`metadata->>'actorId' = $${values.length}`);
    }
    if (params.conversationId) {
      values.push(params.conversationId);
      conditions.push(`metadata->>'conversationId' = $${values.length}`);
    }
    if (params.userId) {
      values.push(params.userId);
      conditions.push(`metadata->>'userId' = $${values.length}`);
    }
  }

  const result = await query<{ skill_id: string }>(
    `SELECT DISTINCT resource_id AS skill_id
     FROM access_bindings
     WHERE ${conditions.join(" AND ")}`,
    values,
  );

  return result.rows.map((row) => row.skill_id);
}

async function findInstalledSkillBySource(
  workspaceId: string,
  sourceCatalogItemId: string,
  run: QueryRunner = query,
) {
  const result = await run<{ id: string }>(
    `SELECT skill.id
     FROM installed_skills skill
     JOIN skill_source_refs source_ref
       ON source_ref.skill_id = skill.id
     WHERE skill.workspace_id = $1
       AND source_ref.source_catalog_item_id = $2
     ORDER BY skill.updated_at DESC
     LIMIT 1`,
    [workspaceId, sourceCatalogItemId],
  );

  return result.rows[0]?.id || null;
}

async function ensureSkillBinding(
  run: QueryRunner,
  input: {
    skillId: string;
    workspaceId: string;
    target: SkillScopeTarget;
    createdBy?: string;
    isPrimary?: boolean;
  },
) {
  const grantTarget = resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    grantScope: input.target.useScope,
    actorId: input.target.actorId,
    conversationId: input.target.conversationId,
    userId: input.target.userId,
  });

  const existing = await run<AccessBindingRow>(
    `SELECT
       id,
       workspace_id,
       resource_type,
       resource_id,
       relation,
       subject_type,
       subject_id,
       subject_relation,
       status,
       created_by,
       reason,
       metadata,
       created_at,
       revoked_at
     FROM access_bindings
     WHERE workspace_id = $1
       AND resource_type = 'installed_skill'
       AND resource_id = $2
       AND relation = $3
       AND subject_type = $4
       AND subject_id = $5
       AND status = 'active'
     ORDER BY created_at DESC
    LIMIT 1`,
    [
      input.workspaceId,
      input.skillId,
      grantTarget.relation,
      grantTarget.subjectType,
      grantTarget.subjectId,
    ],
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      bindingId: row.id,
      authzEntryIds: [] as string[],
    };
  }

  const inserted = await run<{ id: string }>(
    `INSERT INTO access_bindings (
       workspace_id,
       resource_type,
       resource_id,
       relation,
       subject_type,
       subject_id,
       metadata,
       status,
       created_by
     )
     VALUES ($1, 'installed_skill', $2, $3, $4, $5, $6::jsonb, 'active', $7)
     RETURNING id`,
    [
      input.workspaceId,
      input.skillId,
      grantTarget.relation,
      grantTarget.subjectType,
      grantTarget.subjectId,
      JSON.stringify({
        grantScope: input.target.useScope,
        actorId: input.target.actorId,
        conversationId: input.target.conversationId,
        userId: input.target.userId,
        isPrimary: input.isPrimary === true,
      }),
      input.createdBy || null,
    ],
  );
  const bindingId = inserted.rows[0]!.id;

  const authzEntryIds = await queueAuthzRelationships(
    { query: run } as Pick<pg.PoolClient, "query">,
    buildResourceAccessAuthzMutations({
      resourceType: "installed_skill",
      resourceId: input.skillId,
      target: grantTarget,
      operation: "touch",
    }),
    {
      source: input.isPrimary ? "skill.access.primary.create" : "skill.access.grant",
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      bindingId,
    },
  );

  return {
    bindingId,
    authzEntryIds,
  };
}

async function getInstalledSkillResponse(
  workspaceId: string,
  installedSkillId: string,
) {
  const row = await loadInstalledSkillForUpdate(workspaceId, installedSkillId);
  if (!row) {
    throw new SkillError(404, "Installed skill not found");
  }

  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap([installedSkillId]),
    loadSkillFilesMap([row.current_skill_version_id]),
  ]);

  return buildInstalledSkillPayload(
    row,
    bindingMap.get(installedSkillId),
    fileMap.get(row.current_skill_version_id) || [],
  );
}

export async function listMarketplaceSkills(filters?: {
  search?: string;
  tags?: string[];
  workspaceId?: string;
}) {
  const values: unknown[] = [];
  const conditions: string[] = [];

  if (filters?.search?.trim()) {
    values.push(`%${filters.search.trim()}%`);
    conditions.push(
      `(item.display_name ILIKE $${values.length}
        OR item.slug ILIKE $${values.length}
        OR item.summary ILIKE $${values.length}
        OR item.long_description ILIKE $${values.length})`,
    );
  }

  const normalizedTags = (filters?.tags || []).map((tag) => tag.trim()).filter(Boolean);
  if (normalizedTags.length > 0) {
    values.push(normalizedTags);
    conditions.push(`item.tags && $${values.length}::text[]`);
  }

  const result = await query<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
     ${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}
     ORDER BY item.updated_at DESC, item.created_at DESC`,
    values,
  );

  const latestVersionIds = result.rows
    .map((row) => row.latest_version_id)
    .filter((value): value is string => Boolean(value));
  const [filesMap, installationMap] = await Promise.all([
    loadCatalogVersionFilesMap(latestVersionIds),
    filters?.workspaceId ? buildMarketplaceInstallationMap(filters.workspaceId) : Promise.resolve(null),
  ]);

  return result.rows.map((row) =>
    mapMarketplaceEntry(
      row,
      installationMap?.get(row.item_id),
      row.latest_version_id
        ? filesMap.get(row.latest_version_id) || []
        : undefined,
    ),
  );
}

export async function getMarketplaceSkill(skillId: string, workspaceId?: string) {
  const row = await getMarketplaceRowById(skillId);
  if (!row) {
    throw new SkillError(404, "Skill not found");
  }

  const [filesMap, installationMap] = await Promise.all([
    loadCatalogVersionFilesMap(row.latest_version_id ? [row.latest_version_id] : []),
    workspaceId ? buildMarketplaceInstallationMap(workspaceId) : Promise.resolve(null),
  ]);

  return mapMarketplaceEntry(
    row,
    installationMap?.get(row.item_id),
    row.latest_version_id
      ? filesMap.get(row.latest_version_id) || []
      : undefined,
  );
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
  metadata?: JsonObject;
}) {
  const canonicalSlug = sanitizeSlug(input.slug || input.name);
  if (!canonicalSlug) {
    throw new SkillError(400, "Skill slug is required");
  }

  const name = input.name.trim();
  if (!name) {
    throw new SkillError(400, "Skill name is required");
  }

  const version = input.version.trim();
  if (!version) {
    throw new SkillError(400, "Skill version is required");
  }

  const description = normalizeSkillDescription(input.description);
  const descriptionBlocks = [description];
  const summaryText = renderSkillBlocksToText(descriptionBlocks);
  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);

  const result = await transaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(client.query.bind(client), input.authorUserId);
    const existing = input.skillId
      ? await getMarketplaceRowById(input.skillId, client.query.bind(client))
      : await getMarketplaceRowBySlug(publisherId, canonicalSlug, client.query.bind(client));

    let itemId = existing?.item_id || null;
    if (existing && existing.item_id !== input.skillId && input.skillId) {
      throw new SkillError(404, "Skill not found");
    }

    const itemMetadata: JsonObject = {
      ...parseJsonObject(existing?.item_metadata),
      canonicalSlug,
      ...(input.metadata || {}),
    };
    if (input.iconUrl && input.iconUrl.trim()) {
      itemMetadata.iconUrl = input.iconUrl.trim();
    } else {
      delete itemMetadata.iconUrl;
    }

    if (existing) {
      await client.query(
        `UPDATE catalog_items
         SET slug = $2,
             display_name = $3,
             summary = $4,
             long_description = $4,
             tags = $5,
             is_active = $6,
             metadata = $7::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.item_id,
          canonicalSlug,
          name,
          summaryText,
          input.tags || [],
          input.isActive ?? true,
          JSON.stringify(itemMetadata),
        ],
      );
      itemId = existing.item_id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO catalog_items (
           publisher_id,
           workspace_id,
           item_kind,
           slug,
           display_name,
           summary,
           long_description,
           source_kind,
           visibility,
           tags,
           is_active,
           metadata
         )
         VALUES (
           $1,
           NULL,
           'skill_package',
           $2,
           $3,
           $4,
           $4,
           'official',
           'public',
           $5,
           $6,
           $7::jsonb
         )
         RETURNING id`,
        [
          publisherId,
          canonicalSlug,
          name,
          summaryText,
          input.tags || [],
          input.isActive ?? true,
          JSON.stringify(itemMetadata),
        ],
      );
      itemId = inserted.rows[0]!.id;
    }

    const existingVersion = await client.query<{ id: string }>(
      `SELECT id
       FROM catalog_versions
       WHERE catalog_item_id = $1
         AND version = $2
       LIMIT 1`,
      [itemId, version],
    );

    const versionMetadata = input.metadata || {};
    const versionId = existingVersion.rows[0]?.id
      || (
        await client.query<{ id: string }>(
          `INSERT INTO catalog_versions (
             catalog_item_id,
             version,
             status,
             changelog,
             metadata,
             created_by
           )
           VALUES ($1, $2, 'active', $3, $4::jsonb, $5)
           RETURNING id`,
          [
            itemId,
            version,
            input.changelog || "",
            JSON.stringify(versionMetadata),
            input.authorUserId || null,
          ],
        )
      ).rows[0]!.id;

    if (existingVersion.rows[0]) {
      await client.query(
        `UPDATE catalog_versions
         SET status = 'active',
             changelog = $2,
             metadata = $3::jsonb,
             created_by = COALESCE(created_by, $4),
             created_at = created_at
         WHERE id = $1`,
        [
          versionId,
          input.changelog || "",
          JSON.stringify(versionMetadata),
          input.authorUserId || null,
        ],
      );
    }

    await client.query(
      `INSERT INTO skill_package_version_specs (
         catalog_version_id,
         canonical_slug,
         name,
         description_blocks,
         summary_text,
         metadata
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
       ON CONFLICT (catalog_version_id) DO UPDATE SET
         canonical_slug = EXCLUDED.canonical_slug,
         name = EXCLUDED.name,
         description_blocks = EXCLUDED.description_blocks,
         summary_text = EXCLUDED.summary_text,
         metadata = EXCLUDED.metadata`,
      [
        versionId,
        canonicalSlug,
        name,
        JSON.stringify(descriptionBlocks),
        summaryText,
        JSON.stringify(input.metadata || {}),
      ],
    );

    await upsertCatalogVersionFiles(client.query.bind(client), versionId, attachmentFiles);

    await client.query(
      `UPDATE catalog_items
       SET latest_version_id = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [itemId, versionId],
    );

    return itemId;
  });

  return getMarketplaceSkill(result);
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
    throw new SkillError(400, "Skill slug is required");
  }

  const name = input.name.trim();
  if (!name) {
    throw new SkillError(400, "Skill name is required");
  }

  const description = normalizeSkillDescription(input.description);
  const descriptionBlocks = [description];
  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);
  const target = normalizeScopeTarget({
    useScope: input.useScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });

  const result = await transaction(async (client) => {
    await assertWorkspaceSkillSlugAvailable(
      client.query.bind(client),
      input.workspaceId,
      canonicalSlug,
    );

    const insertedSkill = await client.query<{ id: string }>(
      `INSERT INTO installed_skills (
         workspace_id,
         slug,
         name,
         tags,
         current_version,
         is_active,
         created_by
       )
       VALUES ($1, $2, $3, $4, 1, TRUE, $5)
       RETURNING id`,
      [
        input.workspaceId,
        canonicalSlug,
        name,
        input.tags || [],
        input.installedBy || null,
      ],
    );
    const skillId = insertedSkill.rows[0]!.id;

    const insertedVersion = await client.query<{ id: string }>(
      `INSERT INTO skill_versions (
         skill_id,
         version,
         name,
         description_blocks,
         summary_text,
         metadata,
         created_by
       )
       VALUES ($1, 1, $2, $3::jsonb, $4, $5::jsonb, $6)
       RETURNING id`,
      [
        skillId,
        name,
        JSON.stringify(descriptionBlocks),
        renderSkillBlocksToText(descriptionBlocks),
        JSON.stringify(metadataWithIconUrl({}, input.iconUrl)),
        input.installedBy || null,
      ],
    );
    const skillVersionId = insertedVersion.rows[0]!.id;

    await insertSkillFiles(client.query.bind(client), skillVersionId, attachmentFiles);

    const installedSkillAuthzEntryIds = await queueAuthzRelationships(
      client,
      buildInstalledSkillAuthzMutations({
        skillId,
        workspaceId: input.workspaceId,
        ownerUserId: input.installedBy,
        operation: "touch",
      }),
      {
        source: "skill.create",
        workspaceId: input.workspaceId,
        skillId,
      },
    );

    const bindingResult = await ensureSkillBinding(client.query.bind(client), {
      skillId,
      workspaceId: input.workspaceId,
      target,
      createdBy: input.installedBy,
      isPrimary: true,
    });

    return {
      skillId,
      authzEntryIds: [
        ...installedSkillAuthzEntryIds,
        ...bindingResult.authzEntryIds,
      ],
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "skill.create");
  return getInstalledSkillResponse(input.workspaceId, result.skillId);
}

export async function listInstalledSkills(workspaceId: string, filters?: {
  useScope?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  sourceSkillId?: string;
}) {
  const filteredSkillIds = await findSkillIdsByBindingFilter({
    workspaceId,
    useScope: filters?.useScope,
    actorId: filters?.actorId,
    conversationId: filters?.conversationId,
    userId: filters?.userId,
  });
  if (filteredSkillIds && filteredSkillIds.length === 0) {
    return [];
  }

  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: filteredSkillIds || undefined,
    sourceSkillId: filters?.sourceSkillId,
  });
  if (rows.length === 0) return [];

  const skillIds = rows.map((row) => row.skill_id);
  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap(skillIds, {
      useScope: filters?.useScope,
      actorId: filters?.actorId,
      conversationId: filters?.conversationId,
      userId: filters?.userId,
    }),
    loadSkillFilesMap(rows.map((row) => row.current_skill_version_id)),
  ]);

  return rows.map((row) =>
    buildInstalledSkillPayload(
      row,
      bindingMap.get(row.skill_id),
      fileMap.get(row.current_skill_version_id) || [],
    ),
  );
}

export async function getInstalledSkill(workspaceId: string, installedSkillId: string) {
  return getInstalledSkillResponse(workspaceId, installedSkillId);
}

export async function getInstalledSkillAccessState(
  workspaceId: string,
  installedSkillId: string,
) {
  const skillRow = await loadInstalledSkillForUpdate(workspaceId, installedSkillId);
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found");
  }

  const accessRows = await listSkillAccessRows(installedSkillId);
  const grants = accessRows.map(mapSkillAccessRowToGrant);
  const primaryAccess = accessRows.find((row) => isPrimaryAccessBinding(row));
  const suggestedGrantScope = primaryAccess
    ? resolvePublicUseScope(primaryAccess.bind_scope)
    : ("workspace" as SkillUseScope);

  return {
    grants,
    summary: {
      requiredPermissions: ["use"],
      suggestedGrantScope,
      reason: "Choose who can use this installed skill.",
      effectivePermissions: grants.length > 0 ? ["use"] : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  };
}

export async function grantInstalledSkillAccess(input: {
  workspaceId: string;
  installedSkillId: string;
  grantScope?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  permissions?: string[];
  grantedBy?: string;
  reason?: string;
  metadata?: JsonObject;
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId,
  );
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found");
  }

  const accessRows = await listSkillAccessRows(input.installedSkillId);
  const primaryAccess = accessRows.find((row) => isPrimaryAccessBinding(row));
  const grantScope =
    input.grantScope ||
    (primaryAccess
      ? resolvePublicUseScope(primaryAccess.bind_scope)
      : ("workspace" as SkillUseScope));

  const accessTarget = resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    grantScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });

  const existing = accessRows.find(
    (row) =>
      row.status === "active" &&
      row.relation === accessTarget.relation &&
      row.subject_type === accessTarget.subjectType &&
      row.subject_id === accessTarget.subjectId,
  );
  if (existing) {
    return mapSkillAccessRowToGrant(existing);
  }

  const result = await transaction(async (client) => {
    const inserted = await client.query<AccessBindingRow>(
      `INSERT INTO access_bindings (
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         metadata,
         status,
         created_by,
         reason
       )
       VALUES ($1, 'installed_skill', $2, $3, $4, $5, $6::jsonb, 'active', $7, $8)
       RETURNING
         id,
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         subject_relation,
         status,
         created_by,
         reason,
         metadata,
         created_at,
         revoked_at`,
      [
        input.workspaceId,
        input.installedSkillId,
        accessTarget.relation,
        accessTarget.subjectType,
        accessTarget.subjectId,
        JSON.stringify({
          ...(input.metadata || {}),
          isPrimary: false,
          grantScope,
          actorId: accessTarget.actorId,
          conversationId: accessTarget.conversationId,
          userId: accessTarget.userId,
          requestedPermissions: input.permissions || ["use"],
          reason: input.reason || null,
        }),
        input.grantedBy || null,
        input.reason || null,
      ],
    );

    const accessRow = buildSkillAccessRow(inserted.rows[0]!);
    const authzEntryIds = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "installed_skill",
        resourceId: input.installedSkillId,
        target: accessTarget,
        operation: "touch",
      }),
      {
        source: "skill.access.grant",
        workspaceId: input.workspaceId,
        skillId: input.installedSkillId,
        accessBindingId: accessRow.id,
      },
    );

    return {
      accessRow,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "skill.access.grant");
  return mapSkillAccessRowToGrant(result.accessRow);
}

export async function revokeInstalledSkillAccess(input: {
  workspaceId: string;
  installedSkillId: string;
  grantId: string;
}) {
  const accessRows = await listSkillAccessRows(input.installedSkillId, true);
  const accessRow = accessRows.find((row) => row.id === input.grantId);
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found");
  }
  if (isPrimaryAccessBinding(accessRow)) {
    throw new SkillError(
      400,
      "Primary skill access cannot be removed here. Update the installed skill scope instead.",
    );
  }
  if (accessRow.status === "revoked") {
    return mapSkillAccessRowToGrant(accessRow);
  }

  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "installed_skill",
        resourceId: input.installedSkillId,
        target: readAccessBindingTarget(accessRow),
        operation: "delete",
      }),
      {
        source: "skill.access.revoke",
        workspaceId: input.workspaceId,
        skillId: input.installedSkillId,
        accessBindingId: accessRow.id,
      },
    );

    await client.query(
      `UPDATE access_bindings
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1`,
      [accessRow.id],
    );

    return ids;
  });

  await flushQueuedAuthzEntries(authzEntryIds, "skill.access.revoke");
  return { success: true };
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

  const marketplaceSkill = await getMarketplaceRowById(input.marketSkillId);
  if (!marketplaceSkill || !marketplaceSkill.latest_version_id) {
    throw new SkillError(404, "Marketplace skill not found");
  }

  const sourceFilesMap = await loadCatalogVersionFilesMap([marketplaceSkill.latest_version_id]);
  const sourceFiles = sourceFilesMap.get(marketplaceSkill.latest_version_id) || [];

  const result = await transaction(async (client) => {
    const existingSkillId = await findInstalledSkillBySource(
      input.workspaceId,
      input.marketSkillId,
      client.query.bind(client),
    );

    if (existingSkillId) {
      const bindingResult = await ensureSkillBinding(client.query.bind(client), {
        skillId: existingSkillId,
        workspaceId: input.workspaceId,
        target,
        createdBy: input.installedBy,
        isPrimary: false,
      });

      return {
        skillId: existingSkillId,
        authzEntryIds: bindingResult.authzEntryIds,
      };
    }

    const installedSlug = await allocateInstalledSkillSlug(
      client.query.bind(client),
      input.workspaceId,
      sanitizeSlug(marketplaceSkill.spec_canonical_slug || marketplaceSkill.item_slug),
    );

    const insertedSkill = await client.query<{ id: string }>(
      `INSERT INTO installed_skills (
         workspace_id,
         slug,
         name,
         tags,
         current_version,
         is_active,
         created_by
       )
       VALUES ($1, $2, $3, $4, 1, TRUE, $5)
       RETURNING id`,
      [
        input.workspaceId,
        installedSlug,
        marketplaceSkill.spec_name || marketplaceSkill.item_display_name,
        marketplaceSkill.item_tags || [],
        input.installedBy || null,
      ],
    );
    const skillId = insertedSkill.rows[0]!.id;

    const descriptionBlocks = normalizeStoredBlocks(marketplaceSkill.spec_description_blocks);
    const versionMetadata = metadataWithIconUrl(
      {},
      iconUrlFromMetadata(marketplaceSkill.item_metadata),
    );

    const insertedVersion = await client.query<{ id: string }>(
      `INSERT INTO skill_versions (
         skill_id,
         version,
         name,
         description_blocks,
         summary_text,
         metadata,
         created_by
       )
       VALUES ($1, 1, $2, $3::jsonb, $4, $5::jsonb, $6)
       RETURNING id`,
      [
        skillId,
        marketplaceSkill.spec_name || marketplaceSkill.item_display_name,
        JSON.stringify(descriptionBlocks),
        marketplaceSkill.spec_summary_text || renderSkillBlocksToText(descriptionBlocks),
        JSON.stringify(versionMetadata),
        input.installedBy || null,
      ],
    );
    const skillVersionId = insertedVersion.rows[0]!.id;

    await insertSkillFiles(
      client.query.bind(client),
      skillVersionId,
      sourceFiles.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })),
    );

    await client.query(
      `INSERT INTO skill_source_refs (
         skill_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         is_customized,
         metadata
       )
       VALUES ($1, $2, $3, 'manual_merge', FALSE, '{}'::jsonb)`,
      [
        skillId,
        marketplaceSkill.item_id,
        marketplaceSkill.latest_version_id,
      ],
    );

    await client.query(
      `UPDATE catalog_items
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [marketplaceSkill.item_id],
    );

    const installedSkillAuthzEntryIds = await queueAuthzRelationships(
      client,
      buildInstalledSkillAuthzMutations({
        skillId,
        workspaceId: input.workspaceId,
        ownerUserId: input.installedBy,
        operation: "touch",
      }),
      {
        source: "skill.install",
        workspaceId: input.workspaceId,
        skillId,
        sourceSkillId: input.marketSkillId,
      },
    );

    const bindingResult = await ensureSkillBinding(client.query.bind(client), {
      skillId,
      workspaceId: input.workspaceId,
      target,
      createdBy: input.installedBy,
      isPrimary: true,
    });

    return {
      skillId,
      authzEntryIds: [
        ...installedSkillAuthzEntryIds,
        ...bindingResult.authzEntryIds,
      ],
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "skill.install");
  return getInstalledSkillResponse(input.workspaceId, result.skillId);
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
  const existing = await loadInstalledSkillForUpdate(input.workspaceId, input.installedSkillId);
  if (!existing) {
    throw new SkillError(404, "Installed skill not found");
  }

  const currentFilesMap = await loadSkillFilesMap([existing.current_skill_version_id]);
  const currentFiles = currentFilesMap.get(existing.current_skill_version_id) || [];
  const currentDescription = descriptionBlockFromStored(existing.version_description_blocks);
  const touchesContent =
    input.name !== undefined ||
    input.description !== undefined ||
    input.iconUrl !== undefined ||
    input.tags !== undefined ||
    input.attachmentFiles !== undefined;

  await transaction(async (client) => {
    let nextVersion = existing.current_version;
    let nextName = existing.name;
    let nextTags = existing.tags || [];

    if (touchesContent) {
      nextVersion = existing.current_version + 1;
      nextName = input.name?.trim() || existing.name;
      nextTags = input.tags || existing.tags || [];

      const descriptionBlock = input.description
        ? normalizeSkillDescription(input.description)
        : currentDescription;
      const descriptionBlocks = [descriptionBlock];
      const iconUrl =
        input.iconUrl === undefined
          ? iconUrlFromMetadata(existing.version_metadata)
          : input.iconUrl || undefined;
      const attachmentFiles = input.attachmentFiles
        ? normalizeSkillAttachments(input.attachmentFiles)
        : currentFiles.map((file) => ({
            path: file.path,
            contentBlocks: normalizeStoredBlocks(file.contentBlocks),
          }));

      const versionInsert = await client.query<{ id: string }>(
        `INSERT INTO skill_versions (
           skill_id,
           version,
           name,
           description_blocks,
           summary_text,
           metadata,
           created_by
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
         RETURNING id`,
        [
          existing.skill_id,
          nextVersion,
          nextName,
          JSON.stringify(descriptionBlocks),
          renderSkillBlocksToText(descriptionBlocks),
          JSON.stringify(metadataWithIconUrl(existing.version_metadata, iconUrl)),
          existing.created_by || null,
        ],
      );

      await insertSkillFiles(
        client.query.bind(client),
        versionInsert.rows[0]!.id,
        attachmentFiles,
      );

      await client.query(
        `UPDATE installed_skills
         SET name = $2,
             tags = $3,
             current_version = $4,
             is_active = COALESCE($5, is_active),
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.skill_id,
          nextName,
          nextTags,
          nextVersion,
          input.isEnabled === undefined ? null : input.isEnabled,
        ],
      );

      if (existing.source_catalog_item_id) {
        await client.query(
          `UPDATE skill_source_refs
           SET is_customized = TRUE,
               updated_at = NOW()
           WHERE skill_id = $1`,
          [existing.skill_id],
        );
      }

      return;
    }

    if (input.isEnabled !== undefined) {
      await client.query(
        `UPDATE installed_skills
         SET is_active = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [existing.skill_id, input.isEnabled],
      );
    }
  });

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
}) {
  const existing = await loadInstalledSkillForUpdate(input.workspaceId, input.installedSkillId);
  if (!existing) {
    throw new SkillError(404, "Installed skill not found");
  }
  if (!existing.source_catalog_item_id) {
    throw new SkillError(400, "Installed skill has no marketplace source");
  }

  const marketplaceSkill = await getMarketplaceRowById(existing.source_catalog_item_id);
  if (!marketplaceSkill || !marketplaceSkill.latest_version_id) {
    throw new SkillError(400, "Marketplace source has no latest version");
  }

  if (
    existing.source_catalog_version_id &&
    existing.source_catalog_version_id === marketplaceSkill.latest_version_id
  ) {
    return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
  }

  const sourceFilesMap = await loadCatalogVersionFilesMap([marketplaceSkill.latest_version_id]);
  const sourceFiles = sourceFilesMap.get(marketplaceSkill.latest_version_id) || [];

  await transaction(async (client) => {
    const descriptionBlocks = normalizeStoredBlocks(marketplaceSkill.spec_description_blocks);
    const versionInsert = await client.query<{ id: string }>(
      `INSERT INTO skill_versions (
         skill_id,
         version,
         name,
         description_blocks,
         summary_text,
         metadata,
         created_by
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
       RETURNING id`,
      [
        existing.skill_id,
        existing.current_version + 1,
        marketplaceSkill.spec_name || marketplaceSkill.item_display_name,
        JSON.stringify(descriptionBlocks),
        marketplaceSkill.spec_summary_text || renderSkillBlocksToText(descriptionBlocks),
        JSON.stringify(
          metadataWithIconUrl(
            existing.version_metadata,
            iconUrlFromMetadata(marketplaceSkill.item_metadata),
          ),
        ),
        existing.created_by || null,
      ],
    );

    await insertSkillFiles(
      client.query.bind(client),
      versionInsert.rows[0]!.id,
      sourceFiles.map((file) => ({
        path: file.path,
        contentBlocks: file.contentBlocks,
      })),
    );

    await client.query(
      `UPDATE installed_skills
       SET name = $2,
           tags = $3,
           current_version = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [
        existing.skill_id,
        marketplaceSkill.spec_name || marketplaceSkill.item_display_name,
        marketplaceSkill.item_tags || [],
        existing.current_version + 1,
      ],
    );

    await client.query(
      `UPDATE skill_source_refs
       SET source_catalog_version_id = $2,
           is_customized = FALSE,
           updated_at = NOW()
       WHERE skill_id = $1`,
      [
        existing.skill_id,
        marketplaceSkill.latest_version_id,
      ],
    );
  });

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
}

export async function uninstallInstalledSkill(workspaceId: string, installedSkillId: string) {
  const result = await transaction(async (client) => {
    const existing = await client.query<InstalledSkillRow>(
      `${INSTALLED_SKILL_SELECT}
       WHERE skill.workspace_id = $1
         AND skill.id = $2
       LIMIT 1`,
      [workspaceId, installedSkillId],
    );
    const skill = existing.rows[0];
    if (!skill) {
      return {
        deleted: false,
        authzEntryIds: [] as string[],
      };
    }

    const bindings = await client.query<AccessBindingRow>(
      `SELECT
         id,
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         subject_relation,
         status,
         created_by,
         reason,
         metadata,
         created_at,
         revoked_at
       FROM access_bindings
       WHERE resource_type = 'installed_skill'
         AND resource_id = $1`,
      [installedSkillId],
    );

    await client.query(
      `DELETE FROM installed_skills
       WHERE id = $1
         AND workspace_id = $2`,
      [installedSkillId, workspaceId],
    );

    const authzMutations = [
      ...buildInstalledSkillAuthzMutations({
        skillId: installedSkillId,
        workspaceId,
        ownerUserId: skill.created_by,
        operation: "delete",
      }),
      ...bindings.rows
        .filter((binding) => binding.status === "active")
        .flatMap((binding) =>
          buildResourceAccessAuthzMutations({
            resourceType: "installed_skill",
            resourceId: installedSkillId,
            target: readAccessBindingTarget(binding),
            operation: "delete",
          }),
        ),
    ];

    await client.query(
      `DELETE FROM access_bindings
       WHERE resource_type = 'installed_skill'
         AND resource_id = $1`,
      [installedSkillId],
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      authzMutations,
      {
        source: "skill.delete",
        workspaceId,
        skillId: installedSkillId,
      },
    );

    return {
      deleted: true,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "skill.delete");
  return result.deleted;
}

function buildVisibilitySubjects(input: {
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const subjects: AuthzSubject[] = [];

  if (input.actorId) {
    subjects.push({
      type: "actor",
      id: input.actorId,
    });
  }

  if (input.userId) {
    subjects.push({
      type: "user",
      id: input.userId,
    });
  }

  if (input.actorId && input.conversationId) {
    subjects.push({
      type: "actor_conversation",
      id: buildActorConversationContextId(input.actorId, input.conversationId),
    });
  }

  return subjects;
}

function accessMatchesVisibilityContext(
  binding: SkillAccessRow,
  input: {
    actorId?: string;
    conversationId?: string;
    userId?: string;
  },
) {
  switch (binding.bind_scope) {
    case "workspace":
      return true;
    case "conversation":
      return binding.conversation_id === input.conversationId;
    case "actor":
      return binding.actor_id === input.actorId;
    case "actor_conversation":
      return (
        binding.actor_id === input.actorId &&
        binding.conversation_id === input.conversationId
      );
    case "user":
      return binding.user_id === input.userId;
  }
}

function visibleRowToAccessRow(
  row: VisibleSkillRow,
  workspaceId: string,
): SkillAccessRow {
  return {
    id: row.access_binding_id,
    workspace_id: workspaceId,
    resource_type: "installed_skill",
    resource_id: row.skill_id,
    relation: "use_workspace",
    subject_type: "workspace",
    subject_id: workspaceId,
    subject_relation: null,
    status: "active",
    created_by: null,
    reason: null,
    metadata: { isPrimary: true },
    created_at: row.access_created_at,
    revoked_at: null,
    skill_id: row.skill_id,
    bind_scope: row.access_bind_scope,
    conversation_id: row.conversation_id,
    actor_id: row.actor_id,
    user_id: row.user_id,
  };
}

export async function listVisibleSkills(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const subjects = buildVisibilitySubjects(input);
  if (subjects.length === 0) {
    return [] as AvailableSkillSummary[];
  }

  const visibleSkillIds = new Set<string>();
  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources({
        resourceType: "installed_skill",
        permission: "use",
        subject,
      }),
    ),
  );

  for (const ids of lookups) {
    for (const id of ids) {
      visibleSkillIds.add(id);
    }
  }

  if (visibleSkillIds.size === 0) {
    return [];
  }

  const [rows, bindingsBySkillId] = await Promise.all([
    query<VisibleSkillRow>(
      `SELECT
         skill.id AS skill_id,
         skill.slug,
         skill.name,
         skill.current_version,
         version_row.id AS current_skill_version_id,
         version_row.description_blocks,
         imported_version.version AS source_version_value,
         skill.id AS access_binding_id,
         'workspace'::varchar AS access_bind_scope,
         NULL::uuid AS conversation_id,
         NULL::uuid AS actor_id,
         NULL::uuid AS user_id,
         skill.updated_at AS access_created_at
       FROM installed_skills skill
       JOIN skill_versions version_row
         ON version_row.skill_id = skill.id
        AND version_row.version = skill.current_version
       LEFT JOIN skill_source_refs source_ref
         ON source_ref.skill_id = skill.id
       LEFT JOIN catalog_versions imported_version
         ON imported_version.id = source_ref.source_catalog_version_id
       WHERE skill.id = ANY($1::uuid[])
         AND skill.workspace_id = $2
         AND skill.is_active = TRUE
       ORDER BY skill.slug ASC, skill.updated_at DESC`,
      [Array.from(visibleSkillIds), input.workspaceId],
    ),
    loadAccessBindingsBySkillIds(Array.from(visibleSkillIds)),
  ]);

  const deduped = new Map<string, VisibleSkillRow>();
  for (const row of rows.rows) {
    const bindings = (bindingsBySkillId.get(row.skill_id) || []).filter((binding) =>
      accessMatchesVisibilityContext(binding, input),
    );
    const chosenBinding = [...bindings].sort(compareVisibleBindingPriority)[0];
    const candidate: VisibleSkillRow = {
      ...row,
      access_binding_id: chosenBinding?.id || row.access_binding_id,
      access_bind_scope: chosenBinding?.bind_scope || "workspace",
      conversation_id: chosenBinding?.conversation_id || null,
      actor_id: chosenBinding?.actor_id || null,
      user_id: chosenBinding?.user_id || null,
      access_created_at: chosenBinding?.created_at || row.access_created_at,
    };
    const existing = deduped.get(row.slug);
    if (!existing) {
      deduped.set(row.slug, candidate);
      continue;
    }
    if (
      compareVisibleBindingPriority(
        visibleRowToAccessRow(candidate, input.workspaceId),
        visibleRowToAccessRow(existing, input.workspaceId),
      ) < 0
    ) {
      deduped.set(row.slug, candidate);
    }
  }

  return Array.from(deduped.values()).map(buildAvailableSkillPayload);
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
  const match = visibleSkills.find(
    (skill) =>
      skill.slug.toLowerCase() === normalizedName ||
      skill.name.toLowerCase() === normalizedName,
  );

  if (!match) {
    throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
  }

  const installedSkill = await loadInstalledSkillForUpdate(input.workspaceId, match.instanceId);
  if (!installedSkill) {
    throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
  }

  if (!input.assetPath) {
    const description = descriptionBlockFromStored(installedSkill.version_description_blocks);
    return {
      skill: match,
      asset: {
        path: SKILL_DESCRIPTION_ASSET_PATH,
        textContent: renderSkillBlocksToText([description]),
        contentBlocks: [description],
      },
    };
  }

  const targetPath = normalizePath(input.assetPath);
  const result = await query<SkillFileRow>(
    `SELECT id, skill_version_id, path, content_blocks, created_at, updated_at
     FROM skill_files
     WHERE skill_version_id = $1
       AND path = $2
     LIMIT 1`,
    [installedSkill.current_skill_version_id, targetPath],
  );

  const asset = result.rows[0];
  if (!asset) {
    throw new SkillError(404, `Skill attachment "${targetPath}" not found`);
  }

  const contentBlocks = normalizeStoredBlocks(asset.content_blocks);
  return {
    skill: match,
    asset: {
      path: asset.path,
      textContent: renderSkillBlocksToText(contentBlocks),
      contentBlocks,
    },
  };
}
