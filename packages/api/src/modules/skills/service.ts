import crypto from "node:crypto"
import type pg from "pg"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  FILE_ORIGIN_SYSTEMS,
  WORKSPACE_APP_GRANT_PERMISSION,
  actorRef,
  conversationRef,
  maskAllowsConversationTypeKey,
  normalizeConversationTypeMask,
  parseJsonObject,
  remoteAgentRef,
  resolveConversationTypeKey,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  slugify,
  subjectScopeLabel,
  workspaceMemberRef,
  workspaceRef,
  type AvailableSkillSummary,
  type CapabilityAccessTarget,
  type InstalledSkill,
  type WorkspaceAppGrantPermission,
  type WorkspaceAppGrant,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  normalizeCanonicalContentBlocks,
  type RuntimeBindingScope,
  type ScopedSubjectTarget,
  type SkillAttachmentFile,
  type SkillFrontmatter,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  textBlock,
} from "@synapse/shared"
import {
  dateToIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import { lookupResources } from "../access/evaluator.js"
import { ACCESS_ACTIONS } from "../access/actions.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"
import {
  insertWorkspaceAppGrant,
  listActiveWorkspaceAppGrants,
  revokeWorkspaceAppGrant,
  revokeWorkspaceAppGrantsForApp,
} from "../workspace-apps/grant-storage.js"
import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  getWorkspaceCapabilityConversationTypeMask,
  getWorkspaceCapabilityConversationTypePolicyMap,
} from "../capabilities/conversation-type-policies.js"
import { type AutomationEventSourceBindingTarget } from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  validateConversationScopedAccessTarget,
} from "../access/policy.js"
import {
  buildSystemGeneratedOrigin,
  canUserAccessFileWorkspace,
  duplicateFileRecord,
  getFileAccessInfo,
  getFileUrlById,
} from "../files/service.js"
import {
  buildConversationCapabilitySubjects,
  computeRuntimeScopeSubjectIds,
  computeRuntimeSubjectIdsForVisibility,
} from "../access/subject-resolution.js"
// subject-scope-refactor merge: relay-auto-skills was deleted in
// device-runtime-v3 (PR #20). Replace imports with empty stubs so the existing
// skill aggregation logic compiles; relay_auto_loaded sourceKind is dead.
async function listAutoLoadedSkills(
  _args: unknown
): Promise<AvailableSkillSummary[]> {
  return []
}
import { compareAvailableSkillDiscoveryOrder } from "./discovery-order.js"
import {
  SKILL_ENTRY_PATH,
  buildSyntheticEntryFile,
  buildSkillMarkdown,
  normalizeSkillCommandName,
  normalizeSkillFiles,
  normalizeSkillFilePath,
  renderCanonicalBlocksToText,
  type SkillFileInput,
} from "./manifest.js"
import {
  buildPreparedSnapshotFromExistingData,
  buildSyntheticSkillFilesFromSnapshot,
  importClawhubSeedSkillPackage,
  importClawhubSkillPackage,
  importGitHubSkillPackage,
  prepareSkillSnapshotFromFiles,
  type ImportedMirrorSkillPackage,
  type PreparedSkillSnapshot,
} from "./mirror-import.js"

type SkillUseScope =
  | "workspace"
  | "workspace_member"
  | "conversation"
  | "actor"
  | "remote_agent"
type SkillAccessSuggestion =
  | SkillUseScope
  | "actor_conversation"
  | "remote_agent_conversation"

/**
 * Build a ScopedSubjectTarget from the public scope label + ids.
 */
function scopedTargetFromSkillUseScope(input: {
  useScope: SkillUseScope
  workspaceId: string
  workspaceMemberId?: string | null
  actorId?: string | null
  remoteAgentId?: string | null
  conversationId?: string | null
}): ScopedSubjectTarget {
  switch (input.useScope) {
    case "workspace":
      return { subject: workspaceRef(input.workspaceId) }
    case "workspace_member":
      if (!input.workspaceMemberId) {
        throw new SkillError(
          400,
          "workspaceMemberId is required for workspace_member scope"
        )
      }
      return { subject: workspaceMemberRef(input.workspaceMemberId) }
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(
          400,
          "conversationId is required for conversation scope"
        )
      }
      return { subject: conversationRef(input.conversationId) }
    case "actor":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor scope")
      }
      return {
        subject: actorRef(input.actorId),
        ...(input.conversationId
          ? { scope: conversationRef(input.conversationId) }
          : {}),
      }
    case "remote_agent":
      if (!input.remoteAgentId) {
        throw new SkillError(
          400,
          "remoteAgentId is required for remote_agent scope"
        )
      }
      return {
        subject: remoteAgentRef(input.remoteAgentId),
        ...(input.conversationId
          ? { scope: conversationRef(input.conversationId) }
          : {}),
      }
  }
}

/**
 * Collapse a ScopedSubjectTarget back to the public subject label.
 */
function skillUseScopeFromTarget(target: ScopedSubjectTarget): SkillUseScope {
  const label = subjectScopeLabel(target)
  switch (label) {
    case "workspace":
    case "workspace_member":
    case "conversation":
    case "actor":
    case "remote_agent":
      return label
    default:
      return "workspace"
  }
}

type QueryRow = pg.QueryResultRow
type QueryResultLike<T extends QueryRow> = { rows: T[] }
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResultLike<T>>

/** Build a {@link QueryRunner} backed by an {@link Executor} (db/trx). */
function runnerFn(executor: Executor): QueryRunner {
  return <T extends QueryRow>(text: string, params?: unknown[]) =>
    executor
      .executeQuery<T>(CompiledQuery.raw(text, params ? [...params] : []))
      .then((r) => ({ rows: r.rows as T[] })) as Promise<QueryResultLike<T>>
}

/** Run raw SQL on an explicit executor (db / trx). */
function runOn<T extends QueryRow = QueryRow>(
  executor: Executor,
  text: string,
  params?: unknown[]
): Promise<QueryResultLike<T>> {
  return runnerFn(executor)<T>(text, params)
}

/** Run raw SQL on the top-level db. */
function runOnDb<T extends QueryRow = QueryRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResultLike<T>> {
  return runnerFn(db)<T>(text, params)
}

const runQuery: QueryRunner = runnerFn(db)

function clientRunner(client: Executor): QueryRunner {
  return async <T extends QueryRow>(text: string, params?: unknown[]) =>
    runOn<T>(client, text, params)
}

type JsonObject = Record<string, unknown>

type SkillAttachmentInput = {
  path: string
  contentBlocks: CanonicalContentBlockInput[]
  mediaType?: string
}

export type SkillScopeTarget = {
  bindScope: RuntimeBindingScope
  useScope: SkillUseScope
  actorId: string | null
  remoteAgentId: string | null
  // Round 11 review (P2): same fix for workspace_member — controller
  // accepts workspace_member targets, scopedTargetFromSkillUseScope
  // requires workspaceMemberId, but SkillScopeTarget previously didn't
  // carry it. ensureSkillBinding would then call
  // scopedTargetFromSkillUseScope with workspaceMemberId=undefined and
  // crash on the "workspaceMemberId is required" error — making the
  // public skill-grant flow broken for workspace_member targets.
  workspaceMemberId: string | null
  conversationId: string | null
}

type SkillSnapshotJoinRow = {
  snapshot_id: string | null
  snapshot_entry_path: string | null
  snapshot_display_name: string | null
  snapshot_description: string | null
  snapshot_argument_hint: string | null
  snapshot_disable_model_invocation: boolean | null
  snapshot_user_invocable: boolean | null
  snapshot_allowed_tools: string[] | null
  snapshot_model: string | null
  snapshot_effort: "low" | "medium" | "high" | "max" | null
  snapshot_context: "fork" | null
  snapshot_agent: string | null
  snapshot_hooks: unknown
  snapshot_body_blocks: unknown
  snapshot_content_hash: string | null
  snapshot_source_warnings: string[] | null
  snapshot_resolved_revision: string | null
  snapshot_created_at: Date | null
  mirror_source_id: string | null
  mirror_source_type: "github" | "clawhub" | null
  mirror_locator_key: string | null
  mirror_locator: unknown
  mirror_requested_ref: string | null
  mirror_resolved_revision: string | null
  mirror_refresh_mode: "manual" | null
  mirror_last_sync_status: "pending" | "synced" | "error" | null
  mirror_source_warnings: string[] | null
  mirror_last_error: string | null
  mirror_last_synced_at: Date | null
  mirror_created_at: Date | null
  mirror_updated_at: Date | null
}

type SkillPackageRow = {
  item_id: string
  item_slug: string
  item_display_name: string
  item_summary: string
  item_long_description: string
  item_tags: string[] | null
  item_is_active: boolean
  item_download_count: number
  item_icon_file_id: string | null
  item_metadata: unknown
  item_created_at: Date
  item_updated_at: Date
  latest_version_id: string | null
  latest_version_value: string | null
  latest_version_changelog: string | null
  latest_version_created_by_user_id: string | null
  latest_version_created_at: Date | null
  spec_default_conversation_type_mask: number | null
  publisher_id: string
  publisher_slug: string
  publisher_display_name: string
  publisher_owner_user_id: string | null
} & SkillSnapshotJoinRow

type InstalledSkillRow = {
  skill_id: string
  workspace_id: string
  display_name: string
  icon_file_id: string | null
  tags: string[] | null
  current_version: number
  skill_status: "active" | "disabled" | "archived"
  conversation_type_mask_override: number | null
  owner_workspace_member_id: string | null
  created_at: Date
  updated_at: Date
  current_snapshot_id: string
  current_skill_version_id: string
  current_skill_snapshot_id: string
  version_metadata: unknown
  source_catalog_item_id: string | null
  source_catalog_version_id: string | null
  source_sync_mode:
    | "notify"
    | "manual_merge"
    | "follow_upstream"
    | "detached"
    | null
  source_is_customized: boolean | null
  source_slug: string | null
  source_latest_version_id: string | null
  source_version_value: string | null
  latest_source_version: string | null
  source_default_conversation_type_mask: number | null
} & SkillSnapshotJoinRow

type SkillSnapshotFileRow = {
  id: string
  skill_snapshot_id: string
  path: string
  media_type: string | null
  content_blocks: unknown
  created_at: Date
  updated_at: Date
}

export type SkillAccessRow = {
  id: string
  workspace_id: string
  skill_id: string
  bind_scope: RuntimeBindingScope
  conversation_id: string | null
  actor_id: string | null
  // Round 9 review (P2): include remote_agent_id so dedup paths that
  // currently key on (actor_id, conversation_id, workspace_member_id)
  // can also discriminate remote_agent targets.
  remote_agent_id: string | null
  workspace_member_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: Date | null
  revoked_at: Date | null
}

type VisibleSkillRow = {
  access_binding_id: string
  skill_id: string
  workspace_id: string
  access_bind_scope: RuntimeBindingScope
  conversation_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  workspace_member_id: string | null
  display_name: string
  current_version: number
  current_skill_version_id: string
  description: string
  source_slug: string | null
  source_version_value: string | null
  conversation_type_mask_override: number | null
  access_created_at: Date
}

type InstallationSummary = {
  installed: boolean
  installedCount: number
  installedSkillId?: string
}

const DEFAULT_MARKETPLACE_PUBLISHER_SLUG = "synapse-official"
const DEFAULT_MARKETPLACE_PUBLISHER_NAME = "Synapse Official"
const GITHUB_MARKETPLACE_PUBLISHER_SLUG = "github-mirror"
const GITHUB_MARKETPLACE_PUBLISHER_NAME = "GitHub Mirror"
const CLAWHUB_MARKETPLACE_PUBLISHER_SLUG = "clawhub-official"
const CLAWHUB_MARKETPLACE_PUBLISHER_NAME = "ClawHub Mirror"

