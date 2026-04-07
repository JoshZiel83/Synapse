import crypto from "node:crypto";
import type pg from "pg";
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  FILE_ORIGIN_SYSTEMS,
  maskAllowsConversationType,
  normalizeConversationTypeMask,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  type AvailableSkillSummary,
  type CapabilityAccessTarget,
  type InstalledSkill,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  normalizeCanonicalContentBlocks,
  type RuntimeBindingScope,
  type SkillAttachmentFile,
  type SkillFrontmatter,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  textBlock,
} from "@synapse/shared";
import {
  lookupResources,
} from "../access/core.js";
import { transaction } from "../../infrastructure/database/index.js";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";
import {
  getWorkspaceCapabilityConversationTypeMask,
  getWorkspaceCapabilityConversationTypePolicyMap,
} from "../capabilities/conversation-type-policies.js";
import {
  buildResourceAccessBindingRef,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  readAccessBindingTarget,
  relationForAccessTargetType,
  resolveAccessGrantTarget,
  type AccessBindingRow,
} from "../access/bindings.js";
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  validateConversationScopedAccessTarget,
} from "../access/conversation-type-validation.js";
import {
  buildSystemGeneratedOrigin,
  canUserAccessFileWorkspace,
  duplicateFileRecord,
  getFileAccessInfo,
  getFileUrlById,
} from "../files/service.js";
import { buildConversationCapabilitySubjects } from "../access/subject-resolution.js";
import {
  listRelayAutoLoadedSkills,
  readRelayAutoLoadedSkill,
} from "./relay-auto-skills.js";
import {
  SKILL_ENTRY_PATH,
  buildSyntheticEntryFile,
  buildSkillMarkdown,
  normalizeSkillCommandName,
  normalizeSkillFiles,
  normalizeSkillFilePath,
  renderCanonicalBlocksToText,
  type SkillFileInput,
} from "./manifest.js";
import {
  buildPreparedSnapshotFromExistingData,
  buildSyntheticSkillFilesFromSnapshot,
  importClawhubSeedSkillPackage,
  importClawhubSkillPackage,
  importGitHubSkillPackage,
  prepareSkillSnapshotFromFiles,
  type ImportedMirrorSkillPackage,
  type PreparedSkillSnapshot,
} from "./mirror-import.js";

type SkillUseScope = CapabilityAccessTarget["type"];

type QueryRow = pg.QueryResultRow;
type QueryResultLike<T extends QueryRow> = { rows: T[] };
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResultLike<T>>;

const runQuery: QueryRunner = executeSql;

function clientRunner(client: pg.PoolClient): QueryRunner {
  return async <T extends QueryRow>(text: string, params?: unknown[]) =>
    executeSqlOn<T>(client, text, params);
}

type JsonObject = Record<string, unknown>;

type SkillAttachmentInput = {
  path: string;
  contentBlocks: CanonicalContentBlockInput[];
  mediaType?: string;
};

type SkillScopeTarget = {
  bindScope: RuntimeBindingScope;
  useScope: SkillUseScope;
  actorId: string | null;
  conversationId: string | null;
};

type SkillSnapshotJoinRow = {
  snapshot_id: string | null;
  snapshot_entry_path: string | null;
  snapshot_name: string | null;
  snapshot_description: string | null;
  snapshot_argument_hint: string | null;
  snapshot_disable_model_invocation: boolean | null;
  snapshot_user_invocable: boolean | null;
  snapshot_allowed_tools: string[] | null;
  snapshot_model: string | null;
  snapshot_effort: "low" | "medium" | "high" | "max" | null;
  snapshot_context: "fork" | null;
  snapshot_agent: string | null;
  snapshot_hooks: unknown;
  snapshot_body_blocks: unknown;
  snapshot_content_hash: string | null;
  snapshot_source_warnings: string[] | null;
  snapshot_resolved_revision: string | null;
  snapshot_created_at: string | null;
  mirror_source_id: string | null;
  mirror_source_type: "github" | "clawhub" | null;
  mirror_locator_key: string | null;
  mirror_locator: unknown;
  mirror_requested_ref: string | null;
  mirror_resolved_revision: string | null;
  mirror_refresh_mode: "manual" | null;
  mirror_last_sync_status: "pending" | "synced" | "error" | null;
  mirror_source_warnings: string[] | null;
  mirror_last_error: string | null;
  mirror_last_synced_at: string | null;
  mirror_created_at: string | null;
  mirror_updated_at: string | null;
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
  item_icon_file_id: string | null;
  item_metadata: unknown;
  item_created_at: string;
  item_updated_at: string;
  latest_version_id: string | null;
  latest_version_value: string | null;
  latest_version_changelog: string | null;
  latest_version_created_by_user_id: string | null;
  latest_version_created_at: string | null;
  spec_default_conversation_type_mask: number | null;
  publisher_id: string;
  publisher_slug: string;
  publisher_display_name: string;
  publisher_owner_user_id: string | null;
} & SkillSnapshotJoinRow;

type InstalledSkillRow = {
  skill_id: string;
  workspace_id: string;
  slug: string;
  name: string;
  icon_file_id: string | null;
  tags: string[] | null;
  current_version: number;
  is_active: boolean;
  conversation_type_mask_override: number | null;
  created_by_workspace_member_id: string | null;
  created_at: string;
  updated_at: string;
  current_snapshot_id: string;
  current_skill_version_id: string;
  current_skill_snapshot_id: string;
  version_metadata: unknown;
  source_catalog_item_id: string | null;
  source_catalog_version_id: string | null;
  source_sync_mode:
    | "notify"
    | "manual_merge"
    | "follow_upstream"
    | "detached"
    | null;
  source_is_customized: boolean | null;
  source_slug: string | null;
  source_latest_version_id: string | null;
  source_version_value: string | null;
  latest_source_version: string | null;
  source_default_conversation_type_mask: number | null;
} & SkillSnapshotJoinRow;

type SkillSnapshotFileRow = {
  id: string;
  skill_snapshot_id: string;
  path: string;
  media_type: string | null;
  content_blocks: unknown;
  created_at: string;
  updated_at: string;
};

type SkillAccessRow = AccessBindingRow & {
  skill_id: string;
  bind_scope: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  workspace_member_id: string | null;
};

type VisibleSkillRow = {
  access_binding_id: string;
  skill_id: string;
  workspace_id: string;
  access_bind_scope: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  workspace_member_id: string | null;
  slug: string;
  name: string;
  current_version: number;
  current_skill_version_id: string;
  description: string;
  source_version_value: string | null;
  conversation_type_mask_override: number | null;
  access_created_at: string;
};

type InstallationSummary = {
  installed: boolean;
  installedCount: number;
  installedSkillId?: string;
};

const DEFAULT_MARKETPLACE_PUBLISHER_SLUG = "synapse-official";
const DEFAULT_MARKETPLACE_PUBLISHER_NAME = "Synapse Official";
const GITHUB_MARKETPLACE_PUBLISHER_SLUG = "github-mirror";
const GITHUB_MARKETPLACE_PUBLISHER_NAME = "GitHub Mirror";
const CLAWHUB_MARKETPLACE_PUBLISHER_SLUG = "clawhub-official";
const CLAWHUB_MARKETPLACE_PUBLISHER_NAME = "ClawHub Mirror";

const SKILL_SNAPSHOT_SELECT = `
    snapshot.id AS snapshot_id,
    snapshot.entry_path AS snapshot_entry_path,
    snapshot.name AS snapshot_name,
    snapshot.description AS snapshot_description,
    snapshot.argument_hint AS snapshot_argument_hint,
    snapshot.disable_model_invocation AS snapshot_disable_model_invocation,
    snapshot.user_invocable AS snapshot_user_invocable,
    snapshot.allowed_tools AS snapshot_allowed_tools,
    snapshot.model AS snapshot_model,
    snapshot.effort AS snapshot_effort,
    snapshot.context AS snapshot_context,
    snapshot.agent AS snapshot_agent,
    snapshot.hooks AS snapshot_hooks,
    snapshot.body_blocks AS snapshot_body_blocks,
    snapshot.content_hash AS snapshot_content_hash,
    snapshot.source_warnings AS snapshot_source_warnings,
    snapshot.resolved_revision AS snapshot_resolved_revision,
    snapshot.created_at AS snapshot_created_at,
    mirror.id AS mirror_source_id,
    mirror.source_type AS mirror_source_type,
    mirror.locator_key AS mirror_locator_key,
    mirror.locator AS mirror_locator,
    mirror.requested_ref AS mirror_requested_ref,
    mirror.resolved_revision AS mirror_resolved_revision,
    mirror.refresh_mode AS mirror_refresh_mode,
    mirror.last_sync_status AS mirror_last_sync_status,
    mirror.source_warnings AS mirror_source_warnings,
    mirror.last_error AS mirror_last_error,
    mirror.last_synced_at AS mirror_last_synced_at,
    mirror.created_at AS mirror_created_at,
    mirror.updated_at AS mirror_updated_at
`;

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
    item.icon_file_id AS item_icon_file_id,
    item.metadata AS item_metadata,
    item.created_at AS item_created_at,
    item.updated_at AS item_updated_at,
    version.id AS latest_version_id,
    version.version AS latest_version_value,
    version.changelog AS latest_version_changelog,
    version.created_by_user_id AS latest_version_created_by_user_id,
    version.created_at AS latest_version_created_at,
    spec.default_conversation_type_mask AS spec_default_conversation_type_mask,
${SKILL_SNAPSHOT_SELECT},
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
  LEFT JOIN skill_snapshots snapshot
    ON snapshot.id = spec.skill_snapshot_id
  LEFT JOIN skill_mirror_sources mirror
    ON mirror.id = snapshot.mirror_source_id
  WHERE item.item_kind = 'skill_package'
    AND item.workspace_id IS NULL
`;

const INSTALLED_SKILL_SELECT = `
  SELECT
    skill.id AS skill_id,
    skill.workspace_id,
    skill.slug,
    skill.name,
    skill.icon_file_id,
    skill.tags,
    skill.current_version,
    skill.current_snapshot_id,
    skill.is_active,
    skill.conversation_type_mask_override,
    skill.created_by_workspace_member_id,
    skill.created_at,
    skill.updated_at,
    version_row.id AS current_skill_version_id,
    version_row.skill_snapshot_id AS current_skill_snapshot_id,
    version_row.metadata AS version_metadata,
    source_ref.source_catalog_item_id,
    source_ref.source_catalog_version_id,
    source_ref.sync_mode AS source_sync_mode,
    source_ref.is_customized AS source_is_customized,
    source_item.slug AS source_slug,
    source_item.latest_version_id AS source_latest_version_id,
    imported_version.version AS source_version_value,
    latest_version.version AS latest_source_version,
    imported_spec.default_conversation_type_mask AS source_default_conversation_type_mask,
