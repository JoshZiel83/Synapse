import {
  CONVERSATION_PARTICIPANT_TYPE,
  TASK_INPUT_QUESTION_TYPES,
  TASK_REQUEST_KIND,
  parseJsonObject,
  textBlocks,
  type SubjectRef,
} from "@synapse/shared"
import {
  isGroupConversationKind,
  isPlanAwaitingApprovalCollaborationMode,
} from "@synapse/shared/utils"
import { v4 as uuidv4 } from "uuid"
import type {
  CanonicalContentBlock,
  ChatTaskResolveInput,
  ChatTaskResolveOutcome,
  ConversationFeedItem,
  ConversationFeedEventPayloadMap,
  ConversationEntityRef,
  TaskDecision,
  TaskInputAnswer,
  TaskInputOption,
  TaskInputQuestionDefinition,
  TaskInputQuestionSummary,
  TaskRequestKind,
  TaskSummary,
  PlanApprovalDecision,
  PlanChecklistStep,
  RuntimeAuthorizationGrantOption,
  SharedRuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationTaskDetails,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
  SessionCollaborationState,
  Timestamp,
} from "@synapse/shared/types"
import {
  db,
  runBuilder,
  takeFirstOn,
  withDbTransaction,
  type Executor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import {
  deliverResolvedToolCallTask,
  recoverUndeliveredResolvedTask,
  insertToolCallTaskDeduped,
  findLiveToolCallTaskByRequestKey,
  type ToolCallTaskExecutorKind,
  type ToolCallTaskLifecycleStatus,
  type ToolCallTaskOutcome,
} from "../tool-call-tasks/service.js"
import { updateSessionCollaboration } from "../session/service.js"
import {
  authorizeAction,
  userSubject,
  workspaceMemberSubject,
} from "../access/service.js"
import {
  appendWorkspaceMemberSyncEvent,
  createConversationEvent,
  listConversationRealtimeRecipients,
  updateConversationItemEventPayload,
} from "../chat/service.js"
import { getFileUrlById } from "../files/service.js"
import { CompiledQuery, sql, type RawBuilder } from "kysely"
import {
  createRuntimeAuthorizationGrant,
  type RuntimeAuthorizationGrantRecord,
} from "../runtime-authorizations/service.js"
import { autoDispatchRuntimeAuthorizationRetry } from "../runtime-authorizations/auto-retry.js"
import {
  buildSessionPlanDraftState,
  parseSessionCollaborationState,
} from "../session/collaboration-state.js"
import { upsertTaskTransportProjection } from "./transport-projections.js"

/** Run raw SQL (text+params) on db / trx. */
async function runOn<T extends object = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return {
    rows: result.rows as T[],
    rowCount:
      result.numAffectedRows === undefined
        ? null
        : Number(result.numAffectedRows),
  }
}

/** `runOn` bound to the top-level db. */
function runOnDb<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return runOn<T>(db, text, params)
}

/**
 * Run a pre-compiled query on an optional executor: native executeQuery for
 * Kysely executors / top-level db (when undefined).
 */
async function runCompiledOn<T = any>(
  executor: Executor | undefined,
  compiled: CompiledQuery<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await (executor ?? db).executeQuery(compiled)
  return {
    rows: result.rows as T[],
    rowCount:
      result.numAffectedRows === undefined
        ? null
        : Number(result.numAffectedRows),
  }
}

type RawTaskRow = {
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

type RawTaskCommandRow = {
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

function toRevisionNumber(
  value: string | number | null | undefined,
  label: string
) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed)
    }
  }
  throw new Error(`${label} must be a finite revision number`)
}

export interface CreateUserInputTaskParams {
  workspaceId: string
  conversationId: string
  taskId: string
  requesterParticipantId: string
  targetParticipantId: string
  title: string
  instructions?: string
  questions: TaskInputQuestionDefinition[]
  expiresAt?: Timestamp
}

export interface CreateRemoteAgentUserInputTaskParams {
  workspaceId: string
  conversationId: string
  remoteAgentRunId: string
  requesterParticipantId: string
  targetParticipantId?: string
  title: string
  instructions?: string
  questions: TaskInputQuestionDefinition[]
  expiresAt?: Timestamp
}

export interface CreatePlanApprovalTaskParams {
  workspaceId: string
  conversationId: string
  sessionId: string
  taskId: string
  requesterParticipantId: string
  targetParticipantId: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
  collaborationState: SessionCollaborationState
  expiresAt?: Timestamp
}

export interface CreateRemoteAgentPlanApprovalTaskParams {
  workspaceId: string
  conversationId: string
  remoteAgentRunId: string
  requesterParticipantId: string
  targetParticipantId?: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
  collaborationMode?: string
  collaborationState?: Record<string, unknown>
  expiresAt?: Timestamp
}

export interface CreateRuntimeAuthorizationTaskParams {
  workspaceId: string
  conversationId: string
  /**
   * Optional. Actor principals create a
   * tool_call_task so the approval can drive a chat wakeup; remote_agent
   * principals leave it undefined — the bridged agent retries its own
   * tool call on the next round-trip.
   */
  taskId?: string
  requesterParticipantId: string
  deviceCapabilityId: string
  deviceId: string
  deviceExposureId: string
  requestedToolName: string
  runtimeSessionId: string
  deviceToolStableKey: string
  reason: string
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  requestMode: RuntimeAuthorizationRequestMode
  sourceRetryNonce?: string
  sourceRequestArgs?: Record<string, unknown>
  expiresAt?: Timestamp
  /**
   * subject-scope-refactor: principalSubjectId (NOT NULL) — the
   * access_subjects row for the principal that triggered the dispatch.
   * Caller resolves via upsertAccessSubject(actor/remote_agent/conversation)
   * before invoking this function.
   */
  principalSubjectId: string
  /**
   * Optional principal scope subject id (the conversation subject when the
   * triggering principal was an active participant); null otherwise.
   */
  principalScopeSubjectId?: string | null
  /**
   * @deprecated kept for transitional callers; not written to the DB.
   * The approval flow now uses principalSubjectId + presetToOwnerScope.
   */
  principalRemoteAgentId?: string
}

export type ResolveTaskRequestParams = ChatTaskResolveInput & {
  taskId: string
  resolverWorkspaceMemberId: string
  resolverParticipantId: string
}

export interface ResolveTaskRequestResult {
  outcome: ChatTaskResolveOutcome
  task: TaskSummary
  createdGrant?: RuntimeAuthorizationGrantRecord
  createdGrants?: RuntimeAuthorizationGrantRecord[]
}

export interface FindOpenRuntimeAuthorizationTaskParams {
  workspaceId: string
  conversationId: string
  requesterParticipantId: string
  deviceCapabilityId: string
  deviceId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  requestMode: RuntimeAuthorizationRequestMode
  /**
   * Source Agent session id (chat-runtime session.id). Must match the
   * value the caller would write via createRuntimeAuthorizationTaskRequest's
   * `runtimeSessionId` field so the dedupe key matches a previously-created
   * row. Pass the empty string when the caller has no session context (the
   * dedupe still works within that single bucket).
   */
  runtimeSessionId: string
}

function requireJsonObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`)
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} is required`)
    }
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object`)
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `${label} must be a JSON object`
      ) {
        throw error
      }
      throw new Error(`${label} must be a valid JSON object`)
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseJsonArray<T>(value: unknown, label: string): T[] {
  if (value === null || value === undefined) {
    return []
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array`)
      }
      return parsed as T[]
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `${label} must be a JSON array`
      ) {
        throw error
      }
      throw new Error(`${label} must be a valid JSON array`)
    }
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`)
  }
  return value as T[]
}

function requireTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}

function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    )
    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function jsonbValue<T>(value: T) {
  return sql<T>`${JSON.stringify(value ?? null)}::jsonb`
}

/**
 * Build the dedupe key used to merge identical pending runtime-authorization
 * requests. Exported for unit-testing the per-session isolation contract —
 * two callers differing only in runtimeSessionId MUST produce different
 * keys so concurrent Agent sessions never share a single pending task
 * (and, post-approval, never inherit each other's source_runtime_session_id).
 */
export function buildRuntimeAuthorizationDedupeKey(params: {
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  requestMode: RuntimeAuthorizationRequestMode
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  /**
   * Source Agent session id. Included in the dedupe key so two Agent
   * sessions making the same tool call don't merge into a single pending
   * task — critical for CUA where the per-session focusStore would
   * end up keyed off whichever session wrote the row first, then the
   * auto-retry would stamp the WRONG cua_focus_scope_id into the approved
   * envelope. Non-cua capabilities also benefit from per-session approval
   * isolation (different sessions = different audit-trail intent). Pass
   * the empty string for legacy callers that don't have it; the dedupe
   * still works within that single "no-session" bucket.
   */
  runtimeSessionId: string
}) {
  return stableJsonStringify({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
}

function buildTaskRequestKey(taskId: string) {
  return `task:${taskId}`
}

function buildRemoteAgentTaskRequestKey(params: {
  remoteAgentRunId: string
  kind: TaskRequestKind
}) {
  return `remote-agent-run:${params.remoteAgentRunId}:${params.kind}`
}

export function buildRuntimeAuthorizationRequestKey(params: {
  conversationId: string
  requesterParticipantId: string
  dedupeKey: string
}) {
  return stableJsonStringify({
    conversationId: params.conversationId,
    requesterParticipantId: params.requesterParticipantId,
    kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    dedupeKey: params.dedupeKey,
  })
}

function entityAvatarUrl(
  primaryAvatarFileId?: string | null,
  secondaryAvatarFileId?: string | null,
  tertiaryAvatarFileId?: string | null
) {
  if (primaryAvatarFileId) return getFileUrlById(primaryAvatarFileId)
  if (secondaryAvatarFileId) return getFileUrlById(secondaryAvatarFileId)
  if (tertiaryAvatarFileId) return getFileUrlById(tertiaryAvatarFileId)
  return undefined
}

function parseInputOptions(
  value: unknown,
  optionListLabel = "options"
): TaskInputOption[] {
  if (!Array.isArray(value)) {
    return []
  }

  const options: TaskInputOption[] = []
  const usedIds = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(
        `Option ${index + 1} in ${optionListLabel} must be an object`
      )
    }
    const rawId = requireTrimmedString(
      (item as { id?: unknown }).id,
      `Option ${index + 1} id in ${optionListLabel}`
    )
    const optionLabel = requireTrimmedString(
      (item as { label?: unknown }).label,
      `Option ${index + 1} label in ${optionListLabel}`
    )
    const description =
      typeof (item as { description?: unknown }).description === "string"
        ? (item as { description: string }).description.trim()
        : undefined
    const preview =
      typeof (item as { preview?: unknown }).preview === "string"
        ? (item as { preview: string }).preview.trim()
        : undefined
    const id = rawId
    if (usedIds.has(id)) {
      throw new Error(`Duplicate option id "${id}" in ${optionListLabel}`)
    }
    usedIds.add(id)
    options.push({
      id,
      label: optionLabel,
      description: description || undefined,
      preview: preview || undefined,
    })
  }
  return options
}

function normalizeInputQuestionType(
  value: unknown
): TaskInputQuestionDefinition["type"] {
  if (
    typeof value === "string" &&
    (TASK_INPUT_QUESTION_TYPES as readonly string[]).includes(value)
  ) {
    return value as TaskInputQuestionDefinition["type"]
  }
  throw new Error(`Unsupported user input question type: ${String(value)}`)
}

function parseUserInputQuestionDefinitions(
  promptPayload: Record<string, unknown>
): TaskInputQuestionDefinition[] {
  const rawQuestions = promptPayload.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error(
      "user_input prompt_payload.questions must be a non-empty array"
    )
  }
  const definitions: TaskInputQuestionDefinition[] = []
  const usedIds = new Set<string>()

  for (const [index, question] of rawQuestions.entries()) {
    if (!question || typeof question !== "object") {
      throw new Error(`Question ${index + 1} must be an object`)
    }
    const id = requireTrimmedString(
      (question as { id?: unknown }).id,
      `Question ${index + 1} id`
    )
    if (usedIds.has(id)) {
      throw new Error(`Duplicate question id "${id}"`)
    }
    usedIds.add(id)

    const type = normalizeInputQuestionType(
      (question as { type?: unknown }).type
    )
    const definition: TaskInputQuestionDefinition = {
      id,
      header: requireTrimmedString(
        (question as { header?: unknown }).header,
        `Question ${index + 1} header`
      ),
      type,
      prompt: requireTrimmedString(
        (question as { prompt?: unknown }).prompt,
        `Question ${index + 1} prompt`
      ),
      description:
        typeof (question as { description?: unknown }).description === "string"
          ? (question as { description: string }).description.trim() ||
            undefined
          : undefined,
      required: (() => {
        if (
          typeof (question as { required?: unknown }).required !== "boolean"
        ) {
          throw new Error(`Question "${id}" required must be a boolean`)
        }
        return Boolean((question as { required: boolean }).required)
      })(),
    }

    if (type === "text") {
      definition.placeholder =
        typeof (question as { placeholder?: unknown }).placeholder === "string"
          ? (question as { placeholder: string }).placeholder.trim() ||
            undefined
          : undefined
      if (typeof (question as { secret?: unknown }).secret !== "boolean") {
        throw new Error(`Question "${id}" secret must be a boolean`)
      }
      definition.secret = Boolean((question as { secret: boolean }).secret)
    } else {
      definition.options = parseInputOptions(
        (question as { options?: unknown }).options,
        `question "${id}" options`
      )
      if (definition.options.length === 0) {
        throw new Error(`Question "${id}" requires at least one option`)
      }
      if (
        typeof (question as { allowOther?: unknown }).allowOther !== "boolean"
      ) {
        throw new Error(`Question "${id}" allowOther must be a boolean`)
      }
      definition.allowOther = Boolean(
        (question as { allowOther: boolean }).allowOther
      )
      if (
        (question as { minSelections?: unknown }).minSelections !== undefined &&
        (typeof (question as { minSelections?: unknown }).minSelections !==
          "number" ||
          !Number.isFinite(
            (question as { minSelections: number }).minSelections
          ))
      ) {
        throw new Error(
          `Question "${id}" minSelections must be a finite number`
        )
      }
      if (
        (question as { maxSelections?: unknown }).maxSelections !== undefined &&
        (typeof (question as { maxSelections?: unknown }).maxSelections !==
          "number" ||
          !Number.isFinite(
            (question as { maxSelections: number }).maxSelections
          ))
      ) {
        throw new Error(
          `Question "${id}" maxSelections must be a finite number`
        )
      }
      definition.minSelections =
        typeof (question as { minSelections?: unknown }).minSelections ===
        "number"
          ? Math.max(
              0,
              Math.trunc((question as { minSelections: number }).minSelections)
            )
          : undefined
      definition.maxSelections =
        typeof (question as { maxSelections?: unknown }).maxSelections ===
        "number"
          ? Math.max(
              1,
              Math.trunc((question as { maxSelections: number }).maxSelections)
            )
          : undefined
    }

    definitions.push(definition)
  }

  return definitions
}

function parseUserInputAnswers(
  resolutionPayload: Record<string, unknown>,
  questions: TaskInputQuestionDefinition[]
): TaskInputAnswer[] {
  const answers: TaskInputAnswer[] = []
  const seenQuestionIds = new Set<string>()

  if (resolutionPayload.answers === undefined) {
    return answers
  }
  if (!Array.isArray(resolutionPayload.answers)) {
    throw new Error("task resolution_payload.answers must be an array")
  }

  for (const [index, answer] of resolutionPayload.answers.entries()) {
    if (!answer || typeof answer !== "object") {
      throw new Error(`Answer ${index + 1} must be an object`)
    }
    const questionId = requireTrimmedString(
      (answer as { questionId?: unknown }).questionId,
      `Answer ${index + 1} questionId`
    )
    if (!questions.some((question) => question.id === questionId)) {
      throw new Error(`Answer references unknown question "${questionId}"`)
    }
    if (seenQuestionIds.has(questionId)) {
      throw new Error(`Duplicate answer for question "${questionId}"`)
    }
    seenQuestionIds.add(questionId)
    const selectedOptionIds = Array.isArray(
      (answer as { selectedOptionIds?: unknown }).selectedOptionIds
    )
      ? Array.from(
          new Set(
            (
              (answer as { selectedOptionIds: unknown[] }).selectedOptionIds ||
              []
            )
              .map((optionId) =>
                typeof optionId === "string" ? optionId.trim() : ""
              )
              .filter((optionId) => optionId.length > 0)
          )
        )
      : undefined
    if (
      (answer as { selectedOptionIds?: unknown }).selectedOptionIds !==
        undefined &&
      !Array.isArray(
        (answer as { selectedOptionIds?: unknown }).selectedOptionIds
      )
    ) {
      throw new Error(
        `Answer "${questionId}" selectedOptionIds must be an array`
      )
    }
    const selectedOptionLabels = Array.isArray(
      (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels
    )
      ? (
          (answer as { selectedOptionLabels: unknown[] })
            .selectedOptionLabels || []
        )
          .map((label) => (typeof label === "string" ? label.trim() : ""))
          .filter((label) => label.length > 0)
      : undefined
    if (
      (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels !==
        undefined &&
      !Array.isArray(
        (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels
      )
    ) {
      throw new Error(
        `Answer "${questionId}" selectedOptionLabels must be an array`
      )
    }
    const otherText =
      typeof (answer as { otherText?: unknown }).otherText === "string"
        ? (answer as { otherText: string }).otherText.trim() || undefined
        : undefined
    if (
      (answer as { otherText?: unknown }).otherText !== undefined &&
      typeof (answer as { otherText?: unknown }).otherText !== "string"
    ) {
      throw new Error(`Answer "${questionId}" otherText must be a string`)
    }
    const text =
      typeof (answer as { text?: unknown }).text === "string"
        ? (answer as { text: string }).text.trim() || undefined
        : undefined
    if (
      (answer as { text?: unknown }).text !== undefined &&
      typeof (answer as { text?: unknown }).text !== "string"
    ) {
      throw new Error(`Answer "${questionId}" text must be a string`)
    }
    answers.push({
      questionId,
      selectedOptionIds,
      selectedOptionLabels,
      otherText,
      text,
    })
  }
  return answers
}

function buildUserInputQuestionSummaries(
  promptPayload: Record<string, unknown>,
  resolutionPayload: Record<string, unknown>
): TaskInputQuestionSummary[] {
  const definitions = parseUserInputQuestionDefinitions(promptPayload)
  const answers = parseUserInputAnswers(resolutionPayload, definitions)
  const answerMap = new Map<string, TaskInputAnswer>()
  for (const answer of answers) {
    answerMap.set(answer.questionId, answer)
  }

  return definitions.map((question) => {
    const answer = answerMap.get(question.id)
    const labels =
      answer?.selectedOptionIds?.map(
        (selectedId: string) =>
          (question.options || []).find(
            (option: TaskInputOption) => option.id === selectedId
          )?.label || selectedId
      ) || undefined
    return {
      ...question,
      required: question.required === true,
      answer: answer
        ? {
            ...answer,
            selectedOptionLabels:
              answer.selectedOptionLabels &&
              answer.selectedOptionLabels.length > 0
                ? answer.selectedOptionLabels
                : labels,
          }
        : undefined,
    }
  })
}

function summarizeUserInputAnswers(
  userInput: TaskSummary["userInput"]
): string {
  if (!userInput) {
    return "a response"
  }

  const parts: string[] = []
  for (const question of userInput.questions) {
    const answer = question.answer
    if (!answer) continue
    const valueParts: string[] = []
    if (answer.selectedOptionLabels?.length) {
      valueParts.push(answer.selectedOptionLabels.join(", "))
    }
    if (answer.otherText) {
      valueParts.push(answer.otherText)
    }
    if (answer.text) {
      valueParts.push(answer.text)
    }
    if (valueParts.length === 0) {
      continue
    }
    parts.push(
      userInput.questions.length === 1
        ? valueParts.join(", ")
        : `${question.prompt}: ${valueParts.join(", ")}`
    )
  }

  if (parts.length === 0) {
    return "a response"
  }
  return parts.join(" | ")
}

function mapEntityRefFromRow(
  prefix: "requester" | "target" | "resolved_by",
  row: RawTaskRow
): ConversationEntityRef | undefined {
  const participantType = row[`${prefix}_participant_type` as keyof RawTaskRow]
  if (typeof participantType !== "string" || !participantType.trim()) {
    return undefined
  }
  const participantId = row[`${prefix}_participant_id` as keyof RawTaskRow]
  const workspaceMemberId =
    prefix === "requester"
      ? row.requester_workspace_member_id
      : prefix === "target"
        ? row.target_workspace_member_id
        : row.resolved_by_workspace_member_id
  const actorId =
    prefix === "requester"
      ? row.requester_actor_id
      : prefix === "target"
        ? row.target_actor_id
        : row.resolved_by_actor_id
  const remoteAgentId =
    prefix === "requester"
      ? row.requester_remote_agent_id
      : prefix === "target"
        ? row.target_remote_agent_id
        : row.resolved_by_remote_agent_id
  const name = row[`${prefix}_name` as keyof RawTaskRow]
  const title = row[`${prefix}_title` as keyof RawTaskRow]
  const role = row[`${prefix}_role` as keyof RawTaskRow]
  const actorAvatarFileId =
    row[`${prefix}_actor_avatar_file_id` as keyof RawTaskRow]
  const userAvatarFileId =
    row[`${prefix}_user_avatar_file_id` as keyof RawTaskRow]
  const remoteAgentAvatarFileId =
    row[`${prefix}_remote_agent_avatar_file_id` as keyof RawTaskRow]
  const avatarEmoji = row[`${prefix}_avatar_emoji` as keyof RawTaskRow]

  return {
    participantId:
      typeof participantId === "string" ? participantId : undefined,
    participantType:
      participantType as ConversationEntityRef["participantType"],
    actorId: typeof actorId === "string" ? actorId : undefined,
    remoteAgentId:
      typeof remoteAgentId === "string" ? remoteAgentId : undefined,
    workspaceMemberId:
      typeof workspaceMemberId === "string" ? workspaceMemberId : undefined,
    name: typeof name === "string" ? name : undefined,
    title: typeof title === "string" ? title : undefined,
    role: typeof role === "string" ? role : undefined,
    avatarUrl: entityAvatarUrl(
      typeof remoteAgentAvatarFileId === "string"
        ? remoteAgentAvatarFileId
        : null,
      typeof actorAvatarFileId === "string" ? actorAvatarFileId : null,
      typeof userAvatarFileId === "string" ? userAvatarFileId : null
    ),
    avatarEmoji: typeof avatarEmoji === "string" ? avatarEmoji : undefined,
  }
}

function requireEntityRef(
  entity: ConversationEntityRef | undefined,
  label: string
): ConversationEntityRef {
  if (!entity?.participantId || !entity.participantType) {
    throw new Error(`${label} is missing a participant entity`)
  }
  return entity
}

type TaskResolutionStatus =
  | "answered"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "superseded"

function isOpenTaskLifecycle(lifecycle: ToolCallTaskLifecycleStatus): boolean {
  switch (lifecycle) {
    case "submitted":
    case "working":
    case "input_required":
    case "auth_required":
      return true
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return false
  }
}

/**
 * Resolve a conversation participant to its access_subjects id (the task
 * delivery key). Used by the remote-agent task paths that mint their own
 * task (the principal is the requesting remote_agent's participant subject).
 */
async function resolveParticipantSubjectId(
  client: Executor,
  participantId: string
): Promise<string> {
  const row = await client
    .selectFrom("conversationParticipants")
    .select("subjectId")
    .where("id", "=", participantId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.subjectId) {
    throw new Error(`Participant ${participantId} has no subject`)
  }
  return row.subjectId
}

function buildTaskSummary(row: RawTaskRow): TaskSummary {
  const requester = requireEntityRef(
    mapEntityRefFromRow("requester", row),
    `Task ${row.id} requester`
  )
  const target = mapEntityRefFromRow("target", row)
  const resolvedBy = row.resolved_by_participant_id
    ? requireEntityRef(
        mapEntityRefFromRow("resolved_by", row),
        `Task ${row.id} resolved_by`
      )
    : undefined
  const resolutionPayload = requireJsonObject(
    row.resolution_payload,
    `Task ${row.id} resolution_payload`
  )

  const baseTask = {
    id: row.id,
    remoteAgentRunId: row.remote_agent_run_id || undefined,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.conversation_item_id || undefined,
    lifecycleStatus: row.lifecycle_status,
    outcome: row.outcome || undefined,
    revision: toRevisionNumber(row.revision, `Task ${row.id} revision`),
    requester,
    resolvedBy,
    resolutionNote:
      typeof resolutionPayload.note === "string"
        ? resolutionPayload.note.trim() || undefined
        : undefined,
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
    resolvedAt: serializeOptionalInstant(row.resolved_at),
    expiresAt: serializeOptionalInstant(row.expires_at),
    viewerCanResolve: false,
  }

  if (row.kind === TASK_REQUEST_KIND.USER_INPUT) {
    const promptPayload = requireJsonObject(
      row.prompt_payload,
      `Task ${row.id} prompt_payload`
    )
    return {
      ...baseTask,
      kind: TASK_REQUEST_KIND.USER_INPUT,
      target,
      userInput: {
        title: requireTrimmedString(
          promptPayload.title,
          `Task ${row.id} user_input.title`
        ),
        instructions:
          typeof promptPayload.instructions === "string"
            ? promptPayload.instructions.trim() || undefined
            : undefined,
        questions: buildUserInputQuestionSummaries(
          promptPayload,
          resolutionPayload
        ),
      },
    }
  }

  if (row.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    const planPayload = requireJsonObject(
      row.plan_payload,
      `Task ${row.id} plan_payload`
    )
    return {
      ...baseTask,
      kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
      target,
      planApproval: {
        title: requireTrimmedString(
          planPayload.title,
          `Task ${row.id} plan_approval.title`
        ),
        summary:
          typeof planPayload.summary === "string"
            ? planPayload.summary.trim() || undefined
            : undefined,
        planMarkdown: requireTrimmedString(
          planPayload.planMarkdown,
          `Task ${row.id} plan_approval.planMarkdown`
        ),
        checklist: Array.isArray(planPayload.checklist)
          ? (planPayload.checklist as PlanChecklistStep[])
          : undefined,
      },
    }
  }

  const requestedAction = requireJsonObject(
    row.requested_action,
    `Task ${row.id} requested_action`
  ) as unknown as RuntimeAuthorizationRequestedAction
  const grantOptions = parseJsonArray<RuntimeAuthorizationGrantOption>(
    row.grant_options,
    `Task ${row.id} grant_options`
  )
  const availablePresets = parseJsonArray<RuntimeAuthorizationPreset>(
    row.available_presets,
    `Task ${row.id} available_presets`
  )
  const runtimeAuthorization: RuntimeAuthorizationTaskDetails = {
    requestedToolName: requireTrimmedString(
      row.requested_tool_name,
      `Task ${row.id} requested_tool_name`
    ),
    deviceToolStableKey: requireTrimmedString(
      row.device_tool_stable_key,
      `Task ${row.id} device_tool_stable_key`
    ),
    requestedAction,
    reason: requireTrimmedString(
      row.reason,
      `Task ${row.id} runtime_authorization.reason`
    ),
    deviceId: requireTrimmedString(row.device_id, `Task ${row.id} device_id`),
    deviceDisplayName: requireTrimmedString(
      row.device_display_name,
      `Task ${row.id} device_display_name`
    ),
    deviceCapabilityId: requireTrimmedString(
      row.device_capability_id,
      `Task ${row.id} device_capability_id`
    ),
    exposureId: requireTrimmedString(
      row.device_exposure_id,
      `Task ${row.id} device_exposure_id`
    ),
    exposureDisplayName: requireTrimmedString(
      row.exposure_display_name,
      `Task ${row.id} exposure_display_name`
    ),
    grantOptions,
    availablePresets,
    approvedPreset:
      typeof resolutionPayload.approvedPreset === "string"
        ? (resolutionPayload.approvedPreset as RuntimeAuthorizationPreset)
        : undefined,
    approvedGrant:
      resolutionPayload.approvedGrant &&
      typeof resolutionPayload.approvedGrant === "object" &&
      !Array.isArray(resolutionPayload.approvedGrant)
        ? (resolutionPayload.approvedGrant as RuntimeAuthorizationTaskDetails["approvedGrant"])
        : undefined,
    requestMode:
      row.request_mode === "blocking" || row.request_mode === "background"
        ? (row.request_mode as RuntimeAuthorizationRequestMode)
        : (() => {
            throw new Error(
              `Task ${row.id} runtime_authorization.requestMode is invalid`
            )
          })(),
    // Surface the persisted retry_nonce so the dedupe-reuse path in
    // runtime-authorizations/requests.ts can return the row's actual nonce
    // (the one that will match source_retry_nonce on the eventual grant)
    // instead of the freshly-generated nonce that no grant will ever match.
    sourceRetryNonce: row.source_retry_nonce ?? undefined,
  }

  return {
    ...baseTask,
    kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    runtimeAuthorization,
  }
}

async function getTaskRowById(taskId: string, queryable?: Executor) {
  const compiled = sql<RawTaskRow>`
    SELECT ir.*,
            ir.executor_kind AS kind,
            ir.request_payload AS prompt_payload,
            ir.request_payload AS plan_payload,
            auth.requested_tool_name AS requested_tool_name,
            auth.reason AS reason,
            auth.request_mode AS request_mode,
            auth.requested_action AS requested_action,
            auth.grant_options AS grant_options,
            auth.available_presets AS available_presets,
            auth.source_request_args AS source_request_args,
            auth.source_runtime_session_id AS source_runtime_session_id,
            auth.source_retry_nonce AS source_retry_nonce,
            auth.principal_subject_id AS principal_subject_id,
            auth.principal_scope_subject_id AS principal_scope_subject_id,
            principal_subj.kind AS principal_subject_kind,
            principal_subj.remote_agent_id AS principal_remote_agent_id,
            ir.final_result_payload AS resolution_payload,
            auth.device_id,
            auth.device_capability_id,
            auth.device_exposure_id,
            auth.device_tool_stable_key,
            requester_subj.workspace_member_id AS requester_workspace_member_id,
            requester_subj.actor_id AS requester_actor_id,
            requester_subj.remote_agent_id AS requester_remote_agent_id,
            requester_subj.kind AS requester_participant_type,
            COALESCE(requester_remote_agent_app.display_name, requester_actor_app.display_name, requester_user.name, requester.display_name) AS requester_name,
            COALESCE(requester_remote_agent.title, requester_actor.title) AS requester_title,
            COALESCE(CASE WHEN requester_remote_agent.id IS NOT NULL THEN 'remote_agent' END, requester_actor.role::text) AS requester_role,
            requester_actor.avatar_file_id AS requester_actor_avatar_file_id,
            requester_user.avatar_file_id AS requester_user_avatar_file_id,
            requester_remote_agent.avatar_file_id AS requester_remote_agent_avatar_file_id,
            COALESCE(requester_remote_agent.avatar_emoji, requester_actor.avatar_emoji) AS requester_avatar_emoji,
            target_subj.workspace_member_id AS target_workspace_member_id,
            target_subj.actor_id AS target_actor_id,
            target_subj.remote_agent_id AS target_remote_agent_id,
            target_subj.kind AS target_participant_type,
            COALESCE(target_remote_agent_app.display_name, target_actor_app.display_name, target_user.name, target.display_name) AS target_name,
            COALESCE(target_remote_agent.title, target_actor.title) AS target_title,
            COALESCE(CASE WHEN target_remote_agent.id IS NOT NULL THEN 'remote_agent' END, target_actor.role::text) AS target_role,
            target_actor.avatar_file_id AS target_actor_avatar_file_id,
            target_user.avatar_file_id AS target_user_avatar_file_id,
            target_remote_agent.avatar_file_id AS target_remote_agent_avatar_file_id,
            COALESCE(target_remote_agent.avatar_emoji, target_actor.avatar_emoji) AS target_avatar_emoji,
            resolver_subj.workspace_member_id AS resolved_by_workspace_member_id,
            resolver_subj.actor_id AS resolved_by_actor_id,
            resolver_subj.remote_agent_id AS resolved_by_remote_agent_id,
            resolver_subj.kind AS resolved_by_participant_type,
            COALESCE(resolver_remote_agent_app.display_name, resolver_actor_app.display_name, resolver_user.name, resolver.display_name) AS resolved_by_name,
            COALESCE(resolver_remote_agent.title, resolver_actor.title) AS resolved_by_title,
            COALESCE(CASE WHEN resolver_remote_agent.id IS NOT NULL THEN 'remote_agent' END, resolver_actor.role::text) AS resolved_by_role,
            resolver_actor.avatar_file_id AS resolved_by_actor_avatar_file_id,
            resolver_user.avatar_file_id AS resolved_by_user_avatar_file_id,
            resolver_remote_agent.avatar_file_id AS resolved_by_remote_agent_avatar_file_id,
            COALESCE(resolver_remote_agent.avatar_emoji, resolver_actor.avatar_emoji) AS resolved_by_avatar_emoji,
            device.title AS device_display_name,
            exposure.display_name AS exposure_display_name,
            exposure.stable_key AS exposure_stable_key
     FROM tool_call_tasks ir
     LEFT JOIN tool_call_task_runtime_authorization auth
       ON auth.task_id = ir.id
     LEFT JOIN access_subjects principal_subj
       ON principal_subj.id = auth.principal_subject_id
     LEFT JOIN conversation_participants requester
       ON requester.id = ir.requester_participant_id
     LEFT JOIN access_subjects requester_subj
       ON requester_subj.id = requester.subject_id
     LEFT JOIN actors requester_actor
       ON requester_actor.id = requester_subj.actor_id
     LEFT JOIN workspace_apps_live requester_actor_app
       ON requester_actor_app.id = requester_actor.id
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
     LEFT JOIN workspace_apps_live requester_remote_agent_app
       ON requester_remote_agent_app.id = requester_remote_agent.id
     LEFT JOIN workspace_members requester_wm
       ON requester_wm.id = requester_subj.workspace_member_id
     LEFT JOIN users requester_user
       ON requester_user.id = requester_wm.user_id
     LEFT JOIN conversation_participants target
       ON target.id = ir.target_participant_id
     LEFT JOIN access_subjects target_subj
       ON target_subj.id = target.subject_id
     LEFT JOIN actors target_actor
       ON target_actor.id = target_subj.actor_id
     LEFT JOIN workspace_apps_live target_actor_app
       ON target_actor_app.id = target_actor.id
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
     LEFT JOIN workspace_apps_live target_remote_agent_app
       ON target_remote_agent_app.id = target_remote_agent.id
     LEFT JOIN workspace_members target_wm
       ON target_wm.id = target_subj.workspace_member_id
     LEFT JOIN users target_user
       ON target_user.id = target_wm.user_id
     LEFT JOIN conversation_participants resolver
       ON resolver.id = ir.resolved_by_participant_id
     LEFT JOIN access_subjects resolver_subj
       ON resolver_subj.id = resolver.subject_id
     LEFT JOIN actors resolver_actor
       ON resolver_actor.id = resolver_subj.actor_id
     LEFT JOIN workspace_apps_live resolver_actor_app
       ON resolver_actor_app.id = resolver_actor.id
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_apps_live resolver_remote_agent_app
       ON resolver_remote_agent_app.id = resolver_remote_agent.id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.device_id
     LEFT JOIN device_exposures exposure
       ON exposure.id = auth.device_exposure_id
     WHERE ir.id = ${taskId}
     LIMIT 1
  `.compile(db)
  const result = await runCompiledOn<RawTaskRow>(queryable, compiled)
  return result.rows[0] || null
}

type StoredTaskResolveResponse = {
  outcome: ChatTaskResolveOutcome
  task: TaskSummary
}

function requireTaskResolveOutcome(
  value: unknown,
  label: string
): ChatTaskResolveOutcome {
  if (value === "applied" || value === "duplicate" || value === "conflict") {
    return value
  }
  throw new Error(`${label} is invalid`)
}

function parseStoredTaskResolveResponse(
  value: unknown,
  label: string
): StoredTaskResolveResponse {
  const payload = requireJsonObject(value, label)
  const outcome = requireTaskResolveOutcome(payload.outcome, `${label}.outcome`)
  if (!payload.task || typeof payload.task !== "object") {
    throw new Error(`${label}.task is required`)
  }
  return {
    outcome,
    task: payload.task as TaskSummary,
  }
}

async function getTaskCommandRow(
  taskId: string,
  commandId: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("toolCallTaskResponseCommands")
    .selectAll()
    .where("taskId", "=", taskId)
    .where("commandId", "=", commandId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<RawTaskCommandRow>(queryable, compiled)
  return result.rows[0] || null
}

async function getTaskRowByIdForUpdate(taskId: string, queryable: Executor) {
  const compiled = sql<RawTaskRow>`
    SELECT ir.*,
            ir.executor_kind AS kind,
            ir.request_payload AS prompt_payload,
            ir.request_payload AS plan_payload,
            auth.requested_tool_name AS requested_tool_name,
            auth.reason AS reason,
            auth.request_mode AS request_mode,
            auth.requested_action AS requested_action,
            auth.grant_options AS grant_options,
            auth.available_presets AS available_presets,
            auth.source_request_args AS source_request_args,
            auth.source_runtime_session_id AS source_runtime_session_id,
            auth.source_retry_nonce AS source_retry_nonce,
            auth.principal_subject_id AS principal_subject_id,
            auth.principal_scope_subject_id AS principal_scope_subject_id,
            principal_subj.kind AS principal_subject_kind,
            principal_subj.remote_agent_id AS principal_remote_agent_id,
            ir.final_result_payload AS resolution_payload,
            auth.device_id,
            auth.device_capability_id,
            auth.device_exposure_id,
            auth.device_tool_stable_key,
            requester_subj.workspace_member_id AS requester_workspace_member_id,
            requester_subj.actor_id AS requester_actor_id,
            requester_subj.remote_agent_id AS requester_remote_agent_id,
            requester_subj.kind AS requester_participant_type,
            COALESCE(requester_remote_agent_app.display_name, requester_actor_app.display_name, requester_user.name, requester.display_name) AS requester_name,
            COALESCE(requester_remote_agent.title, requester_actor.title) AS requester_title,
            COALESCE(CASE WHEN requester_remote_agent.id IS NOT NULL THEN 'remote_agent' END, requester_actor.role::text) AS requester_role,
            requester_actor.avatar_file_id AS requester_actor_avatar_file_id,
            requester_user.avatar_file_id AS requester_user_avatar_file_id,
            requester_remote_agent.avatar_file_id AS requester_remote_agent_avatar_file_id,
            COALESCE(requester_remote_agent.avatar_emoji, requester_actor.avatar_emoji) AS requester_avatar_emoji,
            target_subj.workspace_member_id AS target_workspace_member_id,
            target_subj.actor_id AS target_actor_id,
            target_subj.remote_agent_id AS target_remote_agent_id,
            target_subj.kind AS target_participant_type,
            COALESCE(target_remote_agent_app.display_name, target_actor_app.display_name, target_user.name, target.display_name) AS target_name,
            COALESCE(target_remote_agent.title, target_actor.title) AS target_title,
            COALESCE(CASE WHEN target_remote_agent.id IS NOT NULL THEN 'remote_agent' END, target_actor.role::text) AS target_role,
            target_actor.avatar_file_id AS target_actor_avatar_file_id,
            target_user.avatar_file_id AS target_user_avatar_file_id,
            target_remote_agent.avatar_file_id AS target_remote_agent_avatar_file_id,
            COALESCE(target_remote_agent.avatar_emoji, target_actor.avatar_emoji) AS target_avatar_emoji,
            resolver_subj.workspace_member_id AS resolved_by_workspace_member_id,
            resolver_subj.actor_id AS resolved_by_actor_id,
            resolver_subj.remote_agent_id AS resolved_by_remote_agent_id,
            resolver_subj.kind AS resolved_by_participant_type,
            COALESCE(resolver_remote_agent_app.display_name, resolver_actor_app.display_name, resolver_user.name, resolver.display_name) AS resolved_by_name,
            COALESCE(resolver_remote_agent.title, resolver_actor.title) AS resolved_by_title,
            COALESCE(CASE WHEN resolver_remote_agent.id IS NOT NULL THEN 'remote_agent' END, resolver_actor.role::text) AS resolved_by_role,
            resolver_actor.avatar_file_id AS resolved_by_actor_avatar_file_id,
            resolver_user.avatar_file_id AS resolved_by_user_avatar_file_id,
            resolver_remote_agent.avatar_file_id AS resolved_by_remote_agent_avatar_file_id,
            COALESCE(resolver_remote_agent.avatar_emoji, resolver_actor.avatar_emoji) AS resolved_by_avatar_emoji,
            device.title AS device_display_name,
            exposure.display_name AS exposure_display_name,
            exposure.stable_key AS exposure_stable_key
     FROM tool_call_tasks ir
     LEFT JOIN tool_call_task_runtime_authorization auth
       ON auth.task_id = ir.id
     LEFT JOIN access_subjects principal_subj
       ON principal_subj.id = auth.principal_subject_id
     LEFT JOIN conversation_participants requester
       ON requester.id = ir.requester_participant_id
     LEFT JOIN access_subjects requester_subj
       ON requester_subj.id = requester.subject_id
     LEFT JOIN actors requester_actor
       ON requester_actor.id = requester_subj.actor_id
     LEFT JOIN workspace_apps_live requester_actor_app
       ON requester_actor_app.id = requester_actor.id
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
     LEFT JOIN workspace_apps_live requester_remote_agent_app
       ON requester_remote_agent_app.id = requester_remote_agent.id
     LEFT JOIN workspace_members requester_wm
       ON requester_wm.id = requester_subj.workspace_member_id
     LEFT JOIN users requester_user
       ON requester_user.id = requester_wm.user_id
     LEFT JOIN conversation_participants target
       ON target.id = ir.target_participant_id
     LEFT JOIN access_subjects target_subj
       ON target_subj.id = target.subject_id
     LEFT JOIN actors target_actor
       ON target_actor.id = target_subj.actor_id
     LEFT JOIN workspace_apps_live target_actor_app
       ON target_actor_app.id = target_actor.id
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
     LEFT JOIN workspace_apps_live target_remote_agent_app
       ON target_remote_agent_app.id = target_remote_agent.id
     LEFT JOIN workspace_members target_wm
       ON target_wm.id = target_subj.workspace_member_id
     LEFT JOIN users target_user
       ON target_user.id = target_wm.user_id
     LEFT JOIN conversation_participants resolver
       ON resolver.id = ir.resolved_by_participant_id
     LEFT JOIN access_subjects resolver_subj
       ON resolver_subj.id = resolver.subject_id
     LEFT JOIN actors resolver_actor
       ON resolver_actor.id = resolver_subj.actor_id
     LEFT JOIN workspace_apps_live resolver_actor_app
       ON resolver_actor_app.id = resolver_actor.id
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_apps_live resolver_remote_agent_app
       ON resolver_remote_agent_app.id = resolver_remote_agent.id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.device_id
     LEFT JOIN device_exposures exposure
       ON exposure.id = auth.device_exposure_id
     WHERE ir.id = ${taskId}
     LIMIT 1
     FOR UPDATE OF ir
  `.compile(db)
  const result = await runCompiledOn<RawTaskRow>(queryable, compiled)
  return result.rows[0] || null
}

async function insertTaskCommandRow(
  client: Executor,
  params: {
    taskId: string
    commandId: string
    baseRevision: number
    outcome: ChatTaskResolveOutcome
    requestPayload: Record<string, unknown>
    responsePayload: StoredTaskResolveResponse
    createdByWorkspaceMemberId: string
  }
) {
  await runBuilder(
    client,
    db.insertInto("toolCallTaskResponseCommands").values({
      taskId: params.taskId,
      commandId: params.commandId,
      baseRevision:
        params.baseRevision as unknown as TableInsert<"toolCallTaskResponseCommands">["baseRevision"],
      outcome: params.outcome,
      requestPayload: jsonbValue(
        params.requestPayload
      ) as unknown as TableInsert<"toolCallTaskResponseCommands">["requestPayload"],
      responsePayload: jsonbValue(
        params.responsePayload
      ) as unknown as TableInsert<"toolCallTaskResponseCommands">["responsePayload"],
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    })
  )
}

async function appendTaskUpdatedSyncEvent(
  queryable: Executor,
  task: TaskSummary
) {
  const allRecipients = await listConversationRealtimeRecipients(
    task.conversationId,
    queryable
  )
  const recipients =
    task.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    (task.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
      !task.target)
      ? allRecipients
      : allRecipients.filter(
          (recipient) =>
            recipient.workspaceMemberId === task.target?.workspaceMemberId ||
            recipient.workspaceMemberId === task.requester?.workspaceMemberId
        )
  for (const recipient of recipients) {
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId: recipient.workspaceId,
      workspaceMemberId: recipient.workspaceMemberId,
      conversationId: task.conversationId,
      itemId: task.itemId,
      eventType: "task.updated",
      payload: {
        conversationId: task.conversationId,
        taskId: task.id,
        itemId: task.itemId,
        task,
      },
    })
  }
}

async function syncTaskEventPayload(task: TaskSummary, queryable?: Executor) {
  if (!task.itemId) return
  await updateConversationItemEventPayload(task.itemId, { task }, queryable)
}

function buildUserInputAsyncNotice(task: TaskSummary) {
  const prompt = task.userInput?.title?.trim() || "Input request"
  const answer = summarizeUserInputAnswers(task.userInput)
  const targetName = task.target?.name || "A user"
  const resolutionNote = task.resolutionNote?.trim()
  const summary = `${targetName} answered "${prompt}".`
  const lines = [
    summary,
    `Answer: ${answer}.`,
    resolutionNote ? `Note: ${resolutionNote}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildPlanApprovalApprovedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "A user"
  const title = task.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} approved "${title}".`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildPlanApprovalRevisionNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "A user"
  const title = task.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} requested revisions for "${title}".`
  const lines = [
    summary,
    task.resolutionNote?.trim()
      ? `Feedback: ${task.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "plan_revision_requested",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildRuntimeAuthorizationRejectedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "An authorized user"
  const deviceName =
    task.runtimeAuthorization?.deviceDisplayName || "the device"
  const summary = `${resolverName} rejected access for ${deviceName}.`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "rejected_by_user",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildRuntimeAuthorizationApprovedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "An authorized user"
  const deviceName =
    task.runtimeAuthorization?.deviceDisplayName || "the device"
  const approvedPreset =
    task.runtimeAuthorization?.approvedPreset || "conversation"
  const summary = `${resolverName} approved ${approvedPreset} access for ${deviceName}.`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

/**
 * After a runtime_authorization task is approved, try to re-issue
 * the original tool call server-side using the persisted args + the grant
 * that was just created. The result becomes the task's finalResultPayload
 * so the model sees the actual tool output instead of a placeholder
 * "approved by ..." string. Returns null when the auto-retry can't be
 * performed (no source args persisted, device offline, etc.) — caller
 * falls back to buildRuntimeAuthorizationApprovedNotice.
 *
 * This is the load-bearing fix that makes runtime_authorization not depend
 * on the model "noticing" the approval and "guessing" a magic retry_nonce
 * arg. The dispatch envelope carries retry_nonce as a structured field
 * (envelope.runtime_authorization.retry_nonce) so the device can match
 * the once-grant safely.
 */
async function maybeAutoRetryAfterApproval(args: {
  task: TaskSummary
  sourceRequestArgs?: Record<string, unknown>
  sourceRetryNonce?: string
  sourceTaskId?: string
  createdGrant?: RuntimeAuthorizationGrantRecord
  lockedPrincipalSubject?: SubjectRef
  lockedPrincipalScopeSubjectId?: string
  resolverWorkspaceMemberId?: string
}) {
  if (args.task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
    return null
  }
  const runtimeAuth = args.task.runtimeAuthorization
  if (!runtimeAuth) return null
  if (!args.createdGrant) return null
  if (!args.sourceRetryNonce) return null
  if (!args.sourceRequestArgs) return null
  if (!args.sourceTaskId) return null
  if (!args.lockedPrincipalSubject) return null

  // subject-scope-refactor: rebuild the principal runtime subject set
  // post-commit (Kysely form — pg transaction is closed). buildRuntime
  // PrincipalContext applies the same active-participant guard the
  // transaction-time rebuild used. If the actor lost participation between
  // approval commit and now, activeConversationSubjectId will be undefined
  // — selectAndClaimRuntimeAuthorizationGrant then refuses to claim any
  // scoped grant and the auto-retry skips (best-effort semantics, not an
  // approval failure since the grant is already in the DB).
  const { buildRuntimePrincipalContext } =
    await import("../access/subject-resolution.js")
  const { deriveOperationPrincipalAudit } =
    await import("../devices/operations.js")
  let ctx
  try {
    ctx = await buildRuntimePrincipalContext(db, {
      principal: args.lockedPrincipalSubject,
      workspaceId: args.task.workspaceId,
      conversationId: args.task.conversationId ?? null,
    })
  } catch {
    return null
  }
  // Post-commit scope mismatch: same equality rule as the transaction-time
  // gate. Mismatch here is "best-effort skip" rather than throw — the
  // approval already committed; we just don't auto-retry.
  if (
    (args.lockedPrincipalScopeSubjectId ?? null) !==
    (ctx.activeConversationSubjectId ?? null)
  ) {
    return null
  }

  let audit
  try {
    audit = deriveOperationPrincipalAudit(ctx)
  } catch {
    return null
  }

  const visibleToolName =
    runtimeAuth.deviceToolStableKey || runtimeAuth.requestedToolName
  const retry = await autoDispatchRuntimeAuthorizationRetry({
    deviceCapabilityId: runtimeAuth.deviceCapabilityId,
    visibleToolName,
    sourceRequestArgs: args.sourceRequestArgs,
    sourceRetryNonce: args.sourceRetryNonce,
    sourceTaskId: args.sourceTaskId,
    approvedGrant: args.createdGrant,
    runtimeSubjectIds: ctx.runtimeSubjectIds,
    runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
    audit: {
      workspaceId: args.task.workspaceId,
      conversationId: args.task.conversationId,
      principalKind: audit.principalKind,
      principalSubjectId: audit.principalSubjectId,
      // Thread the source Agent session id from the persisted grant
      // (originally written via capability-projection at request creation
      // time). auto-retry's cuaFocusScopeForAutoRetry consumes it to stamp
      // the same cua_focus_scope_id the projection dispatch would have used.
      // Falls back to null for non-cua tools or pre-existing grants missing
      // the field — the helper handles undefined safely.
      initiatedBySessionId: args.createdGrant.sourceRuntimeSessionId ?? null,
      initiatedByWorkspaceMemberId: args.resolverWorkspaceMemberId ?? null,
    },
  }).catch((err) => ({
    ok: false as const,
    errorCode: "runtime_constraint",
    errorMessage: `auto-retry threw: ${(err as Error).message}`,
  }))
  if (!retry.ok || !retry.result) return null
  const contentBlocks = Array.isArray(retry.result.content)
    ? (retry.result.content as CanonicalContentBlock[])
    : []
  const summary = `Authorization approved — re-ran ${visibleToolName}.`
  return {
    summary,
    messageBlocks: contentBlocks,
    finalResultPayload: {
      content: contentBlocks,
      isError: retry.result.isError,
      structuredContent: {
        taskId: args.task.id,
        task: args.task,
        synapseRetry: {
          autoRedispatched: true,
          retryNonce: args.sourceRetryNonce,
          toolName: visibleToolName,
        },
        ...(retry.result.metadata && typeof retry.result.metadata === "object"
          ? { toolMeta: retry.result.metadata }
          : {}),
      },
    },
    metadata: {
      taskId: args.task.id,
      taskKind: args.task.kind,
      taskLifecycleStatus: args.task.lifecycleStatus,
      taskOutcome: args.task.outcome,
      synapseRetry: {
        autoRedispatched: true,
      },
    },
  }
}

function buildRuntimeAuthorizationSupersededNotice(task: TaskSummary) {
  const summary =
    "This authorization request was superseded by a newer user message."
  const messageBlocks = textBlocks(summary)

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "superseded",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

async function insertTaskRequest(
  client: Executor,
  params: {
    workspaceId: string
    conversationId: string
    taskId?: string
    remoteAgentRunId?: string
    requesterParticipantId: string
    kind: TaskRequestKind
    requestKey: string
    targetParticipantId?: string
    expiresAt?: Timestamp
  }
): Promise<string | null> {
  // The caller already created the tool_call_tasks row with its request_key and
  // dedupe metadata. Here we attach the human-facing participant fields and
  // return the parent id. The dedupe ON CONFLICT lives at task creation; this
  // UPDATE only succeeds while the task is still non-terminal.
  if (!params.taskId) {
    throw new Error("insertTaskRequest requires a taskId")
  }
  const updated = await runCompiledOn<{ id: string }>(
    client,
    sql<{ id: string }>`
      UPDATE tool_call_tasks
      SET requester_participant_id = ${params.requesterParticipantId},
          target_participant_id = ${params.targetParticipantId || null},
          remote_agent_run_id = COALESCE(${params.remoteAgentRunId || null}, remote_agent_run_id),
          expires_at = COALESCE(${params.expiresAt || null}, expires_at)
      WHERE id = ${params.taskId}
        AND lifecycle_status IN ('submitted', 'working', 'input_required', 'auth_required')
      RETURNING id
    `.compile(db)
  )
  return updated.rows[0]?.id ?? null
}

/**
 * Resolve the existing-pending-task id that won an INSERT race
 * against `insertTaskRequest` (which returned null on conflict).
 * Centralized here so every caller does the same lookup the same way —
 * critical for the dedupe contract: the row we return must be exactly
 * the one the conflicting unique index pinned.
 */
async function resolveInsertConflictWinner(
  client: Executor,
  params: { workspaceId: string; requestKey: string; taskId?: string }
): Promise<string | null> {
  // Prefer the task-keyed lookup when available — for plan_approval /
  // runtime_authorization the request_key is derived from the task so
  // both lookups would return the same row, but staying consistent with
  // the pre-INSERT lookup ordering avoids surprising any cross-callsite
  // assumption.
  if (params.taskId) {
    const byTask = await findTaskIdByTaskId(params.taskId, client)
    if (byTask) return byTask
  }
  return findPendingTaskIdByRequestKey(
    params.workspaceId,
    params.requestKey,
    client
  )
}

async function findTaskIdByTaskId(taskId: string, queryable?: Executor) {
  // Confirm the task exists and is non-terminal so dedupe-reuse only returns a
  // live row.
  const compiled = db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("id", "=", taskId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<{ id: string }>(queryable, compiled)
  return result.rows[0]?.id || null
}

async function findPendingTaskIdByRequestKey(
  workspaceId: string,
  requestKey: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("requestKey", "=", requestKey)
    .where("lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .limit(1)
    .compile()
  const result = await runCompiledOn<{ id: string }>(queryable, compiled)
  return result.rows[0]?.id || null
}

async function insertUserInputTaskDetails(
  _client: Executor,
  _params: {
    taskId: string
    promptPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the prompt payload lives in
  // tool_call_tasks.request_payload (written at task creation). human_input has
  // no CTI detail table.
}

async function insertPlanApprovalTaskDetails(
  _client: Executor,
  _params: {
    taskId: string
    planPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the plan payload lives in
  // tool_call_tasks.request_payload. plan_approval has no CTI detail table.
}

async function insertRuntimeAuthorizationTaskDetails(
  client: Executor,
  params: {
    taskId: string
    deviceId: string
    deviceCapabilityId: string
    deviceExposureId: string
    requestedToolName: string
    deviceToolStableKey: string
    reason: string
    requestMode: RuntimeAuthorizationRequestMode
    sourceRuntimeSessionId?: string
    sourceRetryNonce?: string
    sourceRequestArgs: Record<string, unknown>
    requestedAction: RuntimeAuthorizationRequestedAction
    grantOptions: RuntimeAuthorizationGrantOption[]
    availablePresets: RuntimeAuthorizationPreset[]
    dedupeKey: string
    /** subject-scope-refactor: principal subject_id (NOT NULL on
     * tool_call_task_runtime_authorization). Caller resolves the
     * triggering principal (actor / remote_agent / conversation) to an
     * access_subjects row via upsertAccessSubjectOn(client, ...) and passes
     * the id here. */
    principalSubjectId: string
    /** subject-scope-refactor: optional principal scope subject_id (the
     * conversation subject when the triggering principal was active in a
     * conversation; null otherwise). */
    principalScopeSubjectId?: string | null
    /** @deprecated retained for transitional caller compatibility; not
     * written to the DB. */
    principalRemoteAgentId?: string
  }
) {
  await runBuilder(
    client,
    db.insertInto("toolCallTaskRuntimeAuthorization").values({
      taskId: params.taskId,
      deviceId: params.deviceId,
      deviceCapabilityId: params.deviceCapabilityId,
      deviceExposureId: params.deviceExposureId,
      requestedToolName: params.requestedToolName,
      deviceToolStableKey: params.deviceToolStableKey,
      reason: params.reason,
      requestMode: params.requestMode,
      sourceRuntimeSessionId: params.sourceRuntimeSessionId || null,
      sourceRetryNonce: params.sourceRetryNonce || null,
      sourceRequestArgs: jsonbValue(
        params.sourceRequestArgs
      ) as unknown as TableInsert<"toolCallTaskRuntimeAuthorization">["sourceRequestArgs"],
      principalSubjectId: params.principalSubjectId,
      principalScopeSubjectId: params.principalScopeSubjectId || null,
      requestedAction: jsonbValue(
        params.requestedAction
      ) as unknown as TableInsert<"toolCallTaskRuntimeAuthorization">["requestedAction"],
      grantOptions: jsonbValue(
        params.grantOptions
      ) as unknown as TableInsert<"toolCallTaskRuntimeAuthorization">["grantOptions"],
      availablePresets: jsonbValue(
        params.availablePresets
      ) as unknown as TableInsert<"toolCallTaskRuntimeAuthorization">["availablePresets"],
      dedupeKey: params.dedupeKey,
    })
  )
}

/**
 * Write the runtime_authorization CTI detail row for a freshly-minted task,
 * INSIDE the caller's transaction (createToolCallTaskDeduped's onCreatedInTx).
 * This must run in the same tx as the parent INSERT so the deferred CTI
 * consistency trigger sees exactly one detail row at COMMIT. Computes the
 * content dedupe_key (also used by findOpenRuntimeAuthorizationTask).
 */
export async function writeRuntimeAuthorizationTaskDetailInTx(
  client: Executor,
  params: {
    taskId: string
    deviceId: string
    deviceCapabilityId: string
    deviceExposureId: string
    requestedToolName: string
    deviceToolStableKey: string
    reason: string
    requestMode: RuntimeAuthorizationRequestMode
    runtimeSessionId: string
    sourceRetryNonce?: string
    sourceRequestArgs: Record<string, unknown>
    principalSubjectId: string
    principalScopeSubjectId?: string | null
    requestedAction: RuntimeAuthorizationRequestedAction
    grantOptions: RuntimeAuthorizationGrantOption[]
    availablePresets: RuntimeAuthorizationPreset[]
  }
) {
  const dedupeKey = buildRuntimeAuthorizationDedupeKey({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
  await insertRuntimeAuthorizationTaskDetails(client, {
    taskId: params.taskId,
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    reason: params.reason,
    requestMode: params.requestMode,
    sourceRuntimeSessionId: params.runtimeSessionId,
    sourceRetryNonce: params.sourceRetryNonce,
    sourceRequestArgs: params.sourceRequestArgs || {},
    principalSubjectId: params.principalSubjectId,
    principalScopeSubjectId: params.principalScopeSubjectId,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    dedupeKey,
  })
}

async function updateTaskConversationItemId(
  client: Executor,
  taskId: string,
  conversationItemId: string
) {
  const result = await runBuilder(
    client,
    db
      .updateTable("toolCallTasks")
      .set({
        conversationItemId: conversationItemId,
      })
      .where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update conversation item for task ${taskId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

/**
 * Translate a resolver's business decision into the task lifecycle/outcome
 * fields stored on tool_call_tasks.
 */
function taskResolutionStatusToFields(
  status: TaskResolutionStatus,
  kind: TaskRequestKind
): {
  lifecycleStatus: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
} {
  switch (status) {
    case "answered":
      return { lifecycleStatus: "completed", outcome: "answered" }
    case "approved":
      return {
        lifecycleStatus: "completed",
        outcome:
          kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "granted"
            : "approved",
      }
    case "rejected":
      return {
        lifecycleStatus: "completed",
        outcome:
          kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "denied"
            : "revision_requested",
      }
    case "cancelled":
      return { lifecycleStatus: "cancelled", outcome: null }
    case "superseded":
      return { lifecycleStatus: "cancelled", outcome: null }
    case "expired":
      return { lifecycleStatus: "expired", outcome: null }
  }
}

async function updateTaskRequestRow(
  client: Executor,
  taskId: string,
  values: Record<string, unknown>
) {
  const result = await runBuilder(
    client,
    db.updateTable("toolCallTasks").set(values).where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update task ${taskId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

async function updateTaskResolutionPayload(
  client: Executor,
  taskId: string,
  payload: Record<string, unknown>
) {
  // Task unification: resolution payload lives on the task (final_result_payload)
  // for all kinds — no per-kind detail-table write.
  const result = await runBuilder(
    client,
    db
      .updateTable("toolCallTasks")
      .set({
        finalResultPayload: jsonbValue(
          payload
        ) as unknown as TableInsert<"toolCallTasks">["finalResultPayload"],
      })
      .where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update task ${taskId} resolution payload, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

export async function createUserInputTaskRequest(
  params: CreateUserInputTaskParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: the caller (session-tools createGovernedToolCallTask)
    // already minted the fresh task (deduped at the task layer). Attach the
    // participant fields and create the feed item — no second dedupe.
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.USER_INPUT,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "User-input task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertUserInputTaskDetails(client, {
      taskId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRemoteAgentUserInputTaskRequest(
  params: CreateRemoteAgentUserInputTaskParams
) {
  return withDbTransaction(async (client) => {
    const requestKey = buildRemoteAgentTaskRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: TASK_REQUEST_KIND.USER_INPUT,
    })
    // Task unification: the remote-agent path has no caller-minted task, so we
    // mint it here with delivery_kind=remote_agent_channel. The principal is the
    // requesting remote_agent (its participant's subject). Dedupe via the task's
    // request_key ON CONFLICT (run-derived).
    const principalSubjectId = await resolveParticipantSubjectId(
      client,
      params.requesterParticipantId
    )
    const minted = await insertToolCallTaskDeduped(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      executorKind: "user_input",
      deliveryKind: "remote_agent_channel",
      humanSurface: "needs_response",
      principalSubjectId,
      remoteAgentRunId: params.remoteAgentRunId,
      sourceToolName: "request_user_input",
      requestKey,
      requesterParticipantId: params.requesterParticipantId,
      targetParticipantId: params.targetParticipantId,
      lifecycleStatus: "input_required",
      supportsCancel: true,
      requestPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
      expiresAt: params.expiresAt,
    })
    if (!minted) {
      const winner = await findLiveToolCallTaskByRequestKey(
        client,
        params.workspaceId,
        requestKey
      )
      const existing = winner ? await getTaskSummary(winner.id, client) : null
      if (existing) {
        return existing
      }
      throw new Error(
        "Remote-agent user-input dedupe hit but no live winner found"
      )
    }
    const taskId = minted.id

    await insertUserInputTaskDetails(client, {
      taskId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created remote agent input task")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: targeted ? "targeted_members" : "all_members",
      contextPolicy: targeted ? "targeted_members" : "shared",
      restrictedAudienceParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      contextTargetParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created remote agent input task")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createPlanApprovalTaskRequest(
  params: CreatePlanApprovalTaskParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: caller already minted the fresh deduped task.
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "Plan-approval task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertPlanApprovalTaskDetails(client, {
      taskId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    const collaborationState = parseSessionCollaborationState(
      params.collaborationState
    )
    if (!collaborationState.planDraft) {
      throw new Error(
        "Plan approval tasks require collaborationState.planDraft"
      )
    }
    await updateSessionCollaboration(
      {
        sessionId: params.sessionId,
        collaborationMode: "plan_awaiting_approval",
        collaborationState,
        activePlanApprovalTaskId: taskId,
      },
      client
    )
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRemoteAgentPlanApprovalTaskRequest(
  params: CreateRemoteAgentPlanApprovalTaskParams
) {
  return withDbTransaction(async (client) => {
    const requestKey = buildRemoteAgentTaskRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
    })
    // Task unification: mint the remote-agent task (delivery_kind=
    // remote_agent_channel) here; the principal is the requesting remote_agent.
    const principalSubjectId = await resolveParticipantSubjectId(
      client,
      params.requesterParticipantId
    )
    const minted = await insertToolCallTaskDeduped(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      executorKind: "plan_approval",
      deliveryKind: "remote_agent_channel",
      humanSurface: "needs_response",
      principalSubjectId,
      remoteAgentRunId: params.remoteAgentRunId,
      sourceToolName: "submit_plan",
      requestKey,
      requesterParticipantId: params.requesterParticipantId,
      targetParticipantId: params.targetParticipantId,
      lifecycleStatus: "input_required",
      supportsCancel: true,
      requestPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
      expiresAt: params.expiresAt,
    })
    if (!minted) {
      const winner = await findLiveToolCallTaskByRequestKey(
        client,
        params.workspaceId,
        requestKey
      )
      const existing = winner ? await getTaskSummary(winner.id, client) : null
      if (existing) {
        return existing
      }
      throw new Error(
        "Remote-agent plan-approval dedupe hit but no live winner found"
      )
    }
    const taskId = minted.id

    await insertPlanApprovalTaskDetails(client, {
      taskId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created remote agent plan task")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: targeted ? "targeted_members" : "all_members",
      contextPolicy: targeted ? "targeted_members" : "shared",
      restrictedAudienceParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      contextTargetParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)
    const contextUpsert = await runOn<{ remoteAgentId: string }>(
      client,
      `
        INSERT INTO remote_agent_conversation_contexts (
          remote_agent_id,
          conversation_id,
          collaboration_mode,
          collaboration_state,
          active_plan_approval_task_id
        )
        SELECT
          cpsubj.remote_agent_id,
          $1,
          'plan_awaiting_approval',
          $2::jsonb,
          $3
        FROM conversation_participants cp
        INNER JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
        WHERE cp.id = $4
          AND cpsubj.remote_agent_id IS NOT NULL
        ON CONFLICT (remote_agent_id, conversation_id)
        DO UPDATE SET
          collaboration_mode = EXCLUDED.collaboration_mode,
          collaboration_state = EXCLUDED.collaboration_state,
          active_plan_approval_task_id = EXCLUDED.active_plan_approval_task_id
        RETURNING remote_agent_id
      `,
      [
        params.conversationId,
        JSON.stringify(params.collaborationState || {}),
        taskId,
        params.requesterParticipantId,
      ]
    )
    if (!contextUpsert.rows[0]?.remoteAgentId) {
      throw new Error("Remote agent requester participant is invalid")
    }

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created remote agent plan task")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRuntimeAuthorizationTaskRequest(
  params: CreateRuntimeAuthorizationTaskParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: the caller (runtime-authorizations/requests.ts) minted
    // the tool_call_tasks parent AND wrote the runtime_authorization CTI detail
    // row in ONE transaction (createToolCallTaskDeduped's onCreatedInTx
    // callback) so the deferred consistency trigger passes at that commit. Here
    // we only attach the human-facing participant fields and the feed item —
    // neither is CTI-gated, so a separate tx is fine.
    if (!params.taskId) {
      throw new Error("createRuntimeAuthorizationTaskRequest requires a taskId")
    }
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      requestKey: "",
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      // The task was concurrently terminalized (cancelled / expired) between
      // mint and feed-item creation — surface the current summary.
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "Runtime authorization task was concurrently resolved before its feed item could be written"
        )
      }
      return current
    }

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)

    // G5: enqueue durable projection so the task can be rendered
    // onto any supporting IM transport (v1: QQ only). The worker
    // consumes this asynchronously; the dashboard / API caller doesn't
    // wait on transport delivery.
    await upsertTaskTransportProjection(client, {
      taskId,
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
    })

    return task
  })
}

export async function findOpenRuntimeAuthorizationTask(
  params: FindOpenRuntimeAuthorizationTaskParams
) {
  const dedupeKey = buildRuntimeAuthorizationDedupeKey({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
  const row = await db
    .selectFrom("toolCallTasks as ir")
    .innerJoin(
      "toolCallTaskRuntimeAuthorization as auth",
      "auth.taskId",
      "ir.id"
    )
    .select("ir.id")
    .where("ir.workspaceId", "=", params.workspaceId)
    .where("ir.conversationId", "=", params.conversationId)
    .where(
      sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`
    )
    .where("ir.executorKind", "=", "runtime_authorization")
    .where("ir.lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .where((eb) =>
      eb.or([
        eb("ir.expiresAt", "is", null),
        eb("ir.expiresAt", ">", new Date()),
      ])
    )
    .where("auth.deviceId", "=", params.deviceId)
    .where("auth.deviceCapabilityId", "=", params.deviceCapabilityId)
    .where("auth.deviceExposureId", "=", params.deviceExposureId)
    .where("auth.requestedToolName", "=", params.requestedToolName)
    .where(
      sql<boolean>`auth.device_tool_stable_key = ${params.deviceToolStableKey}`
    )
    .where("auth.requestMode", "=", params.requestMode)
    .where("auth.dedupeKey", "=", dedupeKey)
    .orderBy("ir.updatedAt", "desc")
    .limit(1)
    .executeTakeFirst()

  const taskId = row?.id
  if (!taskId) {
    return null
  }
  return getTaskSummary(taskId)
}

