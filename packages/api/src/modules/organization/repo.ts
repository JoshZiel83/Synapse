// organization/repo.ts — DB-touching helpers for the organization (actor) module.
//
// The only organization file permitted to import the db client / transaction
// runner (guard r8). Owns all raw SQL for actors, actor versions, actor docs,
// actor source refs, and the actor-template catalog reads. The service keeps the
// business logic (version-delta diffing, avatar mutual-exclusion, doc
// normalization, response assembly) and calls into these repo functions.
//
// TRANSACTION ATOMICITY: the four write flows (create / update / delete /
// install) each wrap multiple INSERT/UPDATE statements together with the
// cross-module workspace-resources storage calls (insertWorkspaceResourceRoot,
// insertWorkspaceResourceGrant, updateWorkspaceResourceRoot) in a single
// withDbTransaction. Those whole transactions live here as *Tx functions so the
// db client never leaks into the service; the service passes in already-computed
// inputs (deltas, normalized docs, etc.).
//
// Rows are returned raw (camelCase keys, Date objects preserved). Raw SQL via
// CompiledQuery.raw bypasses CamelCasePlugin's *query* transform, but Kysely
// still runs its *result* transform unconditionally, so top-level result keys
// arrive camelCase (convention A). Renamed/computed columns are aliased to
// double-quoted camelCase identifiers so they round-trip; plain physical
// columns map cleanly on their own. The presenter owns serializeInstant
// (Date→IsoInstantString); this file never serializes Dates. round-6 P1-6.

import type pg from "pg"
import { CompiledQuery } from "kysely"
import {
  normalizeCanonicalContentBlocks,
  type ActorDoc,
  type ActorRole,
  type ActorUpdateSourceType,
  type ActorVersionDelta,
  type CanonicalContentBlockInput,
  type CapabilityAccessTarget,
  type UUID,
  type WorkspaceResourceGrantPermission,
} from "@synapse/shared"
import {
  ActorVersionDeltaSchema,
  CanonicalContentBlockSchema,
} from "@synapse/shared/schemas"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  insertWorkspaceResourceRoot,
  updateWorkspaceResourceRoot,
} from "../workspace-resources/repo.js"
import { insertWorkspaceResourceGrant } from "../workspace-resources/grant-storage.js"
import { listAuthorizedResourceIdsDefault } from "../access/guards.js"
import type { AccessSubject } from "../access/service.js"
import type {
  ActorPackageRow,
  ActorRow,
  ActorVersionRow,
} from "./repo.types.js"

type QueryRow = pg.QueryResultRow
type QueryResultLike<T extends QueryRow> = { rows: T[] }
export type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResultLike<T>>

type ActorDocRow = {
  id: string
  actorVersionId: string
  docKey: ActorDoc["key"]
  title: string
  visibility: ActorDoc["visibility"]
  priority: number
  contentBlocks: unknown
}

/** A normalized actor-doc input ready to be persisted as an actor_version_doc. */
export type ActorDocPersistInput = {
  key: ActorDoc["key"]
  title: string
  visibility: ActorDoc["visibility"]
  priority: number
  content: ActorDoc["content"]
}

const ACTOR_SELECT = `
  SELECT
    a.id,
    resource.workspace_id,
    resource.display_name,
    a.role,
    a.title,
    a.avatar_file_id,
    a.avatar_emoji,
    a.parent_id,
    a.can_represent_user,
    a.specialties,
    a.config,
    a.current_version,
    (resource.status = 'active') AS "isActive",
    a.is_public_shared,
    a.created_at,
    a.updated_at,
    current_version.id AS "currentActorVersionId",
    source_ref.source_catalog_item_id,
    source_ref.source_catalog_version_id,
    source_ref.sync_mode AS "sourceSyncMode",
    source_ref.baseline_actor_version AS "sourceBaselineActorVersion",
    source_ref.created_at AS "sourceCreatedAt",
    source_ref.updated_at AS "sourceUpdatedAt",
    source_item.slug AS "sourceSlug",
    source_item.display_name AS "sourceDisplayName",
    source_item.latest_version_id AS "sourceLatestVersionId",
    source_publisher.slug AS "sourcePublisherSlug",
    source_publisher.display_name AS "sourcePublisherDisplayName",
    imported_version.version AS "sourceImportedVersion",
    latest_version.version AS "sourceLatestVersion"
  FROM actors a
  JOIN workspace_resources_live resource
    ON resource.id = a.id
  JOIN actor_versions current_version
    ON current_version.actor_id = a.id
   AND current_version.version = a.current_version
  LEFT JOIN actor_source_refs source_ref
    ON source_ref.actor_id = a.id
  LEFT JOIN catalog_items source_item
    ON source_item.id = source_ref.source_catalog_item_id
  LEFT JOIN publishers source_publisher
    ON source_publisher.id = source_item.publisher_id
  LEFT JOIN catalog_versions imported_version
    ON imported_version.id = source_ref.source_catalog_version_id
  LEFT JOIN catalog_versions latest_version
    ON latest_version.id = source_item.latest_version_id
`

