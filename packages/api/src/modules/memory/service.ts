import type {
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  CanonicalContextItem,
  Memory,
  MemoryCategory,
  MemoryItemState,
  MemoryRecallResult,
  MemoryRecallRun,
  MemoryRecallType,
  MemorySpaceType,
  MemoryStability,
  UUID,
} from "@synapse/shared"
import {
  extractText,
  normalizeCanonicalContentBlocks,
  textBlocks,
} from "@synapse/shared"
import { sql, type RawBuilder } from "kysely"
import { v4 as uuidv4 } from "uuid"
import { SUBJECT_KIND } from "@synapse/shared"
import { transaction } from "../../infrastructure/database/index.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  db,
  executeCompiledQuery,
  executeSqlOn,
  executeTakeFirst,
  type QueryExecutor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { config } from "../../config/index.js"
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
  type DraftConversationPart,
} from "../chat/message-content.js"
import { ensureConversationActorContext } from "../session/service.js"
import {
  actorSubject,
  filterAuthorizedPermissionResourceIds,
  type AccessSubject,
  workspaceMemberSubject,
} from "../access/service.js"
import { MEMORY_PERMISSION } from "@synapse/shared"
import type { SubjectRef } from "@synapse/shared"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { listSpaceLevelGrantSpaceIds } from "./access-grant-storage.js"

type MemoryRow = {
  id: string
  workspace_id: string
  memory_space_id: string
  space_type: MemorySpaceType
  anchor_actor_id: string | null
  anchor_conversation_id: string | null
  anchor_conversation_actor_context_id: string | null
  anchor_workspace_member_id: string | null
  category: MemoryCategory
  state: MemoryItemState
  importance: number
  confidence: number
  tags: string[]
  text_digest: string
  search_text: string
  index_status: "lexical_ready" | "ready" | "failed"
  embedding_model: string
  embedding_dim: number | null
  indexed_at: string | Date | null
  index_error: string | null
  source_item_id: string | null
  source_tool_call_id: string | null
  source_turn_id: string | null
  supersedes_item_id: string | null
  metadata: Record<string, unknown> | string | null
  created_at: string | Date
  updated_at: string | Date
  actor_name?: string | null
  conversation_title?: string | null
  workspace_member_name?: string | null
  resolved_actor_id?: string | null
  resolved_conversation_id?: string | null
  resolved_workspace_member_id?: string | null
}

type MemorySpaceRow = {
  id: string
  workspace_id: string
  space_type: MemorySpaceType
  anchor_conversation_id: string | null
  anchor_actor_id: string | null
  anchor_conversation_actor_context_id: string | null
  anchor_workspace_member_id: string | null
}

type MemoryPartRow = {
  memory_item_id: string
  part_type: string
  text_value?: string | null
  file_id?: string | null
  json_value?: unknown
  mime_type?: string | null
  name?: string | null
  metadata?: Record<string, unknown> | string | null
  original_name?: string | null
  file_mime_type?: string | null
  size_bytes?: number | null
}

type SearchCandidateRow = MemoryRow & {
  matched_chunk_id: string
  chunk_search_text: string
  text_score?: number | null
  similarity_score?: number | null
  vector_score?: number | null
  rrf_score?: number | null
}

export type MemoryAccessTarget = {
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
  directWorkspaceMemberId?: string
  accessSubject?: AccessSubject
}

type MemorySpaceBinding = {
  spaceType: MemorySpaceType
  actorId?: string
  conversationId?: string
  workspaceMemberId?: string
}

const MEMORY_RECALL_MAX_CONTEXT_SNIPPETS = 8
const MEMORY_RECALL_SNIPPET_MAX_CHARS = 240
const MEMORY_RECALL_QUERY_MAX_CHARS = 1_200
const MEMORY_LEXICAL_TOKEN_LIMIT = 24
const MEMORY_LEXICAL_QUERY_MAX_CHARS = 512
const MEMORY_RRF_K = 60

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return value as Record<string, unknown>
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
}

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

function spaceRank(spaceType: MemorySpaceType) {
  switch (spaceType) {
    case "participant_private":
      return 5
    case "conversation_shared":
      return 4
    case "actor_private":
      return 3
    case "user_private":
      return 2
    case "workspace_shared":
      return 1
    default:
      return 0
  }
}

function spaceMatchesTarget(
  memory: Pick<
    Memory,
    "spaceType" | "actorId" | "conversationId" | "workspaceMemberId"
  >,
  target: MemoryAccessTarget
) {
  const targetWorkspaceMemberId =
    target.workspaceMemberId || target.directWorkspaceMemberId
  switch (memory.spaceType) {
    case "workspace_shared":
      return true
    case "conversation_shared":
      return Boolean(
        target.conversationId && memory.conversationId === target.conversationId
      )
    case "actor_private":
      return Boolean(target.actorId && memory.actorId === target.actorId)
    case "participant_private":
      return Boolean(
        target.actorId &&
        target.conversationId &&
        memory.actorId === target.actorId &&
        memory.conversationId === target.conversationId
      )
    case "user_private":
      return Boolean(
        targetWorkspaceMemberId &&
        memory.workspaceMemberId === targetWorkspaceMemberId
      )
    default:
      return false
  }
}

