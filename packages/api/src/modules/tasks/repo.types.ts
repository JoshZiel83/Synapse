import type {
  ChatTaskResolveOutcome,
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestedAction,
  TaskRequestKind,
} from "@synapse/shared/types"
import type { TableInsert } from "../../infrastructure/database/kysely.js"
import type {
  ToolCallTaskLifecycleStatus,
  ToolCallTaskOutcome,
} from "../tool-call-tasks/service.js"

/**
 * Column-type aliases for the tasks module. Grouping the
 * TableInsert<...> projections here keeps r2 (no TableInsert< in
 * service.ts) satisfied — the service imports these aliases and casts
 * against them instead of reaching into generated/db column types.
 */
export type ToolCallTaskResponseCommandsBaseRevision =
  TableInsert<"toolCallTaskResponseCommands">["baseRevision"]
export type ToolCallTaskResponseCommandsRequestPayload =
  TableInsert<"toolCallTaskResponseCommands">["requestPayload"]
export type ToolCallTaskResponseCommandsResponsePayload =
  TableInsert<"toolCallTaskResponseCommands">["responsePayload"]

export type ToolCallTaskRuntimeAuthorizationSourceRequestArgs =
  TableInsert<"toolCallTaskRuntimeAuthorization">["sourceRequestArgs"]
export type ToolCallTaskRuntimeAuthorizationRequestedAction =
  TableInsert<"toolCallTaskRuntimeAuthorization">["requestedAction"]
export type ToolCallTaskRuntimeAuthorizationGrantOptions =
  TableInsert<"toolCallTaskRuntimeAuthorization">["grantOptions"]
export type ToolCallTaskRuntimeAuthorizationAvailablePresets =
  TableInsert<"toolCallTaskRuntimeAuthorization">["availablePresets"]

export type ToolCallTasksFinalResultPayload =
  TableInsert<"toolCallTasks">["finalResultPayload"]

export type ToolCallTaskActionTokensPayload =
  TableInsert<"toolCallTaskActionTokens">["payload"]

export interface ActionTokenPayload {
  /** One of the option labels we offered (e.g. "allow_once", "deny"). */
  decision: string
  /** Optional preset id (runtime-authorization preset selection). */
  preset?: string
  /** Optional grant option id when the user picks among grant_options. */
  selectedGrantOptionId?: string
}

/**
 * The denormalized task row shape returned by the tasks-module SQL joins
 * (getTaskRowById / getTaskRowByIdForUpdate). This is a hand-written row
 * projection (column aliases) — not a generated TableRow — so the presenter
 * can consume it structurally via `import type` without touching generated/db.
 *
 * Convention A: keys are camelCase. CamelCasePlugin's `transformResult` is
 * unconditional, so the raw-`sql` join rows arrive camelCase at runtime
 * (bare physical columns from `ir.*` + double-quoted camelCase aliases for
 * computed/renamed columns). There is intentionally NO index signature here so
 * tsc catches any stray snake_case read on this row.
 */
export type RawTaskRow = {
  id: string
  workspaceId: string
  conversationId: string
  // Task unification: the row IS the task. sessionId lives on it (nullable for
  // remote_agent_channel delivery). The legacy task_id pointer is gone.
  sessionId: string | null
  remoteAgentRunId: string | null
  conversationItemId: string | null
  kind: TaskRequestKind
  lifecycleStatus: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
  revision: string | number
  promptPayload: Record<string, unknown>
  planPayload: Record<string, unknown>
  requestedToolName: string | null
  reason: string | null
  requestMode: string | null
  requestedAction: RuntimeAuthorizationRequestedAction | null
  grantOptions: RuntimeAuthorizationGrantOption[] | null
  availablePresets: RuntimeAuthorizationPreset[] | null
  sourceRequestArgs: Record<string, unknown> | null
  sourceRuntimeSessionId: string | null
  sourceRetryNonce: string | null
  // subject-scope-refactor: principalRemoteAgentId is derived from
  // principalSubjectId rather than stored on the runtime authorization detail.
  // principalSubjectId (NOT NULL) + principalScopeSubjectId (nullable),
  // both FK to access_subjects with ON DELETE RESTRICT (durable audit).
  principalSubjectId: string
  principalScopeSubjectId: string | null
  // Derived alias for dashboard consumers.
  principalRemoteAgentId: string | null
  principalSubjectKind: string | null
  resolutionPayload: Record<string, unknown>
  resolvedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
  requesterParticipantId: string | null
  requesterWorkspaceMemberId: string | null
  requesterActorId: string | null
  requesterRemoteAgentId: string | null
  targetActorId: string | null
  targetWorkspaceMemberId: string | null
  targetRemoteAgentId: string | null
  targetParticipantId: string | null
  resolvedByActorId: string | null
  resolvedByWorkspaceMemberId: string | null
  resolvedByRemoteAgentId: string | null
  resolvedByParticipantId: string | null
  runtimeCapabilityId: string | null
  runtimeId: string | null
  runtimeExposureId: string | null
  runtimeToolStableKey: string | null
  runtimeDisplayName: string | null
  exposureDisplayName: string | null
  exposureStableKey: string | null
  requesterParticipantType: string | null
  requesterName: string | null
  requesterTitle: string | null
  requesterRole: string | null
  requesterActorAvatarFileId: string | null
  requesterUserAvatarFileId: string | null
  requesterRemoteAgentAvatarFileId: string | null
  requesterAvatarEmoji: string | null
  targetParticipantType: string | null
  targetName: string | null
  targetTitle: string | null
  targetRole: string | null
  targetActorAvatarFileId: string | null
  targetUserAvatarFileId: string | null
  targetRemoteAgentAvatarFileId: string | null
  targetAvatarEmoji: string | null
  resolvedByParticipantType: string | null
  resolvedByName: string | null
  resolvedByTitle: string | null
  resolvedByRole: string | null
  resolvedByActorAvatarFileId: string | null
  resolvedByUserAvatarFileId: string | null
  resolvedByRemoteAgentAvatarFileId: string | null
  resolvedByAvatarEmoji: string | null
}

export type RawTaskDbRow = Omit<
  RawTaskRow,
  | "promptPayload"
  | "planPayload"
  | "requestedAction"
  | "grantOptions"
  | "availablePresets"
  | "sourceRequestArgs"
  | "resolutionPayload"
> & {
  promptPayload: unknown
  planPayload: unknown
  requestedAction: unknown
  grantOptions: unknown
  availablePresets: unknown
  sourceRequestArgs: unknown
  resolutionPayload: unknown
}

export type RawTaskCommandRow = {
  id: string
  taskId: string
  commandId: string
  baseRevision: string | number
  outcome: ChatTaskResolveOutcome
  requestPayload: unknown
  responsePayload: unknown
  createdByWorkspaceMemberId: string | null
  createdAt: Date
  updatedAt: Date
}

export type TaskCommandRow = Omit<
  RawTaskCommandRow,
  "requestPayload" | "responsePayload"
> & {
  requestPayload: Record<string, unknown>
  responsePayload: Record<string, unknown>
}
