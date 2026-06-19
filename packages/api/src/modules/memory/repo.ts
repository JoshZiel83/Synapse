/**
 * Memory module repo (round-6 P1-6 / guard r8).
 *
 * This is the ONLY memory file (besides repo.types.ts) allowed to import the
 * db client and `sql` — its basename matches the guard's isRepo
 * /(^|/)repo[^/]*\.ts$/ allowlist. The controller used to query `db` directly
 * and thread it into the access engine; both now route through this file so
 * the controller carries no db-client import.
 *
 * Two responsibilities:
 *  1. Owned read queries the controller used to run inline (4 id-lookups).
 *  2. Default-db binders/wrappers for the db-injectable access-engine and
 *     access-grant-storage helpers, so the controller calls them with just
 *     their params (same edge-binding pattern as access/guards.ts).
 *
 * Repo functions return camelCase DOMAIN records with Date objects intact
 * (CamelCasePlugin already yields camelCase keys for query-builder selects);
 * time serialization belongs to presenters (guard r3).
 */

import crypto from "node:crypto"
import { CompiledQuery, sql, type RawBuilder } from "kysely"
import { v4 as uuidv4 } from "uuid"
import {
  type MemoryCategory,
  type MemoryItemState,
  type SubjectRef,
} from "@synapse/shared"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  authorizePermission,
  filterAuthorizedPermissionResourceIds,
} from "../access/service.js"
import {
  checkPermission,
  hasMemorySpaceOwnerImplicitPermissionForTuple,
} from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertMemoryAccessGrant,
  listActiveMemoryAccessGrants,
  listSpaceLevelGrantSpaceIds,
  revokeMemoryAccessGrant,
} from "./access-grant-storage.js"
import { MemoryError } from "./errors.js"
import type { DraftConversationPart } from "../chat/message-content.js"
import type {
  MemoryItemChunksMetadata,
  MemoryItemPartsMetadata,
  MemoryItemsMetadata,
  MemoryRecallRunResultsMatchedTerms,
  MemoryRecallRunResultsMetadata,
  MemoryRow,
} from "./repo.types.js"
import type {
  MemoryItemsCategory,
  MemoryItemsState,
} from "../../infrastructure/database/generated/db.js"

/**
 * Resolve the conversation anchor for a memory item's space via its owner /
 * scope subject decomposition. Used by `requireMemoryPermission` to enrich
 * the runtime context so a `subject=actor + scope=conversation` grant
 * matches. Returns the two conversation ids (owner-side / scope-side), each
 * null when the corresponding subject is not a conversation.
 */