${SKILL_SNAPSHOT_SELECT}
  FROM installed_skills skill
  JOIN skill_versions version_row
    ON version_row.skill_id = skill.id
   AND version_row.version = skill.current_version
  JOIN skill_snapshots snapshot
    ON snapshot.id = skill.current_snapshot_id
  LEFT JOIN skill_source_refs source_ref
    ON source_ref.skill_id = skill.id
  LEFT JOIN catalog_items source_item
    ON source_item.id = source_ref.source_catalog_item_id
  LEFT JOIN catalog_versions imported_version
    ON imported_version.id = source_ref.source_catalog_version_id
  LEFT JOIN skill_package_version_specs imported_spec
    ON imported_spec.catalog_version_id = source_ref.source_catalog_version_id
  LEFT JOIN catalog_versions latest_version
    ON latest_version.id = source_item.latest_version_id
  LEFT JOIN skill_mirror_sources mirror
    ON mirror.id = snapshot.mirror_source_id
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
  try {
    return normalizeSkillFilePath(assetPath);
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message);
    }
    throw error;
  }
}

function defaultDescriptionBlock(text = ""): CanonicalContentBlock {
  return textBlock(text);
}

function normalizeSkillDescription(description?: CanonicalContentBlockInput) {
  const normalized = normalizeCanonicalContentBlocks(
    description ? [description] : [defaultDescriptionBlock()],
  );

  return normalized[0] || defaultDescriptionBlock();
}

function normalizeSkillAttachments(files?: SkillAttachmentInput[]) {
  try {
    return normalizeSkillFiles(
      (files || []).map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentBlocks: Array.isArray(file.contentBlocks) ? file.contentBlocks : [],
      })),
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message);
    }
    throw error;
  }
}

function assertRequiredSkillFile(
  files: Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>,
) {
  if (!files.some((file) => file.path === SKILL_ENTRY_PATH)) {
    throw new SkillError(
      400,
      `Skill must include required path: ${SKILL_ENTRY_PATH}`,
    );
  }
}

function normalizeScopeTarget(input: {
  useScope: SkillUseScope;
  actorId?: string | null;
  conversationId?: string | null;
}): SkillScopeTarget {
  switch (input.useScope) {
    case "workspace":
      return {
        bindScope: "workspace",
        useScope: "workspace",
        actorId: null,
        conversationId: null,
      };
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(
          400,
          "conversationId is required for conversation scope",
        );
      }
      return {
        bindScope: "conversation",
        useScope: "conversation",
        actorId: null,
        conversationId: input.conversationId,
      };
    case "actor":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor scope");
      }
      return {
        bindScope: "actor",
        useScope: "actor",
        actorId: input.actorId,
        conversationId: null,
      };
    case "actor_in_conversation":
      if (!input.actorId || !input.conversationId) {
        throw new SkillError(
          400,
          "actorId and conversationId are required for actor_in_conversation scope",
        );
      }
      return {
        bindScope: "actor_in_conversation",
        useScope: "actor_in_conversation",
        actorId: input.actorId,
        conversationId: input.conversationId,
      };
    default:
      throw new SkillError(
        400,
        `Unsupported skill scope: ${String(input.useScope)}`,
      );
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
  return renderCanonicalBlocksToText(blocks)
    .split("\n")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n");
}

async function normalizeWorkspaceSkillIconFileId(
  iconFileId: string,
  workspaceId: string,
) {
  const fileInfo = await getFileAccessInfo(iconFileId);
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found");
  }

  if (fileInfo.workspaceId && fileInfo.workspaceId !== workspaceId) {
    throw new SkillError(
      400,
      "Skill icon file must belong to the current workspace",
    );
  }

  return iconFileId;
}

async function normalizeMarketplaceSkillIconFileId(
  iconFileId: string,
  authorUserId?: string,
) {
  const fileInfo = await getFileAccessInfo(iconFileId);
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found");
  }

  if (authorUserId) {
    const canAccess = await canUserAccessFileWorkspace(
      fileInfo.workspaceId ?? null,
      authorUserId,
    );
    if (!canAccess) {
      throw new SkillError(403, "Skill icon file is not accessible");
    }
  } else if (fileInfo.workspaceId) {
    throw new SkillError(
      400,
      "Marketplace skill icon file must be platform-accessible",
    );
  }

  if (!fileInfo.workspaceId) {
    return iconFileId;
  }

  const duplicated = await duplicateFileRecord(iconFileId, {
    workspaceId: null,
    uploaderUserId: authorUserId || null,
    origin: buildSystemGeneratedOrigin({
      system: FILE_ORIGIN_SYSTEMS.MARKETPLACE_SKILL_ICON_COPY,
      initiatorUserId: authorUserId || null,
      details: {
        parentFileId: iconFileId,
      },
    }),
  });
  if (!duplicated) {
    throw new SkillError(400, "Skill icon file not found");
  }

  return duplicated.id;
}

function buildSkillAttachmentFromCatalogFile(
  row: SkillSnapshotFileRow,
): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    mediaType: row.media_type || undefined,
    contentBlocks: normalizeStoredBlocks(row.content_blocks),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function frontmatterFromSnapshotRow(row: SkillSnapshotJoinRow): SkillFrontmatter {
  if (!row.snapshot_id || !row.snapshot_name || row.snapshot_description === null) {
    throw new SkillError(500, "Skill snapshot metadata is missing");
  }

  return {
    name: row.snapshot_name,
    description: row.snapshot_description,
    argumentHint: row.snapshot_argument_hint || undefined,
    disableModelInvocation: Boolean(row.snapshot_disable_model_invocation),
    userInvocable:
      row.snapshot_user_invocable === null
        ? true
        : Boolean(row.snapshot_user_invocable),
    allowedTools: row.snapshot_allowed_tools || [],
    model: row.snapshot_model || undefined,
    effort: row.snapshot_effort || undefined,
    context: row.snapshot_context || undefined,
    agent: row.snapshot_agent || undefined,
    hooks: parseJsonObject(row.snapshot_hooks),
  };
}

function bodyBlocksFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return normalizeStoredBlocks(row.snapshot_body_blocks);
}

function descriptionBlockFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return defaultDescriptionBlock(row.snapshot_description || "");
}

function buildMirrorSourceSummary(row: SkillSnapshotJoinRow) {
  if (
    !row.mirror_source_id ||
    !row.mirror_source_type ||
    !row.mirror_locator_key
  ) {
    return undefined;
  }

  return {
    id: row.mirror_source_id,
    sourceType: row.mirror_source_type,
    locatorKey: row.mirror_locator_key,
    locator: parseJsonObject(row.mirror_locator),
    requestedRef: row.mirror_requested_ref || undefined,
    resolvedRevision:
      row.snapshot_resolved_revision ||
      row.mirror_resolved_revision ||
      undefined,
    refreshMode: row.mirror_refresh_mode || "manual",
    lastSyncStatus: row.mirror_last_sync_status || "pending",
    sourceWarnings: row.mirror_source_warnings || [],
    lastError: row.mirror_last_error || undefined,
    lastSyncedAt: row.mirror_last_synced_at || undefined,
    createdAt: row.mirror_created_at || row.snapshot_created_at || new Date(0).toISOString(),
    updatedAt: row.mirror_updated_at || row.snapshot_created_at || new Date(0).toISOString(),
  };
}

function buildSyntheticEntryAttachment(
  row: SkillSnapshotJoinRow,
  timestamp: string,
): SkillAttachmentFile {
  const synthetic = buildSyntheticEntryFile({
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
  });

  return {
    id: `${row.snapshot_id}:entry`,
    path: synthetic.path,
    mediaType: synthetic.mediaType,
    contentBlocks: synthetic.contentBlocks,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildSnapshotAttachmentFiles(
  row: SkillSnapshotJoinRow,
  timestamp: string,
  files?: SkillAttachmentFile[],
) {
  return [buildSyntheticEntryAttachment(row, timestamp), ...(files || [])];
}

function resolvePublicUseScope(bindScope: RuntimeBindingScope): SkillUseScope {
  switch (bindScope) {
    case "workspace":
    case "conversation":
    case "actor":
    case "actor_in_conversation":
      return bindScope;
  }
}

function compareBindingPriority(left: SkillAccessRow, right: SkillAccessRow) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  };
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor_in_conversation: 0,
    actor: 1,
    conversation: 2,
    workspace: 3,
  };

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status];
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope];
  }
  return (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function compareVisibleBindingPriority(
  left: SkillAccessRow,
  right: SkillAccessRow,
) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  };
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor_in_conversation: 0,
    actor: 1,
    conversation: 2,
    workspace: 3,
  };

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status];
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope];
  }
  return (
    new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  );
}

function selectInitialSkillGrant(accessRows: SkillAccessRow[]) {
  const activeRows = accessRows.filter((row) => row.status === "active");
  return [...activeRows].sort(
    (left, right) =>
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  )[0];
}

function matchesScopeTarget(
  binding: SkillAccessRow,
  filter?: SkillScopeTarget,
) {
  if (!filter) {
    return true;
  }
  return (
    binding.bind_scope === filter.bindScope &&
    binding.actor_id === filter.actorId &&
    binding.conversation_id === filter.conversationId
  );
}

function mapMarketplaceVersion(
  row: SkillPackageRow,
  files?: SkillAttachmentFile[],
): SkillMarketplaceVersion | undefined {
  if (!row.latest_version_id || !row.latest_version_value) {
    return undefined;
  }

  return {
    id: row.latest_version_id,
    skillId: row.item_id,
    version: row.latest_version_value,
    changelog: row.latest_version_changelog || "",
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshot_entry_path || SKILL_ENTRY_PATH,
    contentHash: row.snapshot_content_hash || "",
    sourceWarnings: row.snapshot_source_warnings || [],
    resolvedRevision: row.snapshot_resolved_revision || undefined,
    description: descriptionBlockFromSnapshotRow(row),
    defaultConversationTypeMask:
      row.spec_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK,
    createdByUserId: row.latest_version_created_by_user_id || undefined,
    createdAt: row.latest_version_created_at || row.item_updated_at,
    files: buildSnapshotAttachmentFiles(
      row,
      row.latest_version_created_at || row.item_updated_at,
      files,
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      row.latest_version_created_at || row.item_updated_at,
      files,
    ),
  };
}

function resolveMarketplaceSkillDefaultConversationTypeMask(row: SkillPackageRow) {
  return row.spec_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK;
}

function resolveInstalledSkillSourceConversationTypeMask(row: InstalledSkillRow) {
  return row.source_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK;
}