const SKILL_SNAPSHOT_SELECT = `
    snapshot.id AS snapshot_id,
    snapshot.entry_path AS snapshot_entry_path,
    snapshot.name AS snapshot_display_name,
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
`

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
  FROM catalog_items_live item
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
`

const INSTALLED_SKILL_SELECT = `
  SELECT
    skill.id AS skill_id,
    app.workspace_id,
    app.display_name AS display_name,
    skill.icon_file_id,
    skill.tags,
    skill.current_version,
    skill.current_snapshot_id,
    app.status AS skill_status,
    app.conversation_type_mask_override,
    app.owner_workspace_member_id,
    app.created_at,
    app.updated_at,
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
  JOIN workspace_apps_live app
    ON app.id = skill.id
  JOIN skill_versions version_row
    ON version_row.skill_id = skill.id
   AND version_row.version = skill.current_version
  JOIN skill_snapshots snapshot
    ON snapshot.id = skill.current_snapshot_id
  LEFT JOIN skill_source_refs source_ref
    ON source_ref.skill_id = skill.id
  LEFT JOIN catalog_items_live source_item
    ON source_item.id = source_ref.source_catalog_item_id
  LEFT JOIN catalog_versions imported_version
    ON imported_version.id = source_ref.source_catalog_version_id
  LEFT JOIN skill_package_version_specs imported_spec
    ON imported_spec.catalog_version_id = source_ref.source_catalog_version_id
  LEFT JOIN catalog_versions latest_version
    ON latest_version.id = source_item.latest_version_id
  LEFT JOIN skill_mirror_sources mirror
    ON mirror.id = snapshot.mirror_source_id
`

export class SkillError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

function sanitizeSlug(value: string) {
  return slugify(value, { maxLength: 120 })
}

function normalizePath(assetPath: string) {
  try {
    return normalizeSkillFilePath(assetPath)
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message)
    }
    throw error
  }
}

function defaultDescriptionBlock(text = ""): CanonicalContentBlock {
  return textBlock(text)
}

function normalizeSkillDescription(description?: CanonicalContentBlockInput) {
  const normalized = normalizeCanonicalContentBlocks(
    description ? [description] : [defaultDescriptionBlock()]
  )

  return normalized[0] || defaultDescriptionBlock()
}

function normalizeSkillAttachments(files?: SkillAttachmentInput[]) {
  try {
    return normalizeSkillFiles(
      (files || []).map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentBlocks: Array.isArray(file.contentBlocks)
          ? file.contentBlocks
          : [],
      }))
    )
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message)
    }
    throw error
  }
}

function assertRequiredSkillFile(
  files: Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>
) {
  if (!files.some((file) => file.path === SKILL_ENTRY_PATH)) {
    throw new SkillError(
      400,
      `Skill must include required path: ${SKILL_ENTRY_PATH}`
    )
  }
}

function normalizeScopeTarget(input: {
  useScope: SkillUseScope
  actorId?: string | null
  remoteAgentId?: string | null
  workspaceMemberId?: string | null
  conversationId?: string | null
}): SkillScopeTarget {
  switch (input.useScope) {
    case "workspace":
      return {
        bindScope: "workspace",
        useScope: "workspace",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: null,
      }
    case "workspace_member":
      // workspace_member-scoped skill bindings are individual approvals.
      // Round 11 review (P2): the intermediate SkillScopeTarget now
      // carries `workspaceMemberId` so the write path (ensureSkillBinding
      // → scopedTargetFromSkillUseScope) doesn't crash on a legitimate
      // workspace_member grant. We tolerate `input.workspaceMemberId
      // == null` here (filter-mode callers may not have it) — the
      // write-side `scopedTargetFromSkillUseScope` is still strict and
      // throws when actually building the SubjectRef.
      return {
        bindScope: "workspace_member",
        useScope: "workspace_member",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: input.workspaceMemberId ?? null,
        conversationId: null,
      }
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(
          400,
          "conversationId is required for conversation scope"
        )
      }
      return {
        bindScope: "conversation",
        useScope: "conversation",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: input.conversationId,
      }
    case "actor":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor scope")
      }
      return {
        bindScope: "actor",
        useScope: "actor",
        actorId: input.actorId,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: input.conversationId ?? null,
      }
    case "remote_agent":
      if (!input.remoteAgentId) {
        throw new SkillError(
          400,
          "remoteAgentId is required for remote_agent scope"
        )
      }
      return {
        bindScope: "remote_agent",
        useScope: "remote_agent",
        actorId: null,
        remoteAgentId: input.remoteAgentId,
        workspaceMemberId: null,
        conversationId: input.conversationId ?? null,
      }
    default:
      throw new SkillError(
        400,
        `Unsupported skill scope: ${String(input.useScope)}`
      )
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return []
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[]
    } catch {
      return []
    }
  }

  return Array.isArray(value) ? (value as T[]) : []
}

function normalizeStoredBlocks(value: unknown) {
  const blocks = normalizeCanonicalContentBlocks(
    parseJsonArray<CanonicalContentBlockInput>(value)
  )
  return blocks
}

function descriptionBlockFromStored(value: unknown) {
  return normalizeStoredBlocks(value)[0] || defaultDescriptionBlock()
}

function renderSkillBlocksToText(blocks: CanonicalContentBlock[]) {
  return renderCanonicalBlocksToText(blocks)
    .split("\n")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n")
}

async function normalizeWorkspaceSkillIconFileId(
  iconFileId: string,
  workspaceId: string
) {
  const fileInfo = await getFileAccessInfo(iconFileId)
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found")
  }

  if (fileInfo.workspaceId && fileInfo.workspaceId !== workspaceId) {
    throw new SkillError(
      400,
      "Skill icon file must belong to the current workspace"
    )
  }

  return iconFileId
}

async function normalizeMarketplaceSkillIconFileId(
  iconFileId: string,
  authorUserId?: string
) {
  const fileInfo = await getFileAccessInfo(iconFileId)
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found")
  }

  if (authorUserId) {
    const canAccess = await canUserAccessFileWorkspace(
      fileInfo.workspaceId ?? null,
      authorUserId
    )
    if (!canAccess) {
      throw new SkillError(403, "Skill icon file is not accessible")
    }
  } else if (fileInfo.workspaceId) {
    throw new SkillError(
      400,
      "Marketplace skill icon file must be platform-accessible"
    )
  }

  if (!fileInfo.workspaceId) {
    return iconFileId
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
  })
  if (!duplicated) {
    throw new SkillError(400, "Skill icon file not found")
  }

  return duplicated.id
}

function buildSkillAttachmentFromCatalogFile(
  row: SkillSnapshotFileRow
): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    mediaType: row.media_type || undefined,
    contentBlocks: normalizeStoredBlocks(row.content_blocks),
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    updatedAt: serializeInstant(row.updated_at),
  }
}

function frontmatterFromSnapshotRow(
  row: SkillSnapshotJoinRow
): SkillFrontmatter {
  if (
    !row.snapshot_id ||
    !row.snapshot_display_name ||
    row.snapshot_description === null
  ) {
    throw new SkillError(500, "Skill snapshot metadata is missing")
  }

  return {
    name: row.snapshot_display_name,
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
  }
}

function bodyBlocksFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return normalizeStoredBlocks(row.snapshot_body_blocks)
}

function descriptionBlockFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return defaultDescriptionBlock(row.snapshot_description || "")
}

function buildMirrorSourceSummary(row: SkillSnapshotJoinRow) {
  if (
    !row.mirror_source_id ||
    !row.mirror_source_type ||
    !row.mirror_locator_key
  ) {
    return undefined
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
    lastSyncedAt: serializeOptionalInstant(row.mirror_last_synced_at),
    createdAt:
      serializeOptionalInstant(row.mirror_created_at) ||
      serializeOptionalInstant(row.snapshot_created_at) ||
      dateToIsoInstant(new Date(0)),
    updatedAt:
      serializeOptionalInstant(row.mirror_updated_at) ||
      serializeOptionalInstant(row.snapshot_created_at) ||
      dateToIsoInstant(new Date(0)),
  }
}

function buildSyntheticEntryAttachment(
  row: SkillSnapshotJoinRow,
  timestamp: IsoInstantString
): SkillAttachmentFile {
  const synthetic = buildSyntheticEntryFile({
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
  })

  return {
    id: `${row.snapshot_id}:entry`,
    path: synthetic.path,
    mediaType: synthetic.mediaType,
    contentBlocks: synthetic.contentBlocks,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function buildSnapshotAttachmentFiles(
  row: SkillSnapshotJoinRow,
  timestamp: IsoInstantString,
  files?: SkillAttachmentFile[]
) {
  return [buildSyntheticEntryAttachment(row, timestamp), ...(files || [])]
}

function resolvePublicUseScope(row: SkillAccessRow): SkillAccessSuggestion {
  if (row.bind_scope === "actor" && row.conversation_id) {
    return "actor_conversation"
  }
  if (row.bind_scope === "remote_agent" && row.conversation_id) {
    return "remote_agent_conversation"
  }
  switch (row.bind_scope) {
    case "workspace":
    case "conversation":
    case "actor":
    case "remote_agent":
      return row.bind_scope
    case "workspace_member":
      // workspace_member-scoped skill bindings are individual approvals.
      // For UI grouping purposes treat them as workspace-level visibility.
      return "workspace"
    default:
      return "workspace"
  }
}

function skillAccessCreatedAtMs(row: SkillAccessRow): number {
  return row.created_at?.getTime?.() ?? 0
}

function compareBindingPriority(left: SkillAccessRow, right: SkillAccessRow) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  }
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor: 0,
    remote_agent: 0,
    workspace_member: 2,
    conversation: 3,
    workspace: 4,
  }

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status]
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope]
  }
  return skillAccessCreatedAtMs(right) - skillAccessCreatedAtMs(left)
}

function compareVisibleBindingPriority(
  left: SkillAccessRow,
  right: SkillAccessRow
) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  }
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor: 0,
    remote_agent: 0,
    workspace_member: 2,
    conversation: 3,
    workspace: 4,
  }

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status]
  }
  if (scopeOrder[left.bind_scope] !== scopeOrder[right.bind_scope]) {
    return scopeOrder[left.bind_scope] - scopeOrder[right.bind_scope]
  }
  return skillAccessCreatedAtMs(right) - skillAccessCreatedAtMs(left)
}

function selectInitialSkillGrant(accessRows: SkillAccessRow[]) {
  const activeRows = accessRows.filter((row) => row.status === "active")
  return [...activeRows].sort(
    (left, right) =>
      skillAccessCreatedAtMs(left) - skillAccessCreatedAtMs(right)
  )[0]
}

export function matchesScopeTarget(
  binding: SkillAccessRow,
  filter?: SkillScopeTarget
) {
  if (!filter) {
    return true
  }
  return (
    binding.bind_scope === filter.bindScope &&
    binding.actor_id === filter.actorId &&
    binding.conversation_id === filter.conversationId &&
    // Round 13 review (P3): comparing only (bind_scope, actor_id,
    // conversation_id) means two grants on the same skill with
    // different workspace_member targets (A vs B) both match a query
    // for A and the preferred-binding selection is arbitrary. Same
    // hazard exists for remote_agent grants — bring both ids into the
    // discriminator now so a future remote_agent list filter doesn't
    // repeat the same bug.
    binding.workspace_member_id === filter.workspaceMemberId &&
    binding.remote_agent_id === filter.remoteAgentId
  )
}

function mapMarketplaceVersion(
  row: SkillPackageRow,
  files?: SkillAttachmentFile[]
): SkillMarketplaceVersion | undefined {
  if (!row.latest_version_id || !row.latest_version_value) {
    return undefined
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
    createdAt:
      serializeOptionalInstant(row.latest_version_created_at) ||
      serializeInstant(row.item_updated_at),
    files: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latest_version_created_at) ||
        serializeInstant(row.item_updated_at),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latest_version_created_at) ||
        serializeInstant(row.item_updated_at),
      files
    ),
  }
}

function resolveMarketplaceSkillDefaultConversationTypeMask(
  row: SkillPackageRow
) {
  return (
    row.spec_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK
  )
}

function resolveInstalledSkillSourceConversationTypeMask(
  row: InstalledSkillRow
) {
  return (
    row.source_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK
  )
}

function resolveInstalledSkillEffectiveConversationTypeMask(row: {
  workspaceConversationTypeMask: number
  conversation_type_mask_override: number | null
}) {
  return resolveNarrowedConversationTypeMask(
    row.workspaceConversationTypeMask,
    row.conversation_type_mask_override
  )
}

