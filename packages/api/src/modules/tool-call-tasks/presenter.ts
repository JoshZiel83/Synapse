import type { Timestamp } from "@synapse/shared"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import type {
  ToolCallTaskDeliveryKind,
  ToolCallTaskExecutorKind,
  ToolCallTaskHumanSurface,
  ToolCallTaskLifecycleStatus,
  ToolCallTaskOutcome,
  ToolCallTaskOutputChunkRow,
  ToolCallTaskRow,
} from "./repo.types.js"

/**
 * Tool-call-task presentation layer: repo record → app-facing record/DTO. Owns
 * outward semantic transforms (Date → IsoInstantString) so the service/controller
 * never call serializeInstant/serializeOptionalInstant (guard-layering r3).
 * The repo owns DB JSONB decoding before records reach this file.
 */

export interface ToolCallTaskRecord {
  id: string
  workspaceId: string
  conversationId: string
  /** Axis 1: where the result comes from. */
  executorKind: ToolCallTaskExecutorKind
  /** Axis 2: how the blocked waiter (agent) is woken. */
  deliveryKind: ToolCallTaskDeliveryKind
  /** Axis 3: does a human see/answer this? */
  humanSurface: ToolCallTaskHumanSurface
  /** THE delivery key (actor OR remote_agent subject). */
  principalSubjectId: string
  /** Present iff delivery_kind=session_wakeup. */
  sessionId?: string
  /** Optional associative col (ask/plan have it, runtime_auth doesn't). */
  remoteAgentRunId?: string
  turnId?: string
  sourceToolCallId?: string
  sourceToolName: string
  /** Pure lifecycle state machine. */
  lifecycleStatus: ToolCallTaskLifecycleStatus
  /** Business verdict, set only when lifecycleStatus='completed'. */
  outcome?: ToolCallTaskOutcome
  statusMessage?: string
  supportsCancel: boolean
  supportsOutputTail: boolean
  /** Optimistic-concurrency token for human resolution. */
  revision: number
  requestKey: string
  requesterParticipantId?: string
  targetParticipantId?: string
  resolvedByParticipantId?: string
  resolvedAt?: Timestamp
  requestPayload: Record<string, unknown>
  immediateResultPayload: Record<string, unknown>
  finalResultPayload: Record<string, unknown>
  finalErrorPayload: Record<string, unknown>
  metadata: Record<string, unknown>
  conversationItemId?: string
  completionItemId?: string
  deadlineAt?: Timestamp
  expiresAt?: Timestamp
  retentionTtlMs?: number
  retainUntil?: Timestamp
  cancelRequestedAt?: Timestamp
  cancelReason?: string
  lastOutputSeq: number
  lastOutputAt?: Timestamp
  completedAt?: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface ToolCallTaskOutputChunk {
  seq: number
  stream: "stdout" | "stderr" | "system"
  text: string
  createdAt: Timestamp
  metadata: Record<string, unknown>
}

export function presentToolCallTask(
  row: ToolCallTaskRow | null
): ToolCallTaskRecord | null {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    executorKind: row.executorKind as ToolCallTaskExecutorKind,
    deliveryKind: row.deliveryKind as ToolCallTaskDeliveryKind,
    humanSurface: row.humanSurface as ToolCallTaskHumanSurface,
    principalSubjectId: row.principalSubjectId,
    sessionId: row.sessionId || undefined,
    remoteAgentRunId: row.remoteAgentRunId || undefined,
    turnId: row.turnId || undefined,
    sourceToolCallId: row.sourceToolCallId || undefined,
    sourceToolName: row.sourceToolName,
    lifecycleStatus: row.lifecycleStatus as ToolCallTaskLifecycleStatus,
    outcome: (row.outcome as ToolCallTaskOutcome | null) || undefined,
    statusMessage: row.statusMessage || undefined,
    supportsCancel: row.supportsCancel === true,
    supportsOutputTail: row.supportsOutputTail === true,
    revision:
      typeof row.revision === "number"
        ? row.revision
        : Number(row.revision || 1),
    requestKey: row.requestKey,
    requesterParticipantId: row.requesterParticipantId || undefined,
    targetParticipantId: row.targetParticipantId || undefined,
    resolvedByParticipantId: row.resolvedByParticipantId || undefined,
    resolvedAt: serializeOptionalInstant(row.resolvedAt),
    requestPayload: row.requestPayload,
    immediateResultPayload: row.immediateResultPayload,
    finalResultPayload: row.finalResultPayload,
    finalErrorPayload: row.finalErrorPayload,
    metadata: row.metadata,
    conversationItemId: row.conversationItemId || undefined,
    completionItemId: row.completionItemId || undefined,
    deadlineAt: serializeOptionalInstant(row.deadlineAt),
    expiresAt: serializeOptionalInstant(row.expiresAt),
    retentionTtlMs:
      row.retentionTtlMs == null ? undefined : Number(row.retentionTtlMs),
    retainUntil: serializeOptionalInstant(row.retainUntil),
    cancelRequestedAt: serializeOptionalInstant(row.cancelRequestedAt),
    cancelReason: row.cancelReason || undefined,
    lastOutputSeq:
      typeof row.lastOutputSeq === "number"
        ? row.lastOutputSeq
        : Number(row.lastOutputSeq || 0),
    lastOutputAt: serializeOptionalInstant(row.lastOutputAt),
    completedAt: serializeOptionalInstant(row.completedAt),
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, `Tool-call task ${row.id} created_at`)
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updatedAt, `Tool-call task ${row.id} updated_at`)
    ),
  } satisfies ToolCallTaskRecord
}

export function presentToolCallTaskOutputChunk(
  row: ToolCallTaskOutputChunkRow
): ToolCallTaskOutputChunk {
  return {
    seq: typeof row.seq === "number" ? row.seq : Number(row.seq || 0),
    stream: row.stream as ToolCallTaskOutputChunk["stream"],
    text: row.textValue,
    createdAt: serializeInstant(
      requireInstantDate(
        row.createdAt,
        "Tool-call task output chunk created_at"
      )
    ),
    metadata: row.metadata,
  }
}