export async function getTaskSummary(taskId: string, queryable?: Executor) {
  const row = await getTaskRowById(taskId, queryable)
  return row ? buildTaskSummary(row) : null
}

export async function getTaskSummaryByTaskId(taskId: string) {
  return getTaskSummary(taskId)
}

export async function cancelTaskRequestByTaskId(taskId: string, note?: string) {
  const task = await getTaskSummaryByTaskId(taskId)
  if (!task) {
    return null
  }
  return cancelTaskRequest(task.id, note)
}

export async function cancelTaskRequest(taskId: string, note?: string) {
  const existing = await getTaskRowById(taskId)
  if (!existing) {
    throw new Error("Task request not found")
  }

  if (!isOpenTaskLifecycle(existing.lifecycle_status)) {
    const current = await getTaskSummary(taskId)
    if (!current) {
      throw new Error("Failed to reload task request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const task = await withDbTransaction(async (client) => {
    await updateTaskRequestRow(client, taskId, {
      lifecycleStatus: "cancelled",
      revision: sql`revision + 1`,
      resolvedAt: sql`NOW()`,
    })

    const payload = {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      cancelled: true,
    }

    await updateTaskResolutionPayload(client, taskId, payload)
    const nextTask = await getTaskSummary(taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload cancelled task")
    }
    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)
    return nextTask
  })

  return task
}