function mapMarketplaceEntry(
  row: SkillPackageRow,
  installation?: InstallationSummary,
  files?: SkillAttachmentFile[]
): SkillMarketplaceEntry {
  const defaultConversationTypeMask =
    resolveMarketplaceSkillDefaultConversationTypeMask(row)
  return {
    id: row.item_id,
    slug: row.item_slug,
    name: row.snapshot_display_name || row.item_display_name,
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
    createdAt: serializeInstant(row.item_created_at),
    updatedAt: serializeInstant(row.item_updated_at),
    defaultConversationTypeMask,
    latestVersionId: row.latest_version_id || undefined,
    latestVersion: mapMarketplaceVersion(row, files),
    mirrorSource: buildMirrorSourceSummary(row),
    workspaceInstallation: installation,
  }
}

function buildInstalledSkillPayload(
  row: InstalledSkillRow,
  binding: SkillAccessRow | undefined,
  workspaceConversationTypeMask: number,
  files?: SkillAttachmentFile[]
): InstalledSkill {
  const chosenBinding = binding
  const accessTarget: CapabilityAccessTarget = chosenBinding
    ? skillBindingToAccessTarget(chosenBinding, row.workspace_id)
    : { subject: workspaceRef(row.workspace_id) }
  const sourceDefaultConversationTypeMask =
    resolveInstalledSkillSourceConversationTypeMask(row)
  const effectiveConversationTypeMask =
    resolveInstalledSkillEffectiveConversationTypeMask({
      workspaceConversationTypeMask,
      conversation_type_mask_override: row.conversation_type_mask_override,
    })

  return {
    id: row.skill_id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshot_entry_path || SKILL_ENTRY_PATH,
    contentHash: row.snapshot_content_hash || "",
    sourceWarnings: row.snapshot_source_warnings || [],
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.icon_file_id ? getFileUrlById(row.icon_file_id) : undefined,
    tags: row.tags || [],
    accessTarget,
    isEnabled: row.skill_status === "active",
    sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask,
    conversationTypeMaskOverride:
      row.conversation_type_mask_override || undefined,
    effectiveConversationTypeMask,
    isCustomized: Boolean(
      row.source_catalog_item_id && row.source_is_customized
    ),
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    updatedAt: serializeInstant(row.updated_at),
    sourceSkillId: row.source_catalog_item_id || undefined,
    sourcePackageSlug: row.source_slug || undefined,
    sourceVersionId: row.source_catalog_version_id || undefined,
    sourceVersion: row.source_version_value || undefined,
    upgradeAvailable:
      Boolean(row.source_catalog_item_id) &&
      Boolean(row.source_catalog_version_id) &&
      Boolean(row.source_latest_version_id) &&
      row.source_catalog_version_id !== row.source_latest_version_id,
    latestSourceVersion: row.latest_source_version || undefined,
    files: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updated_at),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updated_at),
      files
    ),
    mirrorSource: buildMirrorSourceSummary(row),
  }
}

/**
 * Collapse the label switch into a direct
 * call to readAutomationEventSourceAccessBindingTarget. The old switch fell back to
 * `workspace` for any unrecognized `bind_scope`. The mapper feeds into
 * `validateConversationScopedAccessTarget` and
 * `assertGrantConversationTypeOverrideAllowed` from
 * updateInstalledSkill / updateInstalledSkillGrant — so a
 * remote_agent grant being updated would silently
 * decode as workspace, skipping the conversation-scoped policy check
 * and the active-participant check.
 *
 * The row at runtime carries the bindingRowSelectFor `subject_kind` +
 * `subject_*_via_join` + `scope_kind` + `scope_*_via_join` projection
 * that readAutomationEventSourceAccessBindingTarget needs (loadAccessBindingsBySkillIds runs
 * the full SELECT). SkillAccessRow's type doesn't expose those fields,
 * hence the `as any` cast.
 */
function skillBindingToAccessTarget(
  binding: SkillAccessRow,
  _fallbackWorkspaceId: string
): CapabilityAccessTarget {
  switch (binding.bind_scope) {
    case "workspace":
      return { subject: workspaceRef(binding.workspace_id) }
    case "workspace_member":
      if (!binding.workspace_member_id) {
        throw new Error(
          "workspace_member skill binding missing workspace_member_id"
        )
      }
      return { subject: workspaceMemberRef(binding.workspace_member_id) }
    case "conversation":
      if (!binding.conversation_id) {
        throw new Error("conversation skill binding missing conversation_id")
      }
      return { subject: conversationRef(binding.conversation_id) }
    case "actor":
      if (!binding.actor_id) {
        throw new Error("actor skill binding missing actor_id")
      }
      return {
        subject: actorRef(binding.actor_id),
        ...(binding.conversation_id
          ? { scope: conversationRef(binding.conversation_id) }
          : {}),
      }
    case "remote_agent":
      if (!binding.remote_agent_id) {
        throw new Error("remote_agent skill binding missing remote_agent_id")
      }
      return {
        subject: remoteAgentRef(binding.remote_agent_id),
        ...(binding.conversation_id
          ? { scope: conversationRef(binding.conversation_id) }
          : {}),
      }
  }
}

function buildAvailableSkillPayload(
  row: VisibleSkillRow
): AvailableSkillSummary {
  return {
    instanceId: row.skill_id,
    packageId: row.skill_id,
    revisionId: row.current_skill_version_id,
    name: row.display_name,
    description: row.description,
    version: row.source_version_value || `local-${row.current_version}`,
    accessTarget: visibleRowToAccessTarget(row),
    sourcePackageSlug: row.source_slug || undefined,
    sourceKind: "installed",
  }
}

function visibleRowToAccessTarget(
  row: VisibleSkillRow
): CapabilityAccessTarget {
  switch (row.access_bind_scope) {
    case "workspace":
      return { subject: workspaceRef(row.workspace_id) }
    case "workspace_member":
      return row.workspace_member_id
        ? { subject: workspaceMemberRef(row.workspace_member_id) }
        : { subject: workspaceRef(row.workspace_id) }
    case "actor":
      return row.actor_id
        ? {
            subject: actorRef(row.actor_id),
            ...(row.conversation_id
              ? { scope: conversationRef(row.conversation_id) }
              : {}),
          }
        : { subject: workspaceRef(row.workspace_id) }
    case "remote_agent":
      return row.remote_agent_id
        ? {
            subject: remoteAgentRef(row.remote_agent_id),
            ...(row.conversation_id
              ? { scope: conversationRef(row.conversation_id) }
              : {}),
          }
        : { subject: workspaceRef(row.workspace_id) }
    case "conversation":
      return row.conversation_id
        ? { subject: conversationRef(row.conversation_id) }
        : { subject: workspaceRef(row.workspace_id) }
    default:
      return { subject: workspaceRef(row.workspace_id) }
  }
}

async function ensureMarketplacePublisher(
  executor: Executor,
  options?: {
    ownerUserId?: string
    slug?: string
    displayName?: string
    description?: string
  }
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("publishers")
      .values({
        slug: options?.slug || DEFAULT_MARKETPLACE_PUBLISHER_SLUG,
        displayName: options?.displayName || DEFAULT_MARKETPLACE_PUBLISHER_NAME,
        description: "Official marketplace publisher",
        ownerUserId: options?.ownerUserId || null,
        workspaceId: null,
        isVerified: true,
      })
      .onConflict((oc) =>
        oc
          .column("slug")
          .where("deletedAt", "is", null)
          .doUpdateSet({
            displayName: sql`excluded.display_name`,
            description: sql`excluded.description`,
            ownerUserId: sql`COALESCE(publishers.owner_user_id, excluded.owner_user_id)`,
            isVerified: true,
          })
      )
      .returning("id")
  )

  return result.rows[0]!.id
}

function descriptionTextFromInput(description?: CanonicalContentBlockInput) {
  return renderSkillBlocksToText(
    normalizeCanonicalContentBlocks(
      description ? [description] : [defaultDescriptionBlock()]
    )
  ).trim()
}

function buildPreparedSnapshotFromInput(params: {
  fallbackName: string
  explicitName?: string
  explicitDescription?: CanonicalContentBlockInput
  files?: SkillAttachmentInput[]
  existingSnapshot?: {
    frontmatter: SkillFrontmatter
    bodyBlocks: CanonicalContentBlock[]
    files: SkillAttachmentFile[]
  }
}) {
  const descriptionText = descriptionTextFromInput(params.explicitDescription)

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
    })
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
    })
  }

  const frontmatterName = normalizeSkillCommandName(
    params.explicitName?.trim() || params.fallbackName
  )
  if (!frontmatterName) {
    throw new SkillError(400, "Skill name is required")
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
              []
            ),
          },
        ],
      },
    ],
    fallbackName: frontmatterName,
  })
}

async function allocateMarketplaceItemSlug(
  executor: Executor,
  publisherId: string,
  preferredSlug: string,
  excludeItemId?: string
) {
  let candidate = preferredSlug || "skill"
  let index = 2
  while (true) {
    const exclude = excludeItemId || null
    const existing = await runBuilder(
      executor,
      executor
        .selectFrom("catalogItemsLive")
        .select("id")
        .where("publisherId", "=", publisherId)
        .where("itemKind", "=", "skill_package")
        .where("workspaceId", "is", null)
        .where("slug", "=", candidate)
        .where(
          sql<boolean>`(${exclude}::uuid IS NULL OR id <> ${exclude}::uuid)`
        )
        .limit(1)
    )
    if (existing.rows.length === 0) {
      return candidate
    }
    candidate = `${preferredSlug}-${index}`
    index += 1
  }
}

async function upsertSkillMirrorSource(
  executor: Executor,
  input: ImportedMirrorSkillPackage["mirrorSource"]
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("skillMirrorSources")
      .values({
        sourceType: input.sourceType,
        locatorKey: input.locatorKey,
        locator: sql`${JSON.stringify(input.locator)}::jsonb`,
        requestedRef: input.requestedRef || null,
        resolvedRevision: input.resolvedRevision || null,
        refreshMode: "manual",
        lastSyncStatus: "synced",
        sourceWarnings: input.sourceWarnings,
        lastError: null,
        lastSyncedAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["sourceType", "locatorKey"]).doUpdateSet({
          locator: sql`excluded.locator`,
          requestedRef: sql`excluded.requested_ref`,
          resolvedRevision: sql`excluded.resolved_revision`,
          refreshMode: sql`excluded.refresh_mode`,
          lastSyncStatus: "synced",
          sourceWarnings: sql`excluded.source_warnings`,
          lastError: null,
          lastSyncedAt: sql`NOW()`,
        })
      )
      .returning("id")
  )
  return result.rows[0]!.id
}

function hashSnapshotFileContent(blocks: CanonicalContentBlock[]) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(blocks))
    .digest("hex")
}

function snapshotFileSize(blocks: CanonicalContentBlock[]) {
  const fileRefSize = blocks.find((block) => block.type === "file_ref")
  if (fileRefSize && fileRefSize.type === "file_ref") {
    return fileRefSize.sizeBytes
  }
  return Buffer.byteLength(renderSkillBlocksToText(blocks), "utf8")
}

async function insertSkillSnapshot(
  executor: Executor,
  snapshot: PreparedSkillSnapshot,
  options?: {
    mirrorSourceId?: string | null
    resolvedRevision?: string | null
  }
) {
  const inserted = await runBuilder(
    executor,
    executor
      .insertInto("skillSnapshots")
      .values({
        mirrorSourceId: options?.mirrorSourceId || null,
        entryPath: SKILL_ENTRY_PATH,
        name: snapshot.frontmatter.name,
        description: snapshot.frontmatter.description,
        argumentHint: snapshot.frontmatter.argumentHint || null,
        disableModelInvocation: snapshot.frontmatter.disableModelInvocation,
        userInvocable: snapshot.frontmatter.userInvocable,
        allowedTools: snapshot.frontmatter.allowedTools,
        model: snapshot.frontmatter.model || null,
        effort: snapshot.frontmatter.effort || null,
        context: snapshot.frontmatter.context || null,
        agent: snapshot.frontmatter.agent || null,
        hooks: sql`${JSON.stringify(snapshot.frontmatter.hooks || {})}::jsonb`,
        bodyBlocks: sql`${JSON.stringify(snapshot.bodyBlocks)}::jsonb`,
        contentHash: snapshot.contentHash,
        sourceWarnings: snapshot.sourceWarnings,
        resolvedRevision: options?.resolvedRevision || null,
      })
      .returning("id")
  )
  const snapshotId = inserted.rows[0]!.id

  for (const file of snapshot.files) {
    await executor
      .insertInto("skillSnapshotFiles")
      .values({
        skillSnapshotId: snapshotId,
        path: file.path,
        mediaType: file.mediaType || null,
        contentBlocks: sql`${JSON.stringify(file.contentBlocks)}::jsonb`,
        sha256: hashSnapshotFileContent(file.contentBlocks),
        sizeBytes: snapshotFileSize(file.contentBlocks),
      })
      .execute()
  }

  return snapshotId
}

