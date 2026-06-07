import {
  CONVERSATION_PARTICIPANT_TYPE,
  INTERACTION_INPUT_QUESTION_TYPES,
  INTERACTION_REQUEST_KIND,
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
  ChatInteractionResolveInput,
  ChatInteractionResolveOutcome,
  ConversationFeedItem,
  ConversationFeedEventPayloadMap,
  ConversationEntityRef,
  InteractionDecision,
  InteractionInputAnswer,
  InteractionInputOption,
  InteractionInputQuestionDefinition,
  InteractionInputQuestionSummary,
  InteractionRequestKind,
  InteractionRequestStatus,
  TaskSummary,
  PlanApprovalDecision,
  PlanChecklistStep,
  RuntimeAuthorizationGrantOption,
  SharedRuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationInteractionSummary,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
  SessionCollaborationState,
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
import { upsertInteractionTransportProjection } from "./transport-projections.js"

/** Run raw SQL (text+params) on db / trx. */
async function runOn<T = any>(
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
function runOnDb<T = any>(
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

type RawInteractionRow = {
  id: string
  workspace_id: string
  conversation_id: string
  // Task unification: the row IS the task. session_id lives on it (nullable for
  // remote_agent_channel delivery). The legacy task_id pointer is gone.
  session_id: string | null
  remote_agent_run_id: string | null
  conversation_item_id: string | null
  kind: InteractionRequestKind
  status: InteractionRequestStatus
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
  // subject-scope-refactor: principal_remote_agent_id dropped from
  // interaction_runtime_authorization_requests. Replaced by
  // principal_subject_id (NOT NULL) + principal_scope_subject_id (nullable),
  // both FK to access_subjects with ON DELETE RESTRICT (durable audit).
  principal_subject_id: string
  principal_scope_subject_id: string | null
  // Retained on the type for transitional caller compatibility.
  principal_remote_agent_id: string | null
  principal_subject_kind: string | null
  resolution_payload: unknown
  resolved_at: string | Date | null
  expires_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
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

type RawInteractionCommandRow = {
  id: string
  interaction_id: string
  command_id: string
  base_revision: string | number
  outcome: ChatInteractionResolveOutcome
  request_payload: unknown
  response_payload: unknown
  created_by_workspace_member_id: string | null
  created_at: string | Date
  updated_at: string | Date
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : value
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

export interface CreateUserInputInteractionParams {
  workspaceId: string
  conversationId: string
  taskId: string
  requesterParticipantId: string
  targetParticipantId: string
  title: string
  instructions?: string
  questions: InteractionInputQuestionDefinition[]
  expiresAt?: string
}

export interface CreateRemoteAgentUserInputInteractionParams {
  workspaceId: string
  conversationId: string
  remoteAgentRunId: string
  requesterParticipantId: string
  targetParticipantId?: string
  title: string
  instructions?: string
  questions: InteractionInputQuestionDefinition[]
  expiresAt?: string
}

export interface CreatePlanApprovalInteractionParams {
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
  expiresAt?: string
}

export interface CreateRemoteAgentPlanApprovalInteractionParams {
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
  expiresAt?: string
}

export interface CreateRuntimeAuthorizationInteractionParams {
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
  expiresAt?: string
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

export type ResolveInteractionRequestParams = ChatInteractionResolveInput & {
  interactionId: string
  resolverWorkspaceMemberId: string
  resolverParticipantId: string
}

export interface ResolveInteractionRequestResult {
  outcome: ChatInteractionResolveOutcome
  interaction: TaskSummary
  createdGrant?: RuntimeAuthorizationGrantRecord
  createdGrants?: RuntimeAuthorizationGrantRecord[]
}

export interface FindOpenRuntimeAuthorizationInteractionParams {
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
   * value the caller would write via createRuntimeAuthorizationInteractionRequest's
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

function requireIsoString(
  value: string | Date | null | undefined,
  label: string
): string {
  const iso = toIsoString(value)
  if (!iso) {
    throw new Error(`${label} is required`)
  }
  return iso
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
 * keys so concurrent Agent sessions never share a single pending interaction
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
   * interaction — critical for CUA where the per-session focusStore would
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

function buildTaskInteractionRequestKey(taskId: string) {
  return `task:${taskId}`
}

function buildRemoteAgentInteractionRequestKey(params: {
  remoteAgentRunId: string
  kind: InteractionRequestKind
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
    kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
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
): InteractionInputOption[] {
  if (!Array.isArray(value)) {
    return []
  }

  const options: InteractionInputOption[] = []
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
): InteractionInputQuestionDefinition["type"] {
  if (
    typeof value === "string" &&
    (INTERACTION_INPUT_QUESTION_TYPES as readonly string[]).includes(value)
  ) {
    return value as InteractionInputQuestionDefinition["type"]
  }
  throw new Error(`Unsupported user input question type: ${String(value)}`)
}

function parseUserInputQuestionDefinitions(
  promptPayload: Record<string, unknown>
): InteractionInputQuestionDefinition[] {
  const rawQuestions = promptPayload.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error(
      "user_input prompt_payload.questions must be a non-empty array"
    )
  }
  const definitions: InteractionInputQuestionDefinition[] = []
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
    const definition: InteractionInputQuestionDefinition = {
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
  questions: InteractionInputQuestionDefinition[]
): InteractionInputAnswer[] {
  const answers: InteractionInputAnswer[] = []
  const seenQuestionIds = new Set<string>()

  if (resolutionPayload.answers === undefined) {
    return answers
  }
  if (!Array.isArray(resolutionPayload.answers)) {
    throw new Error("interaction resolution_payload.answers must be an array")
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
): InteractionInputQuestionSummary[] {
  const definitions = parseUserInputQuestionDefinitions(promptPayload)
  const answers = parseUserInputAnswers(resolutionPayload, definitions)
  const answerMap = new Map<string, InteractionInputAnswer>()
  for (const answer of answers) {
    answerMap.set(answer.questionId, answer)
  }

  return definitions.map((question) => {
    const answer = answerMap.get(question.id)
    const labels =
      answer?.selectedOptionIds?.map(
        (selectedId: string) =>
          (question.options || []).find(
            (option: InteractionInputOption) => option.id === selectedId
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
  row: RawInteractionRow
): ConversationEntityRef | undefined {
  const participantType =
    row[`${prefix}_participant_type` as keyof RawInteractionRow]
  if (typeof participantType !== "string" || !participantType.trim()) {
    return undefined
  }
  const participantId =
    row[`${prefix}_participant_id` as keyof RawInteractionRow]
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
  const name = row[`${prefix}_name` as keyof RawInteractionRow]
  const title = row[`${prefix}_title` as keyof RawInteractionRow]
  const role = row[`${prefix}_role` as keyof RawInteractionRow]
  const actorAvatarFileId =
    row[`${prefix}_actor_avatar_file_id` as keyof RawInteractionRow]
  const userAvatarFileId =
    row[`${prefix}_user_avatar_file_id` as keyof RawInteractionRow]
  const remoteAgentAvatarFileId =
    row[`${prefix}_remote_agent_avatar_file_id` as keyof RawInteractionRow]
  const avatarEmoji = row[`${prefix}_avatar_emoji` as keyof RawInteractionRow]

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

/**
 * Reverse of interactionStatusToTaskFields: project the task's lifecycle_status
 * ⟂ outcome back into the legacy interaction-status vocabulary the wire/FE still
 * speak (until the Step-3 task-surface migration). Non-terminal → 'pending';
 * completed → answered/approved/rejected by outcome; cancelled/expired direct.
 */
function taskFieldsToInteractionStatus(
  lifecycle: ToolCallTaskLifecycleStatus,
  outcome: ToolCallTaskOutcome | null
): InteractionRequestStatus {
  switch (lifecycle) {
    case "completed":
      switch (outcome) {
        case "answered":
          return "answered"
        case "approved":
        case "granted":
          return "approved"
        case "revision_requested":
        case "denied":
          return "rejected"
        default:
          return "answered"
      }
    case "cancelled":
      return "cancelled"
    case "expired":
      return "expired"
    case "failed":
      return "rejected"
    case "submitted":
    case "working":
    case "input_required":
    case "auth_required":
    default:
      return "pending"
  }
}

/**
 * Resolve a conversation participant to its access_subjects id (the task
 * delivery key). Used by the remote-agent interaction paths that mint their own
 * task (the principal is the requesting remote_agent's participant subject).
 */
async function resolveParticipantSubjectId(
  client: Executor,
  participantId: string
): Promise<string> {
  const row = await client
    .selectFrom("conversation_participants")
    .select("subject_id")
    .where("id", "=", participantId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.subject_id) {
    throw new Error(`Participant ${participantId} has no subject`)
  }
  return row.subject_id
}

function buildInteractionSummary(row: RawInteractionRow): TaskSummary {
  const requester = requireEntityRef(
    mapEntityRefFromRow("requester", row),
    `Interaction ${row.id} requester`
  )
  const target = mapEntityRefFromRow("target", row)
  const resolvedBy = row.resolved_by_participant_id
    ? requireEntityRef(
        mapEntityRefFromRow("resolved_by", row),
        `Interaction ${row.id} resolved_by`
      )
    : undefined
  const resolutionPayload = requireJsonObject(
    row.resolution_payload,
    `Interaction ${row.id} resolution_payload`
  )

  const baseInteraction = {
    id: row.id,
    // Task unification: the task IS the interaction; taskId == the row id.
    taskId: row.id,
    remoteAgentRunId: row.remote_agent_run_id || undefined,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.conversation_item_id || undefined,
    status: taskFieldsToInteractionStatus(
      row.status as unknown as ToolCallTaskLifecycleStatus,
      row.outcome
    ),
    revision: toRevisionNumber(row.revision, `Interaction ${row.id} revision`),
    requester,
    resolvedBy,
    resolutionNote:
      typeof resolutionPayload.note === "string"
        ? resolutionPayload.note.trim() || undefined
        : undefined,
    createdAt: requireIsoString(
      row.created_at,
      `Interaction ${row.id} created_at`
    ),
    updatedAt: requireIsoString(
      row.updated_at,
      `Interaction ${row.id} updated_at`
    ),
    resolvedAt: toIsoString(row.resolved_at),
    expiresAt: toIsoString(row.expires_at),
    viewerCanResolve: false,
  }

  if (row.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    const promptPayload = requireJsonObject(
      row.prompt_payload,
      `Interaction ${row.id} prompt_payload`
    )
    return {
      ...baseInteraction,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      target,
      userInput: {
        title: requireTrimmedString(
          promptPayload.title,
          `Interaction ${row.id} user_input.title`
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

  if (row.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    const planPayload = requireJsonObject(
      row.plan_payload,
      `Interaction ${row.id} plan_payload`
    )
    return {
      ...baseInteraction,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      target,
      planApproval: {
        title: requireTrimmedString(
          planPayload.title,
          `Interaction ${row.id} plan_approval.title`
        ),
        summary:
          typeof planPayload.summary === "string"
            ? planPayload.summary.trim() || undefined
            : undefined,
        planMarkdown: requireTrimmedString(
          planPayload.planMarkdown,
          `Interaction ${row.id} plan_approval.planMarkdown`
        ),
        checklist: Array.isArray(planPayload.checklist)
          ? (planPayload.checklist as PlanChecklistStep[])
          : undefined,
      },
    }
  }

  const requestedAction = requireJsonObject(
    row.requested_action,
    `Interaction ${row.id} requested_action`
  ) as unknown as RuntimeAuthorizationRequestedAction
  const grantOptions = parseJsonArray<RuntimeAuthorizationGrantOption>(
    row.grant_options,
    `Interaction ${row.id} grant_options`
  )
  const availablePresets = parseJsonArray<RuntimeAuthorizationPreset>(
    row.available_presets,
    `Interaction ${row.id} available_presets`
  )
  const runtimeAuthorization: RuntimeAuthorizationInteractionSummary = {
    requestedToolName: requireTrimmedString(
      row.requested_tool_name,
      `Interaction ${row.id} requested_tool_name`
    ),
    deviceToolStableKey: requireTrimmedString(
      row.device_tool_stable_key,
      `Interaction ${row.id} device_tool_stable_key`
    ),
    requestedAction,
    reason: requireTrimmedString(
      row.reason,
      `Interaction ${row.id} runtime_authorization.reason`
    ),
    deviceId: requireTrimmedString(
      row.device_id,
      `Interaction ${row.id} device_id`
    ),
    deviceDisplayName: requireTrimmedString(
      row.device_display_name,
      `Interaction ${row.id} device_display_name`
    ),
    deviceCapabilityId: requireTrimmedString(
      row.device_capability_id,
      `Interaction ${row.id} device_capability_id`
    ),
    exposureId: requireTrimmedString(
      row.device_exposure_id,
      `Interaction ${row.id} device_exposure_id`
    ),
    exposureDisplayName: requireTrimmedString(
      row.exposure_display_name,
      `Interaction ${row.id} exposure_display_name`
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
        ? (resolutionPayload.approvedGrant as RuntimeAuthorizationInteractionSummary["approvedGrant"])
        : undefined,
    requestMode:
      row.request_mode === "blocking" || row.request_mode === "background"
        ? (row.request_mode as RuntimeAuthorizationRequestMode)
        : (() => {
            throw new Error(
              `Interaction ${row.id} runtime_authorization.requestMode is invalid`
            )
          })(),
    // Surface the persisted retry_nonce so the dedupe-reuse path in
    // runtime-authorizations/requests.ts can return the row's actual nonce
    // (the one that will match source_retry_nonce on the eventual grant)
    // instead of the freshly-generated nonce that no grant will ever match.
    sourceRetryNonce: row.source_retry_nonce ?? undefined,
  }

  return {
    ...baseInteraction,
    kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    runtimeAuthorization,
  }
}

async function getInteractionRowById(
  interactionId: string,
  queryable?: Executor
) {
  const compiled = sql<RawInteractionRow>`
    SELECT ir.*,
            ir.lifecycle_status AS status,
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
            COALESCE(requester_remote_agent.name, requester_actor.name, requester_user.name, requester.display_name) AS requester_name,
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
            COALESCE(target_remote_agent.name, target_actor.name, target_user.name, target.display_name) AS target_name,
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
            COALESCE(resolver_remote_agent.name, resolver_actor.name, resolver_user.name, resolver.display_name) AS resolved_by_name,
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
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
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
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
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
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.device_id
     LEFT JOIN device_exposures exposure
       ON exposure.id = auth.device_exposure_id
     WHERE ir.id = ${interactionId}
     LIMIT 1
  `.compile(db)
  const result = await runCompiledOn<RawInteractionRow>(queryable, compiled)
  return result.rows[0] || null
}

type StoredInteractionResolveResponse = {
  outcome: ChatInteractionResolveOutcome
  interaction: TaskSummary
}

function requireInteractionResolveOutcome(
  value: unknown,
  label: string
): ChatInteractionResolveOutcome {
  if (value === "applied" || value === "duplicate" || value === "conflict") {
    return value
  }
  throw new Error(`${label} is invalid`)
}

function parseStoredInteractionResolveResponse(
  value: unknown,
  label: string
): StoredInteractionResolveResponse {
  const payload = requireJsonObject(value, label)
  const outcome = requireInteractionResolveOutcome(
    payload.outcome,
    `${label}.outcome`
  )
  if (!payload.interaction || typeof payload.interaction !== "object") {
    throw new Error(`${label}.interaction is required`)
  }
  return {
    outcome,
    interaction: payload.interaction as TaskSummary,
  }
}

async function getInteractionCommandRow(
  interactionId: string,
  commandId: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("tool_call_task_response_commands")
    .selectAll()
    .where("task_id", "=", interactionId)
    .where("command_id", "=", commandId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<RawInteractionCommandRow>(
    queryable,
    compiled
  )
  return result.rows[0] || null
}

async function getInteractionRowByIdForUpdate(
  interactionId: string,
  queryable: Executor
) {
  const compiled = sql<RawInteractionRow>`
    SELECT ir.*,
            ir.lifecycle_status AS status,
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
            COALESCE(requester_remote_agent.name, requester_actor.name, requester_user.name, requester.display_name) AS requester_name,
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
            COALESCE(target_remote_agent.name, target_actor.name, target_user.name, target.display_name) AS target_name,
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
            COALESCE(resolver_remote_agent.name, resolver_actor.name, resolver_user.name, resolver.display_name) AS resolved_by_name,
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
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
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
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
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
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.device_id
     LEFT JOIN device_exposures exposure
       ON exposure.id = auth.device_exposure_id
     WHERE ir.id = ${interactionId}
     LIMIT 1
     FOR UPDATE OF ir
  `.compile(db)
  const result = await runCompiledOn<RawInteractionRow>(queryable, compiled)
  return result.rows[0] || null
}

async function insertInteractionCommandRow(
  client: Executor,
  params: {
    interactionId: string
    commandId: string
    baseRevision: number
    outcome: ChatInteractionResolveOutcome
    requestPayload: Record<string, unknown>
    responsePayload: StoredInteractionResolveResponse
    createdByWorkspaceMemberId: string
  }
) {
  await runBuilder(
    client,
    db.insertInto("tool_call_task_response_commands").values({
      task_id: params.interactionId,
      command_id: params.commandId,
      base_revision:
        params.baseRevision as unknown as TableInsert<"tool_call_task_response_commands">["base_revision"],
      outcome: params.outcome,
      request_payload: jsonbValue(
        params.requestPayload
      ) as unknown as TableInsert<"tool_call_task_response_commands">["request_payload"],
      response_payload: jsonbValue(
        params.responsePayload
      ) as unknown as TableInsert<"tool_call_task_response_commands">["response_payload"],
      created_by_workspace_member_id: params.createdByWorkspaceMemberId,
    })
  )
}

async function appendInteractionUpdatedSyncEvent(
  queryable: Executor,
  interaction: TaskSummary
) {
  const allRecipients = await listConversationRealtimeRecipients(
    interaction.conversationId,
    queryable
  )
  const recipients =
    interaction.kind === INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    (interaction.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
      !interaction.target)
      ? allRecipients
      : allRecipients.filter(
          (recipient) =>
            recipient.workspaceMemberId ===
              interaction.target?.workspaceMemberId ||
            recipient.workspaceMemberId ===
              interaction.requester?.workspaceMemberId
        )
  for (const recipient of recipients) {
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId: recipient.workspaceId,
      workspaceMemberId: recipient.workspaceMemberId,
      conversationId: interaction.conversationId,
      itemId: interaction.itemId,
      eventType: "task.updated",
      payload: {
        conversationId: interaction.conversationId,
        taskId: interaction.id,
        itemId: interaction.itemId,
        task: interaction,
      },
    })
  }
}

async function syncInteractionEventPayload(
  interaction: TaskSummary,
  queryable?: Executor
) {
  if (!interaction.itemId) return
  await updateConversationItemEventPayload(
    interaction.itemId,
    { task: interaction },
    queryable
  )
}

function buildUserInputAsyncNotice(interaction: TaskSummary) {
  const prompt = interaction.userInput?.title?.trim() || "Input request"
  const answer = summarizeUserInputAnswers(interaction.userInput)
  const targetName = interaction.target?.name || "A user"
  const resolutionNote = interaction.resolutionNote?.trim()
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
        interactionId: interaction.id,
        interaction,
      },
      isError: false,
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

function buildPlanApprovalApprovedNotice(interaction: TaskSummary) {
  const resolverName = interaction.resolvedBy?.name || "A user"
  const title = interaction.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} approved "${title}".`
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Note: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: false,
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

function buildPlanApprovalRevisionNotice(interaction: TaskSummary) {
  const resolverName = interaction.resolvedBy?.name || "A user"
  const title = interaction.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} requested revisions for "${title}".`
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Feedback: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: true,
    },
    finalErrorPayload: {
      interactionId: interaction.id,
      reason: "plan_revision_requested",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

function buildRuntimeAuthorizationRejectedNotice(interaction: TaskSummary) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user"
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "the device"
  const summary = `${resolverName} rejected access for ${deviceName}.`
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Note: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: true,
    },
    finalErrorPayload: {
      interactionId: interaction.id,
      reason: "rejected_by_user",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

function buildRuntimeAuthorizationApprovedNotice(interaction: TaskSummary) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user"
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "the device"
  const approvedPreset =
    interaction.runtimeAuthorization?.approvedPreset || "conversation"
  const summary = `${resolverName} approved ${approvedPreset} access for ${deviceName}.`
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Note: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: false,
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

/**
 * After a runtime_authorization interaction is approved, try to re-issue
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
  interaction: TaskSummary
  sourceRequestArgs?: Record<string, unknown>
  sourceRetryNonce?: string
  sourceTaskId?: string
  createdGrant?: RuntimeAuthorizationGrantRecord
  lockedPrincipalSubject?: SubjectRef
  lockedPrincipalScopeSubjectId?: string
  resolverWorkspaceMemberId?: string
}) {
  if (
    args.interaction.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION
  ) {
    return null
  }
  const runtimeAuth = args.interaction.runtimeAuthorization
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
      workspaceId: args.interaction.workspaceId,
      conversationId: args.interaction.conversationId ?? null,
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
      workspaceId: args.interaction.workspaceId,
      conversationId: args.interaction.conversationId,
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
        interactionId: args.interaction.id,
        interaction: args.interaction,
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
      interactionId: args.interaction.id,
      interactionKind: args.interaction.kind,
      interactionStatus: args.interaction.status,
      synapseRetry: {
        autoRedispatched: true,
      },
    },
  }
}

function buildRuntimeAuthorizationSupersededNotice(interaction: TaskSummary) {
  const summary =
    "This authorization request was superseded by a newer user message."
  const messageBlocks = textBlocks(summary)

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: true,
    },
    finalErrorPayload: {
      interactionId: interaction.id,
      reason: "superseded",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  }
}

async function insertInteractionRequest(
  client: Executor,
  params: {
    workspaceId: string
    conversationId: string
    taskId?: string
    remoteAgentRunId?: string
    requesterParticipantId: string
    kind: InteractionRequestKind
    requestKey: string
    targetParticipantId?: string
    expiresAt?: string
  }
): Promise<string | null> {
  // Task unification: the task IS the interaction. The caller already created
  // the tool_call_tasks row (with its request_key + dedupe). Here we attach the
  // human-facing participant fields onto that task and return its id. The dedupe
  // ON CONFLICT now lives at task creation; this UPDATE only succeeds while the
  // task is still non-terminal-pending (mirrors the old WHERE status='pending').
  if (!params.taskId) {
    // Remote-agent-run-only interactions previously had task_id=null; under the
    // unification every interaction is a task, so a missing taskId is a caller
    // error.
    throw new Error(
      "insertInteractionRequest requires a taskId (the task IS the interaction)"
    )
  }
  const updated = await runCompiledOn<{ id: string }>(
    client,
    sql<{ id: string }>`
      UPDATE tool_call_tasks
      SET requester_participant_id = ${params.requesterParticipantId},
          target_participant_id = ${params.targetParticipantId || null},
          remote_agent_run_id = COALESCE(${params.remoteAgentRunId || null}, remote_agent_run_id),
          expires_at = COALESCE(${params.expiresAt || null}, expires_at),
          updated_at = NOW()
      WHERE id = ${params.taskId}
        AND lifecycle_status IN ('submitted', 'working', 'input_required', 'auth_required')
      RETURNING id
    `.compile(db)
  )
  return updated.rows[0]?.id ?? null
}

/**
 * Resolve the existing-pending-interaction id that won an INSERT race
 * against `insertInteractionRequest` (which returned null on conflict).
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
    const byTask = await findInteractionIdByTaskId(params.taskId, client)
    if (byTask) return byTask
  }
  return findPendingInteractionIdByRequestKey(
    params.workspaceId,
    params.requestKey,
    client
  )
}

async function findInteractionIdByTaskId(taskId: string, queryable?: Executor) {
  // The task IS the interaction now (1:1). The interaction id == the task id;
  // confirm the task exists and is non-terminal-pending so dedupe-reuse only
  // returns a live row.
  const compiled = db
    .selectFrom("tool_call_tasks")
    .select("id")
    .where("id", "=", taskId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<{ id: string }>(queryable, compiled)
  return result.rows[0]?.id || null
}

async function findPendingInteractionIdByRequestKey(
  workspaceId: string,
  requestKey: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("tool_call_tasks")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("request_key", "=", requestKey)
    .where("lifecycle_status", "in", [
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

async function insertUserInputInteractionDetails(
  _client: Executor,
  _params: {
    interactionId: string
    promptPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the prompt payload lives in
  // tool_call_tasks.request_payload (written at task creation). human_input has
  // no CTI detail table.
}

async function insertPlanApprovalInteractionDetails(
  _client: Executor,
  _params: {
    interactionId: string
    planPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the plan payload lives in
  // tool_call_tasks.request_payload. plan_approval has no CTI detail table.
}

async function insertRuntimeAuthorizationInteractionDetails(
  client: Executor,
  params: {
    interactionId: string
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
    /** When the triggering dispatch was a remote_agent principal, the
    /** subject-scope-refactor: principal subject_id (NOT NULL on
     * interaction_runtime_authorization_requests). Caller resolves the
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
    db.insertInto("tool_call_task_runtime_authorization").values({
      task_id: params.interactionId,
      device_id: params.deviceId,
      device_capability_id: params.deviceCapabilityId,
      device_exposure_id: params.deviceExposureId,
      requested_tool_name: params.requestedToolName,
      device_tool_stable_key: params.deviceToolStableKey,
      reason: params.reason,
      request_mode: params.requestMode,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_retry_nonce: params.sourceRetryNonce || null,
      source_request_args: jsonbValue(
        params.sourceRequestArgs
      ) as unknown as TableInsert<"tool_call_task_runtime_authorization">["source_request_args"],
      principal_subject_id: params.principalSubjectId,
      principal_scope_subject_id: params.principalScopeSubjectId || null,
      requested_action: jsonbValue(
        params.requestedAction
      ) as unknown as TableInsert<"tool_call_task_runtime_authorization">["requested_action"],
      grant_options: jsonbValue(
        params.grantOptions
      ) as unknown as TableInsert<"tool_call_task_runtime_authorization">["grant_options"],
      available_presets: jsonbValue(
        params.availablePresets
      ) as unknown as TableInsert<"tool_call_task_runtime_authorization">["available_presets"],
      dedupe_key: params.dedupeKey,
    })
  )
}

/**
 * Write the runtime_authorization CTI detail row for a freshly-minted task,
 * INSIDE the caller's transaction (createToolCallTaskDeduped's onCreatedInTx).
 * This must run in the same tx as the parent INSERT so the deferred CTI
 * consistency trigger sees exactly one detail row at COMMIT. Computes the
 * content dedupe_key (also used by findOpenRuntimeAuthorizationInteraction).
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
  await insertRuntimeAuthorizationInteractionDetails(client, {
    interactionId: params.taskId,
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

async function updateInteractionConversationItemId(
  client: Executor,
  interactionId: string,
  conversationItemId: string
) {
  const result = await runBuilder(
    client,
    db
      .updateTable("tool_call_tasks")
      .set({
        conversation_item_id: conversationItemId,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", interactionId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update conversation item for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

/**
 * Translate the legacy interaction-resolution vocabulary (the wire-facing
 * status the API/FE still speak) into the task's lifecycle_status ⟂ outcome.
 *   answered      → completed / answered
 *   approved      → completed / (plan→approved | runtime_authorization→granted)
 *   rejected      → completed / (plan→revision_requested | runtime_authorization→denied)
 *   cancelled     → cancelled  (no outcome)
 *   superseded    → cancelled  (no outcome; a newer request replaced it)
 *   expired       → expired    (no outcome)
 * "pending" is non-terminal and never written here.
 */
function interactionStatusToTaskFields(
  status: InteractionRequestStatus,
  kind: InteractionRequestKind
): {
  lifecycle_status: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
} {
  switch (status) {
    case "answered":
      return { lifecycle_status: "completed", outcome: "answered" }
    case "approved":
      return {
        lifecycle_status: "completed",
        outcome:
          kind === INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "granted"
            : "approved",
      }
    case "rejected":
      return {
        lifecycle_status: "completed",
        outcome:
          kind === INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "denied"
            : "revision_requested",
      }
    case "cancelled":
      return { lifecycle_status: "cancelled", outcome: null }
    case "superseded":
      return { lifecycle_status: "cancelled", outcome: null }
    case "expired":
      return { lifecycle_status: "expired", outcome: null }
    case "pending":
    default:
      return { lifecycle_status: "working", outcome: null }
  }
}

async function updateInteractionRequestRow(
  client: Executor,
  interactionId: string,
  values: Record<string, unknown>
) {
  const result = await runBuilder(
    client,
    db
      .updateTable("tool_call_tasks")
      .set(values)
      .where("id", "=", interactionId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

async function updateInteractionResolutionPayload(
  client: Executor,
  _interactionKind: InteractionRequestKind,
  interactionId: string,
  payload: Record<string, unknown>
) {
  // Task unification: resolution payload lives on the task (final_result_payload)
  // for all kinds — no per-kind detail-table write.
  const result = await runBuilder(
    client,
    db
      .updateTable("tool_call_tasks")
      .set({
        final_result_payload: jsonbValue(
          payload
        ) as unknown as TableInsert<"tool_call_tasks">["final_result_payload"],
      })
      .where("id", "=", interactionId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update task ${interactionId} resolution payload, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

export async function createUserInputInteractionRequest(
  params: CreateUserInputInteractionParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: the caller (session-tools createGovernedToolCallTask)
    // already minted the fresh task (deduped at the task layer). Attach the
    // participant fields and create the feed item — no second dedupe.
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (interactionId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "User-input task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertUserInputInteractionDetails(client, {
      interactionId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task: interaction },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )

    interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created interaction request")
    }
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)
    return interaction
  })
}

export async function createRemoteAgentUserInputInteractionRequest(
  params: CreateRemoteAgentUserInputInteractionParams
) {
  return withDbTransaction(async (client) => {
    const requestKey = buildRemoteAgentInteractionRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
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
    const interactionId = minted.id

    await insertUserInputInteractionDetails(client, {
      interactionId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created remote agent input interaction")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task: interaction },
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

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )

    interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created remote agent input interaction")
    }
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)
    return interaction
  })
}

export async function createPlanApprovalInteractionRequest(
  params: CreatePlanApprovalInteractionParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: caller already minted the fresh deduped task.
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (interactionId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "Plan-approval task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertPlanApprovalInteractionDetails(client, {
      interactionId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task: interaction },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )

    interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created interaction request")
    }
    const collaborationState = parseSessionCollaborationState(
      params.collaborationState
    )
    if (!collaborationState.planDraft) {
      throw new Error(
        "Plan approval interactions require collaborationState.planDraft"
      )
    }
    await updateSessionCollaboration(
      {
        sessionId: params.sessionId,
        collaborationMode: "plan_awaiting_approval",
        collaborationState,
        activePlanApprovalInteractionId: interactionId,
      },
      client
    )
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)
    return interaction
  })
}

export async function createRemoteAgentPlanApprovalInteractionRequest(
  params: CreateRemoteAgentPlanApprovalInteractionParams
) {
  return withDbTransaction(async (client) => {
    const requestKey = buildRemoteAgentInteractionRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
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
    const interactionId = minted.id

    await insertPlanApprovalInteractionDetails(client, {
      interactionId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created remote agent plan interaction")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task: interaction },
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

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )
    const contextUpsert = await runOn<{ remote_agent_id: string }>(
      client,
      `
        INSERT INTO remote_agent_conversation_contexts (
          remote_agent_id,
          conversation_id,
          collaboration_mode,
          collaboration_state,
          active_plan_approval_interaction_id
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
          active_plan_approval_interaction_id = EXCLUDED.active_plan_approval_interaction_id,
          updated_at = NOW()
        RETURNING remote_agent_id
      `,
      [
        params.conversationId,
        JSON.stringify(params.collaborationState || {}),
        interactionId,
        params.requesterParticipantId,
      ]
    )
    if (!contextUpsert.rows[0]?.remote_agent_id) {
      throw new Error("Remote agent requester participant is invalid")
    }

    interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created remote agent plan interaction")
    }
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)
    return interaction
  })
}

export async function createRuntimeAuthorizationInteractionRequest(
  params: CreateRuntimeAuthorizationInteractionParams
) {
  return withDbTransaction(async (client) => {
    // Task unification: the caller (runtime-authorizations/requests.ts) minted
    // the tool_call_tasks parent AND wrote the runtime_authorization CTI detail
    // row in ONE transaction (createToolCallTaskDeduped's onCreatedInTx
    // callback) so the deferred consistency trigger passes at that commit. Here
    // we only attach the human-facing participant fields and the feed item —
    // neither is CTI-gated, so a separate tx is fine.
    if (!params.taskId) {
      throw new Error(
        "createRuntimeAuthorizationInteractionRequest requires a taskId (the task IS the interaction)"
      )
    }
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      requestKey: "",
      expiresAt: params.expiresAt,
    })
    if (interactionId === null) {
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

    let interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task: interaction },
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      queryable: client,
    })

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )

    interaction = await getTaskSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created interaction request")
    }
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)

    // G5: enqueue durable projection so the interaction can be rendered
    // onto any supporting IM transport (v1: QQ only). The worker
    // consumes this asynchronously; the dashboard / API caller doesn't
    // wait on transport delivery.
    await upsertInteractionTransportProjection(client, {
      interactionRequestId: interactionId,
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
    })

    return interaction
  })
}

export async function findOpenRuntimeAuthorizationInteraction(
  params: FindOpenRuntimeAuthorizationInteractionParams
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
    .selectFrom("tool_call_tasks as ir")
    .innerJoin(
      "tool_call_task_runtime_authorization as auth",
      "auth.task_id",
      "ir.id"
    )
    .select("ir.id")
    .where("ir.workspace_id", "=", params.workspaceId)
    .where("ir.conversation_id", "=", params.conversationId)
    .where(
      sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`
    )
    .where("ir.executor_kind", "=", "runtime_authorization")
    .where("ir.lifecycle_status", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .where((eb) =>
      eb.or([
        eb("ir.expires_at", "is", null),
        eb("ir.expires_at", ">", new Date()),
      ])
    )
    .where("auth.device_id", "=", params.deviceId)
    .where("auth.device_capability_id", "=", params.deviceCapabilityId)
    .where("auth.device_exposure_id", "=", params.deviceExposureId)
    .where("auth.requested_tool_name", "=", params.requestedToolName)
    .where(
      sql<boolean>`auth.device_tool_stable_key = ${params.deviceToolStableKey}`
    )
    .where("auth.request_mode", "=", params.requestMode)
    .where("auth.dedupe_key", "=", dedupeKey)
    .orderBy("ir.updated_at", "desc")
    .limit(1)
    .executeTakeFirst()

  const interactionId = row?.id
  if (!interactionId) {
    return null
  }
  return getTaskSummary(interactionId)
}

export async function getTaskSummary(
  interactionId: string,
  queryable?: Executor
) {
  const row = await getInteractionRowById(interactionId, queryable)
  return row ? buildInteractionSummary(row) : null
}

export async function getTaskSummaryByTaskId(taskId: string) {
  // Task unification: the task IS the interaction (interaction id == task id).
  return getTaskSummary(taskId)
}

export async function cancelInteractionRequestByTaskId(
  taskId: string,
  note?: string
) {
  const interaction = await getTaskSummaryByTaskId(taskId)
  if (!interaction) {
    return null
  }
  return cancelInteractionRequest(interaction.id, note)
}

export async function cancelInteractionRequest(
  interactionId: string,
  note?: string
) {
  const existing = await getInteractionRowById(interactionId)
  if (!existing) {
    throw new Error("Interaction request not found")
  }

  if (
    taskFieldsToInteractionStatus(
      existing.status as unknown as ToolCallTaskLifecycleStatus,
      existing.outcome
    ) !== "pending"
  ) {
    const current = await getTaskSummary(interactionId)
    if (!current) {
      throw new Error("Failed to reload interaction request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const interaction = await withDbTransaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      lifecycle_status: "cancelled",
      revision: sql`revision + 1`,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })

    const payload = {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      cancelled: true,
    }

    await updateInteractionResolutionPayload(
      client,
      existing.kind,
      interactionId,
      payload
    )
    const nextInteraction = await getTaskSummary(interactionId, client)
    if (!nextInteraction) {
      throw new Error("Failed to reload cancelled interaction")
    }
    await syncInteractionEventPayload(nextInteraction, client)
    await appendInteractionUpdatedSyncEvent(client, nextInteraction)
    return nextInteraction
  })

  return interaction
}

export async function canUserViewInteraction(params: {
  interactionId: string
  userId: string
}) {
  const row = await db
    .selectFrom("tool_call_tasks as ir")
    .select("ir.id")
    .where("ir.id", "=", params.interactionId)
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
          eb("ir.executor_kind", "in", [
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
          eb(
            "ir.executor_kind",
            "=",
            INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION
          ),
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

export async function canUserResolveInteraction(params: {
  interaction: TaskSummary
  userId: string
}) {
  const { interaction, userId } = params
  if (interaction.status !== "pending") {
    return false
  }

  if (
    interaction.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    interaction.target?.participantId
  ) {
    const targetParticipantId = interaction.target?.participantId
    const viewerParticipant = await db
      .selectFrom("conversation_participants as cp")
      .innerJoin("access_subjects as subj", "subj.id", "cp.subject_id")
      .innerJoin("workspace_members as wm", "wm.id", "subj.workspace_member_id")
      .select("cp.id")
      .where("cp.id", "=", targetParticipantId)
      .where("cp.state", "=", "active")
      .where("wm.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst()

    return Boolean(viewerParticipant?.id)
  }

  if (
    interaction.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    interaction.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    interaction.requester.remoteAgentId
  ) {
    const viewerMembership = await db
      .selectFrom("conversation_participants as cp")
      .innerJoin("access_subjects as subj", "subj.id", "cp.subject_id")
      .innerJoin("workspace_members as wm", "wm.id", "subj.workspace_member_id")
      .innerJoin("conversations as c", "c.id", "cp.conversation_id")
      .select([
        "subj.workspace_member_id as workspace_member_id",
        "c.kind as conversation_kind",
      ])
      .where("cp.conversation_id", "=", interaction.conversationId)
      .where("cp.state", "=", "active")
      .where("wm.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst()

    if (!viewerMembership?.workspace_member_id) {
      return false
    }

    if (viewerMembership.conversation_kind === "direct") {
      return true
    }

    const grant = await runBuilder(
      db,
      db
        .selectFrom("remote_agent_group_interaction_grants")
        .select("workspace_member_id")
        .where("remote_agent_id", "=", interaction.requester.remoteAgentId)
        .where("workspace_member_id", "=", viewerMembership.workspace_member_id)
        .limit(1)
    )

    return Boolean(grant.rows[0]?.workspace_member_id)
  }

  const deviceId = interaction.runtimeAuthorization?.deviceId
  const deviceCapabilityId =
    interaction.runtimeAuthorization?.deviceCapabilityId
  if (!deviceId || !deviceCapabilityId) {
    return false
  }

  return authorizeAction(db, {
    subject: userSubject(userId),
    action: "device_capability.request_runtime_authorization",
    resourceId: deviceCapabilityId,
  })
}

export async function enrichInteractionForUser(
  interaction: TaskSummary,
  userId?: string
): Promise<TaskSummary> {
  if (!userId) {
    return {
      ...interaction,
      viewerCanResolve: interaction.viewerCanResolve ?? false,
    }
  }

  return {
    ...interaction,
    viewerCanResolve: await canUserResolveInteraction({
      interaction,
      userId,
    }),
  }
}

export async function enrichFeedItemInteractionsForUser(
  item: ConversationFeedItem,
  userId?: string
): Promise<ConversationFeedItem> {
  if (item.kind !== "event" || item.eventType !== "task_requested") {
    return item
  }

  const payload =
    item.payload as ConversationFeedEventPayloadMap["task_requested"]
  const interaction =
    payload.task && typeof payload.task === "object"
      ? (payload.task as TaskSummary)
      : null
  if (!interaction) {
    return item
  }

  return {
    ...item,
    payload: {
      ...payload,
      task: await enrichInteractionForUser(interaction, userId),
    },
  }
}

function buildSubmittedUserInputAnswers(
  params: ResolveInteractionRequestParams,
  questions: InteractionInputQuestionDefinition[]
): InteractionInputAnswer[] {
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
  questions: InteractionInputQuestionDefinition[],
  submittedAnswers: InteractionInputAnswer[]
) {
  const questionMap = new Map(
    questions.map((question) => [question.id, question])
  )
  const answerMap = new Map<string, InteractionInputAnswer>()

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

  const normalized: InteractionInputAnswer[] = []

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
          (option: InteractionInputOption) => option.id === selectedOptionId
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
                    (option: InteractionInputOption) =>
                      option.id === selectedOptionId
                  )?.label || selectedOptionId
              )
            : undefined,
        otherText,
      })
    }
  }

  return normalized
}

function normalizeInteractionCommandAnswers(
  answers?: InteractionInputAnswer[]
): InteractionInputAnswer[] | undefined {
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

function buildNormalizedInteractionCommandPayload(
  params: ResolveInteractionRequestParams
): Record<string, unknown> {
  return {
    answers: normalizeInteractionCommandAnswers(params.answers),
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

export async function resolveInteractionRequest(
  params: ResolveInteractionRequestParams
): Promise<ResolveInteractionRequestResult> {
  const normalizedCommandPayload =
    buildNormalizedInteractionCommandPayload(params)

  const result = await withDbTransaction(async (client) => {
    const locked = await getInteractionRowByIdForUpdate(
      params.interactionId,
      client
    )
    if (!locked) {
      throw new Error("Interaction request not found")
    }

    const existingCommand = await getInteractionCommandRow(
      params.interactionId,
      params.commandId,
      client
    )
    if (existingCommand) {
      const storedRequestPayload = requireJsonObject(
        existingCommand.request_payload,
        `Interaction command ${existingCommand.id} request_payload`
      )
      if (
        stableJsonStringify(storedRequestPayload) !==
        stableJsonStringify(normalizedCommandPayload)
      ) {
        throw new Error(
          `commandId ${params.commandId} was already used with a different interaction payload`
        )
      }

      const storedResponse = parseStoredInteractionResolveResponse(
        existingCommand.response_payload,
        `Interaction command ${existingCommand.id} response_payload`
      )
      return {
        outcome:
          storedResponse.outcome === "applied"
            ? ("duplicate" as const)
            : storedResponse.outcome,
        interaction: storedResponse.interaction,
        createdGrant: undefined,
      }
    }

    if (
      locked.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
      locked.target_participant_id &&
      locked.target_participant_id !== params.resolverParticipantId
    ) {
      throw new Error("Only the targeted user can resolve this interaction")
    }

    if (
      locked.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
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
            .selectFrom("remote_agent_group_interaction_grants")
            .select("workspace_member_id")
            .where("remote_agent_id", "=", locked.requester_remote_agent_id)
            .where("workspace_member_id", "=", params.resolverWorkspaceMemberId)
            .limit(1)
        )
        if (!grantRow.rows[0]?.workspace_member_id) {
          throw new Error(
            "You are not allowed to resolve this remote agent interaction"
          )
        }
      }
    }

    if (locked.kind === INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
      const deviceId = locked.device_id || ""
      if (!deviceId) {
        throw new Error(`Interaction ${locked.id} is missing device_id`)
      }
      const deviceCapabilityId = locked.device_capability_id || ""
      if (!deviceCapabilityId) {
        throw new Error(
          `Interaction ${locked.id} is missing device_capability_id`
        )
      }
      const canResolveRuntimeAuthorization = await authorizeAction(db, {
        subject: workspaceMemberSubject(params.resolverWorkspaceMemberId),
        action: "device_capability.request_runtime_authorization",
        resourceId: deviceCapabilityId,
      })
      if (!canResolveRuntimeAuthorization) {
        throw new Error(
          "You are not allowed to resolve this runtime authorization interaction"
        )
      }
    }

    const lockedRevision = toRevisionNumber(
      locked.revision,
      `Interaction ${locked.id} revision`
    )
    if (
      taskFieldsToInteractionStatus(
        locked.status as unknown as ToolCallTaskLifecycleStatus,
        locked.outcome
      ) !== "pending" ||
      lockedRevision !== params.baseRevision
    ) {
      const currentInteraction = buildInteractionSummary(locked)
      const responsePayload: StoredInteractionResolveResponse = {
        outcome: "conflict",
        interaction: currentInteraction,
      }
      await insertInteractionCommandRow(client, {
        interactionId: params.interactionId,
        commandId: params.commandId,
        baseRevision: params.baseRevision,
        outcome: "conflict",
        requestPayload: normalizedCommandPayload,
        responsePayload,
        createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
      })
      return {
        outcome: "conflict" as const,
        interaction: currentInteraction,
        createdGrant: undefined,
      }
    }

    let nextStatus: InteractionRequestStatus
    let resolutionPayload: Record<string, unknown>
    let createdGrant: RuntimeAuthorizationGrantRecord | undefined
    let lockedPrincipalSubjectForReturn: SubjectRef | undefined

    if (locked.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
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
    } else if (locked.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
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
          .updateTable("remote_agent_conversation_contexts")
          .set({
            collaboration_mode:
              nextStatus === "approved" ? "default" : "plan_drafting",
            collaboration_state: jsonbValue({}),
            active_plan_approval_interaction_id: null,
            updated_at: sql`NOW()`,
          })
          .where("remote_agent_id", "=", locked.requester_remote_agent_id)
          .where("conversation_id", "=", locked.conversation_id)
          .execute()
      } else {
        // Task unification: locked IS the task row, so session_id is on it.
        if (!locked.session_id) {
          throw new Error(`Interaction ${locked.id} is missing task governance`)
        }
        const taskRow = { session_id: locked.session_id }
        const sessionRow = await takeFirstOn(
          client,
          db
            .selectFrom("sessions as s")
            .innerJoin("conversations as c", "c.id", "s.conversation_id")
            .select([
              "s.collaboration_state",
              "s.collaboration_mode",
              "s.active_plan_approval_interaction_id",
              "c.kind as conversation_kind",
            ])
            .where("s.id", "=", taskRow.session_id)
            .limit(1)
        )
        if (!sessionRow) {
          throw new Error(`Session ${taskRow.session_id} not found`)
        }
        if (isGroupConversationKind(sessionRow.conversation_kind)) {
          throw new Error(
            "Plan mode is only available in direct conversations."
          )
        }
        if (
          !isPlanAwaitingApprovalCollaborationMode(
            sessionRow.collaboration_mode
          )
        ) {
          throw new Error(
            `Session ${taskRow.session_id} must be in plan_awaiting_approval before resolving plan approval.`
          )
        }
        if (!sessionRow.active_plan_approval_interaction_id) {
          throw new Error(
            `Session ${taskRow.session_id} is missing active_plan_approval_interaction_id`
          )
        }
        if (sessionRow.active_plan_approval_interaction_id !== locked.id) {
          throw new Error(
            `Session ${taskRow.session_id} points to ${sessionRow.active_plan_approval_interaction_id}, not ${locked.id}`
          )
        }

        const collaborationState = parseSessionCollaborationState(
          sessionRow.collaboration_state == null
            ? {}
            : requireJsonObject(
                sessionRow.collaboration_state,
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
            activePlanApprovalInteractionId: null,
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
          `Interaction ${locked.id} grant_options`
        )
        const availablePresets = parseJsonArray<RuntimeAuthorizationPreset>(
          locked.available_presets,
          `Interaction ${locked.id} available_presets`
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
            `interaction ${locked.id}: principal subject ${locked.principal_subject_id} not found`
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
            `ScopeRebuildMismatchError: interaction ${locked.id} locked principal_scope_subject_id=${lockedScopeId ?? "NULL"} but rebuilt activeConversationSubjectId=${rebuiltScopeId ?? "NULL"} — principal scope drifted between request and approval`
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
    // reloaded summary, the interaction.updated broadcast, the HTTP response,
    // and the command-idempotency row all see the resolved state. Delivery
    // (notice + wakeup/push) and runtime-auth auto-retry happen post-commit
    // (auto-retry writes only final_result_payload, which is NOT terminal-
    // guarded, so it lands on the already-terminal row).
    const taskFields = interactionStatusToTaskFields(nextStatus, locked.kind)
    await updateInteractionRequestRow(client, params.interactionId, {
      lifecycle_status: taskFields.lifecycle_status,
      outcome: taskFields.outcome,
      revision: sql`revision + 1`,
      resolved_by_participant_id: params.resolverParticipantId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })

    await updateInteractionResolutionPayload(
      client,
      locked.kind,
      params.interactionId,
      resolutionPayload
    )

    const nextInteraction = await getTaskSummary(params.interactionId, client)
    if (!nextInteraction) {
      throw new Error("Failed to reload resolved interaction")
    }

    await syncInteractionEventPayload(nextInteraction, client)
    await appendInteractionUpdatedSyncEvent(client, nextInteraction)

    await insertInteractionCommandRow(client, {
      interactionId: params.interactionId,
      commandId: params.commandId,
      baseRevision: params.baseRevision,
      outcome: "applied",
      requestPayload: normalizedCommandPayload,
      responsePayload: {
        outcome: "applied",
        interaction: nextInteraction,
      },
      createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })

    return {
      outcome: "applied" as const,
      interaction: nextInteraction,
      createdGrant,
      // Surface the original args + retry_nonce to the outer scope so the
      // post-commit auto-retry path (autoDispatchRuntimeAuthorizationRetry)
      // can re-issue the original tool call without the model having to
      // notice the approval. Drops to undefined for non-RuntimeAuth
      // interactions (these fields are only populated when locked.kind is
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
      // Task unification: the decision (interaction vocabulary) computed in-tx,
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
    if (result.interaction?.taskId) {
      await recoverUndeliveredResolvedTask(result.interaction.taskId).catch(
        () => undefined
      )
    }
    return {
      outcome: result.outcome,
      interaction: result.interaction,
    }
  }

  const interaction = result.interaction

  // Task unification: the lifecycle/outcome were flipped IN-TX (so result.
  // interaction already reads resolved). Here we only DELIVER (notice + wakeup
  // for session_wakeup; machine-WS push for remote_agent_channel) — no second
  // flip. Every interaction IS a task now, including remote-agent ones, so
  // there is no task=null / early-return special-case. P1: a human "no" (plan
  // revision / authz deny) is completed+outcome 'revision_requested'/'denied',
  // never a machinery failure.
  if (!interaction.taskId) {
    throw new Error(`Interaction ${interaction.id} is missing task governance`)
  }

  if (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    await deliverResolvedToolCallTask(interaction.taskId, "completed", {
      ...buildUserInputAsyncNotice(interaction),
      outcome: "answered",
    })
  } else if (interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    if (result.nextStatus === "approved") {
      await deliverResolvedToolCallTask(interaction.taskId, "completed", {
        ...buildPlanApprovalApprovedNotice(interaction),
        outcome: "approved",
      })
    } else {
      await deliverResolvedToolCallTask(interaction.taskId, "completed", {
        ...buildPlanApprovalRevisionNotice(interaction),
        outcome: "revision_requested",
      })
    }
  } else if (result.nextStatus === "rejected") {
    await deliverResolvedToolCallTask(interaction.taskId, "completed", {
      ...buildRuntimeAuthorizationRejectedNotice(interaction),
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
      interaction,
      sourceRequestArgs: result.lockedSourceRequestArgs,
      sourceRetryNonce: result.lockedSourceRetryNonce,
      sourceTaskId: result.lockedSourceTaskId,
      createdGrant: result.createdGrant,
      lockedPrincipalSubject: result.lockedPrincipalSubject,
      lockedPrincipalScopeSubjectId: result.lockedPrincipalScopeSubjectId,
      resolverWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })
    await deliverResolvedToolCallTask(interaction.taskId, "completed", {
      ...(approvedRetry ??
        buildRuntimeAuthorizationApprovedNotice(interaction)),
      outcome: "granted",
    })
  }

  return {
    outcome: result.outcome,
    interaction,
    createdGrant: result.createdGrant,
    createdGrants: result.createdGrant ? [result.createdGrant] : undefined,
  }
}

export async function markRuntimeAuthorizationInteractionSuperseded(
  interactionId: string,
  note?: string
) {
  const existing = await getInteractionRowById(interactionId)
  if (!existing) {
    throw new Error("Interaction request not found")
  }
  if (
    existing.kind !== INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    taskFieldsToInteractionStatus(
      existing.status as unknown as ToolCallTaskLifecycleStatus,
      existing.outcome
    ) !== "pending"
  ) {
    const current = await getTaskSummary(interactionId)
    if (!current) {
      throw new Error("Failed to reload interaction request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const interaction = await withDbTransaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      lifecycle_status: "cancelled",
      revision: sql`revision + 1`,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    await updateInteractionResolutionPayload(
      client,
      INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      interactionId,
      {
        ...resolutionPayload,
        note: note?.trim() || resolutionPayload.note,
        superseded: true,
      }
    )
    const nextInteraction = await getTaskSummary(interactionId, client)
    if (!nextInteraction) {
      throw new Error("Failed to reload superseded interaction")
    }
    await syncInteractionEventPayload(nextInteraction, client)
    await appendInteractionUpdatedSyncEvent(client, nextInteraction)
    return nextInteraction
  })
  if (interaction.taskId) {
    // Lifecycle already flipped to cancelled in-tx; deliver the supersede notice.
    await deliverResolvedToolCallTask(interaction.taskId, "cancelled", {
      ...buildRuntimeAuthorizationSupersededNotice(interaction),
    })
  }
  return interaction
}