export async function findMemorySpaceConversationAnchor(
  memoryId: string,
  workspaceId: string
): Promise<{
  ownerConversationId: string | null
  scopeConversationId: string | null
} | null> {
  const row = await db
    .selectFrom("memoryItems as mi")
    .innerJoin("memorySpaces as ms", "ms.id", "mi.memorySpaceId")
    .innerJoin(
      "accessSubjects as owner_subj",
      "owner_subj.id",
      "ms.ownerSubjectId"
    )
    .leftJoin(
      "accessSubjects as scope_subj",
      "scope_subj.id",
      "ms.scopeSubjectId"
    )
    .select([
      "owner_subj.conversationId as ownerConversationId",
      "scope_subj.conversationId as scopeConversationId",
    ])
    .where("mi.id", "=", memoryId)
    .where("mi.workspaceId", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory space by id (the controller asserts it belongs to the
 * request's workspace before acting on grants).
 */
export async function findMemorySpaceInWorkspace(
  spaceId: string
): Promise<{ id: string; workspaceId: string } | null> {
  const row = await db
    .selectFrom("memorySpaces")
    .select(["id", "workspaceId"])
    .where("id", "=", spaceId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory item's space membership (the POST grants route asserts the
 * item lives in the target space + workspace).
 */
export async function findMemoryItemSpaceMembership(
  memoryItemId: string
): Promise<{
  id: string
  memorySpaceId: string
  workspaceId: string
} | null> {
  const row = await db
    .selectFrom("memoryItems")
    .select(["id", "memorySpaceId", "workspaceId"])
    .where("id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory access grant's space membership (the DELETE grant route
 * asserts the grant lives in the target space + workspace).
 */
export async function findMemoryAccessGrantMembership(
  grantId: string
): Promise<{
  id: string
  memorySpaceId: string
  workspaceId: string
} | null> {
  const row = await db
    .selectFrom("memoryAccessGrants")
    .select(["id", "memorySpaceId", "workspaceId"])
    .where("id", "=", grantId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Default-db binders for the db-injectable access engine (round-6 P1-6).
// The controller must not import the db client just to thread it into these
// access-module helpers. These bind the runtime default db; the underlying
// functions stay db-injectable for tests. (Same edge-binding pattern as
// access/guards.ts authorizeActionDefault etc., but the canonical home for
// the memory-only helpers is this repo file since access/guards.ts is owned
// centrally this round.)
// ---------------------------------------------------------------------------

export function authorizePermissionDefault(
  params: Parameters<typeof authorizePermission>[1]
): ReturnType<typeof authorizePermission> {
  return authorizePermission(db, params)
}

export function checkPermissionDefault(
  params: Parameters<typeof checkPermission>[1]
): ReturnType<typeof checkPermission> {
  return checkPermission(db, params)
}

export function hasMemorySpaceOwnerImplicitPermissionForTupleDefault(
  subject: Parameters<typeof hasMemorySpaceOwnerImplicitPermissionForTuple>[1],
  tuple: Parameters<typeof hasMemorySpaceOwnerImplicitPermissionForTuple>[2],
  permission: Parameters<
    typeof hasMemorySpaceOwnerImplicitPermissionForTuple
  >[3],
  runtimeContext?: Parameters<
    typeof hasMemorySpaceOwnerImplicitPermissionForTuple
  >[4]
): ReturnType<typeof hasMemorySpaceOwnerImplicitPermissionForTuple> {
  return hasMemorySpaceOwnerImplicitPermissionForTuple(
    db,
    subject,
    tuple,
    permission,
    runtimeContext
  )
}

export function buildRuntimePrincipalContextDefault(
  params: Parameters<typeof buildRuntimePrincipalContext>[1]
): ReturnType<typeof buildRuntimePrincipalContext> {
  return buildRuntimePrincipalContext(db, params)
}

// ---------------------------------------------------------------------------
// Default-db wrappers for the access-grant-storage layer. The grant storage
// helpers take an explicit db (db-injectable) for tests; the controller calls
// these binders so it no longer threads the db client.
// ---------------------------------------------------------------------------

export function insertMemoryAccessGrantDefault(
  input: Parameters<typeof insertMemoryAccessGrant>[1]
): ReturnType<typeof insertMemoryAccessGrant> {
  return insertMemoryAccessGrant(db, input)
}

export function listActiveMemoryAccessGrantsDefault(
  memorySpaceId: string
): ReturnType<typeof listActiveMemoryAccessGrants> {
  return listActiveMemoryAccessGrants(db, memorySpaceId)
}

export function revokeMemoryAccessGrantDefault(
  grantId: string
): ReturnType<typeof revokeMemoryAccessGrant> {
  return revokeMemoryAccessGrant(db, grantId)
}

// ---------------------------------------------------------------------------
// Indexing-engine queries (round-6 P1-6 / guard r8). The chunking / embedding
// / version-staging logic stays in indexing.ts; this file owns the raw SQL,
// the `::vector` casts, the SECURITY DEFINER `sd_replace_memory_item_chunks`
// churn calls, and the transaction boundaries. Repo fns return camelCase
// domain records with Date objects intact. The caller passes pre-formatted
// embedding vector LITERALS (so `formatEmbeddingVector` can stay in
// indexing.ts) and the repo applies the `::vector` cast.
// ---------------------------------------------------------------------------

/**
 * Read the cached passage embeddings for the given content hashes + model,
 * returning the raw `embedding::text` projection. Decoding the vector literal
 * stays in indexing.ts (`parseEmbeddingVector`).
 */
export async function loadMemoryPassageEmbeddingCacheRows(
  hashes: string[],
  modelId: string,
  run: Executor = db
): Promise<Array<{ contentHash: string; embeddingText: string | null }>> {
  if (hashes.length === 0) return []
  return run
    .selectFrom("memoryEmbeddingCache")
    .select(["contentHash", sql<string>`embedding::text`.as("embeddingText")])
    .where("modelId", "=", modelId)
    .where("inputType", "=", "passage")
    .where("contentHash", "in", hashes)
    .execute()
}

/**
 * Upsert passage embedding cache rows in a single transaction. The caller
 * pre-formats each embedding into a `[..]` vector literal; the repo owns the
 * `::vector` cast, the ON CONFLICT target, and `NOW()`.
 */
export async function upsertMemoryPassageEmbeddingCache(
  entries: Array<{
    contentHash: string
    embeddingLiteral: string
    embeddingDim: number
  }>,
  modelId: string
): Promise<void> {
  if (entries.length === 0) return
  await withDbTransaction(async (trx) => {
    for (const entry of entries) {
      await trx
        .insertInto("memoryEmbeddingCache")
        .values({
          modelId,
          inputType: "passage",
          contentHash: entry.contentHash,
          embedding: sql`${entry.embeddingLiteral}::vector`,
          embeddingDim: entry.embeddingDim,
          createdAt: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["modelId", "inputType", "contentHash"]).doUpdateSet({
            embedding: sql`${entry.embeddingLiteral}::vector`,
            embeddingDim: entry.embeddingDim,
          })
        )
        .execute()
    }
  })
}

/**
 * Load a memory item (full row) plus its ordered parts for index rebuild. The
 * caller maps parts → canonical content blocks (`itemPartsToCanonicalContentBlocks`).
 */
export async function loadMemoryItemIndexSourceRows(memoryItemId: string) {
  const item = await db
    .selectFrom("memoryItems as mi")
    .selectAll("mi")
    .where("mi.id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  if (!item) return null

  const parts = await db
    .selectFrom("memoryItemParts as mip")
    .select([
      "mip.id",
      "mip.memoryItemId",
      "mip.ordinal",
      "mip.partType",
      "mip.textValue",
      "mip.refPath",
      "mip.refSha256",
      "mip.jsonValue",
      "mip.mimeType",
      "mip.name",
      "mip.metadata",
    ])
    .where("mip.memoryItemId", "=", memoryItemId)
    .orderBy("mip.ordinal", "asc")
    .execute()

  return { item, parts }
}

/**
 * Atomically rebuild a memory item's lexical chunks for a new index version:
 * (optionally) route the stale staged version through the SECURITY DEFINER
 * churn fn, re-insert the chunk rows, and flip the memory_items index state.
 * The version math + chunk specs are computed by the caller; the repo owns the
 * single transaction so the chunk-replace + inserts + item update stay atomic.
 */
export async function commitMemoryItemLexicalRebuild(params: {
  memoryItemId: string
  workspaceId: string
  searchText: string
  textDigest: string
  state: string
  nextIndexVersion: number
  nextActiveVersion: number
  nextStagedVersion: number | null
  currentStagedVersion: number
  specs: Array<{
    chunkIndex: number
    chunkKind: "digest" | "body"
    searchText: string
  }>
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    if (params.currentStagedVersion > 0) {
      // Index churn: route the physical delete through the SECURITY DEFINER fn
      // (sd_reject_delete forbids a naked DELETE on this persistent child table).
      await sql`SELECT sd_replace_memory_item_chunks(${params.memoryItemId}::uuid, ${params.currentStagedVersion}::int)`.execute(
        trx
      )
    }

    for (const spec of params.specs) {
      await trx
        .insertInto("memoryItemChunks")
        .values({
          id: crypto.randomUUID(),
          memoryItemId: params.memoryItemId,
          workspaceId: params.workspaceId,
          indexVersion: params.nextIndexVersion,
          chunkIndex: spec.chunkIndex,
          chunkKind: spec.chunkKind,
          searchText: spec.searchText,
          embedding: null,
          tokenCount: Math.ceil(spec.searchText.length / 4),
          metadata: {
            textDigest: params.textDigest,
            state: params.state,
          } as MemoryItemChunksMetadata,
          createdAt: sql`NOW()`,
        })
        .execute()
    }

    await trx
      .updateTable("memoryItems")
      .set({
        searchText: params.searchText,
        indexStatus: "lexical_ready",
        activeIndexVersion: params.nextActiveVersion,
        stagedIndexVersion: params.nextStagedVersion,
        embeddingModel: "",
        embeddingDim: null,
        indexedAt: null,
        indexError: null,
      })
      .where("id", "=", params.memoryItemId)
      .execute()
  })
}

/**
 * Read a memory item's active / staged index versions (embedding reindex
 * entrypoint). Returns null when the item is missing.
 */
export async function loadMemoryItemIndexVersions(memoryItemId: string) {
  const item = await db
    .selectFrom("memoryItems")
    .select(["id", "activeIndexVersion", "stagedIndexVersion"])
    .where("id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  return item ?? null
}

/**
 * Read the ordered chunks for a memory item at a specific index version
 * (embedding reindex).
 */
export async function loadMemoryItemChunksForVersion(
  memoryItemId: string,
  indexVersion: number
): Promise<Array<{ id: string; searchText: string; indexVersion: number }>> {
  return db
    .selectFrom("memoryItemChunks")
    .select(["id", "searchText", "indexVersion"])
    .where("memoryItemId", "=", memoryItemId)
    .where("indexVersion", "=", indexVersion)
    .orderBy("chunkIndex", "asc")
    .execute()
}

/**
 * Write a single chunk's embedding (auto-commit, mirroring the original
 * per-chunk update loop in `reindexMemoryItemEmbeddings`). The caller passes a
 * pre-formatted vector literal or null; the repo owns the `::vector` cast and
 * the index_version guard.
 */
export async function setMemoryItemChunkEmbedding(
  chunkId: string,
  indexVersion: number,
  embeddingLiteral: string | null
): Promise<void> {
  await db
    .updateTable("memoryItemChunks")
    .set({
      embedding: embeddingLiteral ? sql`${embeddingLiteral}::vector` : null,
    })
    .where("id", "=", chunkId)
    .where("indexVersion", "=", indexVersion)
    .execute()
}

/**
 * Atomically flip a memory item to the `ready` embedding state and (when a
 * staged version superseded a prior active one) churn the now-stale active
 * version's chunks through the SECURITY DEFINER fn. One transaction so the
 * item update + chunk churn stay atomic. Shared by the no-chunk fast path and
 * the post-embedding success path.
 */
export async function commitMemoryItemEmbeddingReady(params: {
  memoryItemId: string
  targetIndexVersion: number
  activeIndexVersion: number
  stagedIndexVersion: number
  embeddingModel: string
  embeddingDim: number
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    await trx
      .updateTable("memoryItems")
      .set({
        activeIndexVersion: params.targetIndexVersion,
        stagedIndexVersion: null,
        indexStatus: "ready",
        embeddingModel: params.embeddingModel,
        embeddingDim: params.embeddingDim,
        indexedAt: sql`NOW()`,
        indexError: null,
      })
      .where("id", "=", params.memoryItemId)
      .execute()

    if (
      params.stagedIndexVersion > 0 &&
      params.activeIndexVersion > 0 &&
      params.activeIndexVersion !== params.targetIndexVersion
    ) {
      await sql`SELECT sd_replace_memory_item_chunks(${params.memoryItemId}::uuid, ${params.activeIndexVersion}::int)`.execute(
        trx
      )
    }
  })
}

/**
 * Mark a memory item's embedding index as failed (auto-commit error path).
 */
export async function markMemoryItemEmbeddingFailed(params: {
  memoryItemId: string
  embeddingModel: string
  embeddingDim: number
  indexError: string
}): Promise<void> {
  await db
    .updateTable("memoryItems")
    .set({
      indexStatus: "failed",
      embeddingModel: params.embeddingModel,
      embeddingDim: params.embeddingDim,
      indexError: params.indexError,
    })
    .where("id", "=", params.memoryItemId)
    .execute()
}

// ---------------------------------------------------------------------------
// Service-layer queries + transactions (round-6 P1-6 / guard r8). Moved out of
// service.ts so it no longer imports the db client. The retrieval scoring /
// RRF / MMR logic, the where-clause fragment builders (buildSearchFilters etc.,
// pure `sql` tags), and the presenter mapping stay in service.ts; this file
// owns every `db.executeQuery` / Kysely builder run + the 5 transactions.
//
// Raw-SQL note: getMemoryRow / search / list use hand-written physical
// snake_case SQL, but Kysely's CamelCasePlugin still transforms raw-query
// top-level result keys. Repo output records are therefore camelCase; the
// `::vector` / `::jsonb` casts and the sd_replace_memory_item_parts SECURITY
// DEFINER churn are load-bearing and preserved verbatim.
// ---------------------------------------------------------------------------

const DEFAULT_NAMESPACE = "default"

export type MemorySpaceRow = {
  id: string
  workspaceId: string
  ownerSubjectId: string
  scopeSubjectId: string | null
  namespaceKey: string
}

type MemoryPartRow = {
  memoryItemId: string
  partType: string
  textValue?: string | null
  refPath?: string | null
  refSha256?: string | null
  jsonValue?: unknown
  mimeType?: string | null
  name?: string | null
  metadata?: Record<string, unknown> | string | null
  sizeBytes?: number | null
}

export type SearchCandidateRow = MemoryRow & {
  matchedChunkId: string
  chunkSearchText: string
  textScore?: number | null
  similarityScore?: number | null
  vectorScore?: number | null
  rrfScore?: number | null
}

export function normalizeMemoryRow<T extends MemoryRow>(row: T): T {
  const normalized = {
    ...row,
    metadata: parseMemoryMetadata(row.metadata),
  }
  return normalized
}

function parseMemoryMetadata(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {}
  const parsed =
    typeof value === "string" ? parseMemoryMetadataJson(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("memory item metadata must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function parseMemoryMetadataJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("memory item metadata must be valid JSON")
  }
}

/**
 * Raw SQL projecting a memory_items row plus its memory_spaces owner / scope
 * subject decomposition. Used by both the get/list paths and the raw-SQL
 * search candidate queries. The SELECT body is duplicated rather than shared
 * as a string template so that Kysely-side paths keep their aliases.
 */
function memoryRowSelectSql(itemAlias = "mi", spaceAlias = "ms") {
  const item = sql.raw(itemAlias)
  const space = sql.raw(spaceAlias)
  return sql`
    ${item}.id AS id,
    ${item}.workspace_id AS workspace_id,
    ${item}.memory_space_id AS memory_space_id,
    ${space}.owner_subject_id AS space_owner_subject_id,
    ${space}.scope_subject_id AS space_scope_subject_id,
    ${space}.namespace_key AS space_namespace_key,
    owner_subj.kind AS owner_kind,
    owner_subj.workspace_id AS owner_workspace_id,
    owner_subj.workspace_member_id AS owner_workspace_member_id,
    owner_subj.actor_id AS owner_actor_id,
    owner_subj.remote_agent_id AS owner_remote_agent_id,
    owner_subj.conversation_id AS owner_conversation_id,
    scope_subj.kind AS scope_kind,
    scope_subj.workspace_id AS scope_workspace_id_via_join,
    scope_subj.conversation_id AS scope_conversation_id_via_join,
    ${item}.category AS category,
    ${item}.state AS state,
    ${item}.importance AS importance,
    ${item}.confidence AS confidence,
    ${item}.tags AS tags,
    ${item}.text_digest AS text_digest,
    ${item}.search_text AS search_text,
    ${item}.index_status AS index_status,
    ${item}.embedding_model AS embedding_model,
    ${item}.embedding_dim AS embedding_dim,
    ${item}.indexed_at AS indexed_at,
    ${item}.index_error AS index_error,
    ${item}.source_item_id AS source_item_id,
    ${item}.source_tool_call_id AS source_tool_call_id,
    ${item}.source_turn_id AS source_turn_id,
    ${item}.supersedes_item_id AS supersedes_item_id,
    ${item}.metadata AS metadata,
    ${item}.created_at AS created_at,
    ${item}.updated_at AS updated_at,
    COALESCE(owner_actor_app.display_name, owner_remote_agent_app.display_name, owner_conv.title, owner_user.name) AS owner_label,
    COALESCE(scope_conv.title) AS scope_label
  `
}

function memoryRowFromSql(itemAlias = "mi", spaceAlias = "ms") {
  const item = sql.raw(itemAlias)
  const space = sql.raw(spaceAlias)
  return sql`
    ${item}
      JOIN memory_spaces ${space} ON ${space}.id = ${item}.memory_space_id
      JOIN access_subjects owner_subj ON owner_subj.id = ${space}.owner_subject_id
      LEFT JOIN access_subjects scope_subj ON scope_subj.id = ${space}.scope_subject_id
      LEFT JOIN actors owner_actor ON owner_actor.id = owner_subj.actor_id
      LEFT JOIN workspace_resources_live owner_actor_app ON owner_actor_app.id = owner_actor.id
      LEFT JOIN remote_agents owner_remote_agent ON owner_remote_agent.id = owner_subj.remote_agent_id
      LEFT JOIN workspace_resources_live owner_remote_agent_app ON owner_remote_agent_app.id = owner_remote_agent.id
      LEFT JOIN conversations owner_conv ON owner_conv.id = owner_subj.conversation_id
      LEFT JOIN workspace_members owner_wm ON owner_wm.id = owner_subj.workspace_member_id
      LEFT JOIN users owner_user ON owner_user.id = owner_wm.user_id
      LEFT JOIN conversations scope_conv ON scope_conv.id = scope_subj.conversation_id
  `
}

export async function getMemoryRow(
  workspaceId: string,
  memoryId: string
): Promise<MemoryRow | undefined> {
  const select = memoryRowSelectSql("mi", "ms")
  const from = memoryRowFromSql("mi", "ms")
  const result = await db.executeQuery(
    sql<MemoryRow>`SELECT ${select} FROM memory_items ${from}
       WHERE mi.workspace_id = ${workspaceId} AND mi.id = ${memoryId}
       LIMIT 1`.compile(db)
  )
  const row = result.rows[0]
  return row ? normalizeMemoryRow(row) : undefined
}

/**
 * Read the ordered parts for a set of memory items (the service maps them to
 * canonical content blocks + presents the rows).
 */
export async function listMemoryItemPartRows(
  memoryIds: string[]
): Promise<MemoryPartRow[]> {
  if (memoryIds.length === 0) return []
  const partsResult = await db
    .selectFrom("memoryItemParts as mip")
    .select([
      "mip.memoryItemId",
      "mip.partType",
      "mip.textValue",
      "mip.refPath",
      "mip.refSha256",
      "mip.jsonValue",
      "mip.mimeType",
      "mip.name",
      "mip.metadata",
    ])
    .where("mip.memoryItemId", "in", memoryIds)
    .orderBy("mip.memoryItemId", "asc")
    .orderBy("mip.ordinal", "asc")
    .execute()
  return partsResult as MemoryPartRow[]
}

/**
 * Pure read — look up the memory_space row keyed by (workspace_id,
 * owner_subject_id, scope_subject_id?, namespace_key) WITHOUT writing.
 */
export async function findExistingMemorySpace(input: {
  workspaceId: string
  ownerSubjectId: string
  scopeSubjectId: string | null
  namespaceKey?: string
}): Promise<MemorySpaceRow | null> {
  const namespaceKey =
    (input.namespaceKey || DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE
  let query = db
    .selectFrom("memorySpaces")
    .selectAll()
    .where("workspaceId", "=", input.workspaceId)
    .where("ownerSubjectId", "=", input.ownerSubjectId)
    .where("namespaceKey", "=", namespaceKey)
  query = input.scopeSubjectId
    ? query.where("scopeSubjectId", "=", input.scopeSubjectId)
    : query.where("scopeSubjectId", "is", null)
  const row = (await query.limit(1).executeTakeFirst()) as
    | MemorySpaceRow
    | undefined
  return row ?? null
}

/**
 * Upsert an owner/scope subject (used by validateMemorySpaceTuple), returning
 * the subject id. Threads the runtime default db; stays distinct from the
 * tuple's MemoryError branching, which stays in the service.
 */
export async function upsertMemorySubject(ref: SubjectRef): Promise<string> {
  return upsertAccessSubject(db, ref)
}

/**
 * Read the access_subjects rows for the given ids (workspace-consistency check
 * in validateMemorySpaceTuple).
 */
export async function loadAccessSubjectRows(
  ids: string[]
): Promise<Array<{ id: string; workspaceId: string | null; kind: string }>> {
  if (ids.length === 0) return []
  return db
    .selectFrom("accessSubjects")
    .select(["id", "workspaceId", "kind"])
    .where("id", "in", ids)
    .execute()
}

/**
 * Resolve-or-create a memory_spaces row on the given executor (so it joins the
 * caller's transaction). The owner-kind allowlist / scope-kind MemoryError
 * branching stays in the service; this owns the subject upserts (pinned to the
 * executor so they roll back with the outer txn) + the single-statement
 * INSERT ... ON CONFLICT ... RETURNING against the soft-delete-aware partial
 * unique indexes.
 */
async function resolveOrCreateMemorySpaceOn(
  executor: Executor,
  input: {
    workspaceId: string
    owner: SubjectRef
    scope?: SubjectRef
    namespaceKey?: string
  }
): Promise<MemorySpaceRow> {
  const ownerSubjectId = await upsertAccessSubject(executor, input.owner)
  const scopeSubjectId = input.scope
    ? await upsertAccessSubject(executor, input.scope)
    : null
  const namespaceKey =
    (input.namespaceKey || DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE

  // ON CONFLICT targets one of the two partial unique indexes on
  // memory_spaces (scoped vs unscoped); both are soft-delete-aware so the
  // predicate must match exactly (design §8.3). DO UPDATE (no-op) is required
  // for RETURNING on the conflicting row.
  const conflictClause = scopeSubjectId
    ? `(workspace_id, owner_subject_id, scope_subject_id, namespace_key) WHERE scope_subject_id IS NOT NULL AND deleted_at IS NULL`
    : `(workspace_id, owner_subject_id, namespace_key) WHERE scope_subject_id IS NULL AND deleted_at IS NULL`
  const result = await executor.executeQuery<MemorySpaceRow>(
    CompiledQuery.raw(
      `INSERT INTO memory_spaces (id, workspace_id, owner_subject_id, scope_subject_id, namespace_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT ${conflictClause}
       DO UPDATE SET updated_at = memory_spaces.updated_at
     RETURNING id, workspace_id, owner_subject_id, scope_subject_id, namespace_key`,
      [
        uuidv4(),
        input.workspaceId,
        ownerSubjectId,
        scopeSubjectId,
        namespaceKey,
      ]
    )
  )
  const row = result.rows[0]
  if (!row) {
    throw new MemoryError("Failed to resolve or create memory_space", 500)
  }
  return row
}

async function insertMemoryItemPartsOn(
  executor: Executor,
  memoryItemId: string,
  parts: DraftConversationPart[]
) {
  for (let ordinal = 0; ordinal < parts.length; ordinal += 1) {
    const part = parts[ordinal]
    await executor.executeQuery(
      db.insertInto("memoryItemParts").values({
        id: uuidv4(),
        memoryItemId,
        ordinal,
        partType: part.type,
        textValue: part.type === "text" ? part.text || "" : null,
        refPath: part.type === "file_ref" ? (part.refPath ?? null) : null,
        refSha256: part.type === "file_ref" ? (part.refSha256 ?? null) : null,
        jsonValue:
          part.type === "json"
            ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
            : null,
        mimeType: part.mimeType || null,
        name: part.name || null,
        metadata: (part.metadata || {}) as MemoryItemPartsMetadata,
      })
    )
  }
}

async function maybeMarkSupersededOn(
  executor: Executor,
  memoryItemId?: string
) {
  if (!memoryItemId) return
  await executor.executeQuery(
    db
      .updateTable("memoryItems")
      .set({
        state: "superseded",
      })
      .where("id", "=", memoryItemId)
  )
}

/**
 * createMemory transaction: resolve-or-create space + insert the item + insert
 * parts + (optional) mark superseded — atomic. The owner-kind / scope-kind
 * MemoryError validation runs in the service before this is called.
 */
export async function createMemoryItemTx(params: {
  workspaceId: string
  memoryItemId: string
  owner: SubjectRef
  scope?: SubjectRef
  namespaceKey?: string
  category: MemoryItemsCategory
  state: MemoryItemsState
  importance: number
  confidence: number
  tags: string[]
  textDigest: string
  searchText: string
  sourceItemId: string | null
  sourceToolCallId: string | null
  sourceTurnId: string | null
  supersedesItemId: string | null
  metadata: MemoryItemsMetadata
  parts: DraftConversationPart[]
  supersedesMemoryId?: string
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    const space = await resolveOrCreateMemorySpaceOn(trx, {
      workspaceId: params.workspaceId,
      owner: params.owner,
      scope: params.scope,
      namespaceKey: params.namespaceKey,
    })
    await trx.executeQuery(
      db.insertInto("memoryItems").values({
        id: params.memoryItemId,
        workspaceId: params.workspaceId,
        memorySpaceId: space.id,
        category: params.category,
        state: params.state,
        importance: params.importance,
        confidence: params.confidence,
        tags: params.tags,
        textDigest: params.textDigest,
        searchText: params.searchText,
        indexStatus: "lexical_ready",
        activeIndexVersion: 0,
        stagedIndexVersion: null,
        embeddingModel: "",
        embeddingDim: null,
        indexedAt: null,
        indexError: null,
        sourceKind: "manual",
        sourceItemId: params.sourceItemId,
        sourceToolCallId: params.sourceToolCallId,
        sourceTurnId: params.sourceTurnId,
        supersedesItemId: params.supersedesItemId,
        metadata: params.metadata,
        createdAt: sql`NOW()`,
      })
    )
    await insertMemoryItemPartsOn(trx, params.memoryItemId, params.parts)
    await maybeMarkSupersededOn(trx, params.supersedesMemoryId)
  })
}

/**
 * updateMemory transaction: update the item + set-replace parts (via the
 * sd_replace_memory_item_parts SECURITY DEFINER fn, since sd_reject_delete
 * forbids a naked DELETE) + (optional) mark superseded — atomic.
 */
export async function updateMemoryItemTx(params: {
  workspaceId: string
  memoryId: string
  category: MemoryItemsCategory
  state: MemoryItemsState
  importance: number
  confidence: number
  tags: string[]
  textDigest: string
  searchText: string
  sourceItemId: string | null
  sourceToolCallId: string | null
  sourceTurnId: string | null
  supersedesItemId: string | null
  metadata: MemoryItemsMetadata
  parts: DraftConversationPart[]
  supersedesMemoryId?: string
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    await trx.executeQuery(
      db
        .updateTable("memoryItems")
        .set({
          category: params.category,
          state: params.state,
          importance: params.importance,
          confidence: params.confidence,
          tags: params.tags,
          textDigest: params.textDigest,
          searchText: params.searchText,
          sourceItemId: params.sourceItemId,
          sourceToolCallId: params.sourceToolCallId,
          sourceTurnId: params.sourceTurnId,
          supersedesItemId: params.supersedesItemId,
          metadata: params.metadata,
        })
        .where("id", "=", params.memoryId)
        .where("workspaceId", "=", params.workspaceId)
    )

    // Content set-replace: memory_item_parts is aggregate-internal detail; the
    // physical delete goes through the SECURITY DEFINER fn (sd_reject_delete
    // forbids a naked DELETE on this persistent child table). Design §7.5/§11.
    await sql`SELECT sd_replace_memory_item_parts(${params.memoryId}::uuid)`.execute(
      trx
    )
    await insertMemoryItemPartsOn(trx, params.memoryId, params.parts)
    await maybeMarkSupersededOn(trx, params.supersedesMemoryId)
  })
}

/**
 * deleteMemory transaction: soft delete (flip deleted_at). Returns whether a
 * row was affected so the service can raise a 404 on a stale id.
 */
export async function softDeleteMemoryItemTx(
  workspaceId: string,
  memoryId: string
): Promise<boolean> {
  return withDbTransaction(async (trx) => {
    const deleted = await trx
      .updateTable("memoryItems")
      .set({ deletedAt: new Date() })
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", memoryId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
    return Boolean(deleted.numUpdatedRows)
  })
}

/**
 * moveMemoryToSpace transaction: source-exists re-check (racing delete → 404),
 * resolve-or-create the target space, then UPDATE memory_items.memory_space_id.
 * Returns the move outcome so the service can branch on the no-op / not-found
 * cases without owning the transaction.
 */
export async function moveMemoryItemToSpaceTx(params: {
  workspaceId: string
  memoryId: string
  sourceMemorySpaceId: string
  owner: SubjectRef
  scope?: SubjectRef
  namespaceKey?: string
}): Promise<"moved" | "noop"> {
  return withDbTransaction(async (trx) => {
    const stillThere = await trx
      .selectFrom("memoryItems")
      .select("id")
      .where("id", "=", params.memoryId)
      .where("workspaceId", "=", params.workspaceId)
      .limit(1)
      .executeTakeFirst()
    if (!stillThere) {
      throw new MemoryError("Memory not found", 404)
    }
    const targetSpace = await resolveOrCreateMemorySpaceOn(trx, {
      workspaceId: params.workspaceId,
      owner: params.owner,
      scope: params.scope,
      namespaceKey: params.namespaceKey,
    })
    if (targetSpace.id === params.sourceMemorySpaceId) {
      return "noop" // raced into a no-op
    }
    await trx.executeQuery(
      db
        .updateTable("memoryItems")
        .set({
          memorySpaceId: targetSpace.id,
        })
        .where("id", "=", params.memoryId)
        .where("workspaceId", "=", params.workspaceId)
    )
    return "moved"
  })
}

/**
 * recordMemoryRecallRun transaction: insert the recall-run header + one row per
 * result — atomic. The result metadata is encoded by the caller; `::jsonb`
 * casts and `NOW()` stay in the repo.
 */
export async function insertMemoryRecallRunTx(params: {
  runId: string
  workspaceId: string
  actorId: string | null
  conversationId: string | null
  workspaceMemberId: string | null
  recallType: string
  queryText: string
  queryBlocksJson: string
  metadataJson: string
  results: Array<{
    memoryItemId: string
    matchedChunkId: string | null
    rank: number
    finalScore: number
    vectorScore: number | null
    textScore: number | null
    similarityScore: number | null
    matchedTerms: MemoryRecallRunResultsMatchedTerms
    recallReason: string | null
    metadata: MemoryRecallRunResultsMetadata
  }>
}): Promise<void> {
  await withDbTransaction(async (trx) => {
    await trx.executeQuery(
      CompiledQuery.raw(
        `INSERT INTO memory_recall_runs (
         id,
         workspace_id,
         actor_id,
         conversation_id,
         workspace_member_id,
         recall_type,
         query_text,
         query_blocks,
         metadata,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW())`,
        [
          params.runId,
          params.workspaceId,
          params.actorId,
          params.conversationId,
          params.workspaceMemberId,
          params.recallType,
          params.queryText,
          params.queryBlocksJson,
          params.metadataJson,
        ]
      )
    )

    for (const result of params.results) {
      await trx.executeQuery(
        db.insertInto("memoryRecallRunResults").values({
          id: uuidv4(),
          runId: params.runId,
          memoryItemId: result.memoryItemId,
          matchedChunkId: result.matchedChunkId,
          rank: result.rank,
          finalScore: result.finalScore,
          vectorScore: result.vectorScore,
          textScore: result.textScore,
          similarityScore: result.similarityScore,
          matchedTerms: result.matchedTerms,
          recallReason: result.recallReason,
          metadata: result.metadata,
          createdAt: sql`NOW()`,
        })
      )
    }
  })
}

/**
 * D4: spaces the principal can read by owner-implicit permission. Returns the
 * memory_space ids matching `owner_subject_id ∈ runtimeSubjectIds AND
 * (scope_subject_id IS NULL OR scope_subject_id ∈ runtimeScopeSubjectIds)`.
 */
export async function loadOwnerImplicitSpaceIds(
  workspaceId: string,
  runtimeSubjectIds: readonly string[],
  runtimeScopeSubjectIds: readonly string[]
): Promise<string[]> {
  if (runtimeSubjectIds.length === 0) return []
  let query = db
    .selectFrom("memorySpaces")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("ownerSubjectId", "in", [...runtimeSubjectIds])
  if (runtimeScopeSubjectIds.length > 0) {
    const scopes = [...runtimeScopeSubjectIds]
    query = query.where((eb) =>
      eb.or([
        eb("scopeSubjectId", "is", null),
        eb("scopeSubjectId", "in", scopes),
      ])
    )
  } else {
    query = query.where("scopeSubjectId", "is", null)
  }
  const rows = await query.execute()
  return rows.map((row) => row.id)
}

type MemorySearchCandidateFilterInput = {
  actorId?: string
  workspaceMemberId?: string
  accessSubject?: { type: string } | null
  namespaceKeys?: string[]
  categories?: MemoryCategory[]
  states?: MemoryItemState[]
  statuses?: MemoryItemState[]
}

type MemoryListCandidateFilterInput = {
  category?: MemoryCategory
  state?: MemoryItemState
  status?: MemoryItemState
  tags?: string[]
  namespaceKey?: string
}

function normalizeSearchWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function hasPrincipalSearchContext(
  input: Pick<
    MemorySearchCandidateFilterInput,
    "actorId" | "workspaceMemberId" | "accessSubject"
  >
) {
  if (input.accessSubject) {
    return (
      input.accessSubject.type === "actor" ||
      input.accessSubject.type === "workspace_member"
    )
  }
  return Boolean(input.actorId || input.workspaceMemberId)
}

function buildMemorySearchWhereClause(params: {
  workspaceId: string
  input: MemorySearchCandidateFilterInput
  itemAlias?: string
  spaceAlias?: string
  grantSpaceIds?: readonly string[]
  ownerSpaceIds?: readonly string[]
  ownerSubjectIdFilters?: readonly string[]
  scopeSubjectIdFilters?: readonly string[]
  scopeFilterIncludesUnscoped?: boolean
}) {
  const item = sql.raw(params.itemAlias ?? "mi")
  const space = sql.raw(params.spaceAlias ?? "ms")
  const input = params.input
  const conditions: RawBuilder<unknown>[] = [
    sql`${item}.workspace_id = ${params.workspaceId}`,
  ]

  if (input.namespaceKeys && input.namespaceKeys.length > 0) {
    conditions.push(
      sql`${space}.namespace_key = ANY(${input.namespaceKeys}::text[])`
    )
  }

  const ownerSubjectIdFilters = params.ownerSubjectIdFilters ?? []
  if (ownerSubjectIdFilters.length > 0) {
    conditions.push(
      sql`${space}.owner_subject_id = ANY(${[...ownerSubjectIdFilters]}::uuid[])`
    )
  }

  const scopeSubjectIdFilters = params.scopeSubjectIdFilters ?? []
  if (scopeSubjectIdFilters.length > 0) {
    if (params.scopeFilterIncludesUnscoped) {
      conditions.push(
        sql`(${space}.scope_subject_id IS NULL OR ${space}.scope_subject_id = ANY(${[...scopeSubjectIdFilters]}::uuid[]))`
      )
    } else {
      conditions.push(
        sql`${space}.scope_subject_id = ANY(${[...scopeSubjectIdFilters]}::uuid[])`
      )
    }
  }

  if (input.categories && input.categories.length > 0) {
    conditions.push(
      sql`${item}.category::text = ANY(${input.categories}::text[])`
    )
  }

  const states =
    input.states && input.states.length > 0
      ? input.states
      : input.statuses && input.statuses.length > 0
        ? input.statuses
        : ["active"]
  conditions.push(sql`${item}.state::text = ANY(${states}::text[])`)

  if (hasPrincipalSearchContext(input)) {
    const reachable = Array.from(
      new Set([
        ...(params.ownerSpaceIds ?? []),
        ...(params.grantSpaceIds ?? []),
      ])
    )
    if (reachable.length === 0) {
      conditions.push(sql`FALSE`)
    } else {
      conditions.push(sql`${space}.id = ANY(${reachable}::uuid[])`)
    }
  }

  return sql`${sql.join(conditions, sql` AND `)}`
}

function buildMemoryListWhereClause(params: {
  workspaceId: string
  input: MemoryListCandidateFilterInput
  ownerSubjectId?: string
  scopeSubjectId?: string
  reachableSpaceIds?: readonly string[]
}) {
  const conditions: RawBuilder<unknown>[] = [
    sql`mi.workspace_id = ${params.workspaceId}`,
  ]
  const input = params.input

  if (input.category) conditions.push(sql`mi.category = ${input.category}`)
  if (input.state || input.status) {
    conditions.push(sql`mi.state = ${(input.state || input.status)!}`)
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(sql`mi.tags && ${input.tags}`)
  }
  if (input.namespaceKey) {
    conditions.push(sql`ms.namespace_key = ${input.namespaceKey}`)
  }
  if (params.ownerSubjectId) {
    conditions.push(sql`ms.owner_subject_id = ${params.ownerSubjectId}`)
  }
  if (params.scopeSubjectId) {
    conditions.push(sql`ms.scope_subject_id = ${params.scopeSubjectId}`)
  }

  if (params.reachableSpaceIds) {
    if (params.reachableSpaceIds.length === 0) {
      conditions.push(sql`FALSE`)
    } else {
      conditions.push(
        sql`ms.id = ANY(${[...params.reachableSpaceIds]}::uuid[])`
      )
    }
  }

  return sql`${sql.join(conditions, sql` AND `)}`
}

function formatEmbeddingVector(embedding: number[]) {
  return `[${embedding
    .map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0"))
    .join(",")}]`
}

/**
 * Hybrid lexical candidate query. The repo owns the where-clause fragment,
 * full SQL assembly, and execution. queryText / normalizedQueryText are
 * interpolated as bound params verbatim.
 */
export async function searchLexicalCandidateRows(params: {
  whereClause: RawBuilder<unknown>
  queryText: string
  normalizedQueryText: string
  candidateLimit: number
}): Promise<SearchCandidateRow[]> {
  const select = memoryRowSelectSql("mi", "ms")
  const from = memoryRowFromSql("mi", "ms")
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT ${select},
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        GREATEST(
          ts_rank_cd(to_tsvector('simple', mic.search_text), websearch_to_tsquery('simple', ${params.queryText})),
          CASE WHEN POSITION(${params.normalizedQueryText} IN lower(mic.search_text)) > 0 THEN 0.2 ELSE 0 END
        ) AS text_score,
        similarity(mic.search_text, ${params.queryText}) AS similarity_score,
        NULL::real AS vector_score,
        NULL::real AS rrf_score
      FROM memory_item_chunks mic
      JOIN memory_items ${from} ON mi.id = mic.memory_item_id
      WHERE ${params.whereClause}
        AND mic.index_version = mi.active_index_version
        AND (
          to_tsvector('simple', mic.search_text) @@ websearch_to_tsquery('simple', ${params.queryText})
          OR POSITION(${params.normalizedQueryText} IN lower(mic.search_text)) > 0
          OR similarity(mic.search_text, ${params.queryText}) > 0.08
        )
      ORDER BY text_score DESC, similarity_score DESC, mi.importance DESC, mi.updated_at DESC
      LIMIT ${params.candidateLimit}`.compile(db)
  )
  return result.rows.map(normalizeMemoryRow)
}

export async function searchLexicalMemoryCandidateRows(params: {
  workspaceId: string
  input: MemorySearchCandidateFilterInput
  candidateLimit: number
  queryText: string
  grantSpaceIds?: readonly string[]
  ownerSpaceIds?: readonly string[]
  ownerSubjectIdFilters?: readonly string[]
  scopeSubjectIdFilters?: readonly string[]
  scopeFilterIncludesUnscoped?: boolean
}): Promise<SearchCandidateRow[]> {
  if (!params.queryText) return []
  const whereClause = buildMemorySearchWhereClause(params)
  return searchLexicalCandidateRows({
    whereClause,
    queryText: params.queryText,
    normalizedQueryText: normalizeSearchWhitespace(
      params.queryText
    ).toLowerCase(),
    candidateLimit: params.candidateLimit,
  })
}

/**
 * Vector (pgvector) candidate query. The repo owns the where-clause, the
 * `[..]` embedding literal, the `::vector` cast, and execution.
 */
export async function searchVectorCandidateRows(params: {
  whereClause: RawBuilder<unknown>
  formattedEmbedding: string
  candidateLimit: number
}): Promise<SearchCandidateRow[]> {
  const select = memoryRowSelectSql("mi", "ms")
  const from = memoryRowFromSql("mi", "ms")
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT ${select},
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        NULL::real AS text_score,
        NULL::real AS similarity_score,
        (1 - (mic.embedding <=> ${params.formattedEmbedding}::vector))::real AS vector_score,
        NULL::real AS rrf_score
      FROM memory_item_chunks mic
      JOIN memory_items ${from} ON mi.id = mic.memory_item_id
      WHERE ${params.whereClause}
        AND mic.index_version = mi.active_index_version
        AND mic.embedding IS NOT NULL
      ORDER BY mic.embedding <=> ${params.formattedEmbedding}::vector ASC
      LIMIT ${params.candidateLimit}`.compile(db)
  )
  return result.rows.map(normalizeMemoryRow)
}

export async function searchVectorMemoryCandidateRows(params: {
  workspaceId: string
  input: MemorySearchCandidateFilterInput
  embedding: number[]
  candidateLimit: number
  grantSpaceIds?: readonly string[]
  ownerSpaceIds?: readonly string[]
  ownerSubjectIdFilters?: readonly string[]
  scopeSubjectIdFilters?: readonly string[]
  scopeFilterIncludesUnscoped?: boolean
}): Promise<SearchCandidateRow[]> {
  const whereClause = buildMemorySearchWhereClause(params)
  return searchVectorCandidateRows({
    whereClause,
    formattedEmbedding: formatEmbeddingVector(params.embedding),
    candidateLimit: params.candidateLimit,
  })
}

/**
 * listMemories candidate query. The repo owns the where-clause fragment,
 * SQL assembly, and execution.
 */
export async function listMemoryCandidateRows(params: {
  whereClause: RawBuilder<unknown>
  candidateOversample: number
}): Promise<MemoryRow[]> {
  const select = memoryRowSelectSql("mi", "ms")
  const from = memoryRowFromSql("mi", "ms")
  const result = await db.executeQuery(
    sql<MemoryRow>`SELECT ${select} FROM memory_items ${from}
       WHERE ${params.whereClause}
       ORDER BY mi.updated_at DESC
       LIMIT ${params.candidateOversample}`.compile(db)
  )
  return result.rows.map(normalizeMemoryRow)
}

export async function listMemoryCandidateRowsForInput(params: {
  workspaceId: string
  input: MemoryListCandidateFilterInput
  ownerSubjectId?: string
  scopeSubjectId?: string
  reachableSpaceIds?: readonly string[]
  candidateOversample: number
}): Promise<MemoryRow[]> {
  const whereClause = buildMemoryListWhereClause(params)
  return listMemoryCandidateRows({
    whereClause,
    candidateOversample: params.candidateOversample,
  })
}

// ---------------------------------------------------------------------------
// Default-db binders for the remaining service-side threaded-db helpers
// (round-6 P1-6). The service must not import the db client to thread it into
// these access-module / access-grant-storage helpers; they stay db-injectable
// for tests, the binders pin the runtime default db.
// ---------------------------------------------------------------------------

export function filterAuthorizedPermissionResourceIdsDefault(
  params: Parameters<typeof filterAuthorizedPermissionResourceIds>[1]
): ReturnType<typeof filterAuthorizedPermissionResourceIds> {
  return filterAuthorizedPermissionResourceIds(db, params)
}

export function listSpaceLevelGrantSpaceIdsDefault(
  params: Parameters<typeof listSpaceLevelGrantSpaceIds>[1]
): ReturnType<typeof listSpaceLevelGrantSpaceIds> {
  return listSpaceLevelGrantSpaceIds(db, params)
}