async function loadSkillSnapshotFilesMap(snapshotIds: string[]) {
  if (snapshotIds.length === 0) {
    return new Map<string, SkillAttachmentFile[]>()
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
    [snapshotIds]
  )

  const filesBySnapshotId = new Map<string, SkillAttachmentFile[]>()
  for (const row of result.rows) {
    const files = filesBySnapshotId.get(row.skill_snapshot_id) || []
    files.push(buildSkillAttachmentFromCatalogFile(row))
    filesBySnapshotId.set(row.skill_snapshot_id, files)
  }

  return filesBySnapshotId
}

async function buildMarketplaceInstallationMap(workspaceId: string) {
  const result = await runQuery<{
    source_catalog_item_id: string
    skill_id: string
    installed_count: string
  }>(
    `SELECT DISTINCT ON (source_ref.source_catalog_item_id)
       source_ref.source_catalog_item_id,
       source_ref.skill_id,
       COUNT(*) OVER (PARTITION BY source_ref.source_catalog_item_id) AS installed_count
     FROM skill_source_refs source_ref
     JOIN installed_skills skill
       ON skill.id = source_ref.skill_id
     JOIN workspace_apps_live app
       ON app.id = skill.id
     WHERE app.workspace_id = $1
       AND app.deleted_at IS NULL
       AND source_ref.source_catalog_item_id IS NOT NULL
     ORDER BY source_ref.source_catalog_item_id, app.updated_at DESC`,
    [workspaceId]
  )

  const map = new Map<string, InstallationSummary>()
  for (const row of result.rows) {
    map.set(row.source_catalog_item_id, {
      installed: true,
      installedCount: Number(row.installed_count || 0),
      installedSkillId: row.skill_id,
    })
  }
  return map
}

async function getMarketplaceRowById(
  skillId: string,
  run: QueryRunner = runQuery
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.id = $1
     LIMIT 1`,
    [skillId]
  )

  return result.rows[0] || null
}

async function getMarketplaceRowBySlug(
  publisherId: string,
  slug: string,
  run: QueryRunner
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.publisher_id = $1
      AND item.slug = $2
     LIMIT 1`,
    [publisherId, slug]
  )

  return result.rows[0] || null
}

async function getMarketplaceRowByMirrorSourceId(
  mirrorSourceId: string,
  run: QueryRunner = runQuery
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.mirror_source_id = $1
     LIMIT 1`,
    [mirrorSourceId]
  )

  return result.rows[0] || null
}

async function loadInstalledSkillRows(params: {
  workspaceId?: string
  skillIds?: string[]
  sourceSkillId?: string
}) {
  const values: unknown[] = []
  const conditions: string[] = []

  if (params.workspaceId) {
    values.push(params.workspaceId)
    conditions.push(`app.workspace_id = $${values.length}`)
  }

  if (params.skillIds && params.skillIds.length > 0) {
    values.push(params.skillIds)
    conditions.push(`skill.id = ANY($${values.length}::uuid[])`)
  }

  if (params.sourceSkillId) {
    values.push(params.sourceSkillId)
    conditions.push(`source_ref.source_catalog_item_id = $${values.length}`)
  }

  const result = await runQuery<InstalledSkillRow>(
    `${INSTALLED_SKILL_SELECT}
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY app.updated_at DESC`,
    values
  )

  return result.rows
}

// D3: legacy `legacyCapabilityAccessTargetOrThrow` / `legacyAccessGrantTargetOrThrow`
// helpers removed — all CapabilityAccessTarget values are now ScopedSubjectTarget.

export function buildSkillAccessRow(row: SkillAccessRow): SkillAccessRow {
  const target = skillBindingToAccessTarget(row, row.workspace_id)
  const label = subjectScopeLabel(target)
  let bindScope: RuntimeBindingScope
  switch (label) {
    case "workspace":
    case "workspace_member":
    case "conversation":
    case "actor":
    case "remote_agent":
      bindScope = label
      break
    default:
      bindScope = "workspace"
  }
  const actorId =
    target.subject.kind === "actor"
      ? (target.subject as { actorId: string }).actorId
      : null
  const remoteAgentId =
    target.subject.kind === "remote_agent"
      ? (target.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const conversationId =
    target.scope?.kind === "conversation"
      ? (target.scope as { conversationId: string }).conversationId
      : target.subject.kind === "conversation"
        ? (target.subject as { conversationId: string }).conversationId
        : null
  const workspaceMemberId =
    target.subject.kind === "workspace_member"
      ? (target.subject as { memberId: string }).memberId
      : null
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    skill_id: row.skill_id,
    bind_scope: bindScope,
    conversation_id: conversationId,
    actor_id: actorId,
    remote_agent_id: remoteAgentId,
    workspace_member_id: workspaceMemberId,
    conversation_type_mask_override: row.conversation_type_mask_override,
    status: row.status,
    source: row.source as SkillAccessRow["source"],
    created_by_workspace_member_id: row.created_by_workspace_member_id,
    reason: row.reason,
    created_at: row.created_at || new Date(0),
    revoked_at: row.revoked_at,
  }
}

async function loadAccessBindingsBySkillIds(
  skillIds: string[],
  includeRevoked = false
) {
  if (skillIds.length === 0) return new Map<string, SkillAccessRow[]>()
  let query = db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select([
      "app_grant.id",
      "app_grant.workspaceId as workspace_id",
      "app_grant.workspaceAppId as skill_id",
      sql<RuntimeBindingScope>`
        CASE subj.kind
          WHEN 'workspace' THEN 'workspace'
          WHEN 'workspace_member' THEN 'workspace_member'
          WHEN 'conversation' THEN 'conversation'
          WHEN 'actor' THEN 'actor'
          WHEN 'remote_agent' THEN 'remote_agent'
        END
      `.as("bind_scope"),
      "scope.conversationId as conversation_id",
      "subj.actorId as actor_id",
      "subj.remoteAgentId as remote_agent_id",
      "subj.workspaceMemberId as workspace_member_id",
      "app_grant.conversationTypeMaskOverride as conversation_type_mask_override",
      "app_grant.status",
      "app_grant.source",
      "app_grant.createdByWorkspaceMemberId as created_by_workspace_member_id",
      "app_grant.reason",
      "app_grant.createdAt as created_at",
      "app_grant.revokedAt as revoked_at",
    ])
    .where("app_grant.workspaceAppId", "in", skillIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .orderBy("app_grant.createdAt", "desc")

  if (!includeRevoked) {
    query = query.where("app_grant.status", "=", "active")
  }

  const rows = await query.execute()

  const map = new Map<string, SkillAccessRow[]>()
  for (const row of rows) {
    const normalizedRow: SkillAccessRow = {
      ...row,
      created_at: row.created_at || new Date(0),
    }
    const existing = map.get(normalizedRow.skill_id) || []
    existing.push(normalizedRow)
    map.set(row.skill_id, existing)
  }
  return map
}

async function loadAccessBindingsBySkillIdsForContext(
  skillIds: string[],
  context: {
    contextWorkspaceId: string
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    conversationId?: string
  }
) {
  if (skillIds.length === 0) return new Map<string, SkillAccessRow[]>()
  const bindings = await loadAccessBindingsBySkillIds(skillIds)

  const map = new Map<string, SkillAccessRow[]>()
  for (const [skillId, rows] of bindings.entries()) {
    const filtered = rows.filter((row) => {
      switch (row.bind_scope) {
        case "workspace":
          return true
        case "workspace_member":
          return row.workspace_member_id === (context.workspaceMemberId || null)
        case "conversation":
          return row.conversation_id === (context.conversationId || null)
        case "actor":
          return (
            row.actor_id === (context.actorId || null) &&
            (!row.conversation_id ||
              row.conversation_id === (context.conversationId || null))
          )
        case "remote_agent":
          return (
            row.remote_agent_id === (context.remoteAgentId || null) &&
            (!row.conversation_id ||
              row.conversation_id === (context.conversationId || null))
          )
      }
    })
    if (filtered.length > 0) {
      map.set(skillId, filtered)
    }
  }
  return map
}

async function listSkillAccessRows(skillId: string, includeRevoked = false) {
  const rows = await loadAccessBindingsBySkillIds([skillId], includeRevoked)
  return rows.get(skillId) || []
}

function mapSkillAccessRowToGrant(
  row: SkillAccessRow,
  options?: {
    workspaceConversationTypeMask: number
    instanceConversationTypeMaskOverride: number | null
  }
): WorkspaceAppGrant {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride
        ),
        row.conversation_type_mask_override
      )
    : undefined
  return {
    id: row.id,
    workspaceAppId: row.skill_id,
    workspaceId: row.workspace_id,
    target: visibleRowToAccessTarget({
      skill_id: row.skill_id,
      workspace_id: row.workspace_id,
      access_bind_scope: row.bind_scope,
      conversation_id: row.conversation_id,
      actor_id: row.actor_id,
      remote_agent_id: row.remote_agent_id,
      workspace_member_id: row.workspace_member_id,
    } as VisibleSkillRow),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: row.status,
    source: row.source,
    grantedByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    reason: row.reason || undefined,
    conversationTypeMaskOverride: row.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask,
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    revokedAt: serializeOptionalInstant(row.revoked_at),
  }
}

async function loadInstalledSkillForUpdate(
  workspaceId: string,
  skillId: string
) {
  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: [skillId],
  })
  return rows[0] || null
}

async function loadInstalledSkillById(skillId: string) {
  const rows = await loadInstalledSkillRows({
    skillIds: [skillId],
  })
  return rows[0] || null
}

async function chooseBindingMap(
  skillIds: string[],
  filters?: {
    accessTargetType?: SkillUseScope
    actorId?: string
    workspaceMemberId?: string
    conversationId?: string
  }
) {
  const bindingsBySkillId = await loadAccessBindingsBySkillIds(skillIds)
  const preferredTarget = filters?.accessTargetType
    ? normalizeScopeTarget({
        useScope: filters.accessTargetType,
        actorId: filters.actorId,
        workspaceMemberId: filters.workspaceMemberId,
        conversationId: filters.conversationId,
      })
    : undefined

  const map = new Map<string, SkillAccessRow | undefined>()
  for (const skillId of skillIds) {
    const candidates = bindingsBySkillId.get(skillId) || []
    const matching = preferredTarget
      ? candidates.filter((binding) =>
          matchesScopeTarget(binding, preferredTarget)
        )
      : candidates
    const chosen = [...(matching.length > 0 ? matching : candidates)].sort(
      compareBindingPriority
    )[0]
    map.set(skillId, chosen)
  }

  return map
}

async function findSkillIdsByBindingFilter(params: {
  workspaceId: string
  accessTargetType?: SkillUseScope
  actorId?: string
  workspaceMemberId?: string
  conversationId?: string
}) {
  if (
    !params.accessTargetType &&
    !params.actorId &&
    !params.workspaceMemberId &&
    !params.conversationId
  ) {
    return null
  }

  const target = params.accessTargetType
    ? await resolveAccessGrantTarget({
        workspaceId: params.workspaceId,
        target: scopedTargetFromSkillUseScope({
          useScope: params.accessTargetType,
          workspaceId: params.workspaceId,
          actorId: params.actorId,
          workspaceMemberId: params.workspaceMemberId,
          conversationId: params.conversationId,
        }),
      })
    : null

  let query = db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select("app_grant.workspaceAppId as skill_id")
    .distinct()
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.kind", "=", "installed_skill")
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )

  if (target) {
    switch (target.subject.kind) {
      case "workspace":
        query = query.where("subj.kind", "=", "workspace")
        break
      case "workspace_member":
        query = query
          .where("subj.kind", "=", "workspace_member")
          .where("subj.workspaceMemberId", "=", target.subject.memberId)
        break
      case "conversation":
        query = query
          .where("subj.kind", "=", "conversation")
          .where("subj.conversationId", "=", target.subject.conversationId)
        break
      case "actor":
        query = query
          .where("subj.kind", "=", "actor")
          .where("subj.actorId", "=", target.subject.actorId)
        break
      case "remote_agent":
        query = query
          .where("subj.kind", "=", "remote_agent")
          .where("subj.remoteAgentId", "=", target.subject.remoteAgentId)
        break
      default:
        return []
    }

    if (target.scope?.kind === "conversation") {
      query = query.where(
        "scope.conversationId",
        "=",
        target.scope.conversationId
      )
    } else {
      query = query.where("app_grant.scopeSubjectId", "is", null)
    }
  } else {
    if (params.workspaceMemberId) {
      query = query.where(
        "subj.workspaceMemberId",
        "=",
        params.workspaceMemberId
      )
    }
    if (params.actorId) {
      query = query.where("subj.actorId", "=", params.actorId)
    }
    if (params.conversationId) {
      query = query.where(
        sql<boolean>`COALESCE(scope.conversation_id, subj.conversation_id) = ${params.conversationId}`
      )
    }
  }

  const rows = await query.execute()
  return rows
    .map((row) => row.skill_id)
    .filter((skillId): skillId is string => Boolean(skillId))
}

async function ensureSkillBinding(
  client: Executor,
  input: {
    skillId: string
    workspaceId: string
    target: SkillScopeTarget
    createdByWorkspaceMemberId?: string
  }
) {
  const grantTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: scopedTargetFromSkillUseScope({
      useScope: input.target.useScope,
      workspaceId: input.workspaceId,
      actorId: input.target.actorId || undefined,
      remoteAgentId: input.target.remoteAgentId || undefined,
      workspaceMemberId: input.target.workspaceMemberId || undefined,
      conversationId: input.target.conversationId || undefined,
    }),
  })
  const existingRows = await loadAccessBindingsBySkillIds([input.skillId])
  const existingBinding = (existingRows.get(input.skillId) || []).find((row) =>
    matchesScopeTarget(
      row,
      normalizeScopeTarget({
        useScope: input.target.useScope,
        actorId: input.target.actorId,
        remoteAgentId: input.target.remoteAgentId,
        workspaceMemberId: input.target.workspaceMemberId,
        conversationId: input.target.conversationId,
      })
    )
  )

  if (existingBinding) {
    return {
      bindingId: existingBinding.id,
    }
  }

  const inserted = await insertWorkspaceAppGrant(client as any, {
    workspaceId: input.workspaceId,
    workspaceAppId: input.skillId,
    target: grantTarget,
    permissions: ["use"],
    createdByWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
  })

  return {
    bindingId: inserted.id,
  }
}

async function getInstalledSkillResponse(
  workspaceId: string,
  installedSkillId: string
) {
  const row = await loadInstalledSkillForUpdate(workspaceId, installedSkillId)
  if (!row) {
    throw new SkillError(404, "Installed skill not found")
  }

  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap([installedSkillId]),
    loadSkillSnapshotFilesMap([row.current_snapshot_id]),
  ])
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      row.workspace_id,
      "installed_skill"
    )

  return buildInstalledSkillPayload(
    row,
    bindingMap.get(installedSkillId),
    workspaceConversationTypeMask,
    fileMap.get(row.current_snapshot_id) || []
  )
}

export async function listMarketplaceSkills(filters?: {
  search?: string
  tags?: string[]
  workspaceId?: string
}) {
  const values: unknown[] = []
  const conditions: string[] = []

  if (filters?.search?.trim()) {
    values.push(`%${filters.search.trim()}%`)
    conditions.push(
      `(item.display_name ILIKE $${values.length}
        OR item.slug ILIKE $${values.length}
        OR item.summary ILIKE $${values.length}
        OR item.long_description ILIKE $${values.length})`
    )
  }

  const normalizedTags = (filters?.tags || [])
    .map((tag) => tag.trim())
    .filter(Boolean)
  if (normalizedTags.length > 0) {
    values.push(normalizedTags)
    conditions.push(`item.tags && $${values.length}::text[]`)
  }

  const result = await runQuery<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
     ${conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : ""}
     ORDER BY item.updated_at DESC, item.created_at DESC`,
    values
  )

  const latestSnapshotIds = result.rows
    .map((row) => row.snapshot_id)
    .filter((value): value is string => Boolean(value))
  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(latestSnapshotIds),
    filters?.workspaceId
      ? buildMarketplaceInstallationMap(filters.workspaceId)
      : Promise.resolve(null),
  ])

  return result.rows.map((row) =>
    mapMarketplaceEntry(
      row,
      installationMap?.get(row.item_id),
      row.snapshot_id ? filesMap.get(row.snapshot_id) || [] : undefined
    )
  )
}