const ACTOR_PACKAGE_SELECT = `
  SELECT
    item.id AS "packageId",
    item.workspace_id AS "packageWorkspaceId",
    item.slug AS "packageSlug",
    item.display_name AS "packageDisplayName",
    item.icon_file_id AS "packageIconFileId",
    item.summary AS "packageSummary",
    item.long_description AS "packageLongDescription",
    item.source_kind AS "packageSourceKind",
    item.visibility AS "packageVisibility",
    item.tags AS "packageTags",
    item.download_count AS "packageDownloadCount",
    item.is_active AS "packageIsActive",
    item.metadata AS "packageMetadata",
    item.created_at AS "packageCreatedAt",
    item.updated_at AS "packageUpdatedAt",
    publisher.id AS "publisherId",
    publisher.slug AS "publisherSlug",
    publisher.display_name AS "publisherDisplayName",
    publisher.description AS "publisherDescription",
    publisher.owner_user_id AS "publisherOwnerUserId",
    publisher.workspace_id AS "publisherWorkspaceId",
    publisher.is_builtin AS "publisherIsBuiltin",
    publisher.is_verified AS "publisherIsVerified",
    publisher.created_at AS "publisherCreatedAt",
    publisher.updated_at AS "publisherUpdatedAt",
    version.id AS "versionId",
    version.version AS "versionValue",
    version.status AS "versionStatus",
    version.changelog AS "versionChangelog",
    version.metadata AS "versionMetadata",
    version.created_by_user_id AS "versionCreatedByUserId",
    version.created_at AS "versionCreatedAt",
    spec.role AS "actorRole",
    spec.display_name AS "actorDisplayName",
    spec.avatar_file_id AS "actorAvatarFileId",
    spec.avatar_emoji AS "actorAvatarEmoji",
    spec.title AS "actorTitle",
    spec.can_represent_user AS "actorCanRepresentUser",
    spec.docs AS "actorDocs",
    spec.specialties AS "actorSpecialties",
    spec.config AS "actorConfig",
    spec.metadata AS "actorMetadata"
  FROM catalog_items item
  JOIN publishers publisher ON publisher.id = item.publisher_id
  JOIN catalog_versions version ON version.id = item.latest_version_id
  JOIN actor_template_version_specs spec ON spec.catalog_version_id = version.id
  WHERE item.item_kind = 'actor_template'
    AND item.is_active = TRUE
`

export function parseActorDocContentBlocks(
  value: unknown
): CanonicalContentBlockInput[] {
  if (value === null || value === undefined) return []

  let candidate: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error("actor doc content_blocks must be a valid JSON array")
    }
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      throw new Error("actor doc content_blocks must be a valid JSON array")
    }
  }

  if (!Array.isArray(candidate)) {
    throw new Error("actor doc content_blocks must be a JSON array")
  }

  const parsed = CanonicalContentBlockSchema.array().safeParse(candidate)
  if (!parsed.success) {
    throw new Error(
      "actor doc content_blocks must contain canonical content blocks"
    )
  }

  return parsed.data
}

function parseActorVersionDelta(value: unknown): ActorVersionDelta | null {
  if (value === null || value === undefined) return null
  let candidate: unknown = value
  if (typeof value === "string") {
    if (!value.trim()) return null
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      return null
    }
  }
  const parsed = ActorVersionDeltaSchema.safeParse(candidate)
  return parsed.success ? (parsed.data as ActorVersionDelta) : null
}

function parseRepoJsonObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || value === undefined) return {}

  let candidate: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} must be valid JSON`)
    }
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${label} must be valid JSON`)
    }
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new Error(`${label} must be a JSON object`)
  }

  return candidate as Record<string, unknown>
}

