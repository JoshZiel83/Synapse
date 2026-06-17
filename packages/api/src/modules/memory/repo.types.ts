/**
 * Memory module repo types.
 *
 * The ONLY memory file allowed to touch `TableInsert` (guard-layering r2).
 * Groups the JSONB / array column-type aliases so the service can cast
 * payloads (`as MemoryItemsMetadata`, etc.) without referencing
 * `TableInsert<...>` inline, and owns the `memory_items` join-record shape
 * (`MemoryRow`) consumed by the repo SQL paths and the presenter.
 */

import type { TableInsert } from "../../infrastructure/database/kysely.js"
import type { MemoryCategory, MemoryItemState } from "@synapse/shared"

export type MemoryItemsMetadata = TableInsert<"memoryItems">["metadata"]
export type MemoryItemPartsMetadata = TableInsert<"memoryItemParts">["metadata"]
export type MemoryItemChunksMetadata =
  TableInsert<"memoryItemChunks">["metadata"]
export type MemoryRecallRunResultsMatchedTerms =
  TableInsert<"memoryRecallRunResults">["matchedTerms"]
export type MemoryRecallRunResultsMetadata =
  TableInsert<"memoryRecallRunResults">["metadata"]

/**
 * `memory_items` joined with its `memory_spaces` owner / scope subject
 * decomposition (see `memoryRowSelectSql` / `memoryRowFromSql`). Kysely's
 * CamelCasePlugin transforms even raw-query top-level aliases, so this repo
 * record is camelCase. Structural shape only — no `TableRow<...>` so it can be
 * imported by both the repo SQL paths and the presenter.
 */
export type MemoryRow = {
  id: string
  workspaceId: string
  memorySpaceId: string
  spaceOwnerSubjectId: string
  spaceScopeSubjectId: string | null
  spaceNamespaceKey: string
  ownerKind: string
  ownerWorkspaceId: string | null
  ownerWorkspaceMemberId: string | null
  ownerActorId: string | null
  ownerRemoteAgentId: string | null
  ownerConversationId: string | null
  scopeKind: string | null
  scopeWorkspaceIdViaJoin: string | null
  scopeConversationIdViaJoin: string | null
  category: MemoryCategory
  state: MemoryItemState
  importance: number
  confidence: number
  tags: string[]
  textDigest: string
  searchText: string
  indexStatus: "lexical_ready" | "ready" | "failed"
  embeddingModel: string
  embeddingDim: number | null
  indexedAt: Date | null
  indexError: string | null
  sourceItemId: string | null
  sourceToolCallId: string | null
  sourceTurnId: string | null
  supersedesItemId: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  ownerLabel: string | null
  scopeLabel: string | null
}
