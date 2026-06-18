import type pg from "pg"
import { ACCESS_ACTIONS } from "../access/actions.js"
import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  type CanonicalContentBlock,
  type RuntimeBindingScope,
  type SkillFrontmatter,
} from "@synapse/shared"
import crypto from "node:crypto"
import { SKILL_ENTRY_PATH, renderCanonicalBlocksToText } from "./manifest.js"
import type { PreparedSkillSnapshot } from "./mirror-import.js"
import { lookupResources } from "../access/evaluator.js"
import { revokeWorkspaceAppGrant } from "../workspace-apps/grant-storage.js"
import {
  buildConversationCapabilitySubjects,
  computeRuntimeScopeSubjectIds,
  computeRuntimeSubjectIdsForVisibility,
} from "../access/subject-resolution.js"
import { validateConversationScopedAccessTarget } from "../access/policy.js"
import type {
  InstallationSummary,
  InstalledSkillRow,
  SkillAccessRow,
  SkillPackageRow,
  SkillSnapshotJoinRow,
  SkillSnapshotFileRow,
  VisibleSkillRow,
} from "./repo.types.js"

/**
 * Skills repo layer: owns ALL DB-client access for the skills module (guard
 * rule r8). The service imports these helpers and threads the transaction
 * client through the write/read fns so multi-statement transactions stay
 * atomic. This file is a "repo" file (basename starts with `repo`): it may
 * import db / withDbTransaction / runBuilder / sql / CompiledQuery; non-repo
 * files in this module must not.
 *
 * The Kysely instance carries CamelCasePlugin, whose transformResult
 * camelCases the TOP-LEVEL keys of EVERY result row. Every raw query here
 * projects quoted camelCase aliases (e.g. `AS "snapshotDisplayName"`), so the
 * plugin's transform is a no-op and the rows already match this module's
 * camelCase row types — no key inversion ("re-snake") needed. JSONB values stay
 * untouched. Repo fns return camelCase domain records and KEEP Date objects.
 * Service-facing JSONB fields that participate in business decisions are
 * decoded through repo helpers below.
 */

/** Re-export so the service can open transactions without importing the client. */
export { withDbTransaction as withSkillsTransaction }
export { runBuilder }
export type { Executor }

const DEFAULT_MARKETPLACE_PUBLISHER_SLUG = "synapse-official"
const DEFAULT_MARKETPLACE_PUBLISHER_NAME = "Synapse Official"

type QueryRow = pg.QueryResultRow
type QueryResultLike<T extends QueryRow> = { rows: T[] }
export type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResultLike<T>>

/** Build a {@link QueryRunner} backed by an {@link Executor} (db/trx). */
function runnerFn(executor: Executor): QueryRunner {
  return <T extends QueryRow>(text: string, params?: unknown[]) =>
    executor
      .executeQuery<T>(CompiledQuery.raw(text, params ? [...params] : []))
      .then((r) => ({
        // The Kysely instance carries CamelCasePlugin, whose transformResult
        // camelCases the TOP-LEVEL keys of EVERY result row. Every raw query in
        // this module now projects quoted camelCase aliases (e.g.
        // `AS "snapshotDisplayName"`), so the plugin's transform is a no-op and
        // the rows already match this module's camelCase row types — no key
        // inversion ("re-snake") needed. JSONB values stay untouched.
        rows: r.rows as T[],
      })) as Promise<QueryResultLike<T>>
}

/** Run raw SQL on an explicit executor (db / trx). */
export function runOn<T extends QueryRow = QueryRow>(
  executor: Executor,
  text: string,
  params?: unknown[]
): Promise<QueryResultLike<T>> {
  return runnerFn(executor)<T>(text, params)
}

/** Run raw SQL on the top-level db. */
export function runOnDb<T extends QueryRow = QueryRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResultLike<T>> {
  return runnerFn(db)<T>(text, params)
}