export function normalizeActorRow<T extends ActorRow>(row: T): T {
  const normalized = {
    ...row,
    config: parseRepoJsonObject(row.config, "actor config"),
  }
  return normalized
}

export function normalizeActorVersionRow<T extends ActorVersionRow>(row: T): T {
  const normalized = {
    ...row,
    config: parseRepoJsonObject(row.config, "actor version config"),
    versionDelta: parseActorVersionDelta(row.versionDelta),
  }
  return normalized
}

export function normalizeActorPackageRow<T extends ActorPackageRow>(row: T): T {
  const normalized = {
    ...row,
    packageMetadata: parseRepoJsonObject(
      row.packageMetadata,
      "actor package metadata"
    ),
    versionMetadata: parseRepoJsonObject(
      row.versionMetadata,
      "actor package version metadata"
    ),
    actorConfig: parseRepoJsonObject(
      row.actorConfig,
      "actor package actor config"
    ),
    actorMetadata: parseRepoJsonObject(
      row.actorMetadata,
      "actor package actor metadata"
    ),
  }
  return normalized
}

/**
 * Adapt an {@link Executor} (the top-level `db` or a transaction) to the
 * `(text, params) => { rows }` runner convention used throughout this module.
 * Routes raw SQL through Kysely's `CompiledQuery.raw` so the same statement
 * runs on whichever executor (pool or trx) the caller holds.
 *
 * IMPORTANT: `CompiledQuery.raw` bypasses CamelCasePlugin's *query* transform
 * (input), but Kysely still runs every plugin's `transformResult` hook on the
 * *result* rows — and CamelCasePlugin.transformResult is unconditional, so it
 * camelCases the top-level keys of raw rows too. Every `*Row` type in this
 * module (and the presenter) is camelCase (convention A), so the plugin output
 * is exactly what callers are typed for — no re-keying needed. Renamed/computed
 * columns alias to double-quoted camelCase in the SELECT so they round-trip.
 */
function runnerFor(executor: Executor): QueryRunner {
  return async <T extends QueryRow>(text: string, params?: unknown[]) => {
    const result = await executor.executeQuery<QueryRow>(
      CompiledQuery.raw(text, params ? [...params] : [])
    )
    return {
      rows: result.rows as T[],
    } satisfies QueryResultLike<T>
  }
}

async function runQuery<T extends QueryRow>(text: string, params?: unknown[]) {
  return runnerFor(db)<T>(text, params)
}

/**
 * Look up the parent actor (within the workspace, not soft-deleted) and throw
 * if it is missing or if an actor is being made its own parent. The lookup is
 * DB work; it runs on whichever executor (trx) the caller threads in so the
 * guard participates in the surrounding write transaction.
 */
async function ensureParentActor(
  runner: QueryRunner,
  workspaceId: UUID,
  parentId: UUID | null | undefined,
  actorId?: UUID
) {
  if (!parentId) return
  if (actorId && parentId === actorId) {
    throw new Error("Actor cannot be its own parent")
  }

  const parent = await runner<{ id: string }>(
    `SELECT actor.id
     FROM actors actor
     INNER JOIN workspace_resources_live resource
       ON resource.id = actor.id
     WHERE actor.id = $1
       AND resource.workspace_id = $2
       AND resource.deleted_at IS NULL
     LIMIT 1`,
    [parentId, workspaceId]
  )

  if (parent.rows.length === 0) {
    throw new Error("Parent actor not found")
  }
}

/** Authorized actor ids for a subject + action, via the access engine. */
export async function listAuthorizedActorIds(
  subject: AccessSubject,
  action: Parameters<typeof listAuthorizedResourceIdsDefault>[0]["action"]
): Promise<UUID[]> {
  const ids = await listAuthorizedResourceIdsDefault({ subject, action })
  return ids as UUID[]
}

/**
 * Load all docs for the given actor-version ids, grouped by version id and
 * sorted by (priority DESC, title ASC) within each group. JSON content_blocks
 * stay raw on read; canonical normalization happens here (no Date handling).
 */
