import type {
  CanonicalContentBlockInput,
  CanonicalContextItem,
  Memory,
  MemoryCategory,
  MemoryItemState,
  MemoryRecallResult,
  MemoryRecallRun,
  MemoryRecallType,
  MemoryStability,
  SubjectRef,
  UUID,
} from "@synapse/shared"
import {
  extractText,
  MEMORY_PERMISSION,
  normalizeCanonicalContentBlocks,
  SUBJECT_KIND,
  textBlocks,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { sql, type RawBuilder } from "kysely"
import { v4 as uuidv4 } from "uuid"
import { parseInstantString } from "../../infrastructure/datetime.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import {
  buildMemorySearchText,
  buildMemoryTextDigest,
  queueMemoryItemEmbeddingIndex,
  rebuildMemoryItemLexicalIndex,
} from "./indexing.js"
import { embedMemoryQueryCached } from "./embedding-cache.js"
import {
  expandMemoryLexicalQueries,
  extractMemoryKeywords,
  tokenizeMemorySearchText,
} from "./query-expansion.js"
import {
  buildNormalizedMessageContent,
  itemPartsToCanonicalContentBlocks,
} from "../chat/message-content.js"
import {
  actorSubject,
  type AccessSubject,
  workspaceMemberSubject,
} from "../access/service.js"
import { presentMemoryRow } from "./presenter.js"
import { MemoryError } from "./errors.js"
import {
  authorizePermissionDefault,
  buildRuntimePrincipalContextDefault,
  createMemoryItemTx,
  filterAuthorizedPermissionResourceIdsDefault,
  findExistingMemorySpace,
  getMemoryRow,
  hasMemorySpaceOwnerImplicitPermissionForTupleDefault,
  insertMemoryRecallRunTx,
  listMemoryCandidateRows,
  listMemoryItemPartRows,
  listSpaceLevelGrantSpaceIdsDefault,
  loadAccessSubjectRows,
  loadOwnerImplicitSpaceIds as loadOwnerImplicitSpaceIdsRepo,
  moveMemoryItemToSpaceTx,
  searchLexicalCandidateRows,
  searchVectorCandidateRows,
  softDeleteMemoryItemTx,
  updateMemoryItemTx,
  upsertMemorySubject,
} from "./repo.js"
import type {
  MemoryItemsMetadata,
  MemoryRecallRunResultsMatchedTerms,
  MemoryRecallRunResultsMetadata,
  MemoryRow,
} from "./repo.types.js"

// Re-export so existing importers (controller.ts) keep their import path.
// `MemoryError` and `findExistingMemorySpace` are also imported locally above;
// these statements simply surface them under their original module path.
export { MemoryError }
export { findExistingMemorySpace }

const log = createLogger("memory")

/**
 * D4: `memory_spaces` is now keyed by (owner_subject_id, scope_subject_id?,
 * namespace_key). The 5 legacy presets (workspace_shared / conversation_shared
 * / actor_private / participant_private / user_private) translate to:
 *   - workspace_shared    -> owner=workspace, scope=none
 *   - conversation_shared -> owner=conversation, scope=none
 *   - actor_private       -> owner=actor, scope=none
 *   - participant_private -> owner=actor, scope=conversation
 *   - user_private        -> owner=workspace_member, scope=none
 * Translation is exposed via {@link presetToOwnerScope} for backward-compat
 * with controller / orchestrator / AI tool surfaces that still accept the
 * literal preset strings.
 */
export type MemoryPreset =
  | "workspace_shared"
  | "conversation_shared"
  | "actor_private"
  | "participant_private"
  | "user_private"

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

type SearchCandidateRow = MemoryRow & {
  matched_chunk_id: string
  chunk_search_text: string
  text_score?: number | null
  similarity_score?: number | null
  vector_score?: number | null
  rrf_score?: number | null
}

/**
 * Loose target description carried through the access layer. We keep the
 * legacy actor / conversation / workspaceMember projection because:
 *   - the controller / orchestrator still receive it from request bodies, and
 *   - the access layer's filterAuthorizedPermissionResourceIds still keys on
 *     AccessSubject (actor / workspace_member / user).
 *
 * The new subject layer additionally lifts these into a SubjectRef-shaped
 * principal context — see `buildMemoryRuntimeContext`.
 */
export type MemoryAccessTarget = {
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
  directWorkspaceMemberId?: string
  accessSubject?: AccessSubject
}

const MEMORY_RECALL_MAX_CONTEXT_SNIPPETS = 8
const MEMORY_RECALL_SNIPPET_MAX_CHARS = 240
const MEMORY_RECALL_QUERY_MAX_CHARS = 1_200
const MEMORY_LEXICAL_TOKEN_LIMIT = 24
const MEMORY_LEXICAL_QUERY_MAX_CHARS = 512
const MEMORY_RRF_K = 60

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function truncateText(value: string, maxChars: number) {
  const ellipsis = "..."
  if (maxChars <= 0) return ""
  if (maxChars <= ellipsis.length) return ellipsis.slice(0, maxChars)

  const codePoints = Array.from(value)
  if (codePoints.length <= maxChars) return value
  return (
    codePoints
      .slice(0, Math.max(0, maxChars - ellipsis.length))
      .join("")
      .trimEnd() + ellipsis
  )
}

function buildLexicalVariants(queryText: string) {
  return expandMemoryLexicalQueries(queryText, {
    keywordLimit: MEMORY_LEXICAL_TOKEN_LIMIT,
  }).map((value) => truncateText(value, MEMORY_LEXICAL_QUERY_MAX_CHARS))
}

function isTsqueryStackOverflow(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    /tsquery stack too small/i.test((error as { message: string }).message)
  )
}

function computeMatchedTerms(queryText: string, candidateText: string) {
  const queryTokens = extractMemoryKeywords(queryText)
  const candidateTokens = new Set(tokenizeMemorySearchText(candidateText))
  return queryTokens.filter((token) => candidateTokens.has(token))
}

/**
 * D4: subject-aware preset translation. Returns the (owner, scope?) tuple
 * for a legacy preset name, given enough request context to construct the
 * owner / scope subjects. Returns null when the request context is
 * insufficient (e.g. participant_private without actorId+conversationId).
 */
export function presetToOwnerScope(
  preset: MemoryPreset,
  ctx: {
    workspaceId: string
    actorId?: string
    conversationId?: string
    workspaceMemberId?: string
  }
): { owner: SubjectRef; scope?: SubjectRef } | null {
  switch (preset) {
    case "workspace_shared":
      return {
        owner: { kind: SUBJECT_KIND.WORKSPACE, workspaceId: ctx.workspaceId },
      }
    case "conversation_shared":
      if (!ctx.conversationId) return null
      return {
        owner: {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: ctx.conversationId,
        },
      }
    case "actor_private":
      if (!ctx.actorId) return null
      return { owner: { kind: SUBJECT_KIND.ACTOR, actorId: ctx.actorId } }
    case "participant_private":
      if (!ctx.actorId || !ctx.conversationId) return null
      return {
        owner: { kind: SUBJECT_KIND.ACTOR, actorId: ctx.actorId },
        scope: {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: ctx.conversationId,
        },
      }
    case "user_private":
      // "user_private" historically meant workspace_member; the plan keeps
      // it at workspace_member kind ("本轮不启 platform user memory").
      if (!ctx.workspaceMemberId) return null
      return {
        owner: {
          kind: SUBJECT_KIND.WORKSPACE_MEMBER,
          memberId: ctx.workspaceMemberId,
        },
      }
    default:
      return null
  }
}

