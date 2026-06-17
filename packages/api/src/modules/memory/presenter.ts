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
import { SUBJECT_KIND } from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import type { MemoryAccessGrantView } from "@synapse/shared/schemas"
import type { MemoryAccessGrantRow } from "./access-grant-storage.js"
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
    kind: row.ownerKind,
    workspaceId: row.ownerWorkspaceId,
    workspaceMemberId: row.ownerWorkspaceMemberId,
    actorId: row.ownerActorId,
    remoteAgentId: row.ownerRemoteAgentId,
    conversationId: row.ownerConversationId,
  })
  if (!owner) {
    throw new Error(
      `memory_items ${row.id}: could not decode owner subject (kind=${row.ownerKind})`
    )
  }
  const scope = buildSubjectRefFromJoin({
    kind: row.scopeKind,
    workspaceId: row.scopeWorkspaceIdViaJoin,
    workspaceMemberId: null,
    actorId: null,
    remoteAgentId: null,
    conversationId: row.scopeConversationIdViaJoin,
  })
  const state = row.state
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    spaceId: row.memorySpaceId,
    owner,
    scope,
    namespaceKey: row.spaceNamespaceKey,
    category: row.category,
    state,
    status: state,
    stability: "durable",
    importance: Number(row.importance ?? 0),
    confidence: Number(row.confidence ?? 0),
    tags: row.tags ?? [],
    textDigest: row.textDigest || "",
    searchText: row.searchText || "",
    contentBlocks,
    sourceItemId: row.sourceItemId ?? undefined,
    sourceToolCallId: row.sourceToolCallId ?? undefined,
    sourceTurnId: row.sourceTurnId ?? undefined,
    supersedesMemoryId: row.supersedesItemId ?? undefined,
    metadata: row.metadata,
    indexStatus: row.indexStatus,
    embeddingModel: row.embeddingModel || undefined,
    embeddingDim: row.embeddingDim ?? undefined,
    indexedAt: serializeOptionalInstant(row.indexedAt),
    indexError: row.indexError ?? undefined,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
    ownerLabel: row.ownerLabel ?? undefined,
    scopeLabel: row.scopeLabel ?? undefined,
  }
}

export function presentMemoryAccessGrant(
  row: MemoryAccessGrantRow
): MemoryAccessGrantView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    memorySpaceId: row.memorySpaceId,
    memoryItemId: row.memoryItemId,
    subjectId: row.subjectId,
    scopeSubjectId: row.scopeSubjectId,
    permissions: row.permissions,
    status: row.status,
    source: row.source,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId,
    sourceTaskId: row.sourceTaskId,
    revokedAt: serializeOptionalInstant(row.revokedAt) ?? null,
    supersededAt: serializeOptionalInstant(row.supersededAt) ?? null,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}