function resolveInstalledSkillEffectiveConversationTypeMask(row: {
  workspaceConversationTypeMask: number;
  conversation_type_mask_override: number | null;
}) {
  return resolveNarrowedConversationTypeMask(
    row.workspaceConversationTypeMask,
    row.conversation_type_mask_override,
  );
}

function mapMarketplaceEntry(
  row: SkillPackageRow,
  installation?: InstallationSummary,
  files?: SkillAttachmentFile[],
): SkillMarketplaceEntry {
  const defaultConversationTypeMask =
    resolveMarketplaceSkillDefaultConversationTypeMask(row);
  return {
    id: row.item_id,
    slug: row.item_slug,
    name: row.snapshot_name || row.item_display_name,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.item_icon_file_id
      ? getFileUrlById(row.item_icon_file_id)
      : undefined,
    tags: row.item_tags || [],
    authorUserId: row.publisher_owner_user_id || undefined,
    authorName: row.publisher_display_name || undefined,
    isActive: Boolean(row.item_is_active),
    createdAt: row.item_created_at,
    updatedAt: row.item_updated_at,
    defaultConversationTypeMask,
    latestVersionId: row.latest_version_id || undefined,
    latestVersion: mapMarketplaceVersion(row, files),
    mirrorSource: buildMirrorSourceSummary(row),
    workspaceInstallation: installation,
  };
}

function buildInstalledSkillPayload(
  row: InstalledSkillRow,
  binding: SkillAccessRow | undefined,
  workspaceConversationTypeMask: number,
  files?: SkillAttachmentFile[],
): InstalledSkill {
  const chosenBinding = binding;
  const accessTargetType = chosenBinding
    ? resolvePublicUseScope(chosenBinding.bind_scope)
    : ("workspace" as SkillUseScope);
  const sourceDefaultConversationTypeMask =
    resolveInstalledSkillSourceConversationTypeMask(row);
  const effectiveConversationTypeMask =
    resolveInstalledSkillEffectiveConversationTypeMask({
      workspaceConversationTypeMask,
      conversation_type_mask_override: row.conversation_type_mask_override,
    });

  return {
    id: row.skill_id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshot_entry_path || SKILL_ENTRY_PATH,
    contentHash: row.snapshot_content_hash || "",
    sourceWarnings: row.snapshot_source_warnings || [],
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.icon_file_id ? getFileUrlById(row.icon_file_id) : undefined,
    tags: row.tags || [],
    accessTarget: {
      type: accessTargetType,
      actorId: chosenBinding?.actor_id || undefined,
      conversationId: chosenBinding?.conversation_id || undefined,
    },
    isEnabled: Boolean(row.is_active),
    sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask,
    conversationTypeMaskOverride: row.conversation_type_mask_override || undefined,
    effectiveConversationTypeMask,
    isCustomized: Boolean(
      row.source_catalog_item_id && row.source_is_customized,
    ),
    installedByWorkspaceMemberId:
      row.created_by_workspace_member_id || undefined,
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
    files: buildSnapshotAttachmentFiles(row, row.updated_at, files),
    attachmentFiles: buildSnapshotAttachmentFiles(row, row.updated_at, files),
    mirrorSource: buildMirrorSourceSummary(row),
  };
}

function buildAvailableSkillPayload(
  row: VisibleSkillRow,
): AvailableSkillSummary {
  return {
    instanceId: row.skill_id,
    packageId: row.skill_id,
    revisionId: row.current_skill_version_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.source_version_value || `local-${row.current_version}`,
    accessTarget: {
      type: resolvePublicUseScope(row.access_bind_scope),
      actorId: row.actor_id || undefined,
      conversationId: row.conversation_id || undefined,
    },
    sourceKind: "installed",
  };
}

async function ensureMarketplacePublisher(
  run: QueryRunner,
  options?: {
    ownerUserId?: string;
    slug?: string;
    displayName?: string;
    description?: string;
  },
) {
  const result = await run<{ id: string }>(
    `INSERT INTO publishers (
       slug,
       display_name,
       description,
       owner_user_id,
       workspace_id,
       is_verified
     )
     VALUES ($1, $2, 'Official marketplace publisher', $3, NULL, TRUE)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
       is_verified = TRUE,
       updated_at = NOW()
     RETURNING id`,
    [
      options?.slug || DEFAULT_MARKETPLACE_PUBLISHER_SLUG,
      options?.displayName || DEFAULT_MARKETPLACE_PUBLISHER_NAME,
      options?.ownerUserId || null,
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
    throw new SkillError(
      409,
      `Skill slug "${slug}" already exists in this workspace`,
    );
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

function descriptionTextFromInput(description?: CanonicalContentBlockInput) {
  return renderSkillBlocksToText(
    normalizeCanonicalContentBlocks(
      description ? [description] : [defaultDescriptionBlock()],
    ),
  ).trim();
}

function buildPreparedSnapshotFromInput(params: {
  fallbackName: string;
  explicitName?: string;
  explicitDescription?: CanonicalContentBlockInput;
  files?: SkillAttachmentInput[];
  existingSnapshot?: {
    frontmatter: SkillFrontmatter;
    bodyBlocks: CanonicalContentBlock[];
    files: SkillAttachmentFile[];
  };
}) {
  const descriptionText = descriptionTextFromInput(params.explicitDescription);

  if (params.files && params.files.length > 0) {
    return prepareSkillSnapshotFromFiles({
      files: params.files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentBlocks: file.contentBlocks,
      })),
      fallbackName: params.fallbackName,
      frontmatterOverrides: {
        name: params.explicitName?.trim() || undefined,
        description: descriptionText || undefined,
      },
    });
  }

  if (params.existingSnapshot) {
    return buildPreparedSnapshotFromExistingData({
      fallbackName: params.fallbackName,
      existingFiles: buildSyntheticSkillFilesFromSnapshot({
        frontmatter: params.existingSnapshot.frontmatter,
        bodyBlocks: params.existingSnapshot.bodyBlocks,
        files: params.existingSnapshot.files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          contentBlocks: file.contentBlocks,
        })),
      }),
      frontmatterOverrides: {
        name: params.explicitName?.trim() || undefined,
        description: descriptionText || undefined,
      },
    });
  }

  const frontmatterName = normalizeSkillCommandName(
    params.explicitName?.trim() || params.fallbackName,
  );
  if (!frontmatterName) {
    throw new SkillError(400, "Skill name is required");
  }

  return prepareSkillSnapshotFromFiles({
    files: [
      {
        path: SKILL_ENTRY_PATH,
        mediaType: "text/markdown",
        contentBlocks: [
          {
            type: "text",
            text: buildSkillMarkdown(
              {
                name: frontmatterName,
                description:
                  descriptionText || `Skill package for ${frontmatterName}.`,
                disableModelInvocation: false,
                userInvocable: true,
                allowedTools: [],
              },
              [],
            ),
          },
        ],
      },
    ],
    fallbackName: frontmatterName,
  });
}

async function allocateMarketplaceItemSlug(
  run: QueryRunner,
  publisherId: string,
  preferredSlug: string,
  excludeItemId?: string,
) {
  let candidate = preferredSlug || "skill";
  let index = 2;
  while (true) {
    const existing = await run<{ id: string }>(
      `SELECT id
       FROM catalog_items
       WHERE publisher_id = $1
         AND item_kind = 'skill_package'
         AND workspace_id IS NULL
         AND slug = $2
         AND ($3::uuid IS NULL OR id <> $3::uuid)
       LIMIT 1`,
      [publisherId, candidate, excludeItemId || null],
    );
    if (existing.rows.length === 0) {
      return candidate;
    }
    candidate = `${preferredSlug}-${index}`;
    index += 1;
  }
}

async function upsertSkillMirrorSource(
  run: QueryRunner,
  input: ImportedMirrorSkillPackage["mirrorSource"],
) {
  const result = await run<{ id: string }>(
    `INSERT INTO skill_mirror_sources (
       source_type,
       locator_key,
       locator,
       requested_ref,
       resolved_revision,
       refresh_mode,
       last_sync_status,
       source_warnings,
       last_error,
       last_synced_at
     )
     VALUES (
       $1,
       $2,
       $3::jsonb,
       $4,
       $5,
       'manual',
       'synced',
       $6::text[],
       NULL,
       NOW()
     )
     ON CONFLICT (source_type, locator_key) DO UPDATE SET
       locator = EXCLUDED.locator,
       requested_ref = EXCLUDED.requested_ref,
       resolved_revision = EXCLUDED.resolved_revision,
       refresh_mode = EXCLUDED.refresh_mode,
       last_sync_status = 'synced',
       source_warnings = EXCLUDED.source_warnings,
       last_error = NULL,
       last_synced_at = NOW(),
       updated_at = NOW()
     RETURNING id`,
    [
      input.sourceType,
      input.locatorKey,
      JSON.stringify(input.locator),
      input.requestedRef || null,
      input.resolvedRevision || null,
      input.sourceWarnings,
    ],
  );
  return result.rows[0]!.id;
}

function hashSnapshotFileContent(blocks: CanonicalContentBlock[]) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(blocks))
    .digest("hex");
}

function snapshotFileSize(blocks: CanonicalContentBlock[]) {
  const fileRefSize = blocks.find((block) => block.type === "file_ref");
  if (fileRefSize && fileRefSize.type === "file_ref") {
    return fileRefSize.sizeBytes;
  }
  return Buffer.byteLength(renderSkillBlocksToText(blocks), "utf8");
}