/**
 * Best-effort reverse mapping: given an (owner, scope?) tuple, return the
 * matching legacy preset name. Useful for UI labels. Returns null for
 * combinations that don't correspond to any legacy preset (e.g.
 * remote_agent ownership, custom namespace_key).
 */
export function inferMemoryPreset(
  owner: SubjectRef,
  scope?: SubjectRef
): MemoryPreset | null {
  if (owner.kind === SUBJECT_KIND.WORKSPACE && !scope) return "workspace_shared"
  if (owner.kind === SUBJECT_KIND.CONVERSATION && !scope)
    return "conversation_shared"
  if (owner.kind === SUBJECT_KIND.ACTOR && !scope) return "actor_private"
  if (
    owner.kind === SUBJECT_KIND.ACTOR &&
    scope?.kind === SUBJECT_KIND.CONVERSATION
  ) {
    return "participant_private"
  }
  if (owner.kind === SUBJECT_KIND.WORKSPACE_MEMBER && !scope)
    return "user_private"
  return null
}

function buildMemoryOwnerLabel(memory: {
  owner: SubjectRef
  ownerName?: string | null
}): string {
  if (memory.ownerName) return memory.ownerName
  switch (memory.owner.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return "workspace"
    case SUBJECT_KIND.CONVERSATION:
      return "conversation"
    default:
      return memory.owner.kind
  }
}

function rankOwnerScope(owner: SubjectRef, scope?: SubjectRef) {
  // The legacy spaceRank biased toward more-specific spaces. Mirror that:
  // scoped > workspace_member > actor > conversation > workspace.
  if (scope) return 5
  switch (owner.kind) {
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return 4
    case SUBJECT_KIND.ACTOR:
      return 3
    case SUBJECT_KIND.REMOTE_AGENT:
      return 3
    case SUBJECT_KIND.CONVERSATION:
      return 2
    case SUBJECT_KIND.WORKSPACE:
    default:
      return 1
  }
}

function memoryMatchesTarget(memory: Memory, target: MemoryAccessTarget) {
  // Subject-aware match: owner subject directly indicates whose memory it is.
  const targetWorkspaceMemberId =
    target.workspaceMemberId || target.directWorkspaceMemberId
  switch (memory.owner.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return true
    case SUBJECT_KIND.CONVERSATION:
      return Boolean(
        target.conversationId &&
        memory.owner.conversationId === target.conversationId
      )
    case SUBJECT_KIND.ACTOR:
      if (!target.actorId || memory.owner.actorId !== target.actorId) {
        return false
      }
      if (memory.scope?.kind === SUBJECT_KIND.CONVERSATION) {
        return memory.scope.conversationId === target.conversationId
      }
      return true
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return Boolean(
        targetWorkspaceMemberId &&
        memory.owner.memberId === targetWorkspaceMemberId
      )
    case SUBJECT_KIND.REMOTE_AGENT:
      return false
    default:
      return false
  }
}