export async function getMarketplaceSkill(
  skillId: string,
  workspaceId?: string
) {
  const row = await getMarketplaceRowById(skillId)
  if (!row) {
    throw new SkillError(404, "Skill not found")
  }

  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(row.snapshot_id ? [row.snapshot_id] : []),
    workspaceId
      ? buildMarketplaceInstallationMap(workspaceId)
      : Promise.resolve(null),
  ])

  return mapMarketplaceEntry(
    row,
    installationMap?.get(row.item_id),
    row.snapshot_id ? filesMap.get(row.snapshot_id) || [] : undefined
  )
}

function publisherOptionsForMirrorSource(
  sourceType: ImportedMirrorSkillPackage["mirrorSource"]["sourceType"]
) {
  if (sourceType === "github") {
    return {
      slug: GITHUB_MARKETPLACE_PUBLISHER_SLUG,
      displayName: GITHUB_MARKETPLACE_PUBLISHER_NAME,
    }
  }

  return {
    slug: CLAWHUB_MARKETPLACE_PUBLISHER_SLUG,
    displayName: CLAWHUB_MARKETPLACE_PUBLISHER_NAME,
  }
}

async function upsertImportedMarketplaceSkill(
  imported: ImportedMirrorSkillPackage,
  authorUserId?: string
) {
  const result = await withDbTransaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(client, {
      ownerUserId: authorUserId,
      ...publisherOptionsForMirrorSource(imported.mirrorSource.sourceType),
    })
    const mirrorSourceId = await upsertSkillMirrorSource(
      client,
      imported.mirrorSource
    )
    const existing = await getMarketplaceRowByMirrorSourceId(
      mirrorSourceId,
      clientRunner(client)
    )

    if (
      existing &&
      existing.latest_version_value === imported.version &&
      existing.snapshot_content_hash === imported.contentHash
    ) {
      await client
        .updateTable("catalogItems")
        .set({
          displayName: imported.frontmatter.name,
          summary: imported.frontmatter.description,
          longDescription: imported.frontmatter.description,
          tags: imported.tags,
          metadata: sql`${JSON.stringify(imported.itemMetadata)}::jsonb`,
        })
        .where("id", "=", existing.item_id)
        .execute()
      return existing.item_id
    }

    const itemSlug = existing
      ? existing.item_slug
      : await allocateMarketplaceItemSlug(
          client,
          publisherId,
          sanitizeSlug(imported.catalogSlug) || "skill"
        )

    let itemId = existing?.item_id || null
    if (existing) {
      await client
        .updateTable("catalogItems")
        .set({
          slug: itemSlug,
          displayName: imported.frontmatter.name,
          summary: imported.frontmatter.description,
          longDescription: imported.frontmatter.description,
          mirrorSourceId: mirrorSourceId,
          sourceKind: "official",
          visibility: "public",
          tags: imported.tags,
          isActive: true,
          metadata: sql`${JSON.stringify(imported.itemMetadata)}::jsonb`,
        })
        .where("id", "=", existing.item_id)
        .execute()
      itemId = existing.item_id
    } else {
      const inserted = await runBuilder(
        client,
        client
          .insertInto("catalogItems")
          .values({
            publisherId: publisherId,
            workspaceId: null,
            itemKind: "skill_package",
            slug: itemSlug,
            displayName: imported.frontmatter.name,
            summary: imported.frontmatter.description,
            longDescription: imported.frontmatter.description,
            mirrorSourceId: mirrorSourceId,
            sourceKind: "official",
            visibility: "public",
            tags: imported.tags,
            isActive: true,
            metadata: sql`${JSON.stringify(imported.itemMetadata)}::jsonb`,
          })
          .returning("id")
      )
      itemId = inserted.rows[0]!.id
    }

    const snapshotId = await insertSkillSnapshot(client, imported, {
      mirrorSourceId,
      resolvedRevision: imported.mirrorSource.resolvedRevision || null,
    })

    const existingVersion = await runBuilder(
      client,
      client
        .selectFrom("catalogVersions")
        .select("id")
        .where("catalogItemId", "=", itemId!)
        .where("version", "=", imported.version)
        .limit(1)
    )

    const versionId =
      existingVersion.rows[0]?.id ||
      (
        await runBuilder(
          client,
          client
            .insertInto("catalogVersions")
            .values({
              catalogItemId: itemId!,
              version: imported.version,
              status: "active",
              changelog: imported.changelog,
              metadata: sql`${JSON.stringify(imported.itemMetadata)}::jsonb`,
              createdByUserId: authorUserId || null,
            })
            .returning("id")
        )
      ).rows[0]!.id

    if (existingVersion.rows[0]) {
      await client
        .updateTable("catalogVersions")
        .set({
          status: "active",
          changelog: imported.changelog,
          metadata: sql`${JSON.stringify(imported.itemMetadata)}::jsonb`,
        })
        .where("id", "=", versionId)
        .execute()
    }

    await client
      .insertInto("skillPackageVersionSpecs")
      .values({
        catalogVersionId: versionId,
        skillSnapshotId: snapshotId,
        defaultConversationTypeMask: DEFAULT_CONVERSATION_TYPE_MASK,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.column("catalogVersionId").doUpdateSet({
          skillSnapshotId: sql`excluded.skill_snapshot_id`,
          defaultConversationTypeMask: sql`excluded.default_conversation_type_mask`,
        })
      )
      .execute()

    await client
      .updateTable("catalogItems")
      .set({
        latestVersionId: versionId,
      })
      .where("id", "=", itemId!)
      .execute()

    return itemId
  })

  return getMarketplaceSkill(result)
}

export async function importMarketplaceMirrorSkill(
  input:
    | {
        sourceType: "github"
        repoUrl: string
        path: string
        ref?: string
        authorUserId?: string
      }
    | {
        sourceType: "clawhub"
        ownerId?: string
        slug: string
        version?: string
        authorUserId?: string
      }
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
        })

  return upsertImportedMarketplaceSkill(imported, input.authorUserId)
}

export async function importSeededClawhubMarketplaceSkill(input: {
  skillDir: string
  authorUserId?: string
}) {
  const imported = await importClawhubSeedSkillPackage({
    skillDir: input.skillDir,
  })
  return upsertImportedMarketplaceSkill(imported, input.authorUserId)
}

export async function refreshMarketplaceSkill(input: {
  skillId: string
  authorUserId?: string
}) {
  const existing = await getMarketplaceRowById(input.skillId)
  if (!existing || !existing.mirror_source_id || !existing.mirror_source_type) {
    throw new SkillError(400, "Marketplace skill has no mirror source")
  }

  if (existing.mirror_source_type === "github") {
    const locator = parseJsonObject(existing.mirror_locator)
    return importMarketplaceMirrorSkill({
      sourceType: "github",
      repoUrl: String(locator.repoUrl || ""),
      path: String(locator.path || "."),
      ref: existing.mirror_requested_ref || undefined,
      authorUserId: input.authorUserId,
    })
  }

  const locator = parseJsonObject(existing.mirror_locator)
  return importMarketplaceMirrorSkill({
    sourceType: "clawhub",
    ownerId:
      typeof locator.ownerId === "string" && locator.ownerId.trim().length > 0
        ? locator.ownerId
        : undefined,
    slug: String(locator.slug || ""),
    version: existing.mirror_requested_ref || undefined,
    authorUserId: input.authorUserId,
  })
}