async function insertSkillSnapshot(
  run: QueryRunner,
  snapshot: PreparedSkillSnapshot,
  options?: {
    mirrorSourceId?: string | null;
    resolvedRevision?: string | null;
  },
) {
  const inserted = await run<{ id: string }>(
    `INSERT INTO skill_snapshots (
       mirror_source_id,
       entry_path,
       name,
       description,
       argument_hint,
       disable_model_invocation,
       user_invocable,
       allowed_tools,
       model,
       effort,
       context,
       agent,
       hooks,
       body_blocks,
       content_hash,
       source_warnings,
       resolved_revision
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8::text[],
       $9,
       $10,
       $11,
       $12,
       $13::jsonb,
       $14::jsonb,
       $15,
       $16::text[],
       $17
     )
     RETURNING id`,
    [
      options?.mirrorSourceId || null,
      SKILL_ENTRY_PATH,
      snapshot.frontmatter.name,
      snapshot.frontmatter.description,
      snapshot.frontmatter.argumentHint || null,
      snapshot.frontmatter.disableModelInvocation,
      snapshot.frontmatter.userInvocable,
      snapshot.frontmatter.allowedTools,
      snapshot.frontmatter.model || null,
      snapshot.frontmatter.effort || null,
      snapshot.frontmatter.context || null,
      snapshot.frontmatter.agent || null,
      JSON.stringify(snapshot.frontmatter.hooks || {}),
      JSON.stringify(snapshot.bodyBlocks),
      snapshot.contentHash,
      snapshot.sourceWarnings,
      options?.resolvedRevision || null,
    ],
  );
  const snapshotId = inserted.rows[0]!.id;

  for (const file of snapshot.files) {
    await run(
      `INSERT INTO skill_snapshot_files (
         skill_snapshot_id,
         path,
         media_type,
         content_blocks,
         sha256,
         size_bytes
       )
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        snapshotId,
        file.path,
        file.mediaType || null,
        JSON.stringify(file.contentBlocks),
        hashSnapshotFileContent(file.contentBlocks),
        snapshotFileSize(file.contentBlocks),
      ],
    );
  }

  return snapshotId;
}

async function loadSkillSnapshotFilesMap(snapshotIds: string[]) {
  if (snapshotIds.length === 0) {
    return new Map<string, SkillAttachmentFile[]>();
  }

  const result = await runQuery<SkillSnapshotFileRow>(
    `SELECT
       id,
       skill_snapshot_id,
       path,
       media_type,
       content_blocks,
       created_at,
       updated_at
     FROM skill_snapshot_files
     WHERE skill_snapshot_id = ANY($1::uuid[])
     ORDER BY path ASC`,
    [snapshotIds],
  );

  const filesBySnapshotId = new Map<string, SkillAttachmentFile[]>();
  for (const row of result.rows) {
    const files = filesBySnapshotId.get(row.skill_snapshot_id) || [];
    files.push(buildSkillAttachmentFromCatalogFile(row));
    filesBySnapshotId.set(row.skill_snapshot_id, files);
  }

  return filesBySnapshotId;
}

async function buildMarketplaceInstallationMap(workspaceId: string) {
  const result = await runQuery<{
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
  run: QueryRunner = runQuery,
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

async function getMarketplaceRowByMirrorSourceId(
  mirrorSourceId: string,
  run: QueryRunner = runQuery,
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.mirror_source_id = $1
     LIMIT 1`,
    [mirrorSourceId],
  );

  return result.rows[0] || null;
}

async function loadInstalledSkillRows(params: {
  workspaceId?: string;
  skillIds?: string[];
  sourceSkillId?: string;
}) {
  const values: unknown[] = [];
  const conditions: string[] = [];

  if (params.workspaceId) {
    values.push(params.workspaceId);
    conditions.push(`skill.workspace_id = $${values.length}`);
  }

  if (params.skillIds && params.skillIds.length > 0) {
    values.push(params.skillIds);
    conditions.push(`skill.id = ANY($${values.length}::uuid[])`);
  }

  if (params.sourceSkillId) {
    values.push(params.sourceSkillId);
    conditions.push(`source_ref.source_catalog_item_id = $${values.length}`);
  }

  const result = await runQuery<InstalledSkillRow>(
    `${INSTALLED_SKILL_SELECT}
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
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
    workspace_member_id: null,
  };
}

async function loadAccessBindingsBySkillIds(
  skillIds: string[],
  includeRevoked = false,
) {
  if (skillIds.length === 0) return new Map<string, SkillAccessRow[]>();

  const result = await runQuery<AccessBindingRow>(
    `SELECT
       binding.id,
       binding.workspace_id,
       binding.resource_type,
       binding.installed_skill_id,
       binding.plugin_installation_id,
       binding.relay_capability_id,
       binding.installed_skill_id::text AS resource_id,
       binding.target_type,
       binding.subject_workspace_id,
       COALESCE(binding.subject_actor_id, cac.actor_id) AS subject_actor_id,
       COALESCE(binding.subject_conversation_id, cac.conversation_id) AS subject_conversation_id,
       binding.subject_conversation_actor_context_id,
       binding.conversation_type_mask_override,
       binding.status,
       binding.created_by_workspace_member_id,
       binding.reason,
       binding.created_at,
       binding.revoked_at
     FROM resource_access_bindings binding
     LEFT JOIN conversation_actor_contexts cac
       ON cac.id = binding.subject_conversation_actor_context_id
     WHERE binding.installed_skill_id = ANY($1::uuid[])
       ${includeRevoked ? "" : "AND binding.status = 'active'"}
     ORDER BY binding.installed_skill_id, binding.created_at DESC`,
    [skillIds],
  );

  const map = new Map<string, SkillAccessRow[]>();
  for (const rawRow of result.rows) {
    const row = buildSkillAccessRow(normalizeAccessBindingRow(rawRow));
    const existing = map.get(row.skill_id) || [];
    existing.push(row);
    map.set(row.skill_id, existing);
  }
  return map;
}

async function listSkillAccessRows(skillId: string, includeRevoked = false) {
  const rows = await loadAccessBindingsBySkillIds([skillId], includeRevoked);
  return rows.get(skillId) || [];
}

function mapSkillAccessRowToGrant(
  row: SkillAccessRow,
  options?: {
    workspaceConversationTypeMask: number;
    instanceConversationTypeMaskOverride: number | null;
  },
) {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride,
        ),
        row.conversation_type_mask_override,
      )
    : undefined;
  return mapAccessBindingToGrant(row, ["use"], undefined, {
    effectiveConversationTypeMask,
  });
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

async function loadInstalledSkillById(skillId: string) {
  const rows = await loadInstalledSkillRows({
    skillIds: [skillId],
  });
  return rows[0] || null;
}

async function chooseBindingMap(
  skillIds: string[],
  filters?: {
    accessTargetType?: SkillUseScope;
    actorId?: string;
    conversationId?: string;
  },
) {
  const bindingsBySkillId = await loadAccessBindingsBySkillIds(skillIds);
  const preferredTarget = filters?.accessTargetType
    ? normalizeScopeTarget({
        useScope: filters.accessTargetType,
        actorId: filters.actorId,
        conversationId: filters.conversationId,
      })
    : undefined;

  const map = new Map<string, SkillAccessRow | undefined>();
  for (const skillId of skillIds) {
    const candidates = bindingsBySkillId.get(skillId) || [];
    const matching = preferredTarget
      ? candidates.filter((binding) =>
          matchesScopeTarget(binding, preferredTarget),
        )
      : candidates;
    const chosen = [...(matching.length > 0 ? matching : candidates)].sort(
      compareBindingPriority,
    )[0];
    map.set(skillId, chosen);
  }

  return map;
}

async function findSkillIdsByBindingFilter(params: {
  workspaceId: string;
  accessTargetType?: SkillUseScope;
  actorId?: string;
  conversationId?: string;
}) {
  if (!params.accessTargetType && !params.actorId && !params.conversationId) {
    return null;
  }

  const target = params.accessTargetType
    ? await resolveAccessGrantTarget({
        workspaceId: params.workspaceId,
        target: {
          type: params.accessTargetType,
          actorId: params.actorId,
          conversationId: params.conversationId,
        },
      })
    : null;

  const values: unknown[] = [params.workspaceId];
  const conditions = [
    `workspace_id = $1`,
    `installed_skill_id IS NOT NULL`,
    `status = 'active'`,
  ];

  if (target) {
    values.push(target.targetType);
    conditions.push(`target_type = $${values.length}`);
    values.push(target.subjectConversationActorContextId);
    conditions.push(
      `subject_conversation_actor_context_id IS NOT DISTINCT FROM $${values.length}::uuid`,
    );
    values.push(target.subjectWorkspaceId);
    conditions.push(`subject_workspace_id IS NOT DISTINCT FROM $${values.length}::uuid`);
    values.push(target.subjectActorId);
    conditions.push(`subject_actor_id IS NOT DISTINCT FROM $${values.length}::uuid`);
    values.push(target.subjectConversationId);
    conditions.push(`subject_conversation_id IS NOT DISTINCT FROM $${values.length}::uuid`);
  } else {
    if (params.actorId) {
      values.push(params.actorId);
      conditions.push(
        `(subject_actor_id = $${values.length} OR subject_conversation_actor_context_id IN (
          SELECT id FROM conversation_actor_contexts WHERE actor_id = $${values.length}::uuid
        ))`,
      );
    }
    if (params.conversationId) {
      values.push(params.conversationId);
      conditions.push(
        `(subject_conversation_id = $${values.length} OR subject_conversation_actor_context_id IN (
          SELECT id FROM conversation_actor_contexts WHERE conversation_id = $${values.length}::uuid
        ))`,
      );
    }
  }

  const result = await runQuery<{ skill_id: string }>(
    `SELECT DISTINCT installed_skill_id::text AS skill_id
     FROM resource_access_bindings
     WHERE ${conditions.join(" AND ")}`,
    values,
  );

  return result.rows.map((row) => row.skill_id);
}

async function findInstalledSkillBySource(
  workspaceId: string,
  sourceCatalogItemId: string,
  run: QueryRunner = runQuery,
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
    createdByWorkspaceMemberId?: string;
  },
) {
  const grantTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: {
      type: input.target.useScope,
      actorId: input.target.actorId || undefined,
      conversationId: input.target.conversationId || undefined,
    },
  });

  const existing = await run<AccessBindingRow>(
    `SELECT
       binding.id,
       binding.workspace_id,
       binding.resource_type,
       binding.installed_skill_id,
       binding.plugin_installation_id,
       binding.relay_capability_id,
       binding.installed_skill_id::text AS resource_id,
       binding.target_type,
       binding.subject_workspace_id,
       COALESCE(binding.subject_actor_id, cac.actor_id) AS subject_actor_id,
       COALESCE(binding.subject_conversation_id, cac.conversation_id) AS subject_conversation_id,
       binding.subject_conversation_actor_context_id,
       binding.status,
       binding.created_by_workspace_member_id,
       binding.reason,
       binding.created_at,
       binding.revoked_at
     FROM resource_access_bindings binding
     LEFT JOIN conversation_actor_contexts cac
       ON cac.id = binding.subject_conversation_actor_context_id
     WHERE binding.workspace_id = $1
       AND binding.installed_skill_id = $2::uuid
       AND target_type = $3
       AND subject_workspace_id IS NOT DISTINCT FROM $4::uuid
       AND subject_actor_id IS NOT DISTINCT FROM $5::uuid
       AND subject_conversation_id IS NOT DISTINCT FROM $6::uuid
       AND subject_conversation_actor_context_id IS NOT DISTINCT FROM $7::uuid
       AND status = 'active'
     ORDER BY binding.created_at DESC
     LIMIT 1`,
    [
      input.workspaceId,
      input.skillId,
      grantTarget.targetType,
      grantTarget.subjectWorkspaceId,
      grantTarget.subjectActorId,
      grantTarget.subjectConversationId,
      grantTarget.subjectConversationActorContextId,
    ],
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      bindingId: row.id,
    };
  }

  const inserted = await run<{ id: string }>(
    `INSERT INTO resource_access_bindings (
       workspace_id,
       resource_type,
       installed_skill_id,
       target_type,
       subject_workspace_id,
       subject_actor_id,
       subject_conversation_id,
       subject_conversation_actor_context_id,
       status,
       created_by_workspace_member_id
     )
     VALUES (
       $1,
       'installed_skill',
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       'active',
       $9
     )
     RETURNING id`,
    [
      input.workspaceId,
      input.skillId,
      grantTarget.targetType,
      grantTarget.subjectWorkspaceId,
      grantTarget.subjectActorId,
      grantTarget.subjectConversationId,
      grantTarget.subjectConversationActorContextId,
      input.createdByWorkspaceMemberId || null,
    ],
  );
  const bindingId = inserted.rows[0]!.id;

  return {
    bindingId,
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
    loadSkillSnapshotFilesMap([row.current_snapshot_id]),
  ]);
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      row.workspace_id,
      "installed_skill",
    );

  return buildInstalledSkillPayload(
    row,
    bindingMap.get(installedSkillId),
    workspaceConversationTypeMask,
    fileMap.get(row.current_snapshot_id) || [],
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

  const normalizedTags = (filters?.tags || [])
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (normalizedTags.length > 0) {
    values.push(normalizedTags);
    conditions.push(`item.tags && $${values.length}::text[]`);
  }

  const result = await runQuery<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
     ${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}
     ORDER BY item.updated_at DESC, item.created_at DESC`,
    values,
  );

  const latestSnapshotIds = result.rows
    .map((row) => row.snapshot_id)
    .filter((value): value is string => Boolean(value));
  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(latestSnapshotIds),
    filters?.workspaceId
      ? buildMarketplaceInstallationMap(filters.workspaceId)
      : Promise.resolve(null),
  ]);

  return result.rows.map((row) =>
    mapMarketplaceEntry(
      row,
      installationMap?.get(row.item_id),
      row.snapshot_id
        ? filesMap.get(row.snapshot_id) || []
        : undefined,
    ),
  );
}