function deriveSpaceBoost(memory: Memory, target: MemoryAccessTarget) {
  return memoryMatchesTarget(memory, target)
    ? rankOwnerScope(memory.owner, memory.scope) * 0.03
    : 0
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function deriveSummaryDecayMultiplier(
  memory: Pick<Memory, "category" | "createdAt">
) {
  if (memory.category !== "summary") {
    return 1
  }

  const halfLifeDays = Number.isFinite(config.memory.summaryDecayHalfLifeDays)
    ? Math.max(1, config.memory.summaryDecayHalfLifeDays)
    : 30
  const floor = clamp01(config.memory.summaryDecayFloor)
  let createdAtMs: number
  try {
    createdAtMs = parseInstantString(memory.createdAt).getTime()
  } catch {
    return 1
  }
  const ageMs = Math.max(0, Date.now() - createdAtMs)
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  const lambda = Math.LN2 / halfLifeDays
  return floor + (1 - floor) * Math.exp(-lambda * ageDays)
}

function computeBaseScore(
  row: SearchCandidateRow,
  memory: Memory,
  target: MemoryAccessTarget
) {
  const rrfScore = clamp01((row.rrf_score ?? 0) * 18)
  const vectorScore = Math.max(0, row.vector_score ?? 0)
  const textScore = clamp01(row.text_score ?? 0)
  const similarityScore = clamp01(row.similarity_score ?? 0)
  const importanceScore = clamp01(row.importance ?? 0)
  const confidenceScore = clamp01(row.confidence ?? 0)
  const baseScore =
    rrfScore * 0.5 +
    vectorScore * 0.2 +
    textScore * 0.1 +
    similarityScore * 0.05 +
    importanceScore * 0.07 +
    confidenceScore * 0.04 +
    deriveSpaceBoost(memory, target)
  return baseScore * deriveSummaryDecayMultiplier(memory)
}

function jaccardSimilarity(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  const smaller = left.size <= right.size ? left : right
  const larger = left.size <= right.size ? right : left
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union > 0 ? intersection / union : 0
}

function applyMmrRerank<
  T extends { baseScore: number; mmrTokens: Set<string> },
>(items: T[], limit: number) {
  if (items.length <= 1) return items

  const candidatePoolSize = Math.min(
    items.length,
    Math.max(
      12,
      Math.max(1, limit) * Math.max(1, config.memory.mmrCandidateMultiplier)
    )
  )
  const lambda = clamp01(config.memory.mmrLambda)
  const head = items.slice(0, candidatePoolSize)
  const tail = items.slice(head.length)

  const maxScore = Math.max(...head.map((item) => item.baseScore))
  const minScore = Math.min(...head.map((item) => item.baseScore))
  const scoreRange = maxScore - minScore
  const normalizeScore = (score: number) =>
    scoreRange > 0 ? (score - minScore) / scoreRange : 1

  const selected: T[] = []
  const remaining = new Set(head)

  while (remaining.size > 0) {
    let bestItem: T | null = null
    let bestScore = -Infinity

    for (const item of remaining) {
      const relevance = normalizeScore(item.baseScore)
      let maxSimilarity = 0
      for (const selectedItem of selected) {
        maxSimilarity = Math.max(
          maxSimilarity,
          jaccardSimilarity(item.mmrTokens, selectedItem.mmrTokens)
        )
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity
      if (
        mmrScore > bestScore ||
        (mmrScore === bestScore &&
          item.baseScore > (bestItem?.baseScore ?? -Infinity))
      ) {
        bestItem = item
        bestScore = mmrScore
      }
    }

    if (!bestItem) break
    selected.push(bestItem)
    remaining.delete(bestItem)
  }

  return [...selected, ...tail]
}

async function loadMemoryItemsFromRows(rows: MemoryRow[]) {
  if (rows.length === 0) return []

  const memoryIds = rows.map((row) => row.id)
  const partsResult = await listMemoryItemPartRows(memoryIds)

  const partsByMemoryId = new Map<string, MemoryPartRow[]>()
  for (const row of partsResult as MemoryPartRow[]) {
    if (!partsByMemoryId.has(row.memoryItemId)) {
      partsByMemoryId.set(row.memoryItemId, [])
    }
    partsByMemoryId.get(row.memoryItemId)!.push(row)
  }

  return rows.map((row) =>
    presentMemoryRow(
      row,
      itemPartsToCanonicalContentBlocks(partsByMemoryId.get(row.id) || [])
    )
  )
}

/**
 * Pure owner-kind / scope-kind allowlist check (no DB). Rejects
 * user/external/platform owners and non-workspace|conversation scopes with a
 * friendly 400. Used up-front by createMemory (the check formerly lived inside
 * resolveOrCreateMemorySpace's transaction, but it always threw before any
 * write) and reused inside validateMemorySpaceTuple.
 */
function assertMemorySpaceTupleKinds(owner: SubjectRef, scope?: SubjectRef) {
  const ownerKind = owner.kind
  if (
    ownerKind === SUBJECT_KIND.USER ||
    ownerKind === SUBJECT_KIND.EXTERNAL ||
    ownerKind === SUBJECT_KIND.PLATFORM
  ) {
    throw new MemoryError(
      `Memory space owner kind '${ownerKind}' is not permitted`,
      400
    )
  }
  if (
    scope &&
    scope.kind !== SUBJECT_KIND.WORKSPACE &&
    scope.kind !== SUBJECT_KIND.CONVERSATION
  ) {
    throw new MemoryError(
      `Memory space scope kind '${scope.kind}' must be workspace|conversation`,
      400
    )
  }
}

/**
 * Post-D4 round 3 review: validate a (workspaceId, owner, scope?) tuple
 * BEFORE writing anything. Catches cross-workspace owner/scope or invalid
 * owner kind up-front with a friendly 400 instead of letting the
 * trigger raise — and pairs with `findExistingMemorySpace` +
 * `canWriteToMemorySpaceTuple` to keep the auth gate side-effect-free.
 *
 * Returns the upserted subject_ids so the caller (controller) can reuse
 * them for the existing-row lookup. Upserting access_subjects is
 * intentionally benign — it's a lookup table; new rows are append-only
 * and don't confer any permissions on their own.
 */
export async function validateMemorySpaceTuple(
  workspaceId: string,
  owner: SubjectRef,
  scope?: SubjectRef
): Promise<{
  ownerSubjectId: string
  scopeSubjectId: string | null
}> {
  assertMemorySpaceTupleKinds(owner, scope)

  // Workspace consistency: the subject upsert resolves the canonical
  // workspace_id stored on the access_subjects row. We compare against
  // the target workspace before touching memory_spaces so cross-workspace
  // owner/scope is caught here (400) rather than at the DB trigger (500).
  //
  // Round 4 review fix: upsertAccessSubject throws a plain `Error`
  // ("...not found") when the referenced entity (actor/conversation/...)
  // doesn't exist. The controller catches MemoryError only, so a bad
  // owner/scope id would bubble as 500. Wrap each upsert so we get a
  // clean 404 (entity missing) instead.
  const safeUpsert = async (
    ref: SubjectRef,
    label: "owner" | "scope"
  ): Promise<string> => {
    try {
      return await upsertMemorySubject(ref)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) {
        throw new MemoryError(
          `Memory space ${label} not found: ${message}`,
          404
        )
      }
      throw error
    }
  }
  const ownerSubjectId = await safeUpsert(owner, "owner")
  const scopeSubjectId = scope ? await safeUpsert(scope, "scope") : null

  const subjectRows = await loadAccessSubjectRows(
    scopeSubjectId ? [ownerSubjectId, scopeSubjectId] : [ownerSubjectId]
  )
  const byId = new Map(subjectRows.map((r) => [r.id, r]))
  const ownerRow = byId.get(ownerSubjectId)
  const scopeRow = scopeSubjectId ? byId.get(scopeSubjectId) : null

  if (
    !ownerRow ||
    !ownerRow.workspaceId ||
    ownerRow.workspaceId !== workspaceId
  ) {
    throw new MemoryError(
      `Memory space owner does not belong to workspace ${workspaceId}`,
      400
    )
  }
  if (
    scopeRow &&
    (!scopeRow.workspaceId || scopeRow.workspaceId !== workspaceId)
  ) {
    throw new MemoryError(
      `Memory space scope does not belong to workspace ${workspaceId}`,
      400
    )
  }

  return { ownerSubjectId, scopeSubjectId }
}

// `findExistingMemorySpace` and `resolveOrCreateMemorySpace` moved to repo.ts
// (guard r8 — they own DB access / a raw ON CONFLICT upsert) and are
// re-exported from this module above so existing importers stay unchanged.

async function normalizeMemoryContent(input: {
  content?: string
  contentBlocks?: CanonicalContentBlockInput[]
  textDigest?: string
  searchText?: string
  tags?: string[]
  category?: string
}) {
  const normalized = await buildNormalizedMessageContent({
    content: input.content || "",
    contentBlocks: input.contentBlocks,
    metadata: {},
  })

  const textDigest =
    (input.textDigest || "").trim() ||
    buildMemoryTextDigest({
      contentBlocks: normalized.contentBlocks,
    })
  const searchText =
    (input.searchText || "").trim() ||
    buildMemorySearchText({
      contentBlocks: normalized.contentBlocks,
      textDigest,
      tags: input.tags,
      category: input.category,
    })

  if (!textDigest && !searchText && normalized.contentBlocks.length === 0) {
    throw new MemoryError("Memory content is required", 400)
  }

  return {
    parts: normalized.parts,
    contentBlocks: normalized.contentBlocks,
    textDigest,
    searchText,
  }
}

// `insertMemoryParts` / `maybeMarkSuperseded` moved into repo.ts (they run on
// the transaction executor inside createMemoryItemTx / updateMemoryItemTx).

export interface CreateMemoryInput {
  owner: SubjectRef
  scope?: SubjectRef
  namespaceKey?: string
  category: MemoryCategory
  state?: MemoryItemState
  status?: MemoryItemState
  stability?: MemoryStability
  importance?: number
  confidence?: number
  tags?: string[]
  content?: string
  contentBlocks?: CanonicalContentBlockInput[]
  textDigest?: string
  searchText?: string
  sourceItemId?: string
  sourceToolCallId?: string
  sourceTurnId?: string
  supersedesMemoryId?: string
  metadata?: Record<string, unknown>
}

export interface UpdateMemoryInput {
  category?: MemoryCategory
  state?: MemoryItemState
  status?: MemoryItemState
  stability?: MemoryStability
  importance?: number
  confidence?: number
  tags?: string[]
  content?: string
  contentBlocks?: CanonicalContentBlockInput[]
  textDigest?: string
  searchText?: string
  sourceItemId?: string
  sourceToolCallId?: string
  sourceTurnId?: string
  supersedesMemoryId?: string
  metadata?: Record<string, unknown>
}

export interface ListMemoriesInput extends MemoryAccessTarget {
  owner?: SubjectRef
  scope?: SubjectRef
  namespaceKey?: string
  category?: MemoryCategory
  state?: MemoryItemState
  status?: MemoryItemState
  tags?: string[]
  limit?: number
}

export interface SearchMemoriesInput extends MemoryAccessTarget {
  queryText: string
  owners?: SubjectRef[]
  scopes?: SubjectRef[]
  namespaceKeys?: string[]
  categories?: MemoryCategory[]
  states?: MemoryItemState[]
  statuses?: MemoryItemState[]
  limit?: number
  metadata?: Record<string, unknown>
}

export interface RecallMemoriesInput extends SearchMemoriesInput {
  recallType: Exclude<MemoryRecallType, "manual_search">
  queryBlocks?: CanonicalContentBlockInput[]
}

/**
 * Whether the caller has a workspace-bound principal context — i.e. one
 * that earns the reachability gate in search/recall. Originally this only
 * accepted actor principals (the legacy "actor private" path), but
 * workspace_member callers need the same gate or the candidate window
 * fills with unreadable rows and the post-fetch authz filter throws away
 * authorized rows along with them (LIMIT eats the budget).
 *
 * Returns false only when no principal can be resolved — that's the
 * legacy unauthenticated list path, which keeps the wide-open candidate
 * set so the post-fetch filter still has a chance to work.
 */
function hasPrincipalSearchContext(
  input: Pick<
    SearchMemoriesInput,
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

function isActorSearchContext(
  input: Pick<
    SearchMemoriesInput,
    "actorId" | "workspaceMemberId" | "accessSubject"
  >
) {
  if (input.accessSubject?.type === "actor") {
    return true
  }
  if (
    input.accessSubject?.type === "workspace_member" ||
    input.accessSubject?.type === "user"
  ) {
    return false
  }
  return Boolean(input.actorId && !input.workspaceMemberId)
}

function buildOwnerScopeFilter(params: {
  spaceAlias: string
  owners?: SubjectRef[]
  scopes?: SubjectRef[]
  namespaceKeys?: string[]
}) {
  const conditions: RawBuilder<unknown>[] = []
  const space = sql.raw(params.spaceAlias)

  if (params.namespaceKeys && params.namespaceKeys.length > 0) {
    conditions.push(
      sql`${space}.namespace_key = ANY(${params.namespaceKeys}::text[])`
    )
  }

  // owner / scope filtering operates via the joined access_subjects rows.
  // For each owner SubjectRef we accept any subject_id matching the requested
  // kind+id; for scope similarly.
  return conditions
}

async function subjectIdsForRefs(refs: SubjectRef[]): Promise<string[]> {
  const ids: string[] = []
  for (const ref of refs) {
    ids.push(await upsertMemorySubject(ref))
  }
  return Array.from(new Set(ids))
}

function buildSearchFilters(
  workspaceId: string,
  input: SearchMemoriesInput,
  itemAlias = "mi",
  spaceAlias = "ms",
  /**
   * Space-level grant-reachable memory_space ids — these widen the visibility
   * filter so a granted space (where the principal isn't the owner) still
   * shows up in list/search/recall candidate SQL.
   */
  grantSpaceIds: readonly string[] = [],
  /** Owner-implicit reachable memory_space ids derived from runtimeSubjectIds. */
  ownerSpaceIds: readonly string[] = [],
  /**
   * P2 fix (post-D4): caller-supplied owner / scope filters from
   * `SearchMemoriesInput.owners` and `.scopes`. The schema accepted them but
   * the SQL ignored them, so a UI filter like "only actor X's memories"
   * silently degraded to "every reachable memory". When provided we restrict
   * the candidate set by intersecting with the corresponding access_subjects
   * ids (resolved once by the caller and passed through here).
   */
  ownerSubjectIdFilters: readonly string[] = [],
  scopeSubjectIdFilters: readonly string[] = [],
  scopeFilterIncludesUnscoped = false
) {
  const item = sql.raw(itemAlias)
  const space = sql.raw(spaceAlias)
  const conditions: RawBuilder<unknown>[] = [
    sql`${item}.workspace_id = ${workspaceId}`,
  ]

  if (input.namespaceKeys && input.namespaceKeys.length > 0) {
    conditions.push(
      sql`${space}.namespace_key = ANY(${input.namespaceKeys}::text[])`
    )
  }

  if (ownerSubjectIdFilters.length > 0) {
    conditions.push(
      sql`${space}.owner_subject_id = ANY(${[...ownerSubjectIdFilters]}::uuid[])`
    )
  }

  if (scopeSubjectIdFilters.length > 0) {
    if (scopeFilterIncludesUnscoped) {
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

  // Reachability gate: any workspace-bound principal (actor OR
  // workspace_member) is restricted to spaces they have implicit owner
  // access to plus spaces with active space-level grants. The union of
  // (ownerSpaceIds, grantSpaceIds) bounds the candidate set so the SQL
  // LIMIT doesn't push authorized rows out of the window before the
  // post-fetch authz filter runs.
  //
  // Round-7 review fix: the old `isActorSearchContext` check excluded
  // `workspace_member` from this gate, so dashboard search/recall hit
  // the workspace's full memory_items, scored unreachable rows alongside
  // authorized ones, and lost the latter to LIMIT. Broadened to any
  // resolved principal context.
  if (hasPrincipalSearchContext(input)) {
    const reachable = Array.from(new Set([...ownerSpaceIds, ...grantSpaceIds]))
    if (reachable.length === 0) {
      conditions.push(sql`FALSE`)
    } else {
      conditions.push(sql`${space}.id = ANY(${reachable}::uuid[])`)
    }
  }

  return sql`${sql.join(conditions, sql` AND `)}`
}

async function searchLexicalCandidates(
  workspaceId: string,
  input: SearchMemoriesInput,
  candidateLimit: number,
  queryText: string,
  grantSpaceIds: readonly string[] = [],
  ownerSpaceIds: readonly string[] = [],
  ownerSubjectIdFilters: readonly string[] = [],
  scopeSubjectIdFilters: readonly string[] = [],
  scopeFilterIncludesUnscoped = false
) {
  const whereClause = buildSearchFilters(
    workspaceId,
    input,
    "mi",
    "ms",
    grantSpaceIds,
    ownerSpaceIds,
    ownerSubjectIdFilters,
    scopeSubjectIdFilters,
    scopeFilterIncludesUnscoped
  )
  if (!queryText) return []
  const normalizedQueryText = normalizeWhitespace(queryText).toLowerCase()
  return searchLexicalCandidateRows({
    whereClause,
    queryText,
    normalizedQueryText,
    candidateLimit,
  })
}

async function searchVectorCandidates(
  workspaceId: string,
  input: SearchMemoriesInput,
  embedding: number[],
  candidateLimit: number,
  grantSpaceIds: readonly string[] = [],
  ownerSpaceIds: readonly string[] = [],
  ownerSubjectIdFilters: readonly string[] = [],
  scopeSubjectIdFilters: readonly string[] = [],
  scopeFilterIncludesUnscoped = false
) {
  const whereClause = buildSearchFilters(
    workspaceId,
    input,
    "mi",
    "ms",
    grantSpaceIds,
    ownerSpaceIds,
    ownerSubjectIdFilters,
    scopeSubjectIdFilters,
    scopeFilterIncludesUnscoped
  )
  const formattedEmbedding = `[${embedding.map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0")).join(",")}]`
  return searchVectorCandidateRows({
    whereClause,
    formattedEmbedding,
    candidateLimit,
  })
}

function fuseCandidateRows(sources: Array<{ rows: SearchCandidateRow[] }>) {
  const byChunkKey = new Map<string, SearchCandidateRow>()

  for (const source of sources) {
    source.rows.forEach((row, index) => {
      const key = `${row.id}:${row.matched_chunk_id}`
      const contribution = 1 / (MEMORY_RRF_K + index + 1)
      const existing = byChunkKey.get(key)

      if (!existing) {
        byChunkKey.set(key, {
          ...row,
          rrf_score: contribution,
        })
        return
      }

      existing.rrf_score = (existing.rrf_score ?? 0) + contribution
      existing.text_score = Math.max(
        existing.text_score ?? 0,
        row.text_score ?? 0
      )
      existing.similarity_score = Math.max(
        existing.similarity_score ?? 0,
        row.similarity_score ?? 0
      )
      existing.vector_score = Math.max(
        existing.vector_score ?? 0,
        row.vector_score ?? 0
      )
    })
  }

  return Array.from(byChunkKey.values()).sort(
    (left, right) => (right.rrf_score ?? 0) - (left.rrf_score ?? 0)
  )
}

function resolveAccessSubject(target: MemoryAccessTarget) {
  if (target.accessSubject) return target.accessSubject
  if (target.actorId) return actorSubject(target.actorId)
  if (target.workspaceMemberId)
    return workspaceMemberSubject(target.workspaceMemberId)
  return null
}

function resolveSubjectRef(subject: AccessSubject | null): SubjectRef | null {
  if (!subject) return null
  switch (subject.type) {
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: subject.id }
    case "workspace_member":
      return { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: subject.id }
    default:
      // `user` kind isn't workspace-bound and can't anchor a memory grant.
      return null
  }
}

async function buildMemoryRuntimeContext(
  workspaceId: string,
  target: MemoryAccessTarget,
  subject: AccessSubject | null
) {
  const principal = resolveSubjectRef(subject)
  if (!principal) return null
  try {
    return await buildRuntimePrincipalContextDefault({
      principal,
      workspaceId,
      conversationId: target.conversationId ?? null,
    })
  } catch {
    return null
  }
}

async function loadSpaceLevelGrantSpaceIds(
  workspaceId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof buildMemoryRuntimeContext>>>,
  permission: "read" | "recall"
): Promise<string[]> {
  return listSpaceLevelGrantSpaceIdsDefault({
    workspaceId,
    permission:
      permission === "recall"
        ? MEMORY_PERMISSION.RECALL
        : MEMORY_PERMISSION.READ,
    runtimeSubjectIds: ctx.runtimeSubjectIds,
    runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
  })
}

/**
 * D4: spaces the principal can read by owner-implicit permission. The
 * implicit-permission rule is: `owner_subject_id ∈ runtimeSubjectIds AND
 * (scope_subject_id IS NULL OR scope_subject_id ∈ runtimeScopeSubjectIds)`.
 * Used as a SQL-side filter to widen the candidate set. The query lives in
 * repo.ts; this wrapper keeps the runtime-context-shaped call signature.
 */
async function loadOwnerImplicitSpaceIds(
  workspaceId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof buildMemoryRuntimeContext>>>
): Promise<string[]> {
  return loadOwnerImplicitSpaceIdsRepo(
    workspaceId,
    ctx.runtimeSubjectIds,
    ctx.runtimeScopeSubjectIds
  )
}

/**
 * (Removed in P1 review fix.) An earlier round added an admin reachability
 * widener that added unscoped private spaces (actor / member / remote_agent
 * owned) to the list/search candidate set when the principal had workspace
 * `manage_memories`. That contradicted the evaluator's owner-implicit matrix,
 * which only grants `manage_memories` admins `manage` / `delete` on those
 * spaces (NOT `read` / `recall`). The widener would surface unreadable rows
 * that the post-fetch authz filter would then reject — but only after the
 * SQL `LIMIT` had pushed authorized rows out of the candidate window, causing
 * false negatives. Removed: admin's `read/recall` is intentionally narrower
 * than their `manage/delete`, and list/search must reflect that. Admin who
 * needs to read a private space's contents has to be granted access
 * explicitly via memory_access_grants.
 */

async function buildSearchHits(params: {
  workspaceId: UUID
  rows: SearchCandidateRow[]
  queryText: string
  target: MemoryAccessTarget
  permission: "read" | "recall"
  limit: number
  runtimeContext: Awaited<ReturnType<typeof buildMemoryRuntimeContext>>
}) {
  const subject = resolveAccessSubject(params.target)
  let rows = params.rows

  if (rows.length > 0 && subject) {
    // Post-fetch auth gate honors space-level + item-level grant overlays
    // (memory_access_grants with memory_item_id pointed at this item).
    // For the rare case of grant=item-only on an item whose space the
    // principal can't reach via owner_implicit/space-grant, the SQL filter
    // already excluded the row — and that's intentional: the SQL gate is
    // about reachability of the space; the item-level overlay only widens
    // permission within a space the principal can already see.
    const allowedIds = new Set(
      await filterAuthorizedPermissionResourceIdsDefault({
        subject,
        resourceType: "memory_item",
        permission: params.permission,
        resourceIds: rows.map((row) => row.id),
        runtimeSubjectIds: params.runtimeContext?.runtimeSubjectIds,
        runtimeScopeSubjectIds: params.runtimeContext?.runtimeScopeSubjectIds,
      })
    )
    rows = rows.filter((row) => allowedIds.has(row.id))
  }

  const bestByMemoryId = new Map<string, SearchCandidateRow>()
  for (const row of rows) {
    const existing = bestByMemoryId.get(row.id)
    if (!existing || (existing.rrf_score ?? 0) < (row.rrf_score ?? 0)) {
      bestByMemoryId.set(row.id, row)
    }
  }

  const candidateRows = Array.from(bestByMemoryId.values())
  const memories = await loadMemoryItemsFromRows(candidateRows)
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]))

  const orderedRows = candidateRows
    .map((row) => {
      const memory = memoryById.get(row.id)!
      return {
        row,
        memory,
        baseScore: computeBaseScore(row, memory, params.target),
        mmrTokens: new Set(
          tokenizeMemorySearchText(
            row.chunk_search_text || memory.textDigest || memory.searchText
          )
        ),
      }
    })
    .sort((left, right) => right.baseScore - left.baseScore)

  const rerankedRows = applyMmrRerank(orderedRows, params.limit).slice(
    0,
    params.limit
  )

  return rerankedRows.map(
    ({ row, memory, baseScore }, index) =>
      ({
        ...memory,
        matchedChunkId: row.matched_chunk_id,
        rank: index + 1,
        finalScore: baseScore,
        vectorScore: row.vector_score ?? undefined,
        textScore: row.text_score ?? undefined,
        similarityScore: row.similarity_score ?? undefined,
        matchedTerms: computeMatchedTerms(
          params.queryText,
          row.chunk_search_text
        ),
      }) satisfies MemoryRecallResult
  )
}

