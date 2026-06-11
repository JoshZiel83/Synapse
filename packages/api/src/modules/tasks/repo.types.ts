import type { TaskRequestKind } from "@synapse/shared/types"
import type { ChatTaskResolveOutcome } from "@synapse/shared/types"
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

/**
 * The denormalized task row shape returned by the tasks-module SQL joins
 * (getTaskRowById / getTaskRowByIdForUpdate). This is a hand-written row
 * projection (column aliases) — not a generated TableRow — so the presenter
 * can consume it structurally via `import type` without touching generated/db.
 */
export type RawTaskRow = {
  id: string
  workspace_id: string
  conversation_id: string
  // Task unification: the row IS the task. session_id lives on it (nullable for
  // remote_agent_channel delivery). The legacy task_id pointer is gone.
  session_id: string | null
  remote_agent_run_id: string | null
  conversation_item_id: string | null
  kind: TaskRequestKind
  lifecycle_status: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
  revision: string | number
  prompt_payload: unknown
  plan_payload: unknown
  requested_tool_name: string | null
  reason: string | null
  request_mode: string | null
  requested_action: unknown
  grant_options: unknown
  available_presets: unknown
  source_request_args: unknown
  source_runtime_session_id: string | null
  source_retry_nonce: string | null
  // subject-scope-refactor: principal_remote_agent_id is derived from
  // principal_subject_id rather than stored on the runtime authorization detail.
  // principal_subject_id (NOT NULL) + principal_scope_subject_id (nullable),
  // both FK to access_subjects with ON DELETE RESTRICT (durable audit).
  principal_subject_id: string
  principal_scope_subject_id: string | null
  // Derived alias for dashboard consumers.
  principal_remote_agent_id: string | null
  principal_subject_kind: string | null
  resolution_payload: unknown
  resolved_at: Date | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
  requester_participant_id: string | null
  requester_workspace_member_id: string | null
  requester_actor_id: string | null
  requester_remote_agent_id: string | null
  target_actor_id: string | null
  target_workspace_member_id: string | null
  target_remote_agent_id: string | null
  target_participant_id: string | null
  resolved_by_actor_id: string | null
  resolved_by_workspace_member_id: string | null
  resolved_by_remote_agent_id: string | null
  resolved_by_participant_id: string | null
  device_capability_id: string | null
  device_id: string | null
  device_exposure_id: string | null
  device_tool_stable_key: string | null
  device_display_name: string | null
  exposure_display_name: string | null
  exposure_stable_key: string | null
  requester_participant_type: string | null
  requester_name: string | null
  requester_title: string | null
  requester_role: string | null
  requester_actor_avatar_file_id: string | null
  requester_user_avatar_file_id: string | null
  requester_remote_agent_avatar_file_id: string | null
  requester_avatar_emoji: string | null
  target_participant_type: string | null
  target_name: string | null
  target_title: string | null
  target_role: string | null
  target_actor_avatar_file_id: string | null
  target_user_avatar_file_id: string | null
  target_remote_agent_avatar_file_id: string | null
  target_avatar_emoji: string | null
  resolved_by_participant_type: string | null
  resolved_by_name: string | null
  resolved_by_title: string | null
  resolved_by_role: string | null
  resolved_by_actor_avatar_file_id: string | null
  resolved_by_user_avatar_file_id: string | null
  resolved_by_remote_agent_avatar_file_id: string | null
  resolved_by_avatar_emoji: string | null
}

export type RawTaskCommandRow = {
  id: string
  task_id: string
  command_id: string
  base_revision: string | number
  outcome: ChatTaskResolveOutcome
  request_payload: unknown
  response_payload: unknown
  created_by_workspace_member_id: string | null
  created_at: Date
  updated_at: Date
}