export async function getMarketplaceSkill(
  skillId: string,
  workspaceId?: string,
) {
  const row = await getMarketplaceRowById(skillId);
  if (!row) {
    throw new SkillError(404, "Skill not found");
  }

  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(row.snapshot_id ? [row.snapshot_id] : []),
    workspaceId
      ? buildMarketplaceInstallationMap(workspaceId)
      : Promise.resolve(null),
  ]);

  return mapMarketplaceEntry(
    row,
    installationMap?.get(row.item_id),
    row.snapshot_id
      ? filesMap.get(row.snapshot_id) || []
      : undefined,
  );
}

function publisherOptionsForMirrorSource(sourceType: ImportedMirrorSkillPackage["mirrorSource"]["sourceType"]) {
  if (sourceType === "github") {
    return {
      slug: GITHUB_MARKETPLACE_PUBLISHER_SLUG,
      displayName: GITHUB_MARKETPLACE_PUBLISHER_NAME,
    };
  }

  return {
    slug: CLAWHUB_MARKETPLACE_PUBLISHER_SLUG,
    displayName: CLAWHUB_MARKETPLACE_PUBLISHER_NAME,
  };
}

async function upsertImportedMarketplaceSkill(
  imported: ImportedMirrorSkillPackage,
  authorUserId?: string,
) {
  const result = await transaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(
      clientRunner(client),
      {
        ownerUserId: authorUserId,
        ...publisherOptionsForMirrorSource(imported.mirrorSource.sourceType),
      },
    );
    const mirrorSourceId = await upsertSkillMirrorSource(
      clientRunner(client),
      imported.mirrorSource,
    );
    const existing = await getMarketplaceRowByMirrorSourceId(
      mirrorSourceId,
      clientRunner(client),
    );

    if (
      existing &&
      existing.latest_version_value === imported.version &&
      existing.snapshot_content_hash === imported.contentHash
    ) {
      await executeSqlOn(
        client,
        `UPDATE catalog_items
         SET display_name = $2,
             summary = $3,
             long_description = $3,
             tags = $4,
             metadata = $5::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.item_id,
          imported.frontmatter.name,
          imported.frontmatter.description,
          imported.tags,
          JSON.stringify(imported.itemMetadata),
        ],
      );
      return existing.item_id;
    }

    const itemSlug = existing
      ? existing.item_slug
      : await allocateMarketplaceItemSlug(
          clientRunner(client),
          publisherId,
          sanitizeSlug(imported.catalogSlug) || "skill",
        );

    let itemId = existing?.item_id || null;
    if (existing) {
      await executeSqlOn(
        client,
        `UPDATE catalog_items
         SET slug = $2,
             display_name = $3,
             summary = $4,
             long_description = $4,
             mirror_source_id = $5,
             source_kind = 'official',
             visibility = 'public',
             tags = $6,
             is_active = TRUE,
             metadata = $7::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.item_id,
          itemSlug,
          imported.frontmatter.name,
          imported.frontmatter.description,
          mirrorSourceId,
          imported.tags,
          JSON.stringify(imported.itemMetadata),
        ],
      );
      itemId = existing.item_id;
    } else {
      const inserted = await executeSqlOn<{ id: string }>(
        client,
        `INSERT INTO catalog_items (
           publisher_id,
           workspace_id,
           item_kind,
           slug,
           display_name,
           summary,
           long_description,
           mirror_source_id,
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
           $5,
           'official',
           'public',
           $6,
           TRUE,
           $7::jsonb
         )
         RETURNING id`,
        [
          publisherId,
          itemSlug,
          imported.frontmatter.name,
          imported.frontmatter.description,
          mirrorSourceId,
          imported.tags,
          JSON.stringify(imported.itemMetadata),
        ],
      );
      itemId = inserted.rows[0]!.id;
    }

    const snapshotId = await insertSkillSnapshot(clientRunner(client), imported, {
      mirrorSourceId,
      resolvedRevision: imported.mirrorSource.resolvedRevision || null,
    });

    const existingVersion = await executeSqlOn<{ id: string }>(
      client,
      `SELECT id
       FROM catalog_versions
       WHERE catalog_item_id = $1
         AND version = $2
       LIMIT 1`,
      [itemId, imported.version],
    );

    const versionId =
      existingVersion.rows[0]?.id ||
      (
        await executeSqlOn<{ id: string }>(
          client,
          `INSERT INTO catalog_versions (
             catalog_item_id,
             version,
             status,
             changelog,
             metadata,
             created_by_user_id
           )
           VALUES ($1, $2, 'active', $3, $4::jsonb, $5)
           RETURNING id`,
          [
            itemId,
            imported.version,
            imported.changelog,
            JSON.stringify(imported.itemMetadata),
            authorUserId || null,
          ],
        )
      ).rows[0]!.id;

    if (existingVersion.rows[0]) {
      await executeSqlOn(
        client,
        `UPDATE catalog_versions
         SET status = 'active',
             changelog = $2,
             metadata = $3::jsonb
         WHERE id = $1`,
        [
          versionId,
          imported.changelog,
          JSON.stringify(imported.itemMetadata),
        ],
      );
    }

    await executeSqlOn(
      client,
      `INSERT INTO skill_package_version_specs (
         catalog_version_id,
         skill_snapshot_id,
         default_conversation_type_mask,
         created_at
       )
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (catalog_version_id) DO UPDATE SET
         skill_snapshot_id = EXCLUDED.skill_snapshot_id,
         default_conversation_type_mask = EXCLUDED.default_conversation_type_mask`,
      [versionId, snapshotId, DEFAULT_CONVERSATION_TYPE_MASK],
    );

    await executeSqlOn(
      client,
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

export async function importMarketplaceMirrorSkill(input:
  | {
      sourceType: "github";
      repoUrl: string;
      path: string;
      ref?: string;
      authorUserId?: string;
    }
  | {
      sourceType: "clawhub";
      ownerId?: string;
      slug: string;
      version?: string;
      authorUserId?: string;
    },
) {
  const imported =
    input.sourceType === "github"
      ? await importGitHubSkillPackage({
          repoUrl: input.repoUrl,
          path: input.path,
          ref: input.ref,
        })
      : await importClawhubSkillPackage({
          ownerId: input.ownerId,
          slug: input.slug,
          version: input.version,
        });

  return upsertImportedMarketplaceSkill(imported, input.authorUserId);
}

export async function importSeededClawhubMarketplaceSkill(input: {
  skillDir: string;
  authorUserId?: string;
}) {
  const imported = await importClawhubSeedSkillPackage({
    skillDir: input.skillDir,
  });
  return upsertImportedMarketplaceSkill(imported, input.authorUserId);
}

export async function refreshMarketplaceSkill(input: {
  skillId: string;
  authorUserId?: string;
}) {
  const existing = await getMarketplaceRowById(input.skillId);
  if (!existing || !existing.mirror_source_id || !existing.mirror_source_type) {
    throw new SkillError(400, "Marketplace skill has no mirror source");
  }

  if (existing.mirror_source_type === "github") {
    const locator = parseJsonObject(existing.mirror_locator);
    return importMarketplaceMirrorSkill({
      sourceType: "github",
      repoUrl: String(locator.repoUrl || ""),
      path: String(locator.path || "."),
      ref: existing.mirror_requested_ref || undefined,
      authorUserId: input.authorUserId,
    });
  }

  const locator = parseJsonObject(existing.mirror_locator);
  return importMarketplaceMirrorSkill({
    sourceType: "clawhub",
    ownerId:
      typeof locator.ownerId === "string" && locator.ownerId.trim().length > 0
        ? locator.ownerId
        : undefined,
    slug: String(locator.slug || ""),
    version: existing.mirror_requested_ref || undefined,
    authorUserId: input.authorUserId,
  });
}

export async function publishMarketplaceSkill(input: {
  skillId?: string;
  slug: string;
  name: string;
  description?: CanonicalContentBlockInput;
  iconFileId?: string | null;
  tags?: string[];
  version: string;
  changelog?: string;
  attachmentFiles?: SkillAttachmentInput[];
  defaultConversationTypeMask?: number;
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

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: canonicalSlug || name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  });
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: input.defaultConversationTypeMask,
    overrideMask: null,
  });

  const result = await transaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(
      clientRunner(client),
      {
        ownerUserId: input.authorUserId,
      },
    );
    const existing = input.skillId
      ? await getMarketplaceRowById(input.skillId, clientRunner(client))
      : await getMarketplaceRowBySlug(
          publisherId,
          canonicalSlug,
          clientRunner(client),
        );

    let itemId = existing?.item_id || null;
    if (existing && existing.item_id !== input.skillId && input.skillId) {
      throw new SkillError(404, "Skill not found");
    }

    const itemMetadata: JsonObject = {
      ...parseJsonObject(existing?.item_metadata),
      canonicalSlug,
      frontmatterName: preparedSnapshot.frontmatter.name,
      ...(input.metadata || {}),
    };
    const nextIconFileId =
      input.iconFileId === undefined
        ? (existing?.item_icon_file_id ?? null)
        : input.iconFileId
          ? await normalizeMarketplaceSkillIconFileId(
              input.iconFileId,
              input.authorUserId,
            )
          : null;

    if (existing) {
      await executeSqlOn(client, 
        `UPDATE catalog_items
         SET slug = $2,
             display_name = $3,
             summary = $4,
             long_description = $4,
             tags = $5,
             is_active = $6,
             icon_file_id = $7,
             metadata = $8::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.item_id,
          canonicalSlug,
          preparedSnapshot.frontmatter.name,
          preparedSnapshot.frontmatter.description,
          input.tags || [],
          input.isActive ?? true,
          nextIconFileId,
          JSON.stringify(itemMetadata),
        ],
      );
      itemId = existing.item_id;
    } else {
      const inserted = await executeSqlOn<{ id: string }>(client, 
        `INSERT INTO catalog_items (
           publisher_id,
           workspace_id,
           item_kind,
           slug,
           display_name,
           summary,
           long_description,
           mirror_source_id,
           source_kind,
           visibility,
           tags,
           is_active,
           icon_file_id,
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
           NULL,
           'official',
           'public',
           $5,
           $6,
           $7,
           $8::jsonb
         )
         RETURNING id`,
        [
          publisherId,
          canonicalSlug,
          preparedSnapshot.frontmatter.name,
          preparedSnapshot.frontmatter.description,
          input.tags || [],
          input.isActive ?? true,
          nextIconFileId,
          JSON.stringify(itemMetadata),
        ],
      );
      itemId = inserted.rows[0]!.id;
    }

    const snapshotId = await insertSkillSnapshot(
      clientRunner(client),
      preparedSnapshot,
    );

    const existingVersion = await executeSqlOn<{ id: string }>(client, 
      `SELECT id
       FROM catalog_versions
       WHERE catalog_item_id = $1
         AND version = $2
       LIMIT 1`,
      [itemId, version],
    );

    const versionMetadata = input.metadata || {};
    const versionId =
      existingVersion.rows[0]?.id ||
      (
        await executeSqlOn<{ id: string }>(client, 
          `INSERT INTO catalog_versions (
             catalog_item_id,
             version,
             status,
             changelog,
             metadata,
             created_by_user_id
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
      await executeSqlOn(client, 
        `UPDATE catalog_versions
         SET status = 'active',
             changelog = $2,
             metadata = $3::jsonb,
             created_by_user_id = COALESCE(created_by_user_id, $4),
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

    await executeSqlOn(client, 
      `INSERT INTO skill_package_version_specs (
         catalog_version_id,
         skill_snapshot_id,
         default_conversation_type_mask,
         created_at
       )
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (catalog_version_id) DO UPDATE SET
         skill_snapshot_id = EXCLUDED.skill_snapshot_id,
         default_conversation_type_mask = EXCLUDED.default_conversation_type_mask`,
      [
        versionId,
        snapshotId,
        defaultConversationTypeMask,
      ],
    );

    await executeSqlOn(client, 
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
  name: string;
  description?: CanonicalContentBlockInput;
  iconFileId?: string;
  tags?: string[];
  attachmentFiles?: SkillAttachmentInput[];
  accessTarget: CapabilityAccessTarget;
  installedByWorkspaceMemberId?: string;
}) {
  const name = input.name.trim();
  if (!name) {
    throw new SkillError(400, "Skill name is required");
  }

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles);
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  });
  const iconFileId = input.iconFileId
    ? await normalizeWorkspaceSkillIconFileId(
        input.iconFileId,
        input.workspaceId,
      )
    : null;
  const target = normalizeScopeTarget({
    useScope: input.accessTarget.type,
    actorId: input.accessTarget.actorId,
    conversationId: input.accessTarget.conversationId,
  });

  const result = await transaction(async (client) => {
    const snapshotId = await insertSkillSnapshot(
      clientRunner(client),
      preparedSnapshot,
    );
    const installedSlug = await allocateInstalledSkillSlug(
      clientRunner(client),
      input.workspaceId,
      sanitizeSlug(preparedSnapshot.frontmatter.name) || "skill",
    );
    const insertedSkill = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO installed_skills (
         workspace_id,
         slug,
         name,
         icon_file_id,
         tags,
         current_version,
         current_snapshot_id,
         is_active,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, TRUE, $8)
       RETURNING id`,
      [
        input.workspaceId,
        installedSlug,
        preparedSnapshot.frontmatter.name,
        iconFileId,
        input.tags || [],
        snapshotId,
        input.installedByWorkspaceMemberId || null,
      ],
    );
    const skillId = insertedSkill.rows[0]!.id;

    await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO skill_versions (
         skill_id,
         version,
         skill_snapshot_id,
         metadata,
         created_by_workspace_member_id
       )
       VALUES ($1, 1, $2, $3::jsonb, $4)
       RETURNING id`,
      [
        skillId,
          snapshotId,
          JSON.stringify({}),
          input.installedByWorkspaceMemberId || null,
        ],
      );

    await ensureSkillBinding(clientRunner(client), {
      skillId,
      workspaceId: input.workspaceId,
      target,
      createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
    });

    return {
      skillId,
    };
  });

  return getInstalledSkillResponse(input.workspaceId, result.skillId);
}

export async function listInstalledSkills(
  workspaceId: string,
  filters?: {
    accessTargetType?: SkillUseScope;
    actorId?: string;
    conversationId?: string;
    sourceSkillId?: string;
  },
) {
  const filteredSkillIds = await findSkillIdsByBindingFilter({
    workspaceId,
    accessTargetType: filters?.accessTargetType,
    actorId: filters?.actorId,
    conversationId: filters?.conversationId,
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
      accessTargetType: filters?.accessTargetType,
      actorId: filters?.actorId,
      conversationId: filters?.conversationId,
    }),
    loadSkillSnapshotFilesMap(rows.map((row) => row.current_snapshot_id)),
  ]);
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      "installed_skill",
    );

  return rows.map((row) =>
    buildInstalledSkillPayload(
      row,
      bindingMap.get(row.skill_id),
      workspaceConversationTypeMask,
      fileMap.get(row.current_snapshot_id) || [],
    ),
  );
}

export async function getInstalledSkill(
  workspaceId: string,
  installedSkillId: string,
) {
  return getInstalledSkillResponse(workspaceId, installedSkillId);
}

export async function getInstalledSkillAccessState(
  workspaceId: string,
  installedSkillId: string,
) {
  const skillRow = await loadInstalledSkillForUpdate(
    workspaceId,
    installedSkillId,
  );
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found");
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill",
    );
  const accessRows = await listSkillAccessRows(installedSkillId);
  const grants = accessRows.map((row) =>
    mapSkillAccessRowToGrant(row, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversation_type_mask_override ?? null,
    }),
  );
  const initialGrant = selectInitialSkillGrant(accessRows);
  const suggestedGrantScope = initialGrant
    ? resolvePublicUseScope(initialGrant.bind_scope)
    : ("workspace" as SkillUseScope);

  return {
    grants,
    summary: {
      requiredPermissions: ["use"],
      suggestedAccessTargetType: suggestedGrantScope,
      sourceDefaultConversationTypeMask:
        resolveInstalledSkillSourceConversationTypeMask(skillRow),
      workspaceConversationTypeMask,
      conversationTypeMaskOverride:
        skillRow.conversation_type_mask_override ?? null,
      effectiveConversationTypeMask:
        resolveInstalledSkillEffectiveConversationTypeMask({
          workspaceConversationTypeMask,
          conversation_type_mask_override:
            skillRow.conversation_type_mask_override,
        }),
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
  accessTarget?: CapabilityAccessTarget;
  conversationTypeMaskOverride?: number | null;
  grantedByWorkspaceMemberId?: string;
  reason?: string;
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId,
  );
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found");
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill",
    );

  const accessRows = await listSkillAccessRows(input.installedSkillId);
  const accessTargetInput =
    input.accessTarget ||
    (selectInitialSkillGrant(accessRows)
      ? {
          type: resolvePublicUseScope(selectInitialSkillGrant(accessRows)!.bind_scope),
          actorId: selectInitialSkillGrant(accessRows)!.actor_id || undefined,
          conversationId:
            selectInitialSkillGrant(accessRows)!.conversation_id || undefined,
        }
      : ({
          type: "workspace",
        } satisfies CapabilityAccessTarget));

  const accessTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: accessTargetInput,
  });
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversation_type_mask_override ?? null,
  );
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      targetType: accessTarget.targetType,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    });
  await validateConversationScopedAccessTarget({
    targetType: accessTarget.targetType,
    conversationId: accessTarget.conversationId,
    actorId: accessTarget.actorId,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  });

  const existing = accessRows.find(
    (row) =>
      row.status === "active" &&
      row.target_type === accessTarget.targetType &&
      row.actor_id === accessTarget.actorId &&
      row.conversation_id === accessTarget.conversationId,
  );
  if (existing) {
    return mapSkillAccessRowToGrant(existing, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversation_type_mask_override ?? null,
    });
  }

  const result = await transaction(async (client) => {
    const inserted = await executeSqlOn<AccessBindingRow>(client, 
      `INSERT INTO resource_access_bindings (
         workspace_id,
       resource_type,
       installed_skill_id,
       target_type,
       subject_workspace_id,
       subject_actor_id,
       subject_conversation_id,
       subject_conversation_actor_context_id,
       conversation_type_mask_override,
       status,
       created_by_workspace_member_id,
       reason
     )
       VALUES (
         $1,
        'installed_skill',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        'active',
        $10,
        $11
       )
       RETURNING
         id,
         workspace_id,
         resource_type,
         installed_skill_id,
         plugin_installation_id,
         relay_capability_id,
         installed_skill_id::text AS resource_id,
         target_type,
         subject_workspace_id,
         subject_actor_id,
         subject_conversation_id,
         subject_conversation_actor_context_id,
         conversation_type_mask_override,
         status,
         created_by_workspace_member_id,
         reason,
         created_at,
         revoked_at`,
      [
        input.workspaceId,
        input.installedSkillId,
        accessTarget.targetType,
        accessTarget.subjectWorkspaceId,
        accessTarget.subjectActorId,
        accessTarget.subjectConversationId,
        accessTarget.subjectConversationActorContextId,
        input.conversationTypeMaskOverride ?? null,
        input.grantedByWorkspaceMemberId || null,
        input.reason || null,
      ],
    );

    const accessRow = buildSkillAccessRow({
      ...normalizeAccessBindingRow(inserted.rows[0]!),
      subject_actor_id: accessTarget.subjectActorId,
      subject_conversation_id: accessTarget.subjectConversationId,
      subject_conversation_actor_context_id:
        accessTarget.subjectConversationActorContextId,
    } as AccessBindingRow);
    return {
      accessRow,
    };
  });

  return mapSkillAccessRowToGrant(result.accessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversation_type_mask_override ?? null,
  });
}

export async function updateInstalledSkillAccessGrant(input: {
  workspaceId: string;
  installedSkillId: string;
  grantId: string;
  conversationTypeMaskOverride?: number | null;
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId,
  );
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found");
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill",
    );
  const accessRows = await listSkillAccessRows(input.installedSkillId, true);
  const accessRow = accessRows.find((row) => row.id === input.grantId);
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found");
  }
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversation_type_mask_override ?? null,
  );
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      targetType: accessRow.target_type,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    });
  await validateConversationScopedAccessTarget({
    targetType: accessRow.target_type,
    conversationId: accessRow.conversation_id,
    actorId: accessRow.actor_id,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  });

  if (input.conversationTypeMaskOverride !== undefined) {
    await executeSql(
      `UPDATE resource_access_bindings
       SET conversation_type_mask_override = $2
       WHERE id = $1
         AND workspace_id = $3`,
      [input.grantId, input.conversationTypeMaskOverride, input.workspaceId],
    );
  }

  const updatedRows = await listSkillAccessRows(input.installedSkillId);
  const updatedRow = updatedRows.find((row) => row.id === input.grantId);
  if (!updatedRow) {
    throw new SkillError(404, "Access grant not found");
  }

  return mapSkillAccessRowToGrant(updatedRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversation_type_mask_override ?? null,
  });
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
  if (accessRow.status === "revoked") {
    return mapSkillAccessRowToGrant(accessRow);
  }

  await transaction(async (client) => {
    await executeSqlOn(client, 
      `UPDATE resource_access_bindings
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1`,
      [accessRow.id],
    );
  });

  return { success: true };
}

export async function installMarketplaceSkill(input: {
  workspaceId: string;
  marketSkillId: string;
  accessTarget: CapabilityAccessTarget;
  installedByWorkspaceMemberId?: string;
}) {
  const target = normalizeScopeTarget({
    useScope: input.accessTarget.type,
    actorId: input.accessTarget.actorId,
    conversationId: input.accessTarget.conversationId,
  });

  const marketplaceSkill = await getMarketplaceRowById(input.marketSkillId);
  if (!marketplaceSkill || !marketplaceSkill.latest_version_id || !marketplaceSkill.snapshot_id) {
    throw new SkillError(404, "Marketplace skill not found");
  }

  const result = await transaction(async (client) => {
    const existingSkillId = await findInstalledSkillBySource(
      input.workspaceId,
      input.marketSkillId,
      clientRunner(client),
    );

    if (existingSkillId) {
      await ensureSkillBinding(
        clientRunner(client),
        {
          skillId: existingSkillId,
          workspaceId: input.workspaceId,
          target,
          createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
        },
      );

      return {
        skillId: existingSkillId,
      };
    }

    const installedSlug = await allocateInstalledSkillSlug(
      clientRunner(client),
      input.workspaceId,
      sanitizeSlug(marketplaceSkill.snapshot_name || marketplaceSkill.item_slug) ||
        sanitizeSlug(marketplaceSkill.item_slug) ||
        "skill",
    );

    const insertedSkill = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO installed_skills (
         workspace_id,
         slug,
         name,
         icon_file_id,
         tags,
         current_version,
         current_snapshot_id,
         is_active,
         conversation_type_mask_override,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, $3, $4, $5, 1, $6, TRUE, $7, $8)
       RETURNING id`,
      [
        input.workspaceId,
        installedSlug,
        marketplaceSkill.snapshot_name || marketplaceSkill.item_display_name,
        marketplaceSkill.item_icon_file_id,
        marketplaceSkill.item_tags || [],
        marketplaceSkill.snapshot_id,
        marketplaceSkill.spec_default_conversation_type_mask ?? null,
        input.installedByWorkspaceMemberId || null,
      ],
    );
    const skillId = insertedSkill.rows[0]!.id;

    await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO skill_versions (
         skill_id,
         version,
         skill_snapshot_id,
         metadata,
         created_by_workspace_member_id
       )
       VALUES ($1, 1, $2, $3::jsonb, $4)
       RETURNING id`,
      [
        skillId,
          marketplaceSkill.snapshot_id,
          JSON.stringify({}),
          input.installedByWorkspaceMemberId || null,
        ],
      );

    await executeSqlOn(client, 
      `INSERT INTO skill_source_refs (
         skill_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         is_customized
       )
       VALUES ($1, $2, $3, 'manual_merge', FALSE)`,
      [skillId, marketplaceSkill.item_id, marketplaceSkill.latest_version_id],
    );

    await executeSqlOn(client, 
      `UPDATE catalog_items
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [marketplaceSkill.item_id],
    );

    await ensureSkillBinding(clientRunner(client), {
      skillId,
      workspaceId: input.workspaceId,
      target,
      createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
    });

    return {
      skillId,
    };
  });

  return getInstalledSkillResponse(input.workspaceId, result.skillId);
}