async function recordMemoryRecallRun(params: {
  workspaceId: string
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
  recallType: MemoryRecallType
  queryText: string
  queryBlocks?: CanonicalContentBlockInput[]
  metadata?: Record<string, unknown>
  results: MemoryRecallResult[]
}): Promise<MemoryRecallRun> {
  const normalizedQueryBlocks = normalizeCanonicalContentBlocks(
    params.queryBlocks || []
  )
  const runId = uuidv4()
  await insertMemoryRecallRunTx({
    runId,
    workspaceId: params.workspaceId,
    actorId: params.actorId || null,
    conversationId: params.conversationId || null,
    workspaceMemberId: params.workspaceMemberId || null,
    recallType: params.recallType,
    queryText: params.queryText,
    queryBlocksJson: JSON.stringify(normalizedQueryBlocks),
    metadataJson: JSON.stringify(params.metadata || {}),
    results: params.results.map((result) => ({
      memoryItemId: result.id,
      matchedChunkId: result.matchedChunkId || null,
      rank: result.rank,
      finalScore: result.finalScore,
      vectorScore: result.vectorScore ?? null,
      textScore: result.textScore ?? null,
      similarityScore: result.similarityScore ?? null,
      matchedTerms: (result.matchedTerms ??
        []) as MemoryRecallRunResultsMatchedTerms,
      recallReason: result.recallReason || null,
      metadata: {
        ownerKind: result.owner.kind,
        scopeKind: result.scope?.kind,
        namespaceKey: result.namespaceKey,
        category: result.category,
      } as MemoryRecallRunResultsMetadata,
    })),
  })

  return {
    id: runId,
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
    workspaceMemberId: params.workspaceMemberId,
    recallType: params.recallType,
    queryText: params.queryText,
    queryBlocks: normalizedQueryBlocks,
    metadata: params.metadata || {},
    createdAt: nowIsoInstant(),
    results: params.results,
  }
}