export async function loadActorDocsMap(
  actorVersionIds: string[],
  executor: Executor = db
): Promise<Map<string, ActorDoc[]>> {
  if (actorVersionIds.length === 0) {
    return new Map()
  }

  const runner = runnerFor(executor)
  const result = await runner<ActorDocRow>(
    `SELECT id, actor_version_id, doc_key, title, visibility, priority, content_blocks
     FROM actor_version_docs
     WHERE actor_version_id = ANY($1::uuid[])
     ORDER BY priority DESC, created_at ASC`,
    [actorVersionIds]
  )

  const docsByVersionId = new Map<string, ActorDoc[]>()
  for (const row of result.rows) {
    const docs = docsByVersionId.get(row.actorVersionId) || []
    docs.push({
      id: row.id,
      key: row.docKey,
      title: row.title,
      visibility: row.visibility,
      priority: row.priority,
      content: normalizeCanonicalContentBlocks(
        parseActorDocContentBlocks(row.contentBlocks)
      ),
    })
    docsByVersionId.set(row.actorVersionId, docs)
  }

  for (const [versionId, docs] of docsByVersionId.entries()) {
    docsByVersionId.set(
      versionId,
      [...docs].sort((left, right) => {
        if (right.priority !== left.priority)
          return right.priority - left.priority
        return left.title.localeCompare(right.title)
      })
    )
  }

  return docsByVersionId
}

/** Actor rows for a set of ids in a workspace (newest first, not deleted). */
export async function getActorRowsByIds(
  workspaceId: UUID,
  actorIds: UUID[],
  executor: Executor = db
): Promise<ActorRow[]> {
  if (actorIds.length === 0) return []

  const result = await runnerFor(executor)<ActorRow>(
    `${ACTOR_SELECT}
     WHERE resource.workspace_id = $1
       AND resource.deleted_at IS NULL
       AND a.id = ANY($2::uuid[])
     ORDER BY a.created_at DESC`,
    [workspaceId, actorIds]
  )

  return result.rows.map(normalizeActorRow)
}

/** A single actor row in a workspace (not deleted), or null. */
export async function getActorRow(
  workspaceId: UUID,
  actorId: UUID,
  executor: Executor = db
): Promise<ActorRow | null> {
  const result = await runnerFor(executor)<ActorRow>(
    `${ACTOR_SELECT}
     WHERE resource.workspace_id = $1
       AND resource.deleted_at IS NULL
       AND a.id = $2
     LIMIT 1`,
    [workspaceId, actorId]
  )
  return result.rows[0] ? normalizeActorRow(result.rows[0]) : null
}

/** True when the actor exists in the workspace and is not soft-deleted. */
export async function actorExists(
  workspaceId: UUID,
  actorId: UUID,
  executor: Executor = db
): Promise<boolean> {
  const result = await runnerFor(executor)<{ id: string }>(
    `SELECT actor.id
     FROM actors actor
     INNER JOIN workspace_resources_live resource
       ON resource.id = actor.id
     WHERE actor.id = $1
       AND resource.workspace_id = $2
       AND resource.deleted_at IS NULL
     LIMIT 1`,
    [actorId, workspaceId]
  )
  return result.rows.length > 0
}

/** All version rows for an actor (newest version first). */
export async function listActorVersionRows(
  actorId: UUID,
  executor: Executor = db
): Promise<ActorVersionRow[]> {
  const result = await runnerFor(executor)<ActorVersionRow>(
    `SELECT
        id,
        actor_id,
        version,
        previous_version_id,
        display_name,
        role,
        title,
        parent_id,
        can_represent_user,
        specialties,
        config,
        version_delta,
        created_by_workspace_member_id,
        source_type,
        source_workspace_member_id,
        source_actor_id,
        source_session_id,
        source_turn_id,
        source_conversation_id,
        source_reason,
        created_at
     FROM actor_versions
     WHERE actor_id = $1
     ORDER BY version DESC`,
    [actorId]
  )
  return result.rows.map(normalizeActorVersionRow)
}

/** Actor-template catalog rows visible to a workspace, optionally filtered. */
export async function listActorPackageRows(
  params: { workspaceId: UUID; search?: string },
  executor: Executor = db
): Promise<ActorPackageRow[]> {
  const values: unknown[] = [params.workspaceId]
  const searchSql = params.search?.trim()
    ? `AND (
         item.display_name ILIKE $2
         OR item.slug ILIKE $2
         OR item.summary ILIKE $2
         OR publisher.display_name ILIKE $2
       )`
    : ""
  if (searchSql) {
    values.push(`%${params.search!.trim()}%`)
  }

  const result = await runnerFor(executor)<ActorPackageRow>(
    `${ACTOR_PACKAGE_SELECT}
       AND (
         (item.workspace_id IS NULL AND item.visibility <> 'private')
         OR item.workspace_id = $1
       )
       ${searchSql}
     ORDER BY item.download_count DESC, item.updated_at DESC`,
    values
  )

  return result.rows.map(normalizeActorPackageRow)
}

