/**
 * Memory module presenter.
 *
 * Owns the row -> `Memory` DTO shaping (formerly `mapMemoryRow` in service).
 * As a non-service/controller file it MAY call `serializeInstant` /
 * `serializeOptionalInstant` (guard-layering r3). Takes the DB-row shape
 * structurally via `MemoryRow` from `repo.types`; it never imports
 * `generated/db` or uses `TableRow<...>`.
 */

import type { CanonicalContentBlock, Memory, SubjectRef } from "@synapse/shared"
import { parseJsonObject, SUBJECT_KIND } from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import type { MemoryRow } from "./repo.types.js"

export function buildSubjectRefFromJoin(params: {
  kind: string | null
  workspaceId: string | null
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  conversationId: string | null
}): SubjectRef | undefined {
  if (!params.kind) return undefined
  switch (params.kind) {
    case SUBJECT_KIND.WORKSPACE:
      return params.workspaceId
        ? { kind: SUBJECT_KIND.WORKSPACE, workspaceId: params.workspaceId }
        : undefined
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return params.workspaceMemberId
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: params.workspaceMemberId,
          }
        : undefined
    case SUBJECT_KIND.ACTOR:
      return params.actorId
        ? { kind: SUBJECT_KIND.ACTOR, actorId: params.actorId }
        : undefined
    case SUBJECT_KIND.REMOTE_AGENT:
      return params.remoteAgentId
        ? {
            kind: SUBJECT_KIND.REMOTE_AGENT,
            remoteAgentId: params.remoteAgentId,
          }
        : undefined
    case SUBJECT_KIND.CONVERSATION:
      return params.conversationId
        ? {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: params.conversationId,
          }
        : undefined
    default:
      return undefined
  }
}

export function presentMemoryRow(
  row: MemoryRow,
  contentBlocks: CanonicalContentBlock[]
): Memory {
  const owner = buildSubjectRefFromJoin({
    kind: row.owner_kind,
    workspaceId: row.owner_workspace_id,
    workspaceMemberId: row.owner_workspace_member_id,
    actorId: row.owner_actor_id,
    remoteAgentId: row.owner_remote_agent_id,
    conversationId: row.owner_conversation_id,
  })
  if (!owner) {
    throw new Error(
      `memory_items ${row.id}: could not decode owner subject (kind=${row.owner_kind})`
    )
  }
  const scope = buildSubjectRefFromJoin({
    kind: row.scope_kind,
    workspaceId: row.scope_workspace_id_via_join,
    workspaceMemberId: null,
    actorId: null,
    remoteAgentId: null,
    conversationId: row.scope_conversation_id_via_join,
  })
  const state = row.state
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.memory_space_id,
    owner,
    scope,
    namespaceKey: row.space_namespace_key,
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
    indexedAt: serializeOptionalInstant(row.indexed_at),
    indexError: row.index_error ?? undefined,
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
    ownerLabel: row.owner_label ?? undefined,
    scopeLabel: row.scope_label ?? undefined,
  }
}