export async function canUserViewTask(params: {
  taskId: string
  userId: string
}) {
  const row = await db
    .selectFrom("toolCallTasks as ir")
    .select("ir.id")
    .where("ir.id", "=", params.taskId)
    .where((eb) =>
      eb.or([
        sql<boolean>`EXISTS (
          SELECT 1
          FROM conversation_participants cp
          JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
          JOIN workspace_members wm
            ON wm.id = cpsubj.workspace_member_id
          WHERE cp.id = ir.requester_participant_id
            AND wm.user_id = ${params.userId}
        )`,
        eb.and([
          eb("ir.executorKind", "in", [
            "user_input",
            "plan_approval",
          ] satisfies ToolCallTaskExecutorKind[]),
          eb.or([
            sql<boolean>`EXISTS (
              SELECT 1
              FROM conversation_participants cp
              JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
              JOIN workspace_members wm
                ON wm.id = cpsubj.workspace_member_id
              WHERE cp.id = ir.target_participant_id
                AND wm.user_id = ${params.userId}
            )`,
            sql<boolean>`EXISTS (
              SELECT 1
              FROM conversation_participants requester_cp
              JOIN access_subjects requester_subj ON requester_subj.id = requester_cp.subject_id
              JOIN conversation_participants viewer_cp
                ON viewer_cp.conversation_id = requester_cp.conversation_id
               AND viewer_cp.state = 'active'
              JOIN access_subjects viewer_subj ON viewer_subj.id = viewer_cp.subject_id
              JOIN workspace_members viewer_wm
                ON viewer_wm.id = viewer_subj.workspace_member_id
              WHERE requester_cp.id = ir.requester_participant_id
                AND requester_subj.remote_agent_id IS NOT NULL
                AND ir.remote_agent_run_id IS NOT NULL
                AND viewer_wm.user_id = ${params.userId}
            )`,
          ]),
        ]),
        eb.and([
          eb("ir.executorKind", "=", TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM conversation_participants cm
            JOIN access_subjects cm_subj ON cm_subj.id = cm.subject_id
            JOIN workspace_members wm
              ON wm.id = cm_subj.workspace_member_id
            WHERE cm.conversation_id = ir.conversation_id
              AND wm.user_id = ${params.userId}
              AND cm.state = 'active'
          )`,
        ]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function canUserResolveTask(params: {
  task: TaskSummary
  userId: string
}) {
  const { task, userId } = params
  if (!isOpenTaskLifecycle(task.lifecycleStatus)) {
    return false
  }

  if (
    task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    task.target?.participantId
  ) {
    const targetParticipantId = task.target?.participantId
    const viewerParticipant = await db
      .selectFrom("conversationParticipants as cp")
      .innerJoin("accessSubjects as subj", "subj.id", "cp.subjectId")
      .innerJoin("workspaceMembers as wm", "wm.id", "subj.workspaceMemberId")
      .select("cp.id")
      .where("cp.id", "=", targetParticipantId)
      .where("cp.state", "=", "active")
      .where("wm.userId", "=", userId)
      .limit(1)
      .executeTakeFirst()

    return Boolean(viewerParticipant?.id)
  }

  if (
    task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    task.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    task.requester.remoteAgentId
  ) {
    const viewerMembership = await db
      .selectFrom("conversationParticipants as cp")
      .innerJoin("accessSubjects as subj", "subj.id", "cp.subjectId")
      .innerJoin("workspaceMembers as wm", "wm.id", "subj.workspaceMemberId")
      .innerJoin("conversations as c", "c.id", "cp.conversationId")
      .select([
        "subj.workspaceMemberId as workspaceMemberId",
        "c.kind as conversationKind",
      ])
      .where("cp.conversationId", "=", task.conversationId)
      .where("cp.state", "=", "active")
      .where("wm.userId", "=", userId)
      .limit(1)
      .executeTakeFirst()

    if (!viewerMembership?.workspaceMemberId) {
      return false
    }

    if (viewerMembership.conversationKind === "direct") {
      return true
    }

    const grant = await runBuilder(
      db,
      db
        .selectFrom("remoteAgentGroupTaskGrants")
        .select("workspaceMemberId")
        .where("remoteAgentId", "=", task.requester.remoteAgentId)
        .where("workspaceMemberId", "=", viewerMembership.workspaceMemberId)
        .limit(1)
    )

    return Boolean(grant.rows[0]?.workspaceMemberId)
  }

  const deviceId = task.runtimeAuthorization?.deviceId
  const deviceCapabilityId = task.runtimeAuthorization?.deviceCapabilityId
  if (!deviceId || !deviceCapabilityId) {
    return false
  }

  return authorizeAction(db, {
    subject: userSubject(userId),
    action: "device_capability.request_runtime_authorization",
    resourceId: deviceCapabilityId,
  })
}

export async function enrichTaskForUser(
  task: TaskSummary,
  userId?: string
): Promise<TaskSummary> {
  if (!userId) {
    return {
      ...task,
      viewerCanResolve: task.viewerCanResolve ?? false,
    }
  }

  return {
    ...task,
    viewerCanResolve: await canUserResolveTask({
      task,
      userId,
    }),
  }
}

export async function enrichFeedItemTasksForUser(
  item: ConversationFeedItem,
  userId?: string
): Promise<ConversationFeedItem> {
  if (item.kind !== "event" || item.eventType !== "task_requested") {
    return item
  }

  const payload =
    item.payload as ConversationFeedEventPayloadMap["task_requested"]
  const task =
    payload.task && typeof payload.task === "object"
      ? (payload.task as TaskSummary)
      : null
  if (!task) {
    return item
  }

  return {
    ...item,
    payload: {
      ...payload,
      task: await enrichTaskForUser(task, userId),
    },
  }
}

function buildSubmittedUserInputAnswers(
  params: ResolveTaskRequestParams,
  questions: TaskInputQuestionDefinition[]
): TaskInputAnswer[] {
  if (Array.isArray(params.answers) && params.answers.length > 0) {
    return params.answers.map((answer) => ({
      questionId: String(answer.questionId || "").trim(),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? Array.from(
            new Set(
              answer.selectedOptionIds
                .map((optionId: string) => String(optionId || "").trim())
                .filter((optionId: string) => optionId.length > 0)
            )
          )
        : undefined,
      otherText:
        typeof answer.otherText === "string"
          ? answer.otherText.trim() || undefined
          : undefined,
      text:
        typeof answer.text === "string"
          ? answer.text.trim() || undefined
          : undefined,
    }))
  }
  return questions.map((question) => ({
    questionId: question.id,
  }))
}

function validateUserInputAnswers(
  questions: TaskInputQuestionDefinition[],
  submittedAnswers: TaskInputAnswer[]
) {
  const questionMap = new Map(
    questions.map((question) => [question.id, question])
  )
  const answerMap = new Map<string, TaskInputAnswer>()

  for (const answer of submittedAnswers) {
    if (!answer.questionId) {
      throw new Error("Each answer requires a questionId")
    }
    if (!questionMap.has(answer.questionId)) {
      throw new Error(`Unknown question "${answer.questionId}"`)
    }
    if (answerMap.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}"`)
    }
    answerMap.set(answer.questionId, answer)
  }

  const normalized: TaskInputAnswer[] = []

  for (const question of questions) {
    const answer = answerMap.get(question.id)
    const required = question.required !== false

    if (question.type === "text") {
      const text = answer?.text?.trim() || undefined
      if (required && !text) {
        throw new Error(`"${question.prompt}" requires a response`)
      }
      if (text) {
        normalized.push({
          questionId: question.id,
          text,
        })
      }
      continue
    }

    const allowedOptions = question.options || []
    const selectedOptionIds = Array.from(
      new Set(
        (answer?.selectedOptionIds || []).filter((optionId: string) => optionId)
      )
    )
    for (const selectedOptionId of selectedOptionIds) {
      if (
        !allowedOptions.some(
          (option: TaskInputOption) => option.id === selectedOptionId
        )
      ) {
        throw new Error(`"${question.prompt}" contains an invalid option`)
      }
    }

    const otherText = answer?.otherText?.trim() || undefined
    if (otherText && !question.allowOther) {
      throw new Error(`"${question.prompt}" does not allow other input`)
    }

    const effectiveCount = selectedOptionIds.length + (otherText ? 1 : 0)
    const minSelections =
      question.type === "multi_select"
        ? (question.minSelections ?? (required ? 1 : 0))
        : required
          ? 1
          : 0
    const maxSelections =
      question.type === "multi_select"
        ? (question.maxSelections ?? Number.MAX_SAFE_INTEGER)
        : 1

    if (maxSelections < minSelections) {
      throw new Error(`"${question.prompt}" has an invalid selection range`)
    }
    if (effectiveCount < minSelections) {
      throw new Error(`"${question.prompt}" requires more selections`)
    }
    if (effectiveCount > maxSelections) {
      throw new Error(`"${question.prompt}" has too many selections`)
    }
    if (question.type === "single_select" && effectiveCount > 1) {
      throw new Error(`"${question.prompt}" only allows one response`)
    }

    if (effectiveCount > 0) {
      normalized.push({
        questionId: question.id,
        selectedOptionIds:
          selectedOptionIds.length > 0 ? selectedOptionIds : undefined,
        selectedOptionLabels:
          selectedOptionIds.length > 0
            ? selectedOptionIds.map(
                (selectedOptionId) =>
                  allowedOptions.find(
                    (option: TaskInputOption) => option.id === selectedOptionId
                  )?.label || selectedOptionId
              )
            : undefined,
        otherText,
      })
    }
  }

  return normalized
}

function normalizeTaskCommandAnswers(
  answers?: TaskInputAnswer[]
): TaskInputAnswer[] | undefined {
  if (!Array.isArray(answers) || answers.length === 0) {
    return undefined
  }
  return answers
    .map((answer) => ({
      questionId: String(answer.questionId || "").trim(),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? Array.from(
            new Set(
              answer.selectedOptionIds
                .map((optionId) => String(optionId || "").trim())
                .filter((optionId) => optionId.length > 0)
            )
          ).sort()
        : undefined,
      otherText:
        typeof answer.otherText === "string"
          ? answer.otherText.trim() || undefined
          : undefined,
      text:
        typeof answer.text === "string"
          ? answer.text.trim() || undefined
          : undefined,
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
}

function buildNormalizedTaskCommandPayload(
  params: ResolveTaskRequestParams
): Record<string, unknown> {
  return {
    answers: normalizeTaskCommandAnswers(params.answers),
    decision: params.decision,
    preset: params.preset,
    selectedGrantOptionId:
      typeof params.selectedGrantOptionId === "string"
        ? params.selectedGrantOptionId.trim() || undefined
        : undefined,
    note:
      typeof params.note === "string"
        ? params.note.trim() || undefined
        : undefined,
  }
}

export async function resolveTaskRequest(
  params: ResolveTaskRequestParams
): Promise<ResolveTaskRequestResult> {
  const normalizedCommandPayload = buildNormalizedTaskCommandPayload(params)

  const result = await withDbTransaction(async (client) => {
    const locked = await getTaskRowByIdForUpdate(params.taskId, client)
    if (!locked) {
      throw new Error("Task request not found")
    }

    const existingCommand = await getTaskCommandRow(
      params.taskId,
      params.commandId,
      client
    )
    if (existingCommand) {
      const storedRequestPayload = requireJsonObject(
        existingCommand.request_payload,
        `Task command ${existingCommand.id} request_payload`
      )
      if (
        stableJsonStringify(storedRequestPayload) !==
        stableJsonStringify(normalizedCommandPayload)
      ) {
        throw new Error(
          `commandId ${params.commandId} was already used with a different task payload`
        )
      }

      const storedResponse = parseStoredTaskResolveResponse(
        existingCommand.response_payload,
        `Task command ${existingCommand.id} response_payload`
      )
      return {
        outcome:
          storedResponse.outcome === "applied"
            ? ("duplicate" as const)
            : storedResponse.outcome,
        task: storedResponse.task,
        createdGrant: undefined,
      }
    }

    if (
      locked.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
      locked.target_participant_id &&
      locked.target_participant_id !== params.resolverParticipantId
    ) {
      throw new Error("Only the targeted user can resolve this task")
    }

    if (
      locked.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
      !locked.target_participant_id &&
      locked.requester_remote_agent_id
    ) {
      const conversationRow = await takeFirstOn(
        client,
        db
          .selectFrom("conversations")
          .select("kind")
          .where("id", "=", locked.conversation_id)
          .limit(1)
      )
      if (!conversationRow) {
        throw new Error(`Conversation ${locked.conversation_id} not found`)
      }
      if (conversationRow.kind !== "direct") {
        const grantRow = await runBuilder(
          client,
          db
            .selectFrom("remoteAgentGroupTaskGrants")
            .select("workspaceMemberId")
            .where("remoteAgentId", "=", locked.requester_remote_agent_id)
            .where("workspaceMemberId", "=", params.resolverWorkspaceMemberId)
            .limit(1)
        )
        if (!grantRow.rows[0]?.workspaceMemberId) {
          throw new Error(
            "You are not allowed to resolve this remote agent task"
          )
        }
      }
    }

    if (locked.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
      const deviceId = locked.device_id || ""
      if (!deviceId) {
        throw new Error(`Task ${locked.id} is missing device_id`)
      }
      const deviceCapabilityId = locked.device_capability_id || ""
      if (!deviceCapabilityId) {
        throw new Error(`Task ${locked.id} is missing device_capability_id`)
      }
      const canResolveRuntimeAuthorization = await authorizeAction(db, {
        subject: workspaceMemberSubject(params.resolverWorkspaceMemberId),
        action: "device_capability.request_runtime_authorization",
        resourceId: deviceCapabilityId,
      })
      if (!canResolveRuntimeAuthorization) {
        throw new Error(
          "You are not allowed to resolve this runtime authorization task"
        )
      }
    }

    const lockedRevision = toRevisionNumber(
      locked.revision,
      `Task ${locked.id} revision`
    )
    if (
      !isOpenTaskLifecycle(locked.lifecycle_status) ||
      lockedRevision !== params.baseRevision
    ) {
      const currentTask = buildTaskSummary(locked)
      const responsePayload: StoredTaskResolveResponse = {
        outcome: "conflict",
        task: currentTask,
      }
      await insertTaskCommandRow(client, {
        taskId: params.taskId,
        commandId: params.commandId,
        baseRevision: params.baseRevision,
        outcome: "conflict",
        requestPayload: normalizedCommandPayload,
        responsePayload,
        createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
      })
      return {
        outcome: "conflict" as const,
        task: currentTask,
        createdGrant: undefined,
      }
    }

    let nextStatus: TaskResolutionStatus
    let resolutionPayload: Record<string, unknown>
    let createdGrant: RuntimeAuthorizationGrantRecord | undefined
    let lockedPrincipalSubjectForReturn: SubjectRef | undefined

    if (locked.kind === TASK_REQUEST_KIND.USER_INPUT) {
      const promptPayload = parseJsonObject(locked.prompt_payload)
      const questions = parseUserInputQuestionDefinitions(promptPayload)
      if (questions.length === 0) {
        throw new Error("User input request is invalid")
      }
      const submittedAnswers = buildSubmittedUserInputAnswers(params, questions)
      const answers = validateUserInputAnswers(questions, submittedAnswers)
      if (answers.length === 0) {
        throw new Error("A valid response is required")
      }

      nextStatus = "answered"
      resolutionPayload = {
        answers,
        note: params.note?.trim() || undefined,
      }
    } else if (locked.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
      if (params.decision !== "approve" && params.decision !== "revise") {
        throw new Error("decision must be approve or revise")
      }

      nextStatus = params.decision === "approve" ? "approved" : "rejected"
      resolutionPayload = {
        decision: params.decision,
        note: params.note?.trim() || undefined,
      }

      if (locked.remote_agent_run_id && locked.requester_remote_agent_id) {
        await client
          .updateTable("remoteAgentConversationContexts")
          .set({
            collaborationMode:
              nextStatus === "approved" ? "default" : "plan_drafting",
            collaborationState: jsonbValue({}),
            activePlanApprovalTaskId: null,
          })
          .where("remoteAgentId", "=", locked.requester_remote_agent_id)
          .where("conversationId", "=", locked.conversation_id)
          .execute()
      } else {
        // Task unification: locked IS the task row, so session_id is on it.
        if (!locked.session_id) {
          throw new Error(`Task ${locked.id} is missing task governance`)
        }
        const taskRow = { session_id: locked.session_id }
        const sessionRow = await takeFirstOn(
          client,
          db
            .selectFrom("sessions as s")
            .innerJoin("conversations as c", "c.id", "s.conversationId")
            .select([
              "s.collaborationState",
              "s.collaborationMode",
              "s.activePlanApprovalTaskId",
              "c.kind as conversationKind",
            ])
            .where("s.id", "=", taskRow.session_id)
            .limit(1)
        )
        if (!sessionRow) {
          throw new Error(`Session ${taskRow.session_id} not found`)
        }
        if (isGroupConversationKind(sessionRow.conversationKind)) {
          throw new Error(
            "Plan mode is only available in direct conversations."
          )
        }
        if (
          !isPlanAwaitingApprovalCollaborationMode(sessionRow.collaborationMode)
        ) {
          throw new Error(
            `Session ${taskRow.session_id} must be in plan_awaiting_approval before resolving plan approval.`
          )
        }
        if (!sessionRow.activePlanApprovalTaskId) {
          throw new Error(
            `Session ${taskRow.session_id} is missing active_plan_approval_task_id`
          )
        }
        if (sessionRow.activePlanApprovalTaskId !== locked.id) {
          throw new Error(
            `Session ${taskRow.session_id} points to ${sessionRow.activePlanApprovalTaskId}, not ${locked.id}`
          )
        }

        const collaborationState = parseSessionCollaborationState(
          sessionRow.collaborationState == null
            ? {}
            : requireJsonObject(
                sessionRow.collaborationState,
                `Session ${taskRow.session_id} collaboration_state`
              )
        )
        const existingDraft = collaborationState.planDraft
        if (!existingDraft) {
          throw new Error(
            `Session ${taskRow.session_id} is missing collaborationState.planDraft`
          )
        }

        await updateSessionCollaboration(
          {
            sessionId: taskRow.session_id,
            collaborationMode:
              nextStatus === "approved" ? "default" : "plan_drafting",
            collaborationState:
              nextStatus === "approved"
                ? {}
                : {
                    planDraft: buildSessionPlanDraftState({
                      summary: existingDraft.summary,
                      checklist: existingDraft.checklist,
                      explanation: existingDraft.explanation,
                      enteredAt: existingDraft.enteredAt,
                    }),
                  },
            activePlanApprovalTaskId: null,
          },
          client
        )
      }
    } else {
      if (params.decision !== "approve" && params.decision !== "reject") {
        throw new Error("decision must be approve or reject")
      }
      if (params.decision === "approve" && !params.preset) {
        throw new Error(
          "preset is required when approving runtime authorization"
        )
      }

      nextStatus = params.decision === "approve" ? "approved" : "rejected"
      resolutionPayload = {
        decision: params.decision,
        approvedPreset:
          params.decision === "approve" ? params.preset : undefined,
        selectedGrantOptionId:
          params.decision === "approve" &&
          typeof params.selectedGrantOptionId === "string" &&
          params.selectedGrantOptionId.trim().length > 0
            ? params.selectedGrantOptionId.trim()
            : undefined,
        note: params.note?.trim() || undefined,
      }

      if (params.decision === "approve") {
        const selectedGrantOptionId =
          typeof params.selectedGrantOptionId === "string"
            ? params.selectedGrantOptionId.trim()
            : ""
        if (!selectedGrantOptionId) {
          throw new Error(
            "selectedGrantOptionId is required when approving runtime authorization"
          )
        }

        const grantOptions = parseJsonArray<RuntimeAuthorizationGrantOption>(
          locked.grant_options,
          `Task ${locked.id} grant_options`
        )
        const availablePresets = parseJsonArray<RuntimeAuthorizationPreset>(
          locked.available_presets,
          `Task ${locked.id} available_presets`
        )
        if (!availablePresets.includes(params.preset || "once")) {
          throw new Error(
            `preset ${params.preset || "once"} is not allowed for this runtime authorization request`
          )
        }
        const selectedOption = grantOptions.find(
          (candidate) => candidate.id === selectedGrantOptionId
        )
        if (!selectedOption) {
          throw new Error(
            `Unknown runtime authorization option "${selectedGrantOptionId}"`
          )
        }

        // subject-scope-refactor: presetToOwnerScope translates the wire
        // preset + locked request context into the new (subject, scope?,
        // retention) triple that createRuntimeAuthorizationGrant accepts.
        // The principal subject is reconstructed from the locked row, then
        // a FULL RuntimePrincipalContext is rebuilt via the pg-form helper
        // `buildRuntimePrincipalContextOn(client, ...)` so the same Decision-8
        // / active-participant invariants that govern dispatch also govern
        // grant creation at approval time.
        const { presetToOwnerScope, UnsupportedGrantTargetError } =
          await import("../runtime-authorizations/service.js")
        const { loadAccessSubjectOn } =
          await import("../access/subject-registry.js")
        const { buildRuntimePrincipalContextOn } =
          await import("../access/subject-resolution.js")
        const lockedPrincipalSubject = await loadAccessSubjectOn(
          client,
          locked.principal_subject_id
        )
        if (!lockedPrincipalSubject) {
          throw new Error(
            `task ${locked.id}: principal subject ${locked.principal_subject_id} not found`
          )
        }
        lockedPrincipalSubjectForReturn = lockedPrincipalSubject
        // Rebuild RuntimePrincipalContext inside the SAME pg transaction
        // so subject upserts / participant checks see consistent state and
        // the result reflects current participation (an actor who left the
        // conversation between request and approval gets `activeConversation
        // SubjectId === undefined` here, even if the locked row froze one).
        const rebuiltCtx = await buildRuntimePrincipalContextOn(client, {
          principal: lockedPrincipalSubject,
          workspaceId: locked.workspace_id,
          conversationId: locked.conversation_id ?? null,
        })
        // ScopeRebuildMismatchError — explicit equality check between the
        // locked principal_scope_subject_id (frozen at request time) and the
        // rebuilt active conversation scope. Three cases must all match:
        //  (a) locked = null AND rebuilt = undefined  → unscoped, OK
        //  (b) locked = X    AND rebuilt = X          → same scope, OK
        //  (c) locked = X    AND rebuilt = Y or null  → DRIFT, reject
        // Without this gate, an actor that lost their conversation
        // participation between request and approval could still mint a
        // `actor + scope=conversation` grant via the locked snapshot.
        const lockedScopeId = locked.principal_scope_subject_id ?? null
        const rebuiltScopeId = rebuiltCtx.activeConversationSubjectId ?? null
        if (lockedScopeId !== rebuiltScopeId) {
          throw new Error(
            `ScopeRebuildMismatchError: task ${locked.id} locked principal_scope_subject_id=${lockedScopeId ?? "NULL"} but rebuilt activeConversationSubjectId=${rebuiltScopeId ?? "NULL"} — principal scope drifted between request and approval`
          )
        }
        const presetTriple = presetToOwnerScope(
          params.preset || "once",
          rebuiltCtx,
          locked.workspace_id
        )
        createdGrant = await createRuntimeAuthorizationGrant(
          {
            workspaceId: locked.workspace_id,
            deviceId: locked.device_id || "",
            deviceCapabilityId: locked.device_capability_id || "",
            deviceExposureId: locked.device_exposure_id || "",
            subject: presetTriple.subject,
            scope: presetTriple.scope,
            retention: presetTriple.retention,
            createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
            sourceTaskId: locked.id || undefined,
            sourceRetryNonce: locked.source_retry_nonce || undefined,
            sourceRuntimeSessionId:
              locked.source_runtime_session_id || undefined,
            sourceRequestArgs:
              locked.source_request_args &&
              typeof locked.source_request_args === "object"
                ? (locked.source_request_args as Record<string, unknown>)
                : {},
            policy: selectedOption.grantSpec,
          },
          client
        )
        resolutionPayload = {
          ...resolutionPayload,
          approvedGrant: createdGrant,
        }
      }
    }

    // Task unification (design §3.4): the in-tx update records the human
    // resolution (resolver, revision bump, resolution payload) but does NOT
    // flip the lifecycle to terminal. The post-commit fan-out below does the
    // SINGLE terminal flip + delivery via completeToolCallTask/failToolCallTask
    // (so runtime-auth auto-retry can run first and its result drives the
    // Task unification (design §3.4, corrected): flip the task to its terminal
    // lifecycle + outcome IN-TX, so every in-tx-derived view is correct — the
    // reloaded summary, the task.updated broadcast, the HTTP response,
    // and the command-idempotency row all see the resolved state. Delivery
    // (notice + wakeup/push) and runtime-auth auto-retry happen post-commit
    // (auto-retry writes only final_result_payload, which is NOT terminal-
    // guarded, so it lands on the already-terminal row).
    const taskFields = taskResolutionStatusToFields(nextStatus, locked.kind)
    await updateTaskRequestRow(client, params.taskId, {
      lifecycleStatus: taskFields.lifecycleStatus,
      outcome: taskFields.outcome,
      revision: sql`revision + 1`,
      resolvedByParticipantId: params.resolverParticipantId,
      resolvedAt: sql`NOW()`,
    })

    await updateTaskResolutionPayload(client, params.taskId, resolutionPayload)

    const nextTask = await getTaskSummary(params.taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload resolved task")
    }

    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)

    await insertTaskCommandRow(client, {
      taskId: params.taskId,
      commandId: params.commandId,
      baseRevision: params.baseRevision,
      outcome: "applied",
      requestPayload: normalizedCommandPayload,
      responsePayload: {
        outcome: "applied",
        task: nextTask,
      },
      createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })

    return {
      outcome: "applied" as const,
      task: nextTask,
      createdGrant,
      // Surface the original args + retry_nonce to the outer scope so the
      // post-commit auto-retry path (autoDispatchRuntimeAuthorizationRetry)
      // can re-issue the original tool call without the model having to
      // notice the approval. Drops to undefined for non-runtime-authorization
      // tasks (these fields are only populated when locked.kind is
      // RUNTIME_AUTHORIZATION).
      lockedSourceRequestArgs:
        locked.source_request_args &&
        typeof locked.source_request_args === "object"
          ? (locked.source_request_args as Record<string, unknown>)
          : undefined,
      lockedSourceRetryNonce: locked.source_retry_nonce ?? undefined,
      lockedSourceTaskId: locked.id ?? undefined,
      // subject-scope-refactor: skip-task gate is now keyed on
      // principal_subj.kind (resolved via JOIN at SELECT time), not the
      // dropped principal_remote_agent_id column. principal_subject_kind
      // is the legitimate signal; principal_remote_agent_id is kept on
      // the row type only as a derived alias for dashboard consumers.
      lockedPrincipalSubjectKind: locked.principal_subject_kind ?? undefined,
      // subject-scope-refactor: forward the locked principal triple so the
      // post-commit auto-retry can re-build the RuntimePrincipalContext via
      // buildRuntimePrincipalContext (Kysely-form, since the pg transaction
      // is closed by the time we get there) and pass runtimeSubjectIds /
      // runtimeScopeSubjectIds to selectAndClaimRuntimeAuthorizationGrant.
      lockedPrincipalSubjectId: locked.principal_subject_id,
      lockedPrincipalScopeSubjectId:
        locked.principal_scope_subject_id ?? undefined,
      lockedPrincipalSubject: lockedPrincipalSubjectForReturn,
      // Task unification: the decision (task vocabulary) computed in-tx,
      // so the post-commit delivery fan-out can branch on it without relying on
      // the (still non-terminal) lifecycle_status.
      nextStatus,
    }
  })

  if (result.outcome !== "applied") {
    // Crash-recovery (P0): a duplicate-command retry means a prior resolve
    // committed the terminal task but may have crashed before post-commit
    // delivery ran. Re-fire delivery from the persisted task state; it is
    // idempotent (skips if a session_wakeup notice already exists), so a
    // genuinely-already-delivered task is a no-op and a lost wakeup is recovered.
    if (result.task?.id) {
      await recoverUndeliveredResolvedTask(result.task.id).catch(
        () => undefined
      )
    }
    return {
      outcome: result.outcome,
      task: result.task,
    }
  }

  const task = result.task

  // Task unification: the lifecycle/outcome were flipped IN-TX (so result.
  // task already reads resolved). Here we only DELIVER (notice + wakeup
  // for session_wakeup; machine-WS push for remote_agent_channel) — no second
  // flip. P1: a human "no" (plan
  // revision / authz deny) is completed+outcome 'revision_requested'/'denied',
  // never a machinery failure.
  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) {
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...buildUserInputAsyncNotice(task),
      outcome: "answered",
    })
  } else if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    if (result.nextStatus === "approved") {
      await deliverResolvedToolCallTask(task.id, "completed", {
        ...buildPlanApprovalApprovedNotice(task),
        outcome: "approved",
      })
    } else {
      await deliverResolvedToolCallTask(task.id, "completed", {
        ...buildPlanApprovalRevisionNotice(task),
        outcome: "revision_requested",
      })
    }
  } else if (result.nextStatus === "rejected") {
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...buildRuntimeAuthorizationRejectedNotice(task),
      outcome: "denied",
    })
  } else {
    // Approved runtime authorization: re-dispatch the original tool call
    // server-side using the persisted sourceRequestArgs + retry_nonce + the
    // grant we just created (design §3.4: auto-retry runs post-commit; its
    // result drives the completion notice's final_result_payload — written via
    // the unguarded payload update inside deliverResolvedToolCallTask). Falls
    // back to a plain approval notice if auto-retry can't run.
    const approvedRetry = await maybeAutoRetryAfterApproval({
      task,
      sourceRequestArgs: result.lockedSourceRequestArgs,
      sourceRetryNonce: result.lockedSourceRetryNonce,
      sourceTaskId: result.lockedSourceTaskId,
      createdGrant: result.createdGrant,
      lockedPrincipalSubject: result.lockedPrincipalSubject,
      lockedPrincipalScopeSubjectId: result.lockedPrincipalScopeSubjectId,
      resolverWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...(approvedRetry ?? buildRuntimeAuthorizationApprovedNotice(task)),
      outcome: "granted",
    })
  }

  return {
    outcome: result.outcome,
    task,
    createdGrant: result.createdGrant,
    createdGrants: result.createdGrant ? [result.createdGrant] : undefined,
  }
}

export async function markRuntimeAuthorizationTaskSuperseded(
  taskId: string,
  note?: string
) {
  const existing = await getTaskRowById(taskId)
  if (!existing) {
    throw new Error("Task request not found")
  }
  if (
    existing.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    !isOpenTaskLifecycle(existing.lifecycle_status)
  ) {
    const current = await getTaskSummary(taskId)
    if (!current) {
      throw new Error("Failed to reload task request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const task = await withDbTransaction(async (client) => {
    await updateTaskRequestRow(client, taskId, {
      lifecycleStatus: "cancelled",
      revision: sql`revision + 1`,
      resolvedAt: sql`NOW()`,
    })
    await updateTaskResolutionPayload(client, taskId, {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      superseded: true,
    })
    const nextTask = await getTaskSummary(taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload superseded task")
    }
    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)
    return nextTask
  })
  // Lifecycle already flipped to cancelled in-tx; deliver the supersede notice.
  await deliverResolvedToolCallTask(task.id, "cancelled", {
    ...buildRuntimeAuthorizationSupersededNotice(task),
  })
  return task
}