function buildDefaultRecallReason(memory: Memory, target: MemoryAccessTarget) {
  const preset = inferMemoryPreset(memory.owner, memory.scope)
  switch (preset) {
    case "participant_private":
      return "Participant-private memory strongly matched the current actor and conversation"
    case "conversation_shared":
      return "Conversation-shared memory matched the current discussion"
    case "actor_private":
      return "Actor-private memory matched the current task"
    case "user_private":
      return "User-private memory matched the current member context"
    case "workspace_shared":
      return "Workspace-shared memory matched the current task"
    default:
      if (memory.owner.kind === SUBJECT_KIND.REMOTE_AGENT) {
        return "Remote agent memory matched the current task"
      }
      return "Memory matched the current task"
  }
}

export async function createMemory(
  workspaceId: UUID,
  input: CreateMemoryInput
) {
  // Owner-kind / scope-kind allowlist check up-front (was inside
  // resolveOrCreateMemorySpace's transaction; it threw before any write, so
  // hoisting it preserves behavior). Keeps the friendly 400 in the service.
  assertMemorySpaceTupleKinds(input.owner, input.scope)
  const normalizedContent = await normalizeMemoryContent(input)
  const memoryItemId = uuidv4()

  await createMemoryItemTx({
    workspaceId,
    memoryItemId,
    owner: input.owner,
    scope: input.scope,
    namespaceKey: input.namespaceKey,
    category: input.category,
    state: input.state || input.status || "active",
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    tags: input.tags || [],
    textDigest: normalizedContent.textDigest,
    searchText: normalizedContent.searchText,
    sourceItemId: input.sourceItemId || null,
    sourceToolCallId: input.sourceToolCallId || null,
    sourceTurnId: input.sourceTurnId || null,
    supersedesItemId: input.supersedesMemoryId || null,
    metadata: (input.metadata || {}) as MemoryItemsMetadata,
    parts: normalizedContent.parts,
    supersedesMemoryId: input.supersedesMemoryId,
  })

  const lexicalIndex = await rebuildMemoryItemLexicalIndex(memoryItemId)
  if (lexicalIndex) {
    await queueMemoryItemEmbeddingIndex(memoryItemId, lexicalIndex.indexVersion)
  }

  const memory = await getMemory(workspaceId, memoryItemId)
  await emitEvent({
    type: "memory.created",
    workspaceId,
    payload: {
      memoryId: memory.id,
      ownerKind: memory.owner.kind,
      scopeKind: memory.scope?.kind,
      namespaceKey: memory.namespaceKey,
    },
    timestamp: nowIsoInstant(),
  })
  return memory
}