/** A single actor-template catalog row visible to a workspace, or null. */
export async function getActorPackageRow(
  packageId: UUID,
  workspaceId: UUID,
  executor: Executor = db
): Promise<ActorPackageRow | null> {
  const result = await runnerFor(executor)<ActorPackageRow>(
    `${ACTOR_PACKAGE_SELECT}
       AND item.id = $1
       AND (
         (item.workspace_id IS NULL AND item.visibility <> 'private')
         OR item.workspace_id = $2
       )
     LIMIT 1`,
    [packageId, workspaceId]
  )
  return result.rows[0] ? normalizeActorPackageRow(result.rows[0]) : null
}

async function insertActorVersionDoc(
  runner: QueryRunner,
  actorVersionId: string,
  doc: ActorDocPersistInput
) {
  await runner(
    `INSERT INTO actor_version_docs (
       actor_version_id,
       doc_key,
       title,
       visibility,
       priority,
       content_blocks
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actorVersionId,
      doc.key,
      doc.title,
      doc.visibility,
      doc.priority,
      JSON.stringify(doc.content),
    ]
  )
}

export type ActorGrantInput = {
  target: CapabilityAccessTarget
  permissions: WorkspaceResourceGrantPermission[]
  conversationTypeMaskOverride?: number | null
  reason?: string
}

/**
 * Create an actor end-to-end in ONE transaction: workspace-resources root row, the
 * actors detail row, grants, the v1 actor_version, and its docs. The parent
 * guard runs first (and aborts the tx on failure). Returns the new actor id.
 */
export async function createActorTx(input: {
  workspaceId: UUID
  createdByWorkspaceMemberId?: UUID
  displayName: string
  role: ActorRole
  title?: string
  avatarFileId?: UUID
  avatarEmoji?: string | null
  canRepresentUser?: boolean
  parentId?: UUID
  specialties: string[]
  config?: Record<string, unknown>
  docs: ActorDocPersistInput[]
  grants?: ActorGrantInput[]
}): Promise<{ actorId: string }> {
  return withDbTransaction(async (trx) => {
    const runner = runnerFor(trx)
    await ensureParentActor(
      runner,
      input.workspaceId,
      input.parentId,
      undefined
    )

    const actorId = crypto.randomUUID()
    await insertWorkspaceResourceRoot(trx, {
      id: actorId,
      workspaceId: input.workspaceId,
      kind: "actor",
      displayName: input.displayName,
      ownerWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
      status: "active",
    })
    const actorResult = await runner<{ id: string }>(
      `INSERT INTO actors (
	         id,
	         role,
         title,
         avatar_file_id,
         avatar_emoji,
         parent_id,
         can_represent_user,
         specialties,
         config,
         current_version
       )
	       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1)
	       RETURNING id`,
      [
        actorId,
        input.role,
        input.title || "",
        input.avatarFileId || null,
        input.avatarEmoji || null,
        input.parentId || null,
        Boolean(input.canRepresentUser),
        input.specialties,
        JSON.stringify(input.config || {}),
      ]
    )
    const insertedActorId = actorResult.rows[0]!.id

    for (const grant of input.grants || []) {
      await insertWorkspaceResourceGrant(trx, {
        workspaceId: input.workspaceId,
        workspaceResourceId: insertedActorId,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
        reason: grant.reason ?? null,
      })
    }

    const versionResult = await runner<{ id: string }>(
      `INSERT INTO actor_versions (
         actor_id,
         version,
         display_name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
         source_reason
       )
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        insertedActorId,
        input.displayName,
        input.role,
        input.title || "",
        input.parentId || null,
        Boolean(input.canRepresentUser),
        input.specialties,
        JSON.stringify(input.config || {}),
        input.createdByWorkspaceMemberId || null,
        input.createdByWorkspaceMemberId ? "workspace_member" : "system",
        input.createdByWorkspaceMemberId || null,
        "actor_create",
      ]
    )
    const actorVersionId = versionResult.rows[0]!.id

    for (const doc of input.docs) {
      await insertActorVersionDoc(runner, actorVersionId, doc)
    }

    return { actorId: insertedActorId }
  })
}