export const runQuery: QueryRunner = runnerFn(db)

export function clientRunner(client: Executor): QueryRunner {
  return async <T extends QueryRow>(text: string, params?: unknown[]) =>
    runOn<T>(client, text, params)
}

export function decodeSkillSnapshotHooks(row: {
  snapshotHooks: unknown
}): Record<string, unknown> {
  return parseSkillJsonRecord(row.snapshotHooks, "skill snapshot hooks")
}

export function decodeSkillMirrorLocator(row: {
  mirrorLocator: unknown
}): Record<string, unknown> {
  return parseSkillJsonRecord(row.mirrorLocator, "skill mirror locator")
}

export function decodeSkillPackageItemMetadata(
  row: { itemMetadata?: unknown } | null | undefined
): Record<string, unknown> {
  return parseSkillJsonRecord(row?.itemMetadata, "skill package item metadata")
}

export function decodeInstalledSkillVersionMetadata(row: {
  versionMetadata: unknown
}): Record<string, unknown> {
  return parseSkillJsonRecord(
    row.versionMetadata,
    "installed skill version metadata"
  )
}

function parseSkillJsonRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  const parsed =
    typeof value === "string" ? parseSkillJson(value, label) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseSkillJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

export function normalizeSkillSnapshotJoinRow<T extends SkillSnapshotJoinRow>(
  row: T
): T {
  const normalized = {
    ...row,
    snapshotHooks: decodeSkillSnapshotHooks(row),
    mirrorLocator: decodeSkillMirrorLocator(row),
  }
  return normalized
}

export function normalizeSkillPackageRow(
  row: SkillPackageRow
): SkillPackageRow {
  const normalized = {
    ...normalizeSkillSnapshotJoinRow(row),
    itemMetadata: decodeSkillPackageItemMetadata(row),
  }
  return normalized
}

export function normalizeInstalledSkillRow(
  row: InstalledSkillRow
): InstalledSkillRow {
  const normalized = {
    ...normalizeSkillSnapshotJoinRow(row),
    versionMetadata: decodeInstalledSkillVersionMetadata(row),
  }
  return normalized
}

const SKILL_SNAPSHOT_SELECT = `
    snapshot.id AS "snapshotId",
    snapshot.entry_path AS "snapshotEntryPath",
    snapshot.name AS "snapshotDisplayName",
    snapshot.description AS "snapshotDescription",
    snapshot.argument_hint AS "snapshotArgumentHint",
    snapshot.disable_model_invocation AS "snapshotDisableModelInvocation",
    snapshot.user_invocable AS "snapshotUserInvocable",
    snapshot.allowed_tools AS "snapshotAllowedTools",
    snapshot.model AS "snapshotModel",
    snapshot.effort AS "snapshotEffort",
    snapshot.context AS "snapshotContext",
    snapshot.agent AS "snapshotAgent",
    snapshot.hooks AS "snapshotHooks",
    snapshot.body_blocks AS "snapshotBodyBlocks",
    snapshot.content_hash AS "snapshotContentHash",
    snapshot.source_warnings AS "snapshotSourceWarnings",
    snapshot.resolved_revision AS "snapshotResolvedRevision",
    snapshot.created_at AS "snapshotCreatedAt",
    mirror.id AS "mirrorSourceId",
    mirror.source_type AS "mirrorSourceType",
    mirror.locator_key AS "mirrorLocatorKey",
    mirror.locator AS "mirrorLocator",
    mirror.requested_ref AS "mirrorRequestedRef",
    mirror.resolved_revision AS "mirrorResolvedRevision",
    mirror.refresh_mode AS "mirrorRefreshMode",
    mirror.last_sync_status AS "mirrorLastSyncStatus",
    mirror.source_warnings AS "mirrorSourceWarnings",
    mirror.last_error AS "mirrorLastError",
    mirror.last_synced_at AS "mirrorLastSyncedAt",
    mirror.created_at AS "mirrorCreatedAt",
    mirror.updated_at AS "mirrorUpdatedAt"
`