function deriveSpaceBoost(memory: Memory, target: MemoryAccessTarget) {
  return spaceMatchesTarget(memory, target)
    ? spaceRank(memory.spaceType) * 0.03
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
  const createdAtMs = new Date(memory.createdAt).getTime()
  if (!Number.isFinite(createdAtMs)) {
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

function mapMemoryRow(
  row: MemoryRow,
  contentBlocks: CanonicalContentBlock[]
): Memory {
  const actorId = row.resolved_actor_id ?? row.anchor_actor_id ?? undefined
  const conversationId =
    row.resolved_conversation_id ?? row.anchor_conversation_id ?? undefined
  const workspaceMemberId =
    row.resolved_workspace_member_id ??
    row.anchor_workspace_member_id ??
    undefined
  const state = row.state
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.memory_space_id,
    spaceType: row.space_type,
    ownerScope: row.space_type,
    actorId,
    conversationId,
    workspaceMemberId,
    ownerActorId: actorId,
    ownerConversationId: conversationId,
    ownerWorkspaceMemberId: workspaceMemberId,
    category: row.category,
    state,
    status: state,
    stability: "durable",
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    tags: row.tags ?? [],
    textDigest: row.text_digest || "",
    searchText: row.search_text || "",
    contentBlocks,
    sourceItemId: row.source_item_id ?? undefined,
    sourceToolCallId: row.source_tool_call_id ?? undefined,
    sourceTurnId: row.source_turn_id ?? undefined,
    supersedesMemoryId: row.supersedes_item_id ?? undefined,
    metadata: parseJsonObject(row.metadata),
    indexStatus: row.index_status,
    embeddingModel: row.embedding_model || undefined,
    embeddingDim: row.embedding_dim ?? undefined,
    indexedAt: toIsoString(row.indexed_at),
    indexError: row.index_error ?? undefined,
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
    actorName: row.actor_name ?? undefined,
    conversationTitle: row.conversation_title ?? undefined,
    workspaceMemberName: row.workspace_member_name ?? undefined,
  }
}

async function loadMemoryItemsFromRows(rows: MemoryRow[]) {
  if (rows.length === 0) return []

  const memoryIds = rows.map((row) => row.id)
  const partsResult = await db
    .selectFrom("memory_item_parts as mip")
    .leftJoin("files as f", "f.id", "mip.file_id")
    .select([
      "mip.memory_item_id",
      "mip.part_type",
      "mip.text_value",
      "mip.file_id",
      "mip.json_value",
      "mip.mime_type",
      "mip.name",
      "mip.metadata",
      "f.original_name",
      "f.mime_type as file_mime_type",
      "f.size_bytes",
    ])
    .where("mip.memory_item_id", "in", memoryIds)
    .orderBy("mip.memory_item_id", "asc")
    .orderBy("mip.ordinal", "asc")
    .execute()

  const partsByMemoryId = new Map<string, MemoryPartRow[]>()
  for (const row of partsResult as MemoryPartRow[]) {
    if (!partsByMemoryId.has(row.memory_item_id)) {
      partsByMemoryId.set(row.memory_item_id, [])
    }
    partsByMemoryId.get(row.memory_item_id)!.push(row)
  }

  return rows.map((row) =>
    mapMemoryRow(
      row,
      itemPartsToCanonicalContentBlocks(partsByMemoryId.get(row.id) || [])
    )
  )
}

function baseMemorySelect() {
  return [
    "mi.id",
    "mi.workspace_id",
    "mi.memory_space_id",
    "ms.space_type",
    "ms.anchor_actor_id",
    "ms.anchor_conversation_id",
    "ms.anchor_conversation_actor_context_id",
    "ms.anchor_workspace_member_id",
    "mi.category",
    "mi.state",
    "mi.importance",
    "mi.confidence",
    "mi.tags",
    "mi.text_digest",
    "mi.search_text",
    "mi.index_status",
    "mi.embedding_model",
    "mi.embedding_dim",
    "mi.indexed_at",
    "mi.index_error",
    "mi.source_item_id",
    "mi.source_tool_call_id",
    "mi.source_turn_id",
    "mi.supersedes_item_id",
    "mi.metadata",
    "mi.created_at",
    "mi.updated_at",
    sql<string | null>`COALESCE(a_space.name, a_participant.name)`.as(
      "actor_name"
    ),
    sql<string | null>`COALESCE(c_space.title, c_participant.title)`.as(
      "conversation_title"
    ),
    "u.name as workspace_member_name",
    sql<string | null>`COALESCE(ms.anchor_actor_id, cac.actor_id)`.as(
      "resolved_actor_id"
    ),
    sql<
      string | null
    >`COALESCE(ms.anchor_conversation_id, cac.conversation_id)`.as(
      "resolved_conversation_id"
    ),
    sql<string | null>`ms.anchor_workspace_member_id`.as(
      "resolved_workspace_member_id"
    ),
  ] as const
}

async function getMemoryRow(workspaceId: string, memoryId: string) {
  return db
    .selectFrom("memory_items as mi")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "ms.anchor_conversation_actor_context_id"
    )
    .leftJoin("actors as a_space", "a_space.id", "ms.anchor_actor_id")
    .leftJoin("actors as a_participant", "a_participant.id", "cac.actor_id")
    .leftJoin(
      "conversations as c_space",
      "c_space.id",
      "ms.anchor_conversation_id"
    )
    .leftJoin(
      "conversations as c_participant",
      "c_participant.id",
      "cac.conversation_id"
    )
    .leftJoin(
      "workspace_members as wm",
      "wm.id",
      "ms.anchor_workspace_member_id"
    )
    .leftJoin("users as u", "u.id", "wm.user_id")
    .select(baseMemorySelect())
    .where("mi.workspace_id", "=", workspaceId)
    .where("mi.id", "=", memoryId)
    .limit(1)
    .executeTakeFirst() as Promise<MemoryRow | undefined>
}

function validateMemorySpaceBinding(input: MemorySpaceBinding, label: string) {
  switch (input.spaceType) {
    case "workspace_shared":
      if (input.actorId || input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(
          `${label} workspace_shared cannot include actorId, conversationId, or workspaceMemberId`,
          400
        )
      }
      break
    case "conversation_shared":
      if (!input.conversationId || input.actorId || input.workspaceMemberId) {
        throw new MemoryError(
          `${label} conversation_shared requires conversationId and no actorId or workspaceMemberId`,
          400
        )
      }
      break
    case "actor_private":
      if (!input.actorId || input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(
          `${label} actor_private requires actorId and no conversationId or workspaceMemberId`,
          400
        )
      }
      break
    case "participant_private":
      if (!input.actorId || !input.conversationId || input.workspaceMemberId) {
        throw new MemoryError(
          `${label} participant_private requires actorId and conversationId and no workspaceMemberId`,
          400
        )
      }
      break
    case "user_private":
      if (!input.workspaceMemberId || input.actorId || input.conversationId) {
        throw new MemoryError(
          `${label} user_private requires workspaceMemberId and no actorId or conversationId`,
          400
        )
      }
      break
  }
}

