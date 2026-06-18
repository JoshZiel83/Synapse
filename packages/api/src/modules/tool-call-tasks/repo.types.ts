import type {
  ToolCallTasksDeliveryKind,
  ToolCallTasksExecutorKind,
  ToolCallTasksHumanSurface,
  ToolCallTasksLifecycleStatus,
  ToolCallTasksOutcome,
} from "../../infrastructure/database/generated/db.js"
import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * Tool-call-task data-access types. The ONLY tool-call-tasks file (besides
 * repo*.ts) allowed to touch `generated/db` / `TableRow` / `TableInsert`
 * (guard-layering r1/r2). Houses the DB-row types, the per-column type aliases
 * the service casts JSON payloads to, and the app-facing enum re-exports
 * derived from the DB enums.
 */

// ── App-facing enum aliases (derived from the DB enums) ─────────────────────
export type ToolCallTaskLifecycleStatus = ToolCallTasksLifecycleStatus
export type ToolCallTaskOutcome = ToolCallTasksOutcome
export type ToolCallTaskDeliveryKind = ToolCallTasksDeliveryKind
export type ToolCallTaskHumanSurface = ToolCallTasksHumanSurface
export type ToolCallTaskExecutorKind = ToolCallTasksExecutorKind

// ── DB-row types ────────────────────────────────────────────────────────────
type ToolCallTaskRawRow = TableRow<"toolCallTasks">

export type ToolCallTaskRow = Omit<
  ToolCallTaskRawRow,
  | "requestPayload"
  | "immediateResultPayload"
  | "finalResultPayload"
  | "finalErrorPayload"
  | "metadata"
  | "retentionTtlMs"
> & {
  requestPayload: Record<string, unknown>
  immediateResultPayload: Record<string, unknown>
  finalResultPayload: Record<string, unknown>
  finalErrorPayload: Record<string, unknown>
  metadata: Record<string, unknown>
  // retention_ttl_ms is BIGINT (Int8 = string at the wire); the repo decodes
  // it back to a JS number on exit, so the decoded row exposes number | null.
  retentionTtlMs: number | null
}

type ToolCallTaskOutputChunkRawRow = Pick<
  TableRow<"toolCallTaskOutputChunks">,
  "createdAt" | "metadata" | "seq" | "stream" | "textValue"
>

export type ToolCallTaskOutputChunkRow = Omit<
  ToolCallTaskOutputChunkRawRow,
  "metadata"
> & {
  metadata: Record<string, unknown>
}

export type { ToolCallTaskRawRow, ToolCallTaskOutputChunkRawRow }

// ── Insert column-type aliases (JSON columns the service casts payloads to) ──
export type ToolCallTaskInsert = TableInsert<"toolCallTasks">
export type ToolCallTaskRequestPayload = ToolCallTaskInsert["requestPayload"]
export type ToolCallTaskImmediateResultPayload =
  ToolCallTaskInsert["immediateResultPayload"]
export type ToolCallTaskFinalResultPayload =
  ToolCallTaskInsert["finalResultPayload"]
export type ToolCallTaskFinalErrorPayload =
  ToolCallTaskInsert["finalErrorPayload"]
export type ToolCallTaskMetadata = ToolCallTaskInsert["metadata"]

export type ToolCallTaskOutputChunkInsert =
  TableInsert<"toolCallTaskOutputChunks">
export type ToolCallTaskOutputChunkMetadata =
  ToolCallTaskOutputChunkInsert["metadata"]