export async function getMemory(workspaceId: UUID, memoryId: UUID) {
  const row = await getMemoryRow(workspaceId, memoryId)
  if (!row) {
    throw new MemoryError("Memory not found", 404)
  }
  const [memory] = await loadMemoryItemsFromRows([row])
  return memory
}

/**
 * D4: cross-space "moves" are no longer supported via update — per the plan
 * "memory cross-space move = source delete + target write". updateMemory
 * only touches content / tags / importance / state. The controller layer
 * may still expose a separate move endpoint that wraps delete + create.
 */
export async function updateMemory(
  workspaceId: UUID,
  memoryId: UUID,
  input: UpdateMemoryInput
) {
  const existingRow = await getMemoryRow(workspaceId, memoryId)
  if (!existingRow) {
    throw new MemoryError("Memory not found", 404)
  }
  const [existing] = await loadMemoryItemsFromRows([existingRow])

  const normalizedContent = await normalizeMemoryContent({
    content: input.content,
    contentBlocks:
      input.contentBlocks ||
      (input.content === undefined ? existing.contentBlocks : undefined),
    textDigest:
      input.textDigest ||
      (input.content === undefined && !input.contentBlocks
        ? existing.textDigest
        : undefined),
    searchText: input.searchText,
    tags: input.tags || existing.tags,
    category: input.category || existing.category,
  })

  await updateMemoryItemTx({
    workspaceId,
    memoryId,
    category: input.category || existing.category,
    state: input.state || input.status || existing.state,
    importance: input.importance ?? existing.importance,
    confidence: input.confidence ?? existing.confidence,
    tags: input.tags || existing.tags,
    textDigest: normalizedContent.textDigest,
    searchText: normalizedContent.searchText,
    sourceItemId:
      input.sourceItemId !== undefined
        ? input.sourceItemId
        : existing.sourceItemId || null,
    sourceToolCallId:
      input.sourceToolCallId !== undefined
        ? input.sourceToolCallId
        : existing.sourceToolCallId || null,
    sourceTurnId:
      input.sourceTurnId !== undefined
        ? input.sourceTurnId
        : existing.sourceTurnId || null,
    supersedesItemId:
      input.supersedesMemoryId !== undefined
        ? input.supersedesMemoryId
        : existing.supersedesMemoryId || null,
    metadata: (input.metadata ||
      existing.metadata ||
      {}) as MemoryItemsMetadata,
    parts: normalizedContent.parts,
    supersedesMemoryId: input.supersedesMemoryId,
  })

  const lexicalIndex = await rebuildMemoryItemLexicalIndex(memoryId)
  if (lexicalIndex) {
    await queueMemoryItemEmbeddingIndex(memoryId, lexicalIndex.indexVersion)
  }

  return getMemory(workspaceId, memoryId)
}