export async function updateInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
  name?: string;
  description?: CanonicalContentBlockInput;
  iconFileId?: string | null;
  tags?: string[];
  isEnabled?: boolean;
  conversationTypeMaskOverride?: number | null;
  attachmentFiles?: SkillAttachmentInput[];
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId,
  );
  if (!existing) {
    throw new SkillError(404, "Installed skill not found");
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    const workspaceConversationTypeMask =
      await getWorkspaceCapabilityConversationTypeMask(
        existing.workspace_id,
        "installed_skill",
      );
    const nextInstanceConversationTypeMask =
      assertConversationTypeMaskWithinParent({
        parentConversationTypeMask: workspaceConversationTypeMask,
        conversationTypeMaskOverride: input.conversationTypeMaskOverride,
        buildError: (message) => new SkillError(400, message),
        invalidMaskMessage:
          "Installed skill conversation policy must allow at least one workspace conversation type.",
      });
    const accessRows = await listSkillAccessRows(input.installedSkillId);
    for (const accessRow of accessRows) {
      await validateConversationScopedAccessTarget({
        targetType: accessRow.target_type,
        conversationId: accessRow.conversation_id,
        actorId: accessRow.actor_id,
        effectiveConversationTypeMask: nextInstanceConversationTypeMask,
        buildError: (message) => new SkillError(400, message),
      });
    }
  }

  const currentFilesMap = await loadSkillSnapshotFilesMap([
    existing.current_snapshot_id,
  ]);
  const currentFiles =
    currentFilesMap.get(existing.current_snapshot_id) || [];
  const touchesContent =
    input.name !== undefined ||
    input.description !== undefined ||
    input.attachmentFiles !== undefined;

  await transaction(async (client) => {
    let nextVersion = existing.current_version;
    let nextName = existing.name;

    if (touchesContent) {
      nextVersion = existing.current_version + 1;
      nextName = input.name?.trim() || existing.name;

      const preparedSnapshot = buildPreparedSnapshotFromInput({
        fallbackName: existing.slug || existing.name,
        explicitName: nextName,
        explicitDescription: input.description,
        files: input.attachmentFiles
          ? normalizeSkillAttachments(input.attachmentFiles)
          : undefined,
        existingSnapshot: {
          frontmatter: frontmatterFromSnapshotRow(existing),
          bodyBlocks: bodyBlocksFromSnapshotRow(existing),
          files: currentFiles,
        },
      });
      const snapshotId = await insertSkillSnapshot(
        clientRunner(client),
        preparedSnapshot,
      );
      nextName = preparedSnapshot.frontmatter.name;

      await executeSqlOn<{ id: string }>(client, 
        `INSERT INTO skill_versions (
           skill_id,
           version,
           skill_snapshot_id,
           metadata,
           created_by_workspace_member_id
         )
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING id`,
        [
          existing.skill_id,
          nextVersion,
          snapshotId,
          JSON.stringify(parseJsonObject(existing.version_metadata)),
          existing.created_by_workspace_member_id || null,
        ],
      );

      await executeSqlOn(client, 
        `UPDATE installed_skills
         SET name = $2,
             icon_file_id = $3,
             tags = $4,
             current_version = $5,
             current_snapshot_id = $6,
             is_active = COALESCE($7, is_active),
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.skill_id,
          nextName,
          input.iconFileId === undefined
            ? existing.icon_file_id
            : input.iconFileId
              ? await normalizeWorkspaceSkillIconFileId(
                  input.iconFileId,
                  input.workspaceId,
                )
              : null,
          input.tags || existing.tags || [],
          nextVersion,
          snapshotId,
          input.isEnabled === undefined ? null : input.isEnabled,
        ],
      );

      if (existing.source_catalog_item_id) {
        await executeSqlOn(client, 
          `UPDATE skill_source_refs
           SET is_customized = TRUE,
               updated_at = NOW()
           WHERE skill_id = $1`,
          [existing.skill_id],
        );
      }

      return;
    }

    if (
      input.isEnabled !== undefined ||
      input.iconFileId !== undefined ||
      input.tags !== undefined ||
      input.conversationTypeMaskOverride !== undefined
    ) {
      const nextIconFileId =
        input.iconFileId === undefined
          ? existing.icon_file_id
          : input.iconFileId
            ? await normalizeWorkspaceSkillIconFileId(
                input.iconFileId,
                input.workspaceId,
              )
            : null;
      await executeSqlOn(client,
        `UPDATE installed_skills
         SET icon_file_id = $2,
             tags = $3,
             is_active = $4,
             conversation_type_mask_override = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [
          existing.skill_id,
          nextIconFileId,
          input.tags === undefined ? existing.tags || [] : input.tags,
          input.isEnabled === undefined ? existing.is_active : input.isEnabled,
          input.conversationTypeMaskOverride === undefined
            ? existing.conversation_type_mask_override
            : input.conversationTypeMaskOverride,
        ],
      );
    }
  });

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string;
  installedSkillId: string;
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId,
  );
  if (!existing) {
    throw new SkillError(404, "Installed skill not found");
  }
  if (!existing.source_catalog_item_id) {
    throw new SkillError(400, "Installed skill has no marketplace source");
  }

  const marketplaceSkill = await getMarketplaceRowById(
    existing.source_catalog_item_id,
  );
  if (!marketplaceSkill || !marketplaceSkill.latest_version_id || !marketplaceSkill.snapshot_id) {
    throw new SkillError(400, "Marketplace source has no latest version");
  }

  if (
    existing.source_catalog_version_id &&
    existing.source_catalog_version_id === marketplaceSkill.latest_version_id
  ) {
    return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
  }

  await transaction(async (client) => {
    await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO skill_versions (
         skill_id,
         version,
         skill_snapshot_id,
         metadata,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [
        existing.skill_id,
        existing.current_version + 1,
        marketplaceSkill.snapshot_id,
        JSON.stringify(parseJsonObject(existing.version_metadata)),
        existing.created_by_workspace_member_id || null,
      ],
    );

    await executeSqlOn(client, 
      `UPDATE installed_skills
       SET name = $2,
           icon_file_id = $3,
           tags = $4,
           current_version = $5,
           current_snapshot_id = $6,
            updated_at = NOW()
       WHERE id = $1`,
      [
        existing.skill_id,
        marketplaceSkill.snapshot_name || marketplaceSkill.item_display_name,
        marketplaceSkill.item_icon_file_id,
        marketplaceSkill.item_tags || [],
        existing.current_version + 1,
        marketplaceSkill.snapshot_id,
      ],
    );

    await executeSqlOn(client, 
      `UPDATE skill_source_refs
       SET source_catalog_version_id = $2,
           is_customized = FALSE,
           updated_at = NOW()
       WHERE skill_id = $1`,
      [existing.skill_id, marketplaceSkill.latest_version_id],
    );
  });

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId);
}