export async function publishMarketplaceSkill(input: {
  skillId?: string
  slug: string
  name: string
  description?: CanonicalContentBlockInput
  iconFileId?: string | null
  tags?: string[]
  version: string
  changelog?: string
  attachmentFiles?: SkillAttachmentInput[]
  defaultConversationTypeMask?: number
  authorUserId?: string
  isActive?: boolean
  metadata?: JsonObject
}) {
  const canonicalSlug = sanitizeSlug(input.slug || input.name)
  if (!canonicalSlug) {
    throw new SkillError(400, "Skill slug is required")
  }

  const name = input.name.trim()
  if (!name) {
    throw new SkillError(400, "Skill name is required")
  }

  const version = input.version.trim()
  if (!version) {
    throw new SkillError(400, "Skill version is required")
  }

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles)
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: canonicalSlug || name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  })
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: input.defaultConversationTypeMask,
    overrideMask: null,
  })

  const result = await withDbTransaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(client, {
      ownerUserId: input.authorUserId,
    })
    const existing = input.skillId
      ? await getMarketplaceRowById(input.skillId, clientRunner(client))
      : await getMarketplaceRowBySlug(
          publisherId,
          canonicalSlug,
          clientRunner(client)
        )

    let itemId = existing?.item_id || null
    if (existing && existing.item_id !== input.skillId && input.skillId) {
      throw new SkillError(404, "Skill not found")
    }

    const itemMetadata: JsonObject = {
      ...parseJsonObject(existing?.item_metadata),
      canonicalSlug,
      frontmatterName: preparedSnapshot.frontmatter.name,
      ...(input.metadata || {}),
    }
    const nextIconFileId =
      input.iconFileId === undefined
        ? (existing?.item_icon_file_id ?? null)
        : input.iconFileId
          ? await normalizeMarketplaceSkillIconFileId(
              input.iconFileId,
              input.authorUserId
            )
          : null

    if (existing) {
      await client
        .updateTable("catalogItems")
        .set({
          slug: canonicalSlug,
          displayName: preparedSnapshot.frontmatter.name,
          summary: preparedSnapshot.frontmatter.description,
          longDescription: preparedSnapshot.frontmatter.description,
          tags: input.tags || [],
          isActive: input.isActive ?? true,
          iconFileId: nextIconFileId,
          metadata: sql`${JSON.stringify(itemMetadata)}::jsonb`,
        })
        .where("id", "=", existing.item_id)
        .execute()
      itemId = existing.item_id
    } else {
      const inserted = await runBuilder(
        client,
        client
          .insertInto("catalogItems")
          .values({
            publisherId: publisherId,
            workspaceId: null,
            itemKind: "skill_package",
            slug: canonicalSlug,
            displayName: preparedSnapshot.frontmatter.name,
            summary: preparedSnapshot.frontmatter.description,
            longDescription: preparedSnapshot.frontmatter.description,
            mirrorSourceId: null,
            sourceKind: "official",
            visibility: "public",
            tags: input.tags || [],
            isActive: input.isActive ?? true,
            iconFileId: nextIconFileId,
            metadata: sql`${JSON.stringify(itemMetadata)}::jsonb`,
          })
          .returning("id")
      )
      itemId = inserted.rows[0]!.id
    }

    const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)

    const existingVersion = await runBuilder(
      client,
      client
        .selectFrom("catalogVersions")
        .select("id")
        .where("catalogItemId", "=", itemId!)
        .where("version", "=", version)
        .limit(1)
    )

    const versionMetadata = input.metadata || {}
    const versionId =
      existingVersion.rows[0]?.id ||
      (
        await runBuilder(
          client,
          client
            .insertInto("catalogVersions")
            .values({
              catalogItemId: itemId!,
              version,
              status: "active",
              changelog: input.changelog || "",
              metadata: sql`${JSON.stringify(versionMetadata)}::jsonb`,
              createdByUserId: input.authorUserId || null,
            })
            .returning("id")
        )
      ).rows[0]!.id

    if (existingVersion.rows[0]) {
      await client
        .updateTable("catalogVersions")
        .set({
          status: "active",
          changelog: input.changelog || "",
          metadata: sql`${JSON.stringify(versionMetadata)}::jsonb`,
          createdByUserId: sql`COALESCE(created_by_user_id, ${input.authorUserId || null})`,
          createdAt: sql`created_at`,
        })
        .where("id", "=", versionId)
        .execute()
    }

    await client
      .insertInto("skillPackageVersionSpecs")
      .values({
        catalogVersionId: versionId,
        skillSnapshotId: snapshotId,
        defaultConversationTypeMask: defaultConversationTypeMask,
        createdAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.column("catalogVersionId").doUpdateSet({
          skillSnapshotId: sql`excluded.skill_snapshot_id`,
          defaultConversationTypeMask: sql`excluded.default_conversation_type_mask`,
        })
      )
      .execute()

    await client
      .updateTable("catalogItems")
      .set({
        latestVersionId: versionId,
      })
      .where("id", "=", itemId!)
      .execute()

    return itemId
  })

  return getMarketplaceSkill(result)
}

export async function createWorkspaceSkill(input: {
  workspaceId: string
  name: string
  description?: CanonicalContentBlockInput
  iconFileId?: string
  tags?: string[]
  attachmentFiles?: SkillAttachmentInput[]
  accessTarget?: CapabilityAccessTarget
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  installedByWorkspaceMemberId?: string
}) {
  const name = input.name.trim()
  if (!name) {
    throw new SkillError(400, "Skill name is required")
  }

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles)
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  })
  const iconFileId = input.iconFileId
    ? await normalizeWorkspaceSkillIconFileId(
        input.iconFileId,
        input.workspaceId
      )
    : null
  // D3: input.accessTarget is now a ScopedSubjectTarget; collapse to the
  // legacy SkillUseScope label for downstream SkillScopeTarget bookkeeping.
  // Round 10 review (P2): also extract remoteAgentId so SkillScopeTarget
  // doesn't drop the remote_agent identity when the target subject is
  // a remote agent.
  // Round 11 review (P2): same for workspace_member — without this the
  // workspace_member skill grant path would crash in ensureSkillBinding.
  const target = input.accessTarget
    ? normalizeScopeTarget({
        useScope: skillUseScopeFromTarget(input.accessTarget),
        actorId:
          input.accessTarget.subject.kind === "actor"
            ? (input.accessTarget.subject as { actorId: string }).actorId
            : null,
        remoteAgentId:
          input.accessTarget.subject.kind === "remote_agent"
            ? (input.accessTarget.subject as { remoteAgentId: string })
                .remoteAgentId
            : null,
        workspaceMemberId:
          input.accessTarget.subject.kind === "workspace_member"
            ? (input.accessTarget.subject as { memberId: string }).memberId
            : null,
        conversationId:
          input.accessTarget.scope?.kind === "conversation"
            ? (input.accessTarget.scope as { conversationId: string })
                .conversationId
            : input.accessTarget.subject.kind === "conversation"
              ? (input.accessTarget.subject as { conversationId: string })
                  .conversationId
              : null,
      })
    : null

  const result = await withDbTransaction(async (client) => {
    const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)
    const skillId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: skillId,
      workspaceId: input.workspaceId,
      kind: "installed_skill",
      displayName: preparedSnapshot.frontmatter.name,
      ownerWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      status: "active",
      conversationTypeMaskOverride: null,
    })
    const insertedSkill = await runBuilder(
      client,
      client
        .insertInto("installedSkills")
        .values({
          id: skillId,
          iconFileId: iconFileId,
          tags: input.tags || [],
          currentVersion: 1,
          currentSnapshotId: snapshotId,
        })
        .returning("id")
    )
    const insertedSkillId = insertedSkill.rows[0]!.id

    await client
      .insertInto("skillVersions")
      .values({
        skillId: insertedSkillId,
        version: 1,
        skillSnapshotId: snapshotId,
        metadata: sql`${JSON.stringify({})}::jsonb`,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      })
      .execute()

    if (input.grants?.length) {
      for (const grant of input.grants) {
        await insertWorkspaceAppGrant(client as any, {
          workspaceId: input.workspaceId,
          workspaceAppId: insertedSkillId,
          target: await resolveAccessGrantTarget({
            workspaceId: input.workspaceId,
            target: grant.target,
          }),
          permissions: grant.permissions,
          conversationTypeMaskOverride:
            grant.conversationTypeMaskOverride ?? null,
          createdByWorkspaceMemberId:
            input.installedByWorkspaceMemberId || null,
          reason: grant.reason ?? null,
        })
      }
    } else if (target) {
      await ensureSkillBinding(client, {
        skillId: insertedSkillId,
        workspaceId: input.workspaceId,
        target,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
      })
    }

    return {
      skillId: insertedSkillId,
    }
  })

  return getInstalledSkillResponse(input.workspaceId, result.skillId)
}

export async function listInstalledSkills(
  workspaceId: string,
  filters?: {
    skillIds?: string[]
    accessTargetType?: SkillUseScope
    actorId?: string
    // Round 12 review (P3): workspace_member filter requires the id so
    // the underlying scopedTargetFromSkillUseScope("workspace_member")
    // call can build a SubjectRef. Previously the filter mode accepted
    // accessTargetType=workspace_member from the controller but the
    // service had no way to receive the id, so the filter crashed at
    // "workspaceMemberId is required for workspace_member scope".
    workspaceMemberId?: string
    conversationId?: string
    sourceSkillId?: string
  }
) {
  const filteredSkillIds = await findSkillIdsByBindingFilter({
    workspaceId,
    accessTargetType: filters?.accessTargetType,
    actorId: filters?.actorId,
    workspaceMemberId: filters?.workspaceMemberId,
    conversationId: filters?.conversationId,
  })
  if (filteredSkillIds && filteredSkillIds.length === 0) {
    return []
  }

  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: filters?.skillIds || filteredSkillIds || undefined,
    sourceSkillId: filters?.sourceSkillId,
  })
  if (rows.length === 0) return []

  const skillIds = rows.map((row) => row.skill_id)
  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap(skillIds, {
      accessTargetType: filters?.accessTargetType,
      actorId: filters?.actorId,
      workspaceMemberId: filters?.workspaceMemberId,
      conversationId: filters?.conversationId,
    }),
    loadSkillSnapshotFilesMap(rows.map((row) => row.current_snapshot_id)),
  ])
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      "installed_skill"
    )

  return rows.map((row) =>
    buildInstalledSkillPayload(
      row,
      bindingMap.get(row.skill_id),
      workspaceConversationTypeMask,
      fileMap.get(row.current_snapshot_id) || []
    )
  )
}

export async function getInstalledSkill(
  workspaceId: string,
  installedSkillId: string
) {
  return getInstalledSkillResponse(workspaceId, installedSkillId)
}

export async function getInstalledSkillGrantState(
  workspaceId: string,
  installedSkillId: string
) {
  const skillRow = await loadInstalledSkillForUpdate(
    workspaceId,
    installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill"
    )
  const accessRows = await listSkillAccessRows(installedSkillId)
  const grants = accessRows.map((row) =>
    mapSkillAccessRowToGrant(row, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversation_type_mask_override ?? null,
    })
  )
  const initialGrant = selectInitialSkillGrant(accessRows)
  const suggestedGrantScope = initialGrant
    ? resolvePublicUseScope(initialGrant)
    : ("workspace" as SkillAccessSuggestion)

  return {
    grants,
    summary: {
      requiredPermissions: [ACCESS_ACTIONS["installed_skill.use"].permission],
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
      effectivePermissions:
        grants.length > 0
          ? [ACCESS_ACTIONS["installed_skill.use"].permission]
          : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  }
}