const MARKETPLACE_SKILL_SELECT = `
  SELECT
    item.id AS "itemId",
    item.slug AS "itemSlug",
    item.display_name AS "itemDisplayName",
    item.summary AS "itemSummary",
    item.long_description AS "itemLongDescription",
    item.tags AS "itemTags",
    item.is_active AS "itemIsActive",
    item.download_count AS "itemDownloadCount",
    item.icon_file_id AS "itemIconFileId",
    item.metadata AS "itemMetadata",
    item.created_at AS "itemCreatedAt",
    item.updated_at AS "itemUpdatedAt",
    version.id AS "latestVersionId",
    version.version AS "latestVersionValue",
    version.changelog AS "latestVersionChangelog",
    version.created_by_user_id AS "latestVersionCreatedByUserId",
    version.created_at AS "latestVersionCreatedAt",
    spec.default_conversation_type_mask AS "specDefaultConversationTypeMask",
${SKILL_SNAPSHOT_SELECT},
    publisher.id AS "publisherId",
    publisher.slug AS "publisherSlug",
    publisher.display_name AS "publisherDisplayName",
    publisher.owner_user_id AS "publisherOwnerUserId"
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

export const INSTALLED_SKILL_SELECT = `
  SELECT
    skill.id AS "skillId",
    app.workspace_id AS "workspaceId",
    app.display_name AS "displayName",
    skill.icon_file_id AS "iconFileId",
    skill.tags AS "tags",
    skill.current_version AS "currentVersion",
    skill.current_snapshot_id AS "currentSnapshotId",
    app.status AS "skillStatus",
    app.conversation_type_mask_override AS "conversationTypeMaskOverride",
    app.owner_workspace_member_id AS "ownerWorkspaceMemberId",
    app.created_at AS "createdAt",
    app.updated_at AS "updatedAt",
    version_row.id AS "currentSkillVersionId",
    version_row.skill_snapshot_id AS "currentSkillSnapshotId",
    version_row.metadata AS "versionMetadata",
    source_ref.source_catalog_item_id AS "sourceCatalogItemId",
    source_ref.source_catalog_version_id AS "sourceCatalogVersionId",
    source_ref.sync_mode AS "sourceSyncMode",
    source_ref.is_customized AS "sourceIsCustomized",
    source_item.slug AS "sourceSlug",
    source_item.latest_version_id AS "sourceLatestVersionId",
    imported_version.version AS "sourceVersionValue",
    latest_version.version AS "latestSourceVersion",
    imported_spec.default_conversation_type_mask AS "sourceDefaultConversationTypeMask",
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

