/**
 * Memory module repo types.
 *
 * The ONLY memory file allowed to touch `TableInsert` (guard-layering r2).
 * Groups the JSONB / array column-type aliases so the service can cast
 * payloads (`as MemoryItemsMetadata`, etc.) without referencing
 * `TableInsert<...>` inline, and owns the raw `memory_items` join-row shape
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
 * Raw `memory_items` row joined with its `memory_spaces` owner / scope
 * subject decomposition (see `memoryRowSelectSql` / `memoryRowFromSql`).
 * Structural shape only — no `TableRow<...>` so it can be imported by both
 * the repo SQL paths and the presenter.
 */
export type MemoryRow = {
  id: string
  workspace_id: string
  memory_space_id: string
  space_owner_subject_id: string
  space_scope_subject_id: string | null
  space_namespace_key: string
  owner_kind: string
  owner_workspace_id: string | null
  owner_workspace_member_id: string | null
  owner_actor_id: string | null
  owner_remote_agent_id: string | null
  owner_conversation_id: string | null
  scope_kind: string | null
  scope_workspace_id_via_join: string | null
  scope_conversation_id_via_join: string | null
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
  indexed_at: Date | null
  index_error: string | null
  source_item_id: string | null
  source_tool_call_id: string | null
  source_turn_id: string | null
  supersedes_item_id: string | null
  metadata: Record<string, unknown> | string | null
  created_at: Date
  updated_at: Date
  owner_label: string | null
  scope_label: string | null
}