export async function createInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  accessTarget?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  grantedByWorkspaceMemberId?: string
  reason?: string
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill"
    )

  const accessRows = await listSkillAccessRows(input.installedSkillId)
  const initialGrant = selectInitialSkillGrant(accessRows)
  const accessTargetInput =
    input.accessTarget ||
    (initialGrant
      ? skillBindingToAccessTarget(initialGrant, input.workspaceId)
      : ({
          subject: workspaceRef(input.workspaceId),
        } satisfies CapabilityAccessTarget))

  const accessTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: accessTargetInput,
  })
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversation_type_mask_override ?? null
  )
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    })
  await validateConversationScopedAccessTarget({
    db,
    target: accessTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  })

  // P2/P3 fix: include workspace_member_id in the dedupe key. Without it, two
  // different members both look like {workspace_member, null, null} and the
  // second grant is incorrectly treated as already-existing — silently
  // dropping the new member's binding.
  //
  // Round 9 review (P2): include remote_agent_id for the same reason. Two
  // remote_agent grants for different remote agents both have
  // bind_scope="remote_agent" and were silently deduped against each
  // other before this fix.
  const accessTargetLabel = subjectScopeLabel(accessTarget)
  const accessTargetActorId =
    accessTarget.subject.kind === "actor"
      ? (accessTarget.subject as { actorId: string }).actorId
      : null
  const accessTargetRemoteAgentId =
    accessTarget.subject.kind === "remote_agent"
      ? (accessTarget.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const accessTargetConversationId =
    accessTarget.scope?.kind === "conversation"
      ? (accessTarget.scope as { conversationId: string }).conversationId
      : accessTarget.subject.kind === "conversation"
        ? (accessTarget.subject as { conversationId: string }).conversationId
        : null
  const accessTargetWorkspaceMemberId =
    accessTarget.subject.kind === "workspace_member"
      ? (accessTarget.subject as { memberId: string }).memberId
      : null
  const existing = accessRows.find(
    (row) =>
      row.status === "active" &&
      row.bind_scope === accessTargetLabel &&
      row.actor_id === accessTargetActorId &&
      row.remote_agent_id === accessTargetRemoteAgentId &&
      row.conversation_id === accessTargetConversationId &&
      row.workspace_member_id === accessTargetWorkspaceMemberId
  )
  if (existing) {
    return mapSkillAccessRowToGrant(existing, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversation_type_mask_override ?? null,
    })
  }

  const result = await withDbTransaction(async (client) => {
    const inserted = await insertWorkspaceAppGrant(client as any, {
      workspaceId: input.workspaceId,
      workspaceAppId: input.installedSkillId,
      target: accessTarget,
      permissions: ["use"],
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || null,
    })
    return {
      accessRow: {
        id: inserted.id,
        workspace_id: inserted.workspaceId,
        skill_id: inserted.workspaceAppId,
        bind_scope: accessTarget.subject.kind as RuntimeBindingScope,
        conversation_id:
          accessTarget.scope?.kind === "conversation"
            ? accessTarget.scope.conversationId
            : accessTarget.subject.kind === "conversation"
              ? accessTarget.subject.conversationId
              : null,
        actor_id:
          accessTarget.subject.kind === "actor"
            ? accessTarget.subject.actorId
            : null,
        remote_agent_id:
          accessTarget.subject.kind === "remote_agent"
            ? accessTarget.subject.remoteAgentId
            : null,
        workspace_member_id:
          accessTarget.subject.kind === "workspace_member"
            ? accessTarget.subject.memberId
            : null,
        conversation_type_mask_override: inserted.conversationTypeMaskOverride,
        status: inserted.status,
        source: inserted.source,
        created_by_workspace_member_id: inserted.createdByWorkspaceMemberId,
        reason: inserted.reason,
        created_at: inserted.createdAt,
        revoked_at: inserted.revokedAt,
        relation: "use_workspace",
      } as SkillAccessRow,
    }
  })

  return mapSkillAccessRowToGrant(result.accessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversation_type_mask_override ?? null,
  })
}

export async function updateInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  grantId: string
  conversationTypeMaskOverride?: number | null
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspace_id,
      "installed_skill"
    )
  const accessRows = await listSkillAccessRows(input.installedSkillId, true)
  const accessRow = accessRows.find((row) => row.id === input.grantId)
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found")
  }
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversation_type_mask_override ?? null
  )
  const accessRowTarget = skillBindingToAccessTarget(
    accessRow,
    input.workspaceId
  )
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessRowTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    })
  await validateConversationScopedAccessTarget({
    db,
    target: accessRowTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  })

  if (input.conversationTypeMaskOverride !== undefined) {
    await db
      .updateTable("workspaceAppGrants")
      .set({
        conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      } as any)
      .where("id", "=", input.grantId)
      .where("workspaceId", "=", input.workspaceId)
      .execute()
  }

  const updatedRows = await listSkillAccessRows(input.installedSkillId)
  const updatedRow = updatedRows.find((row) => row.id === input.grantId)
  if (!updatedRow) {
    throw new SkillError(404, "Access grant not found")
  }

  return mapSkillAccessRowToGrant(updatedRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversation_type_mask_override ?? null,
  })
}

export async function revokeInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  grantId: string
}) {
  const accessRows = await listSkillAccessRows(input.installedSkillId, true)
  const accessRow = accessRows.find((row) => row.id === input.grantId)
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found")
  }
  if (accessRow.status === "revoked") {
    return mapSkillAccessRowToGrant(accessRow)
  }

  await revokeWorkspaceAppGrant(db, accessRow.id)

  return { success: true }
}

export async function installMarketplaceSkill(input: {
  workspaceId: string
  marketSkillId: string
  accessTarget?: CapabilityAccessTarget
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  installedByWorkspaceMemberId?: string
}) {
  const target = input.accessTarget
    ? normalizeScopeTarget({
        useScope: skillUseScopeFromTarget(input.accessTarget),
        actorId:
          input.accessTarget.subject.kind === "actor"
            ? (input.accessTarget.subject as { actorId: string }).actorId
            : null,
        remoteAgentId:
          input.accessTarget.subject.kind === "remote_agent"
            ? (input.accessTarget.subject as { remoteAgentId: string })
                .remoteAgentId
            : null,
        workspaceMemberId:
          input.accessTarget.subject.kind === "workspace_member"
            ? (input.accessTarget.subject as { memberId: string }).memberId
            : null,
        conversationId:
          input.accessTarget.scope?.kind === "conversation"
            ? (input.accessTarget.scope as { conversationId: string })
                .conversationId
            : input.accessTarget.subject.kind === "conversation"
              ? (input.accessTarget.subject as { conversationId: string })
                  .conversationId
              : null,
      })
    : null

  const marketplaceSkill = await getMarketplaceRowById(input.marketSkillId)
  if (
    !marketplaceSkill ||
    !marketplaceSkill.latest_version_id ||
    !marketplaceSkill.snapshot_id
  ) {
    throw new SkillError(404, "Marketplace skill not found")
  }

  const result = await withDbTransaction(async (client) => {
    const skillId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: skillId,
      workspaceId: input.workspaceId,
      kind: "installed_skill",
      displayName:
        marketplaceSkill.snapshot_display_name ||
        marketplaceSkill.item_display_name,
      ownerWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      status: "active",
      conversationTypeMaskOverride:
        marketplaceSkill.spec_default_conversation_type_mask ?? null,
    })

    const insertedSkill = await runBuilder(
      client,
      client
        .insertInto("installedSkills")
        .values({
          id: skillId,
          iconFileId: marketplaceSkill.item_icon_file_id,
          tags: marketplaceSkill.item_tags || [],
          currentVersion: 1,
          currentSnapshotId: marketplaceSkill.snapshot_id!,
        })
        .returning("id")
    )
    const insertedSkillId = insertedSkill.rows[0]!.id

    await client
      .insertInto("skillVersions")
      .values({
        skillId: insertedSkillId,
        version: 1,
        skillSnapshotId: marketplaceSkill.snapshot_id!,
        metadata: sql`${JSON.stringify({})}::jsonb`,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      })
      .execute()

    await client
      .insertInto("skillSourceRefs")
      .values({
        skillId: insertedSkillId,
        sourceCatalogItemId: marketplaceSkill.item_id,
        sourceCatalogVersionId: marketplaceSkill.latest_version_id,
        syncMode: "manual_merge",
        isCustomized: false,
      })
      .execute()

    await client
      .updateTable("catalogItems")
      .set({
        downloadCount: sql`${sql.ref("downloadCount")} + 1`,
      })
      .where("id", "=", marketplaceSkill.item_id)
      .execute()

    if (input.grants?.length) {
      for (const grant of input.grants) {
        await insertWorkspaceAppGrant(client as any, {
          workspaceId: input.workspaceId,
          workspaceAppId: insertedSkillId,
          target: await resolveAccessGrantTarget({
            workspaceId: input.workspaceId,
            target: grant.target,
          }),
          permissions: grant.permissions,
          conversationTypeMaskOverride:
            grant.conversationTypeMaskOverride ?? null,
          createdByWorkspaceMemberId:
            input.installedByWorkspaceMemberId || null,
          reason: grant.reason ?? null,
        })
      }
    } else if (target) {
      await ensureSkillBinding(client, {
        skillId: insertedSkillId,
        workspaceId: input.workspaceId,
        target,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
      })
    }

    return {
      skillId: insertedSkillId,
    }
  })

  return getInstalledSkillResponse(input.workspaceId, result.skillId)
}

export async function updateInstalledSkill(input: {
  workspaceId: string
  installedSkillId: string
  name?: string
  description?: CanonicalContentBlockInput
  iconFileId?: string | null
  tags?: string[]
  isEnabled?: boolean
  conversationTypeMaskOverride?: number | null
  attachmentFiles?: SkillAttachmentInput[]
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!existing) {
    throw new SkillError(404, "Installed skill not found")
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    const workspaceConversationTypeMask =
      await getWorkspaceCapabilityConversationTypeMask(
        existing.workspace_id,
        "installed_skill"
      )
    const nextInstanceConversationTypeMask =
      assertConversationTypeMaskWithinParent({
        parentConversationTypeMask: workspaceConversationTypeMask,
        conversationTypeMaskOverride: input.conversationTypeMaskOverride,
        buildError: (message) => new SkillError(400, message),
        invalidMaskMessage:
          "Installed skill conversation policy must allow at least one workspace conversation type.",
      })
    const accessRows = await listSkillAccessRows(input.installedSkillId)
    for (const accessRow of accessRows) {
      await validateConversationScopedAccessTarget({
        db,
        target: skillBindingToAccessTarget(accessRow, input.workspaceId),
        effectiveConversationTypeMask: nextInstanceConversationTypeMask,
        buildError: (message) => new SkillError(400, message),
      })
    }
  }

  const currentFilesMap = await loadSkillSnapshotFilesMap([
    existing.current_snapshot_id,
  ])
  const currentFiles = currentFilesMap.get(existing.current_snapshot_id) || []
  const touchesContent =
    input.name !== undefined ||
    input.description !== undefined ||
    input.attachmentFiles !== undefined

  await withDbTransaction(async (client) => {
    let nextVersion = existing.current_version
    let nextDisplayName = existing.display_name

    if (touchesContent) {
      nextVersion = existing.current_version + 1
      nextDisplayName = input.name?.trim() || existing.display_name

      const preparedSnapshot = buildPreparedSnapshotFromInput({
        fallbackName: existing.display_name,
        explicitName: nextDisplayName,
        explicitDescription: input.description,
        files: input.attachmentFiles
          ? normalizeSkillAttachments(input.attachmentFiles)
          : undefined,
        existingSnapshot: {
          frontmatter: frontmatterFromSnapshotRow(existing),
          bodyBlocks: bodyBlocksFromSnapshotRow(existing),
          files: currentFiles,
        },
      })
      const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)
      nextDisplayName = preparedSnapshot.frontmatter.name

      await client
        .insertInto("skillVersions")
        .values({
          skillId: existing.skill_id,
          version: nextVersion,
          skillSnapshotId: snapshotId,
          metadata: sql`${JSON.stringify(parseJsonObject(existing.version_metadata))}::jsonb`,
          createdByWorkspaceMemberId:
            existing.owner_workspace_member_id || null,
        })
        .execute()

      await client
        .updateTable("installedSkills")
        .set({
          iconFileId:
            input.iconFileId === undefined
              ? existing.icon_file_id
              : input.iconFileId
                ? await normalizeWorkspaceSkillIconFileId(
                    input.iconFileId,
                    input.workspaceId
                  )
                : null,
          tags: input.tags || existing.tags || [],
          currentVersion: nextVersion,
          currentSnapshotId: snapshotId,
          updatedAt: sql`NOW()`,
        })
        .where("id", "=", existing.skill_id)
        .execute()
      await updateWorkspaceAppRoot(client, {
        id: existing.skill_id,
        displayName: nextDisplayName,
        status:
          input.isEnabled === undefined
            ? existing.skill_status === "active"
              ? "active"
              : "disabled"
            : input.isEnabled
              ? "active"
              : "disabled",
      })

      if (existing.source_catalog_item_id) {
        await client
          .updateTable("skillSourceRefs")
          .set({
            isCustomized: true,
          })
          .where("skillId", "=", existing.skill_id)
          .execute()
      }

      return
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
                input.workspaceId
              )
            : null
      await client
        .updateTable("installedSkills")
        .set({
          iconFileId: nextIconFileId,
          tags: input.tags === undefined ? existing.tags || [] : input.tags,
          updatedAt: sql`NOW()`,
        })
        .where("id", "=", existing.skill_id)
        .execute()
      await updateWorkspaceAppRoot(client, {
        id: existing.skill_id,
        status:
          input.isEnabled === undefined
            ? existing.skill_status === "active"
              ? "active"
              : "disabled"
            : input.isEnabled
              ? "active"
              : "disabled",
        conversationTypeMaskOverride:
          input.conversationTypeMaskOverride === undefined
            ? existing.conversation_type_mask_override
            : input.conversationTypeMaskOverride,
      })
    }
  })

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId)
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string
  installedSkillId: string
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!existing) {
    throw new SkillError(404, "Installed skill not found")
  }
  if (!existing.source_catalog_item_id) {
    throw new SkillError(400, "Installed skill has no marketplace source")
  }

  const marketplaceSkill = await getMarketplaceRowById(
    existing.source_catalog_item_id
  )
  if (
    !marketplaceSkill ||
    !marketplaceSkill.latest_version_id ||
    !marketplaceSkill.snapshot_id
  ) {
    throw new SkillError(400, "Marketplace source has no latest version")
  }

  if (
    existing.source_catalog_version_id &&
    existing.source_catalog_version_id === marketplaceSkill.latest_version_id
  ) {
    return getInstalledSkillResponse(input.workspaceId, input.installedSkillId)
  }

  await withDbTransaction(async (client) => {
    await client
      .insertInto("skillVersions")
      .values({
        skillId: existing.skill_id,
        version: existing.current_version + 1,
        skillSnapshotId: marketplaceSkill.snapshot_id!,
        metadata: sql`${JSON.stringify(parseJsonObject(existing.version_metadata))}::jsonb`,
        createdByWorkspaceMemberId: existing.owner_workspace_member_id || null,
      })
      .execute()

    await client
      .updateTable("installedSkills")
      .set({
        iconFileId: marketplaceSkill.item_icon_file_id,
        tags: marketplaceSkill.item_tags || [],
        currentVersion: existing.current_version + 1,
        currentSnapshotId: marketplaceSkill.snapshot_id!,
      })
      .where("id", "=", existing.skill_id)
      .execute()
    await updateWorkspaceAppRoot(client, {
      id: existing.skill_id,
      displayName:
        marketplaceSkill.snapshot_display_name ||
        marketplaceSkill.item_display_name,
    })

    await client
      .updateTable("skillSourceRefs")
      .set({
        sourceCatalogVersionId: marketplaceSkill.latest_version_id,
        isCustomized: false,
      })
      .where("skillId", "=", existing.skill_id)
      .execute()
  })

  return getInstalledSkillResponse(input.workspaceId, input.installedSkillId)
}