export async function uninstallInstalledSkill(
  workspaceId: string,
  installedSkillId: string,
) {
  const result = await transaction(async (client) => {
    const existing = await executeSqlOn<InstalledSkillRow>(client, 
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
      };
    }

    await executeSqlOn<AccessBindingRow>(client,
      `SELECT
         id,
         workspace_id,
         resource_type,
         installed_skill_id,
         plugin_installation_id,
         relay_capability_id,
         installed_skill_id::text AS resource_id,
         target_type,
         subject_workspace_id,
         subject_actor_id,
         subject_conversation_id,
         subject_conversation_actor_context_id,
         status,
         created_by_workspace_member_id,
         reason,
         '{}'::jsonb AS metadata,
         created_at,
         revoked_at
      FROM resource_access_bindings
      WHERE installed_skill_id = $1::uuid`,
      [installedSkillId],
    );

    await executeSqlOn(client, 
      `DELETE FROM installed_skills
       WHERE id = $1
         AND workspace_id = $2`,
      [installedSkillId, workspaceId],
    );

    await executeSqlOn(client, 
      `DELETE FROM resource_access_bindings
       WHERE installed_skill_id = $1::uuid`,
      [installedSkillId],
    );

    return {
      deleted: true,
    };
  });

  return result.deleted;
}