export async function deleteMemory(workspaceId: UUID, memoryId: UUID) {
  const existingRow = await getMemoryRow(workspaceId, memoryId)
  if (!existingRow) {
    throw new MemoryError("Memory not found", 404)
  }
  // Soft delete (design §7.4): flip deleted_at. memory_item_parts/chunks stay
  // as aggregate-internal detail until offline purge; hard delete is forbidden
  // by sd_reject_delete.
  const deleted = await softDeleteMemoryItemTx(workspaceId, memoryId)
  if (!deleted) {
    throw new MemoryError("Memory not found", 404)
  }
}

/**
 * P1 fix (post-D4 review): atomic cross-space move. Replaces the web UI's
 * delete + create dance, which dropped item-level grants, indexing state,
 * source-* relations and the stable id whenever a memory hopped folders,
 * and risked losing data entirely if the create-side failed.
 *
 * Permission contract: the caller must have `delete` on the SOURCE space
 * AND `write` on the TARGET space — the same rule the documented
 * "source delete + target write" pattern required. Source `delete` is
 * asserted at the controller boundary (via `requireMemoryPermission`);
 * target `write` is asserted here.
 *
 * Post-D4 round 3 review (P2): detect-then-check-then-create. The earlier
 * iteration upserted the target space first and then asked the evaluator
 * for write — that leaked an empty orphan target row on every denial.
 * Now we:
 *   1. validate the (workspace, owner, scope?) tuple (workspace alignment
 *      and owner-kind allowlist) up-front (clean 400 instead of trigger 500)
 *   2. look up existing target space; if present, evaluate against the
 *      real row (covers owner-implicit + memory_access_grants overlay)
 *   3. if no row yet, evaluate against a synthetic owner-implicit-only
 *      tuple — no grants can target a non-existent space, so the
 *      synthetic check is equivalent and avoids any write
 *   4. only after the write check passes do we resolveOrCreateMemorySpace
 *      (creating the row if necessary) and UPDATE memory_items.memory_space_id
 *
 * The actual move runs in its own transaction with a source-exists
 * re-check so a racing delete becomes a clean 404 rather than a silent
 * 0-row UPDATE.
 */
export async function moveMemoryToSpace(
  workspaceId: UUID,
  memoryId: UUID,
  target: {
    owner: SubjectRef
    scope?: SubjectRef
    namespaceKey?: string
  },
  /**
   * The runtime context of the caller — same shape as what the controller
   * builds via `buildRuntimePrincipalContext`. The service needs it to
   * evaluate `write` permission against the target space id.
   */
  authContext: {
    accessSubject: AccessSubject
    runtimeSubjectIds: readonly string[]
    runtimeScopeSubjectIds: readonly string[]
  }
): Promise<Memory> {
  const existingRow = await getMemoryRow(workspaceId, memoryId)
  if (!existingRow) {
    throw new MemoryError("Memory not found", 404)
  }

  // Phase 1: validate the target tuple (workspace alignment, owner-kind
  // allowlist). Throws MemoryError(400) on mismatch.
  const subjects = await validateMemorySpaceTuple(
    workspaceId,
    target.owner,
    target.scope
  )

  // Phase 2: look up the existing target space (read-only). If it exists
  // we can evaluate against the real id (full owner-implicit + grant
  // overlay). If not, the synthetic owner-implicit check is sufficient
  // (no grants can target a non-existent space).
  const existingTarget = await findExistingMemorySpace({
    workspaceId,
    ownerSubjectId: subjects.ownerSubjectId,
    scopeSubjectId: subjects.scopeSubjectId,
    namespaceKey: target.namespaceKey,
  })

  // No-op move: source and target are the same space. Skip the permission
  // dance and the UPDATE; report the unchanged memory.
  if (existingTarget && existingTarget.id === existingRow.memory_space_id) {
    const same = await getMemory(workspaceId, memoryId)
    if (!same) {
      throw new MemoryError("Memory disappeared during move (unexpected)", 500)
    }
    return same
  }

  // Phase 3: target write permission gate.
  let writeAllowed = false
  if (existingTarget) {
    writeAllowed = await authorizePermissionDefault({
      subject: authContext.accessSubject,
      resourceType: "memory_space",
      resourceId: existingTarget.id,
      permission: "write",
      runtimeSubjectIds: authContext.runtimeSubjectIds,
      runtimeScopeSubjectIds: authContext.runtimeScopeSubjectIds,
    })
  } else {
    writeAllowed = await hasMemorySpaceOwnerImplicitPermissionForTupleDefault(
      authContext.accessSubject,
      {
        workspaceId,
        owner: target.owner,
        scope: target.scope,
        ownerSubjectId: subjects.ownerSubjectId,
        scopeSubjectId: subjects.scopeSubjectId,
      },
      "write",
      {
        runtimeSubjectIds: authContext.runtimeSubjectIds,
        runtimeScopeSubjectIds: authContext.runtimeScopeSubjectIds,
      }
    )
  }
  if (!writeAllowed) {
    throw new MemoryError(
      "Not allowed to move memory into the target space (write permission required)",
      403
    )
  }

  // Phase 4: the actual move. Create the target space (if it doesn't
  // already exist) and UPDATE the memory row in one transaction. The
  // source-exists re-check inside the txn turns a racing delete into a
  // clean 404 instead of a silent 0-row UPDATE.
  await moveMemoryItemToSpaceTx({
    workspaceId,
    memoryId,
    sourceMemorySpaceId: existingRow.memory_space_id,
    owner: target.owner,
    scope: target.scope,
    namespaceKey: target.namespaceKey,
  })
  const moved = await getMemory(workspaceId, memoryId)
  if (!moved) {
    throw new MemoryError("Memory disappeared during move (unexpected)", 500)
  }
  return moved
}