export async function uninstallInstalledSkill(
  workspaceId: string,
  installedSkillId: string
) {
  const result = await withDbTransaction(async (client) => {
    const existing = await runOn<InstalledSkillRow>(
      client,
      `${INSTALLED_SKILL_SELECT}
       WHERE app.workspace_id = $1
         AND app.deleted_at IS NULL
         AND skill.id = $2
       LIMIT 1`,
      [workspaceId, installedSkillId]
    )
    const skill = existing.rows[0]
    if (!skill) {
      return {
        deleted: false,
      }
    }

    // Root lifecycle lives on workspace_apps. The detail row stays until purge.
    await updateWorkspaceAppRoot(client, {
      id: installedSkillId,
      status: "archived",
      deletedAt: new Date(),
    })

    await revokeWorkspaceAppGrantsForApp(client, installedSkillId)

    return {
      deleted: true,
    }
  })

  return result.deleted
}

async function buildVisibilitySubjects(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  return buildConversationCapabilitySubjects(db, {
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
}

function visibleRowToAccessRow(
  row: VisibleSkillRow,
  workspaceId: string
): SkillAccessRow {
  return {
    id: row.access_binding_id,
    workspace_id: workspaceId,
    conversation_type_mask_override: null,
    status: "active",
    source: "manual",
    created_by_workspace_member_id: null,
    reason: null,
    created_at: row.access_created_at,
    revoked_at: null,
    skill_id: row.skill_id,
    bind_scope: row.access_bind_scope,
    actor_id: row.actor_id,
    conversation_id: row.conversation_id,
    remote_agent_id: row.remote_agent_id,
    workspace_member_id: row.workspace_member_id,
  }
}

export async function listVisibleSkills(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  sessionId?: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
}) {
  const subjects = await buildVisibilitySubjects(input)
  // PR-fix-round-4: compute the scope subject set for this conversation
  // context once and pass it through to every lookupResources call so
  // scoped grants (subject=actor + scope=conversation) show up in the
  // skill list. Without this scoped grants were silently filtered out by
  // listGrantedResourceIds's default "scope IS NULL only" branch.
  const runtimeScopeSubjectIds = await computeRuntimeScopeSubjectIds(db, {
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
  // P1 fix (post-D4): subject_ids the principal can claim, including the
  // conversation subject when an active participant. Without this,
  // `subject=conversation C` bindings on skills are written + UI-visible
  // but the evaluator never surfaces them to participants of C.
  const runtimeSubjectIds = await computeRuntimeSubjectIdsForVisibility(db, {
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
  const autoLoadedSkills = await listAutoLoadedSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    isImConversation: input.isImConversation,
  })
  if (subjects.length === 0) {
    return autoLoadedSkills
  }

  const visibleSkillIds = new Set<string>()
  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources(db, {
        resourceType: ACCESS_ACTIONS["installed_skill.use"].resourceType,
        permission: ACCESS_ACTIONS["installed_skill.use"].permission,
        subject,
        runtimeScopeSubjectIds,
        runtimeSubjectIds,
      })
    )
  )

  for (const ids of lookups) {
    for (const id of ids) {
      visibleSkillIds.add(id)
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
	                 app.workspace_id,
	                 app.display_name AS display_name,
	                 skill.current_version,
	                 version_row.id AS current_skill_version_id,
	                 snapshot.description,
	                 source_item.slug AS source_slug,
	                 imported_version.version AS source_version_value,
	                 app.conversation_type_mask_override,
	                 skill.id AS access_binding_id,
	                 'workspace'::varchar AS access_bind_scope,
                 NULL::uuid AS conversation_id,
                 NULL::uuid AS actor_id,
                 NULL::uuid AS remote_agent_id,
                 NULL::uuid AS workspace_member_id,
                 app.updated_at AS access_created_at
               FROM installed_skills skill
               JOIN workspace_apps_live app
                 ON app.id = skill.id
               JOIN skill_versions version_row
                 ON version_row.skill_id = skill.id
                AND version_row.version = skill.current_version
               JOIN skill_snapshots snapshot
                 ON snapshot.id = skill.current_snapshot_id
		               LEFT JOIN skill_source_refs source_ref
		                 ON source_ref.skill_id = skill.id
		               LEFT JOIN catalog_items_live source_item
		                 ON source_item.id = source_ref.source_catalog_item_id
		               LEFT JOIN catalog_versions imported_version
		                 ON imported_version.id = source_ref.source_catalog_version_id
		               WHERE skill.id = ANY($1::uuid[])
		                 AND app.deleted_at IS NULL
		                 AND app.status = 'active'
		               ORDER BY app.display_name ASC, app.updated_at DESC`,
              [Array.from(visibleSkillIds)]
            ),
            loadAccessBindingsBySkillIdsForContext(
              Array.from(visibleSkillIds),
              {
                contextWorkspaceId: input.workspaceId,
                workspaceMemberId: input.workspaceMemberId,
                actorId: input.actorId,
                remoteAgentId: input.remoteAgentId,
                conversationId: input.conversationId,
              }
            ),
          ])
          const workspacePolicyMap =
            await getWorkspaceCapabilityConversationTypePolicyMap(
              rows.rows.map((row) => row.workspace_id)
            )
          // type-key is loop-invariant (a property of the conversation, not the
          // skill binding), so resolve it once and use the pure key check below.
          const conversationTypeKey = resolveConversationTypeKey(
            input.conversationKind,
            input.isImConversation ?? false
          )

          const deduped = new Map<string, VisibleSkillRow>()
          for (const row of rows.rows) {
            const workspaceConversationTypeMask =
              workspacePolicyMap.get(row.workspace_id)?.installed_skill ||
              DEFAULT_CONVERSATION_TYPE_MASK
            const instanceConversationTypeMask =
              resolveInstalledSkillEffectiveConversationTypeMask({
                workspaceConversationTypeMask,
                conversation_type_mask_override:
                  row.conversation_type_mask_override,
              })
            const bindings = (bindingsBySkillId.get(row.skill_id) || []).filter(
              (binding) =>
                maskAllowsConversationTypeKey(
                  resolveNarrowedConversationTypeMask(
                    instanceConversationTypeMask,
                    binding.conversation_type_mask_override
                  ),
                  conversationTypeKey
                )
            )
            if (bindings.length === 0) {
              continue
            }
            const chosenBinding = [...bindings].sort(
              compareVisibleBindingPriority
            )[0]
            const candidate: VisibleSkillRow = {
              ...row,
              access_binding_id: chosenBinding?.id || row.access_binding_id,
              access_bind_scope: chosenBinding?.bind_scope || "workspace",
              conversation_id: chosenBinding?.conversation_id || null,
              actor_id: chosenBinding?.actor_id || null,
              remote_agent_id: chosenBinding?.remote_agent_id || null,
              workspace_member_id: chosenBinding?.workspace_member_id || null,
              access_created_at:
                chosenBinding?.created_at || row.access_created_at,
            }
            const existing = deduped.get(row.skill_id)
            if (!existing) {
              deduped.set(row.skill_id, candidate)
              continue
            }
            if (
              compareVisibleBindingPriority(
                visibleRowToAccessRow(candidate, input.workspaceId),
                visibleRowToAccessRow(existing, input.workspaceId)
              ) < 0
            ) {
              deduped.set(row.skill_id, candidate)
            }
          }

          return Array.from(deduped.values()).map(buildAvailableSkillPayload)
        })()

  const combined = new Map<string, AvailableSkillSummary>()
  for (const skill of installedSkills) {
    combined.set(skill.instanceId, skill)
  }
  for (const skill of autoLoadedSkills) {
    if (!combined.has(skill.instanceId)) {
      combined.set(skill.instanceId, skill)
    }
  }

  return Array.from(combined.values()).sort(compareAvailableSkillDiscoveryOrder)
}

export async function readVisibleSkill(input: {
  workspaceId: string
  actorId?: string
  remoteAgentId?: string
  sessionId?: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  skillInstanceId: string
  assetPath?: string
}) {
  const visibleSkills = await listVisibleSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    isImConversation: input.isImConversation,
  })

  const skillInstanceId = input.skillInstanceId.trim()
  const match = visibleSkills.find(
    (skill) => skill.instanceId === skillInstanceId
  )

  if (!match) {
    throw new SkillError(
      404,
      `Visible skill instance "${input.skillInstanceId}" not found`
    )
  }

  const installedSkill = await loadInstalledSkillById(match.instanceId)
  if (!installedSkill) {
    throw new SkillError(
      404,
      `Visible skill instance "${input.skillInstanceId}" not found`
    )
  }

  if (!input.assetPath) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    })
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    }
  }

  const targetPath = normalizePath(input.assetPath)
  if (targetPath === SKILL_ENTRY_PATH) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    })
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    }
  }

  const result = await runBuilder(
    db,
    db
      .selectFrom("skillSnapshotFiles")
      .select(["path", "contentBlocks"])
      .where("skillSnapshotId", "=", installedSkill.current_snapshot_id)
      .where("path", "=", targetPath)
      .limit(1)
  )

  const asset = result.rows[0]
  if (!asset) {
    throw new SkillError(404, `Skill attachment "${targetPath}" not found`)
  }

  const contentBlocks = normalizeStoredBlocks(asset.contentBlocks)
  return {
    skill: match,
    asset: {
      path: asset.path,
      textContent: renderSkillBlocksToText(contentBlocks),
      contentBlocks,
    },
  }
}