async function buildVisibilitySubjects(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
}) {
  return buildConversationCapabilitySubjects({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
  });
}

function accessMatchesVisibilityContext(
  binding: SkillAccessRow,
  input: {
    actorId?: string;
    conversationId?: string;
  },
) {
  switch (binding.bind_scope) {
    case "workspace":
      return true;
    case "conversation":
      return binding.conversation_id === input.conversationId;
    case "actor":
      return binding.actor_id === input.actorId;
    case "actor_in_conversation":
      return (
        binding.actor_id === input.actorId &&
        binding.conversation_id === input.conversationId
      );
  }
}

function visibleRowToAccessRow(
  row: VisibleSkillRow,
  workspaceId: string,
): SkillAccessRow {
  const publicScope = resolvePublicUseScope(row.access_bind_scope);
  const relation =
    relationForAccessTargetType(publicScope);

  return {
    id: row.access_binding_id,
    workspace_id: workspaceId,
    ...buildResourceAccessBindingRef({
      resourceType: "installed_skill",
      resourceId: row.skill_id,
    }),
    resource_id: row.skill_id,
    target_type: publicScope,
    relation,
    subject_workspace_id: publicScope === "workspace" ? workspaceId : null,
    subject_actor_id: publicScope === "actor" ? row.actor_id : null,
    subject_conversation_id:
      publicScope === "conversation" ? row.conversation_id : null,
    subject_conversation_actor_context_id: null,
    conversation_type_mask_override: null,
    status: "active",
    created_by_workspace_member_id: null,
    reason: null,
    created_at: row.access_created_at,
    revoked_at: null,
    skill_id: row.skill_id,
    bind_scope: row.access_bind_scope,
    actor_id: row.actor_id,
    conversation_id: row.conversation_id,
    workspace_member_id: row.workspace_member_id,
  };
}

export async function listVisibleSkills(input: {
  workspaceId: string;
  actorId?: string;
  sessionId?: string;
  conversationId?: string;
  conversationKind?: "private" | "group" | "virtual";
  conversationBoundary?: "internal" | "external";
}) {
  const subjects = await buildVisibilitySubjects(input);
  const relayAutoLoadedSkills = await listRelayAutoLoadedSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    conversationBoundary: input.conversationBoundary,
  });
  if (subjects.length === 0) {
    return relayAutoLoadedSkills;
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

  const installedSkills =
    visibleSkillIds.size === 0
      ? []
      : await (async () => {
	          const [rows, bindingsBySkillId] = await Promise.all([
	            runQuery<VisibleSkillRow>(
	              `SELECT
	                 skill.id AS skill_id,
	                 skill.workspace_id,
	                 skill.slug,
	                 skill.name,
	                 skill.current_version,
	                 version_row.id AS current_skill_version_id,
	                 snapshot.description,
	                 imported_version.version AS source_version_value,
	                 skill.conversation_type_mask_override,
	                 skill.id AS access_binding_id,
	                 'workspace'::varchar AS access_bind_scope,
                 NULL::uuid AS conversation_id,
                 NULL::uuid AS actor_id,
                 NULL::uuid AS workspace_member_id,
                 skill.updated_at AS access_created_at
               FROM installed_skills skill
               JOIN skill_versions version_row
                 ON version_row.skill_id = skill.id
                AND version_row.version = skill.current_version
               JOIN skill_snapshots snapshot
                 ON snapshot.id = skill.current_snapshot_id
	               LEFT JOIN skill_source_refs source_ref
	                 ON source_ref.skill_id = skill.id
	               LEFT JOIN catalog_versions imported_version
	                 ON imported_version.id = source_ref.source_catalog_version_id
	               WHERE skill.id = ANY($1::uuid[])
	                 AND skill.is_active = TRUE
	               ORDER BY skill.slug ASC, skill.updated_at DESC`,
              [Array.from(visibleSkillIds)],
            ),
	            loadAccessBindingsBySkillIds(Array.from(visibleSkillIds)),
	          ]);
	          const workspacePolicyMap =
	            await getWorkspaceCapabilityConversationTypePolicyMap(
	              rows.rows.map((row) => row.workspace_id),
	            );

	          const deduped = new Map<string, VisibleSkillRow>();
	          for (const row of rows.rows) {
	            const workspaceConversationTypeMask =
	              workspacePolicyMap.get(row.workspace_id)?.installed_skill ||
	              DEFAULT_CONVERSATION_TYPE_MASK;
	            const instanceConversationTypeMask =
	              resolveInstalledSkillEffectiveConversationTypeMask({
	                workspaceConversationTypeMask,
	                conversation_type_mask_override:
	                  row.conversation_type_mask_override,
	              });
	            const bindings = (bindingsBySkillId.get(row.skill_id) || []).filter(
	              (binding) =>
	                accessMatchesVisibilityContext(binding, input) &&
	                maskAllowsConversationType(
	                  resolveNarrowedConversationTypeMask(
	                    instanceConversationTypeMask,
	                    binding.conversation_type_mask_override,
	                  ),
	                  input.conversationKind,
	                  input.conversationBoundary,
	                ),
	            );
	            if (bindings.length === 0) {
	              continue;
	            }
	            const chosenBinding = [...bindings].sort(compareVisibleBindingPriority)[0];
            const candidate: VisibleSkillRow = {
              ...row,
              access_binding_id: chosenBinding?.id || row.access_binding_id,
              access_bind_scope: chosenBinding?.bind_scope || "workspace",
              conversation_id: chosenBinding?.conversation_id || null,
              actor_id: chosenBinding?.actor_id || null,
              workspace_member_id: chosenBinding?.workspace_member_id || null,
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
        })();

  const combined = new Map<string, AvailableSkillSummary>();
  for (const skill of installedSkills) {
    combined.set(skill.slug.toLowerCase(), skill);
  }
  for (const skill of relayAutoLoadedSkills) {
    if (!combined.has(skill.slug.toLowerCase())) {
      combined.set(skill.slug.toLowerCase(), skill);
    }
  }

  return Array.from(combined.values()).sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
}

export async function readVisibleSkill(input: {
  workspaceId: string;
  actorId?: string;
  sessionId?: string;
  conversationId?: string;
  conversationKind?: "private" | "group" | "virtual";
  conversationBoundary?: "internal" | "external";
  skillName: string;
  assetPath?: string;
}) {
  const visibleSkills = await listVisibleSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    conversationBoundary: input.conversationBoundary,
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

  if (match.sourceKind === "relay_auto_loaded") {
    try {
      const relayAutoLoaded = await readRelayAutoLoadedSkill({
        skillName: input.skillName,
        actorId: input.actorId,
        conversationId: input.conversationId,
        assetPath: input.assetPath,
        skill: match,
      });
      if (!relayAutoLoaded) {
        throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
      }
      return relayAutoLoaded;
    } catch (error) {
      if (error instanceof SkillError) {
        throw error;
      }
      if (error instanceof Error) {
        if (error.message.startsWith("Invalid skill file path: ")) {
          throw new SkillError(400, error.message);
        }
        throw new SkillError(404, `Skill attachment "${input.assetPath || SKILL_ENTRY_PATH}" not found`);
      }
      throw error;
    }
  }

  const installedSkill = await loadInstalledSkillById(match.instanceId);
  if (!installedSkill) {
    throw new SkillError(404, `Visible skill "${input.skillName}" not found`);
  }

  if (!input.assetPath) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    });
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    };
  }

  const targetPath = normalizePath(input.assetPath);
  if (targetPath === SKILL_ENTRY_PATH) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    });
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    };
  }

  const result = await runQuery<SkillSnapshotFileRow>(
    `SELECT id, skill_snapshot_id, path, media_type, content_blocks, created_at, updated_at
     FROM skill_snapshot_files
     WHERE skill_snapshot_id = $1
       AND path = $2
     LIMIT 1`,
    [installedSkill.current_snapshot_id, targetPath],
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