export async function ensureMarketplacePublisher(
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

export async function allocateMarketplaceItemSlug(
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

export async function upsertSkillMirrorSource(
  executor: Executor,
  input: {
    sourceType: "github" | "clawhub"
    locatorKey: string
    locator: unknown
    requestedRef?: string | null
    resolvedRevision?: string | null
    sourceWarnings: string[]
  }
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

function renderSkillBlocksToText(blocks: CanonicalContentBlock[]) {
  return renderCanonicalBlocksToText(blocks)
    .split("\n")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n")
}

function snapshotFileSize(blocks: CanonicalContentBlock[]) {
  const fileRefSize = blocks.find((block) => block.type === "file_ref")
  if (fileRefSize && fileRefSize.type === "file_ref") {
    return fileRefSize.sizeBytes
  }
  return Buffer.byteLength(renderSkillBlocksToText(blocks), "utf8")
}

export async function insertSkillSnapshot(
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

export async function insertInstalledSkillRecord(
  executor: Executor,
  input: {
    id: string
    iconFileId: string | null
    tags: string[]
    currentVersion: number
    currentSnapshotId: string
  }
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("installedSkills")
      .values({
        id: input.id,
        iconFileId: input.iconFileId,
        tags: input.tags,
        currentVersion: input.currentVersion,
        currentSnapshotId: input.currentSnapshotId,
      })
      .returning("id")
  )

  return result.rows[0]!.id
}

export async function insertSkillVersionRecord(
  executor: Executor,
  input: {
    skillId: string
    version: number
    skillSnapshotId: string
    metadata: Record<string, unknown>
    createdByWorkspaceMemberId?: string | null
  }
) {
  await executor
    .insertInto("skillVersions")
    .values({
      skillId: input.skillId,
      version: input.version,
      skillSnapshotId: input.skillSnapshotId,
      metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
    })
    .execute()
}

export async function updateInstalledSkillContentState(
  executor: Executor,
  input: {
    skillId: string
    iconFileId: string | null
    tags: string[]
    currentVersion: number
    currentSnapshotId: string
  }
) {
  await executor
    .updateTable("installedSkills")
    .set({
      iconFileId: input.iconFileId,
      tags: input.tags,
      currentVersion: input.currentVersion,
      currentSnapshotId: input.currentSnapshotId,
      updatedAt: sql`NOW()`,
    })
    .where("id", "=", input.skillId)
    .execute()
}

export async function updateInstalledSkillProfileState(
  executor: Executor,
  input: {
    skillId: string
    iconFileId: string | null
    tags: string[]
  }
) {
  await executor
    .updateTable("installedSkills")
    .set({
      iconFileId: input.iconFileId,
      tags: input.tags,
      updatedAt: sql`NOW()`,
    })
    .where("id", "=", input.skillId)
    .execute()
}

export async function updateInstalledSkillMarketplaceState(
  executor: Executor,
  input: {
    skillId: string
    iconFileId: string | null
    tags: string[]
    currentVersion: number
    currentSnapshotId: string
  }
) {
  await executor
    .updateTable("installedSkills")
    .set({
      iconFileId: input.iconFileId,
      tags: input.tags,
      currentVersion: input.currentVersion,
      currentSnapshotId: input.currentSnapshotId,
    })
    .where("id", "=", input.skillId)
    .execute()
}

export async function insertSkillSourceRefRecord(
  executor: Executor,
  input: {
    skillId: string
    sourceCatalogItemId: string
    sourceCatalogVersionId: string | null
    syncMode: "notify" | "manual_merge" | "follow_upstream" | "detached"
    isCustomized: boolean
  }
) {
  await executor
    .insertInto("skillSourceRefs")
    .values({
      skillId: input.skillId,
      sourceCatalogItemId: input.sourceCatalogItemId,
      sourceCatalogVersionId: input.sourceCatalogVersionId,
      syncMode: input.syncMode,
      isCustomized: input.isCustomized,
    })
    .execute()
}

export async function incrementSkillCatalogDownloadCount(
  executor: Executor,
  catalogItemId: string
) {
  await executor
    .updateTable("catalogItems")
    .set({
      downloadCount: sql`${sql.ref("downloadCount")} + 1`,
    })
    .where("id", "=", catalogItemId)
    .execute()
}

export async function markSkillSourceRefCustomized(
  executor: Executor,
  skillId: string
) {
  await executor
    .updateTable("skillSourceRefs")
    .set({
      isCustomized: true,
    })
    .where("skillId", "=", skillId)
    .execute()
}

export async function updateSkillSourceRefVersion(
  executor: Executor,
  input: {
    skillId: string
    sourceCatalogVersionId: string
    isCustomized: boolean
  }
) {
  await executor
    .updateTable("skillSourceRefs")
    .set({
      sourceCatalogVersionId: input.sourceCatalogVersionId,
      isCustomized: input.isCustomized,
    })
    .where("skillId", "=", input.skillId)
    .execute()
}

export async function loadSkillSnapshotFilesMap(snapshotIds: string[]) {
  if (snapshotIds.length === 0) {
    return new Map<string, SkillSnapshotFileRow[]>()
  }

  const result = await runQuery<SkillSnapshotFileRow>(
    `SELECT
       id,
       skill_snapshot_id AS "skillSnapshotId",
       path,
       media_type AS "mediaType",
       content_blocks AS "contentBlocks",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM skill_snapshot_files
     WHERE skill_snapshot_id = ANY($1::uuid[])
     ORDER BY path ASC`,
    [snapshotIds]
  )

  const filesBySnapshotId = new Map<string, SkillSnapshotFileRow[]>()
  for (const row of result.rows) {
    const files = filesBySnapshotId.get(row.skillSnapshotId) || []
    files.push(row)
    filesBySnapshotId.set(row.skillSnapshotId, files)
  }

  return filesBySnapshotId
}

export async function buildMarketplaceInstallationMap(workspaceId: string) {
  const result = await runQuery<{
    sourceCatalogItemId: string
    skillId: string
    installedCount: string
  }>(
    `SELECT DISTINCT ON (source_ref.source_catalog_item_id)
       source_ref.source_catalog_item_id AS "sourceCatalogItemId",
       source_ref.skill_id AS "skillId",
       COUNT(*) OVER (PARTITION BY source_ref.source_catalog_item_id) AS "installedCount"
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
    map.set(row.sourceCatalogItemId, {
      installed: true,
      installedCount: Number(row.installedCount || 0),
      installedSkillId: row.skillId,
    })
  }
  return map
}

export async function getMarketplaceRowById(
  skillId: string,
  run: QueryRunner = runQuery
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.id = $1
     LIMIT 1`,
    [skillId]
  )

  const row = result.rows[0]
  return row ? normalizeSkillPackageRow(row) : null
}

export async function getMarketplaceRowBySlug(
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

  const row = result.rows[0]
  return row ? normalizeSkillPackageRow(row) : null
}

export async function getMarketplaceRowByMirrorSourceId(
  mirrorSourceId: string,
  run: QueryRunner = runQuery
) {
  const result = await run<SkillPackageRow>(
    `${MARKETPLACE_SKILL_SELECT}
      AND item.mirror_source_id = $1
     LIMIT 1`,
    [mirrorSourceId]
  )

  const row = result.rows[0]
  return row ? normalizeSkillPackageRow(row) : null
}

export async function updateMarketplaceCatalogItemSummary(
  executor: Executor,
  input: {
    itemId: string
    displayName: string
    summary: string
    longDescription: string
    tags: string[]
    metadata: unknown
  }
) {
  await executor
    .updateTable("catalogItems")
    .set({
      displayName: input.displayName,
      summary: input.summary,
      longDescription: input.longDescription,
      tags: input.tags,
      metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
    })
    .where("id", "=", input.itemId)
    .execute()
}

export async function updateMarketplaceCatalogItemRecord(
  executor: Executor,
  input: {
    itemId: string
    slug: string
    displayName: string
    summary: string
    longDescription: string
    mirrorSourceId: string | null
    sourceKind: "official"
    visibility: "public"
    tags: string[]
    isActive: boolean
    iconFileId?: string | null
    metadata: unknown
  }
) {
  await executor
    .updateTable("catalogItems")
    .set({
      slug: input.slug,
      displayName: input.displayName,
      summary: input.summary,
      longDescription: input.longDescription,
      mirrorSourceId: input.mirrorSourceId,
      sourceKind: input.sourceKind,
      visibility: input.visibility,
      tags: input.tags,
      isActive: input.isActive,
      iconFileId: input.iconFileId ?? null,
      metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
    })
    .where("id", "=", input.itemId)
    .execute()
}

export async function insertMarketplaceCatalogItemRecord(
  executor: Executor,
  input: {
    publisherId: string
    slug: string
    displayName: string
    summary: string
    longDescription: string
    mirrorSourceId: string | null
    sourceKind: "official"
    visibility: "public"
    tags: string[]
    isActive: boolean
    iconFileId?: string | null
    metadata: unknown
  }
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("catalogItems")
      .values({
        publisherId: input.publisherId,
        workspaceId: null,
        itemKind: "skill_package",
        slug: input.slug,
        displayName: input.displayName,
        summary: input.summary,
        longDescription: input.longDescription,
        mirrorSourceId: input.mirrorSourceId,
        sourceKind: input.sourceKind,
        visibility: input.visibility,
        tags: input.tags,
        isActive: input.isActive,
        iconFileId: input.iconFileId ?? null,
        metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
      })
      .returning("id")
  )

  return result.rows[0]!.id
}

export async function getCatalogVersionId(
  executor: Executor,
  input: {
    catalogItemId: string
    version: string
  }
) {
  const result = await runBuilder(
    executor,
    executor
      .selectFrom("catalogVersions")
      .select("id")
      .where("catalogItemId", "=", input.catalogItemId)
      .where("version", "=", input.version)
      .limit(1)
  )

  return result.rows[0]?.id ?? null
}

export async function insertCatalogVersionRecord(
  executor: Executor,
  input: {
    catalogItemId: string
    version: string
    changelog: string
    metadata: unknown
    createdByUserId?: string | null
  }
) {
  const result = await runBuilder(
    executor,
    executor
      .insertInto("catalogVersions")
      .values({
        catalogItemId: input.catalogItemId,
        version: input.version,
        status: "active",
        changelog: input.changelog,
        metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
        createdByUserId: input.createdByUserId || null,
      })
      .returning("id")
  )

  return result.rows[0]!.id
}

export async function updateCatalogVersionRecord(
  executor: Executor,
  input: {
    versionId: string
    changelog: string
    metadata: unknown
  }
) {
  await executor
    .updateTable("catalogVersions")
    .set({
      status: "active",
      changelog: input.changelog,
      metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
    })
    .where("id", "=", input.versionId)
    .execute()
}

export async function updateRepublishedCatalogVersionRecord(
  executor: Executor,
  input: {
    versionId: string
    changelog: string
    metadata: unknown
    createdByUserId?: string | null
  }
) {
  await executor
    .updateTable("catalogVersions")
    .set({
      status: "active",
      changelog: input.changelog,
      metadata: sql`${JSON.stringify(input.metadata)}::jsonb`,
      createdByUserId: sql`COALESCE(created_by_user_id, ${input.createdByUserId || null})`,
      createdAt: sql`created_at`,
    })
    .where("id", "=", input.versionId)
    .execute()
}

export async function upsertSkillPackageVersionSpecRecord(
  executor: Executor,
  input: {
    catalogVersionId: string
    skillSnapshotId: string
    defaultConversationTypeMask: number
  }
) {
  await executor
    .insertInto("skillPackageVersionSpecs")
    .values({
      catalogVersionId: input.catalogVersionId,
      skillSnapshotId: input.skillSnapshotId,
      defaultConversationTypeMask: input.defaultConversationTypeMask,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("catalogVersionId").doUpdateSet({
        skillSnapshotId: sql`excluded.skill_snapshot_id`,
        defaultConversationTypeMask: sql`excluded.default_conversation_type_mask`,
      })
    )
    .execute()
}

export async function updateCatalogItemLatestVersion(
  executor: Executor,
  input: {
    itemId: string
    versionId: string
  }
) {
  await executor
    .updateTable("catalogItems")
    .set({
      latestVersionId: input.versionId,
    })
    .where("id", "=", input.itemId)
    .execute()
}

export async function loadInstalledSkillRows(params: {
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

  return result.rows.map(normalizeInstalledSkillRow)
}

export async function getInstalledSkillRowForWorkspace(
  executor: Executor,
  params: { workspaceId: string; installedSkillId: string }
): Promise<InstalledSkillRow | null> {
  const result = await runOn<InstalledSkillRow>(
    executor,
    `${INSTALLED_SKILL_SELECT}
     WHERE app.workspace_id = $1
       AND app.deleted_at IS NULL
       AND skill.id = $2
     LIMIT 1`,
    [params.workspaceId, params.installedSkillId]
  )

  const row = result.rows[0]
  return row ? normalizeInstalledSkillRow(row) : null
}

export async function loadAccessBindingsBySkillIds(
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
      "app_grant.workspaceId as workspaceId",
      "app_grant.workspaceAppId as skillId",
      sql<RuntimeBindingScope>`
        CASE subj.kind
          WHEN 'workspace' THEN 'workspace'
          WHEN 'workspace_member' THEN 'workspace_member'
          WHEN 'conversation' THEN 'conversation'
          WHEN 'actor' THEN 'actor'
          WHEN 'remote_agent' THEN 'remote_agent'
        END
      `.as("bindScope"),
      "scope.conversationId as conversationId",
      "subj.actorId as actorId",
      "subj.remoteAgentId as remoteAgentId",
      "subj.workspaceMemberId as workspaceMemberId",
      "app_grant.conversationTypeMaskOverride as conversationTypeMaskOverride",
      "app_grant.status",
      "app_grant.source",
      "app_grant.createdByWorkspaceMemberId as createdByWorkspaceMemberId",
      "app_grant.reason",
      "app_grant.createdAt as createdAt",
      "app_grant.revokedAt as revokedAt",
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
    const normalizedBinding: SkillAccessRow = {
      ...row,
      createdAt: row.createdAt,
    }
    const existing = map.get(normalizedBinding.skillId) || []
    existing.push(normalizedBinding)
    map.set(row.skillId, existing)
  }
  return map
}

export async function findSkillIdsByBindingFilter(params: {
  workspaceId: string
  resolvedTarget: {
    subject:
      | { kind: "workspace" }
      | { kind: "workspace_member"; memberId: string }
      | { kind: "conversation"; conversationId: string }
      | { kind: "actor"; actorId: string }
      | { kind: "remote_agent"; remoteAgentId: string }
      | { kind: string }
    scope?:
      | { kind: "conversation"; conversationId: string }
      | { kind: string }
      | null
  } | null
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  const target = params.resolvedTarget
  let query = db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select("app_grant.workspaceAppId as skillId")
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
          .where(
            "subj.workspaceMemberId",
            "=",
            (target.subject as { memberId: string }).memberId
          )
        break
      case "conversation":
        query = query
          .where("subj.kind", "=", "conversation")
          .where(
            "subj.conversationId",
            "=",
            (target.subject as { conversationId: string }).conversationId
          )
        break
      case "actor":
        query = query
          .where("subj.kind", "=", "actor")
          .where(
            "subj.actorId",
            "=",
            (target.subject as { actorId: string }).actorId
          )
        break
      case "remote_agent":
        query = query
          .where("subj.kind", "=", "remote_agent")
          .where(
            "subj.remoteAgentId",
            "=",
            (target.subject as { remoteAgentId: string }).remoteAgentId
          )
        break
      default:
        return []
    }

    if (target.scope?.kind === "conversation") {
      query = query.where(
        "scope.conversationId",
        "=",
        (target.scope as { conversationId: string }).conversationId
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
    if (params.remoteAgentId) {
      query = query.where("subj.remoteAgentId", "=", params.remoteAgentId)
    }
    if (params.conversationId) {
      query = query.where(
        sql<boolean>`COALESCE(scope.conversation_id, subj.conversation_id) = ${params.conversationId}`
      )
    }
  }

  const rows = await query.execute()
  return rows
    .map((row) => row.skillId)
    .filter((skillId): skillId is string => Boolean(skillId))
}

export async function listMarketplaceRows(filters?: {
  search?: string
  tags?: string[]
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

  return result.rows.map(normalizeSkillPackageRow)
}

export async function loadVisibleSkillRows(skillIds: string[]) {
  const result = await runQuery<VisibleSkillRow>(
    `SELECT
       skill.id AS "skillId",
       app.workspace_id AS "workspaceId",
       app.display_name AS "displayName",
       skill.current_version AS "currentVersion",
       version_row.id AS "currentSkillVersionId",
       snapshot.description AS "description",
       source_item.slug AS "sourceSlug",
       imported_version.version AS "sourceVersionValue",
       app.conversation_type_mask_override AS "conversationTypeMaskOverride",
       skill.id AS "accessBindingId",
       'workspace'::varchar AS "accessBindScope",
       NULL::uuid AS "conversationId",
       NULL::uuid AS "actorId",
       NULL::uuid AS "remoteAgentId",
       NULL::uuid AS "workspaceMemberId",
       app.updated_at AS "accessCreatedAt"
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
    [skillIds]
  )
  return result.rows
}

export async function loadSkillSnapshotFileByPath(
  snapshotId: string,
  path: string
) {
  const result = await runBuilder(
    db,
    db
      .selectFrom("skillSnapshotFiles")
      .select(["path", "contentBlocks"])
      .where("skillSnapshotId", "=", snapshotId)
      .where("path", "=", path)
      .limit(1)
  )

  return result.rows[0] || null
}

export async function updateInstalledSkillGrantConversationTypeMaskOverride(
  grantId: string,
  workspaceId: string,
  conversationTypeMaskOverride: number | null
) {
  await db
    .updateTable("workspaceAppGrants")
    .set({
      conversationTypeMaskOverride,
    } as any)
    .where("id", "=", grantId)
    .where("workspaceId", "=", workspaceId)
    .execute()
}

/** Default-bound revoke so the service revokes without importing the client. */
export function revokeWorkspaceAppGrantDefault(grantId: string) {
  return revokeWorkspaceAppGrant(db, grantId)
}

/**
 * Default-bound wrappers for the cross-module injectable helpers that take the
 * production `db` executor. The service is a non-repo file and may not import
 * `db`; it calls these wrappers so the repo supplies `db`.
 */
export function validateConversationScopedAccessTargetDefault(input: {
  target: Parameters<typeof validateConversationScopedAccessTarget>[0]["target"]
  effectiveConversationTypeMask: number
  buildError: (message: string) => Error
}) {
  return validateConversationScopedAccessTarget({
    db,
    target: input.target,
    effectiveConversationTypeMask: input.effectiveConversationTypeMask,
    buildError: input.buildError,
  })
}

export function buildConversationCapabilitySubjectsDefault(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  return buildConversationCapabilitySubjects(db, input)
}

export function computeRuntimeScopeSubjectIdsDefault(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  return computeRuntimeScopeSubjectIds(db, input)
}

export function computeRuntimeSubjectIdsForVisibilityDefault(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  return computeRuntimeSubjectIdsForVisibility(db, input)
}

export function lookupSkillResourcesDefault(input: {
  subject: Parameters<typeof lookupResources>[1]["subject"]
  runtimeScopeSubjectIds: Parameters<
    typeof lookupResources
  >[1]["runtimeScopeSubjectIds"]
  runtimeSubjectIds: Parameters<typeof lookupResources>[1]["runtimeSubjectIds"]
}) {
  return lookupResources(db, {
    resourceType: ACCESS_ACTIONS["installed_skill.use"].resourceType,
    permission: ACCESS_ACTIONS["installed_skill.use"].permission,
    subject: input.subject,
    runtimeScopeSubjectIds: input.runtimeScopeSubjectIds,
    runtimeSubjectIds: input.runtimeSubjectIds,
  })
}

/** Re-export so the service can build snapshots consistently. */
export { DEFAULT_CONVERSATION_TYPE_MASK }