async function assertWorkspaceMemberExists(
  workspaceId: string,
  workspaceMemberId: string
) {
  const row = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new MemoryError("Workspace member not found", 404)
  }
}

async function assertActorInWorkspace(workspaceId: string, actorId: string) {
  const row = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", actorId)
    .where("workspace_id", "=", workspaceId)
    .where("is_active", "=", true)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new MemoryError("Actor not found in this workspace", 404)
  }
}

async function assertConversationInWorkspace(
  workspaceId: string,
  conversationId: string
) {
  // P1b: traverse via access_subjects to recover workspace_member / actor refs
  // from the joined subject row.
  const row = await db
    .selectFrom("conversation_participants as cp")
    .innerJoin("access_subjects as subj", "subj.id", "cp.subject_id")
    .leftJoin("workspace_members as wm", "wm.id", "subj.workspace_member_id")
    .leftJoin("actors as a", "a.id", "subj.actor_id")
    .select("cp.id")
    .where("cp.conversation_id", "=", conversationId)
    .where((eb) =>
      eb.or([
        eb("wm.workspace_id", "=", workspaceId),
        eb("a.workspace_id", "=", workspaceId),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new MemoryError("Conversation not found in this workspace", 404)
  }
}

async function assertActorInConversation(
  conversationId: string,
  actorId: string
) {
  // P1b: filter by access_subjects FK via subject_id rather than the dropped
  // polymorphic actor_id column.
  const actorSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const row = await db
    .selectFrom("conversation_participants")
    .select("id")
    .where("conversation_id", "=", conversationId)
    .where("subject_id", "=", actorSubjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new MemoryError(
      "Actor is not an active participant of this conversation",
      400
    )
  }
}

async function validateMemorySpaceTarget(
  workspaceId: string,
  input: MemorySpaceBinding
) {
  switch (input.spaceType) {
    case "workspace_shared":
      return
    case "conversation_shared":
      if (input.conversationId) {
        await assertConversationInWorkspace(workspaceId, input.conversationId)
      }
      return
    case "actor_private":
      if (input.actorId) {
        await assertActorInWorkspace(workspaceId, input.actorId)
      }
      return
    case "participant_private":
      if (input.actorId && input.conversationId) {
        await assertActorInWorkspace(workspaceId, input.actorId)
        await assertConversationInWorkspace(workspaceId, input.conversationId)
        await assertActorInConversation(input.conversationId, input.actorId)
      }
      return
    case "user_private":
      if (input.workspaceMemberId) {
        await assertWorkspaceMemberExists(workspaceId, input.workspaceMemberId)
      }
      return
  }
}

async function resolveConversationActorContextId(binding: MemorySpaceBinding) {
  if (
    binding.spaceType !== "participant_private" ||
    !binding.actorId ||
    !binding.conversationId
  ) {
    return null
  }

  const context = await ensureConversationActorContext({
    actorId: binding.actorId,
    conversationId: binding.conversationId,
  })
  return context.conversationActorContextId
}

async function findExistingMemorySpace(
  client: QueryExecutor,
  workspaceId: string,
  binding: MemorySpaceBinding,
  conversationActorContextId?: string | null
) {
  switch (binding.spaceType) {
    case "workspace_shared":
      return executeTakeFirst<MemorySpaceRow>(
        client,
        db
          .selectFrom("memory_spaces")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("space_type", "=", binding.spaceType)
          .limit(1)
      )
    case "conversation_shared":
      return binding.conversationId
        ? executeTakeFirst<MemorySpaceRow>(
            client,
            db
              .selectFrom("memory_spaces")
              .selectAll()
              .where("workspace_id", "=", workspaceId)
              .where("space_type", "=", binding.spaceType)
              .where("anchor_conversation_id", "=", binding.conversationId)
              .limit(1)
          )
        : null
    case "actor_private":
      return binding.actorId
        ? executeTakeFirst<MemorySpaceRow>(
            client,
            db
              .selectFrom("memory_spaces")
              .selectAll()
              .where("workspace_id", "=", workspaceId)
              .where("space_type", "=", binding.spaceType)
              .where("anchor_actor_id", "=", binding.actorId)
              .limit(1)
          )
        : null
    case "participant_private":
      return conversationActorContextId
        ? executeTakeFirst<MemorySpaceRow>(
            client,
            db
              .selectFrom("memory_spaces")
              .selectAll()
              .where("workspace_id", "=", workspaceId)
              .where("space_type", "=", binding.spaceType)
              .where(
                "anchor_conversation_actor_context_id",
                "=",
                conversationActorContextId
              )
              .limit(1)
          )
        : null
    case "user_private":
      return binding.workspaceMemberId
        ? executeTakeFirst<MemorySpaceRow>(
            client,
            db
              .selectFrom("memory_spaces")
              .selectAll()
              .where("workspace_id", "=", workspaceId)
              .where("space_type", "=", binding.spaceType)
              .where(
                "anchor_workspace_member_id",
                "=",
                binding.workspaceMemberId
              )
              .limit(1)
          )
        : null
    default:
      return null
  }
}

async function ensureMemorySpace(
  client: QueryExecutor,
  workspaceId: string,
  binding: MemorySpaceBinding
) {
  validateMemorySpaceBinding(binding, "Memory space")
  await validateMemorySpaceTarget(workspaceId, binding)
  const conversationActorContextId =
    await resolveConversationActorContextId(binding)
  const existing = await findExistingMemorySpace(
    client,
    workspaceId,
    binding,
    conversationActorContextId
  )
  if (existing) {
    return {
      spaceId: existing.id,
      conversationActorContextId: conversationActorContextId || undefined,
    }
  }

  const spaceId = uuidv4()
  await executeCompiledQuery(
    client,
    db.insertInto("memory_spaces").values({
      id: spaceId,
      workspace_id: workspaceId,
      space_type: binding.spaceType,
      anchor_conversation_id:
        binding.spaceType === "conversation_shared"
          ? binding.conversationId || null
          : null,
      anchor_actor_id:
        binding.spaceType === "actor_private" ? binding.actorId || null : null,
      anchor_conversation_actor_context_id:
        binding.spaceType === "participant_private"
          ? conversationActorContextId
          : null,
      anchor_workspace_member_id:
        binding.spaceType === "user_private"
          ? binding.workspaceMemberId || null
          : null,
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
  )

  return {
    spaceId,
    conversationActorContextId: conversationActorContextId || undefined,
  }
}

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

async function insertMemoryParts(
  client: QueryExecutor,
  memoryItemId: string,
  parts: DraftConversationPart[]
) {
  for (let ordinal = 0; ordinal < parts.length; ordinal += 1) {
    const part = parts[ordinal]
    await executeCompiledQuery(
      client,
      db.insertInto("memory_item_parts").values({
        id: uuidv4(),
        memory_item_id: memoryItemId,
        ordinal,
        part_type: part.type,
        text_value: part.type === "text" ? part.text || "" : null,
        file_id: part.type === "file_ref" ? part.fileId || null : null,
        json_value:
          part.type === "json"
            ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
            : null,
        mime_type: part.mimeType || null,
        name: part.name || null,
        metadata: (part.metadata ||
          {}) as TableInsert<"memory_item_parts">["metadata"],
      })
    )
  }
}

async function maybeMarkSuperseded(
  client: QueryExecutor,
  memoryItemId?: string
) {
  if (!memoryItemId) return
  await executeCompiledQuery(
    client,
    db
      .updateTable("memory_items")
      .set({
        state: "superseded",
        updated_at: sql`NOW()`,
      })
      .where("id", "=", memoryItemId)
  )
}

type MemoryInputAliases = {
  spaceType?: MemorySpaceType
  ownerScope?: MemorySpaceType
  actorId?: string
  ownerActorId?: string
  conversationId?: string
  ownerConversationId?: string
  workspaceMemberId?: string
  ownerWorkspaceMemberId?: string
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

function normalizeMemorySpaceBinding(
  input: Pick<
    MemoryInputAliases,
    | "spaceType"
    | "ownerScope"
    | "actorId"
    | "ownerActorId"
    | "conversationId"
    | "ownerConversationId"
    | "workspaceMemberId"
    | "ownerWorkspaceMemberId"
  >
): MemorySpaceBinding {
  return {
    spaceType: (input.spaceType ||
      input.ownerScope ||
      "workspace_shared") as MemorySpaceType,
    actorId: input.actorId || input.ownerActorId,
    conversationId: input.conversationId || input.ownerConversationId,
    workspaceMemberId: input.workspaceMemberId || input.ownerWorkspaceMemberId,
  }
}

export interface CreateMemoryInput extends MemoryInputAliases {
  category: MemoryCategory
}

export interface UpdateMemoryInput extends MemoryInputAliases {}

export interface ListMemoriesInput extends MemoryAccessTarget {
  spaceType?: MemorySpaceType
  ownerScope?: MemorySpaceType
  category?: MemoryCategory
  state?: MemoryItemState
  status?: MemoryItemState
  tags?: string[]
  limit?: number
}

export interface SearchMemoriesInput extends MemoryAccessTarget {
  queryText: string
  spaceTypes?: MemorySpaceType[]
  scopes?: MemorySpaceType[]
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

type DirectUserPrivateContext = {
  workspaceMemberId: string
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

async function resolveDirectUserPrivateContext(
  params: Pick<SearchMemoriesInput, "actorId" | "conversationId">
): Promise<DirectUserPrivateContext | null> {
  if (!params.actorId || !params.conversationId) {
    return null
  }

  // P1b: direct_conversation_bindings now exposes participant_*_subject_id
  // referencing access_subjects; JOIN access_subjects twice (one per
  // participant) to recover the actor_id / workspace_member_id values this
  // memory bridge needs.
  const row = await db
    .selectFrom("conversations as c")
    .innerJoin(
      "direct_conversation_bindings as dcb",
      "dcb.conversation_id",
      "c.id"
    )
    .innerJoin(
      "access_subjects as p1",
      "p1.id",
      "dcb.participant_one_subject_id"
    )
    .innerJoin(
      "access_subjects as p2",
      "p2.id",
      "dcb.participant_two_subject_id"
    )
    .select([
      "p1.kind as participant_one_kind",
      "p1.workspace_member_id as participant_one_workspace_member_id",
      "p1.actor_id as participant_one_actor_id",
      "p2.kind as participant_two_kind",
      "p2.workspace_member_id as participant_two_workspace_member_id",
      "p2.actor_id as participant_two_actor_id",
    ])
    .where("c.id", "=", params.conversationId)
    .where("c.kind", "=", "private")
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  const participantOneActorId =
    row.participant_one_kind === "actor" ? row.participant_one_actor_id : null
  const participantTwoActorId =
    row.participant_two_kind === "actor" ? row.participant_two_actor_id : null
  const participantOneWorkspaceMemberId =
    row.participant_one_kind === "workspace_member"
      ? row.participant_one_workspace_member_id
      : null
  const participantTwoWorkspaceMemberId =
    row.participant_two_kind === "workspace_member"
      ? row.participant_two_workspace_member_id
      : null

  const boundActorId = participantOneActorId || participantTwoActorId
  const boundWorkspaceMemberId =
    participantOneWorkspaceMemberId || participantTwoWorkspaceMemberId

  if (
    !boundActorId ||
    !boundWorkspaceMemberId ||
    boundActorId !== params.actorId
  ) {
    return null
  }

  return {
    workspaceMemberId: boundWorkspaceMemberId,
  }
}

function buildListWhereClause(workspaceId: string, input: ListMemoriesInput) {
  const conditions: RawBuilder<unknown>[] = [
    sql`mi.workspace_id = ${workspaceId}`,
  ]

  const spaceType = input.spaceType || input.ownerScope
  if (spaceType) {
    conditions.push(sql`ms.space_type = ${spaceType}`)
  }
  if (input.category) {
    conditions.push(sql`mi.category = ${input.category}`)
  }
  if (input.state || input.status) {
    conditions.push(sql`mi.state = ${(input.state || input.status)!}`)
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(sql`mi.tags && ${input.tags}`)
  }

  return sql`${sql.join(conditions, sql` AND `)}`
}

function buildSearchFilters(
  workspaceId: string,
  input: SearchMemoriesInput,
  itemAlias = "mi",
  spaceAlias = "ms",
  /**
   * PR-fix-round-2: space-level grant-reachable memory_space ids. When a
   * granted space is `user_private`, the `isActorSearchContext` exclusion
   * would normally strip it from the candidate set; we override that
   * exclusion when the space is in this list so granted user_private
   * memories DO show up in search/recall for the grant subject. Filters
   * for state/category/tag still apply uniformly via the surrounding
   * conditions.
   */
  grantSpaceIds: readonly string[] = []
) {
  const item = sql.raw(itemAlias)
  const space = sql.raw(spaceAlias)
  const conditions: RawBuilder<unknown>[] = [
    sql`${item}.workspace_id = ${workspaceId}`,
  ]

  const spaceTypes =
    input.spaceTypes && input.spaceTypes.length > 0
      ? input.spaceTypes
      : input.scopes && input.scopes.length > 0
        ? input.scopes
        : undefined
  if (spaceTypes) {
    conditions.push(sql`${space}.space_type::text = ANY(${spaceTypes}::text[])`)
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

  if (isActorSearchContext(input)) {
    if (grantSpaceIds.length > 0) {
      const ids = sql.raw(
        `ARRAY[${grantSpaceIds.map((id) => `'${id}'`).join(",")}]::uuid[]`
      )
      if (input.directWorkspaceMemberId) {
        conditions.push(
          sql`(${space}.space_type != 'user_private' OR ${space}.anchor_workspace_member_id = ${input.directWorkspaceMemberId} OR ${space}.id = ANY(${ids}))`
        )
      } else {
        conditions.push(
          sql`(${space}.space_type != 'user_private' OR ${space}.id = ANY(${ids}))`
        )
      }
    } else if (input.directWorkspaceMemberId) {
      conditions.push(
        sql`(${space}.space_type != 'user_private' OR ${space}.anchor_workspace_member_id = ${input.directWorkspaceMemberId})`
      )
    } else {
      conditions.push(sql`${space}.space_type != 'user_private'`)
    }
  }

  return sql`${sql.join(conditions, sql` AND `)}`
}

async function searchLexicalCandidates(
  workspaceId: string,
  input: SearchMemoriesInput,
  candidateLimit: number,
  queryText: string,
  grantSpaceIds: readonly string[] = []
) {
  const whereClause = buildSearchFilters(
    workspaceId,
    input,
    "mi",
    "ms",
    grantSpaceIds
  )
  if (!queryText) return []
  const normalizedQueryText = normalizeWhitespace(queryText).toLowerCase()
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT mi.id,
        mi.workspace_id,
        mi.memory_space_id,
        ms.space_type,
        ms.anchor_actor_id,
        ms.anchor_conversation_id,
        ms.anchor_conversation_actor_context_id,
        ms.anchor_workspace_member_id,
        mi.category,
        mi.state,
        mi.importance,
        mi.confidence,
        mi.tags,
        mi.text_digest,
        mi.search_text,
        mi.index_status,
        mi.embedding_model,
        mi.embedding_dim,
        mi.indexed_at,
        mi.index_error,
        mi.source_item_id,
        mi.source_tool_call_id,
        mi.source_turn_id,
        mi.supersedes_item_id,
        mi.metadata,
        mi.created_at,
        mi.updated_at,
        COALESCE(a_space.name, a_participant.name) AS actor_name,
        COALESCE(c_space.title, c_participant.title) AS conversation_title,
        u.name AS workspace_member_name,
        COALESCE(ms.anchor_actor_id, cac.actor_id) AS resolved_actor_id,
        COALESCE(ms.anchor_conversation_id, cac.conversation_id) AS resolved_conversation_id,
        ms.anchor_workspace_member_id AS resolved_workspace_member_id,
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        GREATEST(
          ts_rank_cd(to_tsvector('simple', mic.search_text), websearch_to_tsquery('simple', ${queryText})),
          CASE WHEN POSITION(${normalizedQueryText} IN lower(mic.search_text)) > 0 THEN 0.2 ELSE 0 END
        ) AS text_score,
        similarity(mic.search_text, ${queryText}) AS similarity_score,
        NULL::real AS vector_score,
        NULL::real AS rrf_score
      FROM memory_item_chunks mic
      JOIN memory_items mi ON mi.id = mic.memory_item_id
      JOIN memory_spaces ms ON ms.id = mi.memory_space_id
      LEFT JOIN conversation_actor_contexts cac ON cac.id = ms.anchor_conversation_actor_context_id
      LEFT JOIN actors a_space ON a_space.id = ms.anchor_actor_id
      LEFT JOIN actors a_participant ON a_participant.id = cac.actor_id
      LEFT JOIN conversations c_space ON c_space.id = ms.anchor_conversation_id
      LEFT JOIN conversations c_participant ON c_participant.id = cac.conversation_id
      LEFT JOIN workspace_members wm ON wm.id = ms.anchor_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      WHERE ${whereClause}
        AND mic.index_version = mi.active_index_version
        AND (
          to_tsvector('simple', mic.search_text) @@ websearch_to_tsquery('simple', ${queryText})
          OR POSITION(${normalizedQueryText} IN lower(mic.search_text)) > 0
          OR similarity(mic.search_text, ${queryText}) > 0.08
        )
      ORDER BY text_score DESC, similarity_score DESC, mi.importance DESC, mi.updated_at DESC
      LIMIT ${candidateLimit}`.compile(db)
  )

  return result.rows
}

async function searchVectorCandidates(
  workspaceId: string,
  input: SearchMemoriesInput,
  embedding: number[],
  candidateLimit: number,
  grantSpaceIds: readonly string[] = []
) {
  const whereClause = buildSearchFilters(
    workspaceId,
    input,
    "mi",
    "ms",
    grantSpaceIds
  )
  const formattedEmbedding = `[${embedding.map((value) => (Number.isFinite(value) ? value.toFixed(8) : "0")).join(",")}]`
  const result = await db.executeQuery(
    sql<SearchCandidateRow>`SELECT mi.id,
        mi.workspace_id,
        mi.memory_space_id,
        ms.space_type,
        ms.anchor_actor_id,
        ms.anchor_conversation_id,
        ms.anchor_conversation_actor_context_id,
        ms.anchor_workspace_member_id,
        mi.category,
        mi.state,
        mi.importance,
        mi.confidence,
        mi.tags,
        mi.text_digest,
        mi.search_text,
        mi.index_status,
        mi.embedding_model,
        mi.embedding_dim,
        mi.indexed_at,
        mi.index_error,
        mi.source_item_id,
        mi.source_tool_call_id,
        mi.source_turn_id,
        mi.supersedes_item_id,
        mi.metadata,
        mi.created_at,
        mi.updated_at,
        COALESCE(a_space.name, a_participant.name) AS actor_name,
        COALESCE(c_space.title, c_participant.title) AS conversation_title,
        u.name AS workspace_member_name,
        COALESCE(ms.anchor_actor_id, cac.actor_id) AS resolved_actor_id,
        COALESCE(ms.anchor_conversation_id, cac.conversation_id) AS resolved_conversation_id,
        ms.anchor_workspace_member_id AS resolved_workspace_member_id,
        mic.id AS matched_chunk_id,
        mic.search_text AS chunk_search_text,
        NULL::real AS text_score,
        NULL::real AS similarity_score,
        (1 - (mic.embedding <=> ${formattedEmbedding}::vector))::real AS vector_score,
        NULL::real AS rrf_score
      FROM memory_item_chunks mic
      JOIN memory_items mi ON mi.id = mic.memory_item_id
      JOIN memory_spaces ms ON ms.id = mi.memory_space_id
      LEFT JOIN conversation_actor_contexts cac ON cac.id = ms.anchor_conversation_actor_context_id
      LEFT JOIN actors a_space ON a_space.id = ms.anchor_actor_id
      LEFT JOIN actors a_participant ON a_participant.id = cac.actor_id
      LEFT JOIN conversations c_space ON c_space.id = ms.anchor_conversation_id
      LEFT JOIN conversations c_participant ON c_participant.id = cac.conversation_id
      LEFT JOIN workspace_members wm ON wm.id = ms.anchor_workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      WHERE ${whereClause}
        AND mic.index_version = mi.active_index_version
        AND mic.embedding IS NOT NULL
      ORDER BY mic.embedding <=> ${formattedEmbedding}::vector ASC
      LIMIT ${candidateLimit}`.compile(db)
  )

  return result.rows
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

/**
 * PR5 fix: lift the resolved AccessSubject into a `SubjectRef` so we can
 * build a RuntimePrincipalContext for the memory_access_grants overlay.
 * `user` subjects are not workspace-bound and can't anchor a memory grant —
 * we deliberately return null for them so the grant overlay stays off.
 */
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
    return await buildRuntimePrincipalContext(db, {
      principal,
      workspaceId,
      conversationId: target.conversationId ?? null,
    })
  } catch {
    // Builder fails closed when the principal doesn't belong to the
    // workspace (PR2 security guard). For memory reads we let the legacy
    // path continue without a runtime context — it will deny access via
    // the existing space_type rules.
    return null
  }
}

/**
 * PR-fix-round-2: previous round POST-fetch unioned grant-reachable items
 * into the candidate set; that bypassed the lexical/vector match and the
 * `state='active'` / category / tag filters in `buildSearchFilters` /
 * `buildListWhereClause`. The correct shape is to WIDEN the SQL candidate
 * filters so granted spaces participate in the same filters as everything
 * else — implemented here for search/recall via
 * `buildSearchFilters(..., grantSpaceIds)` which overrides the
 * `isActorSearchContext` user_private exclusion for granted spaces. For
 * list the legacy candidate SQL is already inclusive (no SQL-level
 * visibility filter); auth filtering with `runtimeContext` is sufficient.
 */
async function loadSpaceLevelGrantSpaceIds(
  workspaceId: string,
  ctx: NonNullable<Awaited<ReturnType<typeof buildMemoryRuntimeContext>>>,
  permission: "read" | "recall"
): Promise<string[]> {
  return listSpaceLevelGrantSpaceIds(db, {
    workspaceId,
    permission:
      permission === "recall"
        ? MEMORY_PERMISSION.RECALL
        : MEMORY_PERMISSION.READ,
    runtimeSubjectIds: ctx.runtimeSubjectIds,
    runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
  })
}

function isDirectUserPrivateRowVisible(
  row: SearchCandidateRow,
  target: MemoryAccessTarget
) {
  return Boolean(
    target.directWorkspaceMemberId &&
    row.space_type === "user_private" &&
    row.anchor_workspace_member_id === target.directWorkspaceMemberId
  )
}

async function buildSearchHits(params: {
  workspaceId: UUID
  rows: SearchCandidateRow[]
  queryText: string
  target: MemoryAccessTarget
  permission: "read" | "recall"
  limit: number
}) {
  const subject = resolveAccessSubject(params.target)
  let rows = params.rows

  // PR-fix-round-2: previous round POST-fetch unioned every grant-reachable
  // item; that pulled in items that didn't match the lexical/vector query.
  // The grants now participate via buildSearchFilters (the legacy
  // user_private exclusion is widened to allow granted spaces) so the
  // query-match SQL handles them naturally. Here we only need to plumb
  // the runtime context into filterAuthorizedPermissionResourceIds so the
  // post-fetch auth gate sees the same grant overlay the evaluator uses.
  const runtimeContext = await buildMemoryRuntimeContext(
    params.workspaceId,
    params.target,
    subject
  )

  if (rows.length > 0) {
    const directVisibleIds = new Set(
      rows
        .filter((row) => isDirectUserPrivateRowVisible(row, params.target))
        .map((row) => row.id)
    )

    if (subject) {
      const allowedIds = new Set(
        await filterAuthorizedPermissionResourceIds(db, {
          subject,
          resourceType: "memory_item",
          permission: params.permission,
          resourceIds: rows.map((row) => row.id),
          runtimeSubjectIds: runtimeContext?.runtimeSubjectIds,
          runtimeScopeSubjectIds: runtimeContext?.runtimeScopeSubjectIds,
        })
      )
      rows = rows.filter(
        (row) => allowedIds.has(row.id) || directVisibleIds.has(row.id)
      )
    } else if (directVisibleIds.size > 0) {
      rows = rows.filter((row) => directVisibleIds.has(row.id))
    }
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
  await transaction(async (client) => {
    await executeSqlOn(
      client,
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
        runId,
        params.workspaceId,
        params.actorId || null,
        params.conversationId || null,
        params.workspaceMemberId || null,
        params.recallType,
        params.queryText,
        JSON.stringify(normalizedQueryBlocks),
        JSON.stringify(params.metadata || {}),
      ]
    )

    for (const result of params.results) {
      await executeCompiledQuery(
        client,
        db.insertInto("memory_recall_run_results").values({
          id: uuidv4(),
          run_id: runId,
          memory_item_id: result.id,
          matched_chunk_id: result.matchedChunkId || null,
          rank: result.rank,
          final_score: result.finalScore,
          vector_score: result.vectorScore ?? null,
          text_score: result.textScore ?? null,
          similarity_score: result.similarityScore ?? null,
          matched_terms: (result.matchedTerms ??
            []) as TableInsert<"memory_recall_run_results">["matched_terms"],
          recall_reason: result.recallReason || null,
          metadata: {
            spaceType: result.spaceType,
            category: result.category,
          } as TableInsert<"memory_recall_run_results">["metadata"],
          created_at: sql`NOW()`,
        })
      )
    }
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
    createdAt: new Date().toISOString(),
    results: params.results,
  }
}

function buildDefaultRecallReason(memory: Memory, target: MemoryAccessTarget) {
  switch (memory.spaceType) {
    case "participant_private":
      return "Participant-private memory strongly matched the current actor and conversation"
    case "conversation_shared":
      return "Conversation-shared memory matched the current discussion"
    case "actor_private":
      return "Actor-private memory matched the current task"
    case "user_private":
      return target.directWorkspaceMemberId
        ? "PM personal memory from this workspace matched the current direct conversation"
        : "User-private memory matched the current member context"
    case "workspace_shared":
    default:
      return "Workspace-shared memory matched the current task"
  }
}

export async function createMemory(
  workspaceId: UUID,
  input: CreateMemoryInput
) {
  const binding = normalizeMemorySpaceBinding(input)
  validateMemorySpaceBinding(binding, "Memory space")
  await validateMemorySpaceTarget(workspaceId, binding)
  const normalizedContent = await normalizeMemoryContent(input)
  const memoryItemId = uuidv4()

  await transaction(async (client) => {
    const ensuredSpace = await ensureMemorySpace(client, workspaceId, binding)
    await executeCompiledQuery(
      client,
      db.insertInto("memory_items").values({
        id: memoryItemId,
        workspace_id: workspaceId,
        memory_space_id: ensuredSpace.spaceId,
        category: input.category,
        state: input.state || input.status || "active",
        importance: input.importance ?? 0.5,
        confidence: input.confidence ?? 0.8,
        tags: input.tags || [],
        text_digest: normalizedContent.textDigest,
        search_text: normalizedContent.searchText,
        index_status: "lexical_ready",
        active_index_version: 0,
        staged_index_version: null,
        embedding_model: "",
        embedding_dim: null,
        indexed_at: null,
        index_error: null,
        source_kind: "manual",
        source_item_id: input.sourceItemId || null,
        source_tool_call_id: input.sourceToolCallId || null,
        source_turn_id: input.sourceTurnId || null,
        supersedes_item_id: input.supersedesMemoryId || null,
        metadata: (input.metadata ||
          {}) as TableInsert<"memory_items">["metadata"],
        created_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
    )
    await insertMemoryParts(client, memoryItemId, normalizedContent.parts)
    await maybeMarkSuperseded(client, input.supersedesMemoryId)
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
      spaceType: memory.spaceType,
      actorId: memory.actorId,
      conversationId: memory.conversationId,
      workspaceMemberId: memory.workspaceMemberId,
    },
    timestamp: new Date().toISOString(),
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
  const nextBinding = normalizeMemorySpaceBinding({
    spaceType: input.spaceType ?? existing.spaceType,
    actorId: input.actorId !== undefined ? input.actorId : existing.actorId,
    conversationId:
      input.conversationId !== undefined
        ? input.conversationId
        : existing.conversationId,
    workspaceMemberId:
      input.workspaceMemberId !== undefined
        ? input.workspaceMemberId
        : existing.workspaceMemberId,
  })
  validateMemorySpaceBinding(nextBinding, "Memory space")
  await validateMemorySpaceTarget(workspaceId, nextBinding)

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

  await transaction(async (client) => {
    const ensuredSpace = await ensureMemorySpace(
      client,
      workspaceId,
      nextBinding
    )
    await executeCompiledQuery(
      client,
      db
        .updateTable("memory_items")
        .set({
          memory_space_id: ensuredSpace.spaceId,
          category: input.category || existing.category,
          state: input.state || input.status || existing.state,
          importance: input.importance ?? existing.importance,
          confidence: input.confidence ?? existing.confidence,
          tags: input.tags || existing.tags,
          text_digest: normalizedContent.textDigest,
          search_text: normalizedContent.searchText,
          source_item_id:
            input.sourceItemId !== undefined
              ? input.sourceItemId
              : existing.sourceItemId || null,
          source_tool_call_id:
            input.sourceToolCallId !== undefined
              ? input.sourceToolCallId
              : existing.sourceToolCallId || null,
          source_turn_id:
            input.sourceTurnId !== undefined
              ? input.sourceTurnId
              : existing.sourceTurnId || null,
          supersedes_item_id:
            input.supersedesMemoryId !== undefined
              ? input.supersedesMemoryId
              : existing.supersedesMemoryId || null,
          metadata: (input.metadata ||
            existing.metadata ||
            {}) as TableInsert<"memory_items">["metadata"],
          updated_at: sql`NOW()`,
        })
        .where("id", "=", memoryId)
        .where("workspace_id", "=", workspaceId)
    )

    await executeCompiledQuery(
      client,
      db.deleteFrom("memory_item_parts").where("memory_item_id", "=", memoryId)
    )
    await insertMemoryParts(client, memoryId, normalizedContent.parts)
    await maybeMarkSuperseded(client, input.supersedesMemoryId)
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
  await transaction(async (client) => {
    const deleted = await executeCompiledQuery(
      client,
      db
        .deleteFrom("memory_items")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", memoryId)
    )
    if (!deleted.rowCount) {
      throw new MemoryError("Memory not found", 404)
    }
  })
}

export async function listMemories(
  workspaceId: UUID,
  input: ListMemoriesInput
) {
  const whereClause = buildListWhereClause(workspaceId, input)
  let rows = (await db
    .selectFrom("memory_items as mi")
    .innerJoin("memory_spaces as ms", "ms.id", "mi.memory_space_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "ms.anchor_conversation_actor_context_id"
    )
    .leftJoin("actors as a_space", "a_space.id", "ms.anchor_actor_id")
    .leftJoin("actors as a_participant", "a_participant.id", "cac.actor_id")
    .leftJoin(
      "conversations as c_space",
      "c_space.id",
      "ms.anchor_conversation_id"
    )
    .leftJoin(
      "conversations as c_participant",
      "c_participant.id",
      "cac.conversation_id"
    )
    .leftJoin(
      "workspace_members as wm",
      "wm.id",
      "ms.anchor_workspace_member_id"
    )
    .leftJoin("users as u", "u.id", "wm.user_id")
    .select(baseMemorySelect())
    .where(sql<boolean>`${whereClause}`)
    .orderBy("mi.updated_at", "desc")
    .limit(Math.max(1, Math.min(200, input.limit ?? 100)))
    .execute()) as MemoryRow[]

  const subject = resolveAccessSubject(input)
  // PR-fix-round-2: the legacy list candidate SQL has no SQL-level
  // visibility filter (post-fetch auth is the only gate). Build the
  // runtime context so the explicit grant overlay sees the same subject
  // set on the auth check; no candidate widening necessary (and the
  // previous round's post-fetch union has been removed because it
  // bypassed list filters like category/state/tags).
  const runtimeContext = await buildMemoryRuntimeContext(
    workspaceId,
    input,
    subject
  )
  if (subject && rows.length > 0) {
    const allowedIds = new Set(
      await filterAuthorizedPermissionResourceIds(db, {
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

  return loadMemoryItemsFromRows(rows)
}

export async function searchMemories(
  workspaceId: UUID,
  input: SearchMemoriesInput,
  permission: "read" | "recall" = "read"
): Promise<MemoryRecallResult[]> {
  const directUserPrivateContext = await resolveDirectUserPrivateContext(input)
  const searchInput = directUserPrivateContext
    ? {
        ...input,
        directWorkspaceMemberId: directUserPrivateContext.workspaceMemberId,
      }
    : input
  const candidateLimit = Math.max(
    input.limit ?? config.memory.recallLimit,
    config.memory.searchCandidateLimit
  )
  const queryText = searchInput.queryText.trim()
  const lexicalSources: Array<{ rows: SearchCandidateRow[] }> = []

  // PR-fix-round-2: compute the principal's space-level grant set ONCE per
  // request and pass it into searchLexicalCandidates / searchVectorCandidates.
  // The user_private exclusion in buildSearchFilters is overridden for
  // granted spaces — items in those spaces participate in the same lexical
  // / vector / state / category / tag filters as anything else, so the
  // grant only widens which spaces are reachable, not which items match.
  const runtimeContextForSearch = await buildMemoryRuntimeContext(
    workspaceId,
    searchInput,
    resolveAccessSubject(searchInput)
  )
  const grantSpaceIds = runtimeContextForSearch
    ? await loadSpaceLevelGrantSpaceIds(
        workspaceId,
        runtimeContextForSearch,
        permission
      )
    : []

  if (queryText) {
    for (const variant of buildLexicalVariants(queryText)) {
      try {
        lexicalSources.push({
          rows: await searchLexicalCandidates(
            workspaceId,
            searchInput,
            candidateLimit,
            variant,
            grantSpaceIds
          ),
        })
      } catch (error) {
        if (!isTsqueryStackOverflow(error)) throw error
        console.warn(
          "[memory] lexical search degraded due to tsquery stack overflow",
          {
            workspaceId,
            actorId: searchInput.actorId,
            conversationId: searchInput.conversationId,
            queryLength: queryText.length,
          }
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
          searchInput,
          embedding,
          candidateLimit,
          grantSpaceIds
        )
      }
    } catch (error) {
      console.warn(
        "[memory] vector search unavailable, falling back to lexical only:",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  const fusedRows = fuseCandidateRows([...lexicalSources, { rows: vectorRows }])

  return buildSearchHits({
    workspaceId,
    rows: fusedRows,
    queryText,
    target: searchInput,
    permission,
    limit: Math.max(1, Math.min(50, input.limit ?? config.memory.topK)),
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
  actorName?: string
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
  if (params.actorName) {
    snippets.push(
      truncateText(
        normalizeWhitespace(`actor:${params.actorName}`),
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

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = "MemoryError"
  }
}