/**
 * Apply an avatar-only change (no new version) OUTSIDE a transaction, matching
 * the service's pre-existing fast path: a single UPDATE on actors guarded by
 * workspace membership + soft-delete, followed by a workspace-resources root
 * display-name sync. Both run on the singleton db (non-transactional), exactly
 * as before.
 */
export async function updateActorAvatar(input: {
  actorId: UUID
  workspaceId: UUID
  avatarFileId: UUID | null
  avatarEmoji: string | null
  displayName: string
}): Promise<void> {
  await runQuery(
    `UPDATE actors
     SET avatar_file_id = $2,
         avatar_emoji = $3
     WHERE id = $1
       AND EXISTS (
         SELECT 1
         FROM workspace_resources_live resource
         WHERE resource.id = actors.id
           AND resource.workspace_id = $4
           AND resource.deleted_at IS NULL
       )`,
    [input.actorId, input.avatarFileId, input.avatarEmoji, input.workspaceId]
  )
  await updateWorkspaceResourceRoot(db, {
    id: input.actorId,
    displayName: input.displayName,
  })
}

/**
 * Persist a full actor update in ONE transaction: a new actor_version (with its
 * version_delta), its docs, the actors detail UPDATE (guarded by workspace +
 * soft-delete), and the workspace-resources root display-name sync. The parent guard
 * runs first and aborts the tx on failure. The delta is pre-computed by the
 * service and serialized here.
 */
export async function updateActorTx(input: {
  actorId: UUID
  workspaceId: UUID
  nextVersion: number
  previousVersionId: string
  displayName: string
  role: ActorRole
  title: string
  avatarFileId: UUID | null
  avatarEmoji: string | null
  parentId: UUID | null
  canRepresentUser: boolean
  specialties: string[]
  config: Record<string, unknown>
  delta: unknown
  docs: ActorDocPersistInput[]
  source: {
    type: ActorUpdateSourceType
    workspaceMemberId?: UUID
    actorId?: UUID
    sessionId?: UUID
    turnId?: UUID
    conversationId?: UUID
    reason?: string
  }
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    const runner = runnerFor(trx)
    await ensureParentActor(
      runner,
      input.workspaceId,
      input.parentId,
      input.actorId
    )

    const versionResult = await runner<{ id: string }>(
      `INSERT INTO actor_versions (
         actor_id,
         version,
         previous_version_id,
         display_name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         version_delta,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
	         source_actor_id,
	         source_session_id,
	         source_turn_id,
	         source_conversation_id,
	         source_reason
	       )
	       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)
	       RETURNING id`,
      [
        input.actorId,
        input.nextVersion,
        input.previousVersionId,
        input.displayName,
        input.role,
        input.title,
        input.parentId || null,
        input.canRepresentUser,
        input.specialties,
        JSON.stringify(input.config || {}),
        JSON.stringify(input.delta),
        input.source.workspaceMemberId || null,
        input.source.type,
        input.source.workspaceMemberId || null,
        input.source.actorId || null,
        input.source.sessionId || null,
        input.source.turnId || null,
        input.source.conversationId || null,
        input.source.reason || null,
      ]
    )
    const actorVersionId = versionResult.rows[0]!.id

    for (const doc of input.docs) {
      await insertActorVersionDoc(runner, actorVersionId, doc)
    }

    await runner(
      `UPDATE actors
      SET role = $2,
           title = $3,
           avatar_file_id = $4,
           avatar_emoji = $5,
           parent_id = $6,
           can_represent_user = $7,
           specialties = $8,
           config = $9::jsonb,
           current_version = $10,
           updated_at = NOW()
       WHERE id = $1
         AND EXISTS (
           SELECT 1
           FROM workspace_resources_live resource
           WHERE resource.id = actors.id
             AND resource.workspace_id = $11
             AND resource.deleted_at IS NULL
         )`,
      [
        input.actorId,
        input.role,
        input.title,
        input.avatarFileId || null,
        input.avatarEmoji || null,
        input.parentId || null,
        input.canRepresentUser,
        input.specialties,
        JSON.stringify(input.config || {}),
        input.nextVersion,
        input.workspaceId,
      ]
    )
    await updateWorkspaceResourceRoot(trx, {
      id: input.actorId,
      displayName: input.displayName,
    })
  })
}

/**
 * Soft-delete an actor in ONE transaction: confirm it exists (in workspace, not
 * deleted) then archive the workspace-resources root row (status archived + deletedAt
 * stamp). The actors detail row stays until purge. Returns whether it was found.
 */