export async function listMemories(
  workspaceId: UUID,
  input: ListMemoriesInput
) {
  const requestedLimit = Math.max(1, Math.min(200, input.limit ?? 100))
  const subject = resolveAccessSubject(input)
  const runtimeContext = await buildMemoryRuntimeContext(
    workspaceId,
    input,
    subject
  )
  const ownerSpaceIds = runtimeContext
    ? await loadOwnerImplicitSpaceIds(workspaceId, runtimeContext)
    : []
  const grantSpaceIds = runtimeContext
    ? await loadSpaceLevelGrantSpaceIds(workspaceId, runtimeContext, "read")
    : []

  const conditions: RawBuilder<unknown>[] = [
    sql`mi.workspace_id = ${workspaceId}`,
  ]
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
  if (input.owner) {
    const ownerSubjectId = await upsertMemorySubject(input.owner)
    conditions.push(sql`ms.owner_subject_id = ${ownerSubjectId}`)
  }
  if (input.scope) {
    const scopeSubjectId = await upsertMemorySubject(input.scope)
    conditions.push(sql`ms.scope_subject_id = ${scopeSubjectId}`)
  }

  if (subject) {
    // Subject-based reachability gate: owner-implicit + space-grant. The
    // workspace-admin manage_memories override only unlocks manage/delete on
    // private spaces (not read/recall — see hasMemorySpaceOwnerImplicitPermission)
    // so it is NOT added here; surfacing those rows would only push authorized
    // ones out of the SQL LIMIT window before the post-fetch authz filter ran.
    const reachable = Array.from(new Set([...ownerSpaceIds, ...grantSpaceIds]))
    if (reachable.length === 0) {
      // No reachable spaces — bail early; nothing to fetch.
      return []
    }
    conditions.push(sql`ms.id = ANY(${reachable}::uuid[])`)
  }

  const whereClause = sql`${sql.join(conditions, sql` AND `)}`
  // Oversample so post-fetch authz (item-level grants) has room to swap rows.
  const candidateOversample = Math.min(2000, requestedLimit * 5)
  let rows = await listMemoryCandidateRows({
    whereClause,
    candidateOversample,
  })

  if (subject && rows.length > 0) {
    const allowedIds = new Set(
      await filterAuthorizedPermissionResourceIdsDefault({
        subject,
        resourceType: "memory_item",
        permission: "read",
        resourceIds: rows.map((row) => row.id),
        runtimeSubjectIds: runtimeContext?.runtimeSubjectIds,
        runtimeScopeSubjectIds: runtimeContext?.runtimeScopeSubjectIds,
      })
    )
    rows = rows.filter((row) => allowedIds.has(row.id))
  }

  rows = rows.slice(0, requestedLimit)
  return loadMemoryItemsFromRows(rows)
}

export async function searchMemories(
  workspaceId: UUID,
  input: SearchMemoriesInput,
  permission: "read" | "recall" = "read"
): Promise<MemoryRecallResult[]> {
  const candidateLimit = Math.max(
    input.limit ?? config.memory.recallLimit,
    config.memory.searchCandidateLimit
  )
  const queryText = input.queryText.trim()
  const lexicalSources: Array<{ rows: SearchCandidateRow[] }> = []

  const runtimeContextForSearch = await buildMemoryRuntimeContext(
    workspaceId,
    input,
    resolveAccessSubject(input)
  )
  const ownerSpaceIds = runtimeContextForSearch
    ? await loadOwnerImplicitSpaceIds(workspaceId, runtimeContextForSearch)
    : []
  const grantSpaceIds = runtimeContextForSearch
    ? await loadSpaceLevelGrantSpaceIds(
        workspaceId,
        runtimeContextForSearch,
        permission
      )
    : []
  // P2 fix (post-D4): resolve the caller-supplied owners[] / scopes[]
  // SubjectRef filters into access_subjects ids so the SQL WHERE clause can
  // restrict candidates. Previously the schema accepted these fields but the
  // SQL ignored them.
  const ownerSubjectIdFilters = input.owners
    ? await subjectIdsForRefs(input.owners)
    : []
  const scopeSubjectIdFilters = input.scopes
    ? await subjectIdsForRefs(input.scopes)
    : []

  if (queryText) {
    for (const variant of buildLexicalVariants(queryText)) {
      try {
        lexicalSources.push({
          rows: await searchLexicalCandidates(
            workspaceId,
            input,
            candidateLimit,
            variant,
            grantSpaceIds,
            ownerSpaceIds,
            ownerSubjectIdFilters,
            scopeSubjectIdFilters
          ),
        })
      } catch (error) {
        if (!isTsqueryStackOverflow(error)) throw error
        log.warn(
          {
            workspaceId,
            actorId: input.actorId,
            conversationId: input.conversationId,
            queryLength: queryText.length,
          },
          "[memory] lexical search degraded due to tsquery stack overflow"
        )
      }
    }
  }

  let vectorRows: SearchCandidateRow[] = []
  if (queryText) {
    try {
      const embedding = await embedMemoryQueryCached(queryText)
      if (embedding) {
        vectorRows = await searchVectorCandidates(
          workspaceId,
          input,
          embedding,
          candidateLimit,
          grantSpaceIds,
          ownerSpaceIds,
          ownerSubjectIdFilters,
          scopeSubjectIdFilters
        )
      }
    } catch (error) {
      log.warn(
        { err: error },
        "[memory] vector search unavailable, falling back to lexical only"
      )
    }
  }

  const fusedRows = fuseCandidateRows([...lexicalSources, { rows: vectorRows }])

  return buildSearchHits({
    workspaceId,
    rows: fusedRows,
    queryText,
    target: input,
    permission,
    limit: Math.max(1, Math.min(50, input.limit ?? config.memory.topK)),
    runtimeContext: runtimeContextForSearch,
  })
}

export async function runMemorySearch(
  workspaceId: UUID,
  input: SearchMemoriesInput
) {
  const results = await searchMemories(workspaceId, input, "read")
  const run = await recordMemoryRecallRun({
    workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
    workspaceMemberId: input.workspaceMemberId,
    recallType: "manual_search",
    queryText: input.queryText,
    queryBlocks: input.queryText ? textBlocks(input.queryText) : [],
    metadata: input.metadata,
    results,
  })
  return { run, memories: results }
}

export async function recallMemories(
  workspaceId: UUID,
  input: RecallMemoriesInput
) {
  const results = await searchMemories(workspaceId, input, "recall")
  const enrichedResults = results.map((result, index) => ({
    ...result,
    rank: index + 1,
    recallReason: buildDefaultRecallReason(result, input),
  }))

  const run = await recordMemoryRecallRun({
    workspaceId,
    actorId: input.actorId,
    conversationId: input.conversationId,
    workspaceMemberId: input.workspaceMemberId,
    recallType: input.recallType,
    queryText: input.queryText,
    queryBlocks: input.queryBlocks,
    metadata: input.metadata,
    results: enrichedResults,
  })

  return { run, memories: enrichedResults }
}

export function buildMemoryRecallQuery(params: {
  actorDisplayName?: string
  conversationTitle?: string
  contextItems: CanonicalContextItem[]
}) {
  const snippets: string[] = []
  const textualItems = params.contextItems
    .filter((item) => item.kind !== "memory_recall")
    .map((item) => {
      const parts = "parts" in item ? item.parts : undefined
      return normalizeWhitespace(extractText(parts || []).trim())
    })
    .filter(Boolean)

  const latestSnippet = textualItems.at(-1)
  if (latestSnippet) {
    snippets.push(truncateText(latestSnippet, MEMORY_RECALL_SNIPPET_MAX_CHARS))
  }
  if (params.conversationTitle) {
    snippets.push(
      truncateText(
        normalizeWhitespace(`conversation:${params.conversationTitle}`),
        MEMORY_RECALL_SNIPPET_MAX_CHARS
      )
    )
  }
  if (params.actorDisplayName) {
    snippets.push(
      truncateText(
        normalizeWhitespace(`actor:${params.actorDisplayName}`),
        MEMORY_RECALL_SNIPPET_MAX_CHARS
      )
    )
  }

  for (const text of textualItems.slice(
    -MEMORY_RECALL_MAX_CONTEXT_SNIPPETS - 1,
    -1
  )) {
    snippets.push(truncateText(text, MEMORY_RECALL_SNIPPET_MAX_CHARS))
  }

  return truncateText(snippets.join("\n").trim(), MEMORY_RECALL_QUERY_MAX_CHARS)
}