export async function deleteActorTx(
  actorId: UUID,
  workspaceId: UUID
): Promise<{ deleted: boolean }> {
  return withDbTransaction(async (trx) => {
    const runner = runnerFor(trx)
    const existing = await runner<{ id: string }>(
      `SELECT actor.id
       FROM actors actor
       INNER JOIN workspace_resources_live resource
         ON resource.id = actor.id
       WHERE actor.id = $1
         AND resource.workspace_id = $2
         AND resource.deleted_at IS NULL
       LIMIT 1`,
      [actorId, workspaceId]
    )
    if (existing.rows.length === 0) {
      return { deleted: false }
    }

    // Root lifecycle lives on workspace_resources. The detail row stays until purge.
    await updateWorkspaceResourceRoot(trx, {
      id: actorId,
      status: "archived",
      deletedAt: new Date(),
    })

    return { deleted: true }
  })
}

/**
 * Install an actor-template package in ONE transaction: workspace-resources root row,
 * the actors detail row, grants, the v1 actor_version + docs, the source ref,
 * and the catalog download-count increment. The parent guard runs first and
 * aborts the tx on failure. Returns the new actor id.
 */
export async function installActorPackageTx(input: {
  workspaceId: UUID
  createdByWorkspaceMemberId?: UUID
  displayName: string
  role: ActorRole
  title: string
  avatarFileId?: string | null
  avatarEmoji?: string | null
  parentId?: UUID | null
  canRepresentUser: boolean
  specialties: string[]
  config?: Record<string, unknown>
  docs: ActorDocPersistInput[]
  grants?: ActorGrantInput[]
  sourceCatalogItemId: string
  sourceCatalogVersionId: string | null
  syncMode: string
}): Promise<{ actorId: string }> {
  return withDbTransaction(async (trx) => {
    const runner = runnerFor(trx)
    await ensureParentActor(
      runner,
      input.workspaceId,
      input.parentId || null,
      undefined
    )

    const actorId = crypto.randomUUID()
    await insertWorkspaceResourceRoot(trx, {
      id: actorId,
      workspaceId: input.workspaceId,
      kind: "actor",
      displayName: input.displayName,
      ownerWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
      status: "active",
    })
    const actorResult = await runner<{ id: string }>(
      `INSERT INTO actors (
         id,
         role,
         title,
         avatar_file_id,
         avatar_emoji,
         parent_id,
         can_represent_user,
         specialties,
         config,
         current_version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1)
       RETURNING id`,
      [
        actorId,
        input.role,
        input.title,
        input.avatarFileId || null,
        input.avatarEmoji || null,
        input.parentId || null,
        input.canRepresentUser,
        input.specialties,
        JSON.stringify(input.config || {}),
      ]
    )
    const insertedActorId = actorResult.rows[0]!.id

    for (const grant of input.grants || []) {
      await insertWorkspaceResourceGrant(trx, {
        workspaceId: input.workspaceId,
        workspaceResourceId: insertedActorId,
        target: grant.target,
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
        reason: grant.reason ?? null,
      })
    }

    const versionResult = await runner<{ id: string }>(
      `INSERT INTO actor_versions (
         actor_id,
         version,
         display_name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
         source_reason
       )
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        insertedActorId,
        input.displayName,
        input.role,
        input.title,
        input.parentId || null,
        input.canRepresentUser,
        input.specialties,
        JSON.stringify(input.config || {}),
        input.createdByWorkspaceMemberId || null,
        input.createdByWorkspaceMemberId ? "workspace_member" : "system",
        input.createdByWorkspaceMemberId || null,
        "actor_package_install",
      ]
    )
    const actorVersionId = versionResult.rows[0]!.id

    for (const doc of input.docs) {
      await insertActorVersionDoc(runner, actorVersionId, doc)
    }

    await runner(
      `INSERT INTO actor_source_refs (
         actor_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         baseline_actor_version
       )
       VALUES ($1, $2, $3, $4, 1)`,
      [
        actorId,
        input.sourceCatalogItemId,
        input.sourceCatalogVersionId,
        input.syncMode,
      ]
    )

    await runner(
      `UPDATE catalog_items
       SET download_count = download_count + 1
       WHERE id = $1`,
      [input.sourceCatalogItemId]
    )

    return { actorId: insertedActorId }
  })
}
