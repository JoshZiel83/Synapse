import {
  CONVERSATION_PARTICIPANT_TYPE,
  INTERACTION_INPUT_QUESTION_TYPES,
  INTERACTION_REQUEST_KIND,
  textBlocks,
} from "@synapse/shared"
import {
  isGroupConversationKind,
  isPlanAwaitingApprovalCollaborationMode,
} from "@synapse/shared/utils"
import { v4 as uuidv4 } from "uuid"
import type {
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
  InteractionRequestSummary,
  PlanApprovalDecision,
  PlanChecklistStep,
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationInteractionSummary,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
  SessionCollaborationState,
} from "@synapse/shared/types"
import { type Queryable } from "../../infrastructure/events/index.js"
import { transaction } from "../../infrastructure/database/index.js"
import {
  db,
  executeCompiledQuery,
  executeCompiledSql,
  executeSql,
  executeSqlOn,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import {
  completeToolCallTask,
  failToolCallTask,
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
import { sql } from "kysely"
import {
  createRuntimeAuthorizationGrant,
  type RuntimeAuthorizationGrantRecord,
} from "../runtime-authorizations/service.js"
import {
  buildSessionPlanDraftState,
  parseSessionCollaborationState,
} from "../session/collaboration-state.js"

type RawInteractionRow = {
  id: string
  workspace_id: string
  conversation_id: string
  task_id: string | null
  remote_agent_run_id: string | null
  conversation_item_id: string | null
  kind: InteractionRequestKind
  status: InteractionRequestStatus
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
  taskId: string
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
}

export type ResolveInteractionRequestParams = ChatInteractionResolveInput & {
  interactionId: string
  resolverWorkspaceMemberId: string
  resolverParticipantId: string
}

export interface ResolveInteractionRequestResult {
  outcome: ChatInteractionResolveOutcome
  interaction: InteractionRequestSummary
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
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {}
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

function buildRuntimeAuthorizationDedupeKey(params: {
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  requestMode: RuntimeAuthorizationRequestMode
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
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

function buildRuntimeAuthorizationInteractionRequestKey(params: {
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
  userInput: InteractionRequestSummary["userInput"]
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

function buildInteractionSummary(
  row: RawInteractionRow
): InteractionRequestSummary {
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
    taskId: row.task_id || undefined,
    remoteAgentRunId: row.remote_agent_run_id || undefined,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.conversation_item_id || undefined,
    status: row.status,
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
  }

  return {
    ...baseInteraction,
    kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    runtimeAuthorization,
  }
}

async function getInteractionRowById(
  interactionId: string,
  queryable?: Queryable
) {
  const compiled = sql<RawInteractionRow>`
    SELECT ir.*,
            user_input.prompt_payload AS prompt_payload,
            plan.plan_payload AS plan_payload,
            auth.requested_tool_name AS requested_tool_name,
            auth.reason AS reason,
            auth.request_mode AS request_mode,
            auth.requested_action AS requested_action,
            auth.grant_options AS grant_options,
            auth.available_presets AS available_presets,
            auth.source_request_args AS source_request_args,
            auth.source_runtime_session_id AS source_runtime_session_id,
            auth.source_retry_nonce AS source_retry_nonce,
            COALESCE(
              user_input.resolution_payload,
              plan.resolution_payload,
              auth.resolution_payload,
              '{}'::jsonb
            ) AS resolution_payload,
            auth.device_id,
            auth.device_capability_id,
            auth.device_exposure_id,
            auth.device_tool_stable_key,
            requester_subj.workspace_member_id AS requester_workspace_member_id,
            requester_subj.actor_id AS requester_actor_id,
            requester_subj.remote_agent_id AS requester_remote_agent_id,
            requester.participant_type AS requester_participant_type,
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
            target.participant_type AS target_participant_type,
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
            resolver.participant_type AS resolved_by_participant_type,
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
     FROM interaction_requests ir
     LEFT JOIN interaction_user_input_requests user_input
       ON user_input.interaction_id = ir.id
     LEFT JOIN interaction_plan_approval_requests plan
       ON plan.interaction_id = ir.id
     LEFT JOIN interaction_runtime_authorization_requests auth
       ON auth.interaction_id = ir.id
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
  const result = queryable
    ? await executeCompiledSql<RawInteractionRow>(queryable, compiled)
    : await db.executeQuery(compiled)
  return result.rows[0] || null
}

type StoredInteractionResolveResponse = {
  outcome: ChatInteractionResolveOutcome
  interaction: InteractionRequestSummary
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
    interaction: payload.interaction as InteractionRequestSummary,
  }
}

async function getInteractionCommandRow(
  interactionId: string,
  commandId: string,
  queryable?: Queryable
) {
  const compiled = db
    .selectFrom("interaction_response_commands")
    .selectAll()
    .where("interaction_id", "=", interactionId)
    .where("command_id", "=", commandId)
    .limit(1)
    .compile()
  const result = queryable
    ? await executeCompiledSql<RawInteractionCommandRow>(queryable, compiled)
    : await db.executeQuery(compiled)
  return result.rows[0] || null
}

async function getInteractionRowByIdForUpdate(
  interactionId: string,
  queryable: Queryable
) {
  const compiled = sql<RawInteractionRow>`
    SELECT ir.*,
            user_input.prompt_payload AS prompt_payload,
            plan.plan_payload AS plan_payload,
            auth.requested_tool_name AS requested_tool_name,
            auth.reason AS reason,
            auth.request_mode AS request_mode,
            auth.requested_action AS requested_action,
            auth.grant_options AS grant_options,
            auth.available_presets AS available_presets,
            auth.source_request_args AS source_request_args,
            auth.source_runtime_session_id AS source_runtime_session_id,
            auth.source_retry_nonce AS source_retry_nonce,
            COALESCE(
              user_input.resolution_payload,
              plan.resolution_payload,
              auth.resolution_payload,
              '{}'::jsonb
            ) AS resolution_payload,
            auth.device_id,
            auth.device_capability_id,
            auth.device_exposure_id,
            auth.device_tool_stable_key,
            requester_subj.workspace_member_id AS requester_workspace_member_id,
            requester_subj.actor_id AS requester_actor_id,
            requester_subj.remote_agent_id AS requester_remote_agent_id,
            requester.participant_type AS requester_participant_type,
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
            target.participant_type AS target_participant_type,
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
            resolver.participant_type AS resolved_by_participant_type,
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
     FROM interaction_requests ir
     LEFT JOIN interaction_user_input_requests user_input
       ON user_input.interaction_id = ir.id
     LEFT JOIN interaction_plan_approval_requests plan
       ON plan.interaction_id = ir.id
     LEFT JOIN interaction_runtime_authorization_requests auth
       ON auth.interaction_id = ir.id
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
  const result = await executeCompiledSql<RawInteractionRow>(
    queryable,
    compiled
  )
  return result.rows[0] || null
}

async function insertInteractionCommandRow(
  client: Queryable,
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
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_response_commands").values({
      interaction_id: params.interactionId,
      command_id: params.commandId,
      base_revision:
        params.baseRevision as unknown as TableInsert<"interaction_response_commands">["base_revision"],
      outcome: params.outcome,
      request_payload: jsonbValue(
        params.requestPayload
      ) as unknown as TableInsert<"interaction_response_commands">["request_payload"],
      response_payload: jsonbValue(
        params.responsePayload
      ) as unknown as TableInsert<"interaction_response_commands">["response_payload"],
      created_by_workspace_member_id: params.createdByWorkspaceMemberId,
    })
  )
}

async function appendInteractionUpdatedSyncEvent(
  queryable: Queryable,
  interaction: InteractionRequestSummary
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
      eventType: "interaction.updated",
      payload: {
        conversationId: interaction.conversationId,
        interactionId: interaction.id,
        itemId: interaction.itemId,
        interaction,
      },
    })
  }
}

async function syncInteractionEventPayload(
  interaction: InteractionRequestSummary,
  queryable?: Queryable
) {
  if (!interaction.itemId) return
  await updateConversationItemEventPayload(
    interaction.itemId,
    { interaction },
    queryable
  )
}

function buildUserInputAsyncNotice(interaction: InteractionRequestSummary) {
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

function buildPlanApprovalApprovedNotice(
  interaction: InteractionRequestSummary
) {
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

function buildPlanApprovalRevisionNotice(
  interaction: InteractionRequestSummary
) {
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

function buildRuntimeAuthorizationRejectedNotice(
  interaction: InteractionRequestSummary
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user"
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "relay device"
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

function buildRuntimeAuthorizationApprovedNotice(
  interaction: InteractionRequestSummary
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user"
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "relay device"
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

function buildRuntimeAuthorizationSupersededNotice(
  interaction: InteractionRequestSummary
) {
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
  client: Queryable,
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
) {
  const interactionId = uuidv4()
  const created = await executeCompiledSql<{ id: string }>(
    client,
    sql<{ id: string }>`
      INSERT INTO interaction_requests (
        id,
        workspace_id,
        conversation_id,
        task_id,
        remote_agent_run_id,
        requester_participant_id,
        kind,
        status,
        request_key,
        target_participant_id,
        expires_at
      )
      VALUES (
        ${interactionId},
        ${params.workspaceId},
        ${params.conversationId},
        ${params.taskId || null},
        ${params.remoteAgentRunId || null},
        ${params.requesterParticipantId},
        ${params.kind},
        'pending',
        ${params.requestKey},
        ${params.targetParticipantId || null},
        ${params.expiresAt || null}
      )
      RETURNING id
    `.compile(db)
  )
  if (!created.rows[0]?.id) {
    throw new Error("Failed to create interaction request")
  }
  return created.rows[0]!.id
}

async function findInteractionIdByTaskId(
  taskId: string,
  queryable?: Queryable
) {
  const compiled = db
    .selectFrom("interaction_requests")
    .select("id")
    .where("task_id", "=", taskId)
    .limit(1)
    .compile()
  const result = queryable
    ? await executeCompiledSql<{ id: string }>(queryable, compiled)
    : await db.executeQuery(compiled)
  return result.rows[0]?.id || null
}

async function findPendingInteractionIdByRequestKey(
  workspaceId: string,
  requestKey: string,
  queryable?: Queryable
) {
  const compiled = db
    .selectFrom("interaction_requests")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("request_key", "=", requestKey)
    .where("status", "=", "pending")
    .limit(1)
    .compile()
  const result = queryable
    ? await executeCompiledSql<{ id: string }>(queryable, compiled)
    : await db.executeQuery(compiled)
  return result.rows[0]?.id || null
}

async function insertUserInputInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string
    promptPayload: Record<string, unknown>
  }
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_user_input_requests").values({
      interaction_id: params.interactionId,
      prompt_payload: jsonbValue(
        params.promptPayload
      ) as unknown as TableInsert<"interaction_user_input_requests">["prompt_payload"],
      resolution_payload: jsonbValue(
        {}
      ) as unknown as TableInsert<"interaction_user_input_requests">["resolution_payload"],
    })
  )
}

async function insertPlanApprovalInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string
    planPayload: Record<string, unknown>
  }
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_plan_approval_requests").values({
      interaction_id: params.interactionId,
      plan_payload: jsonbValue(
        params.planPayload
      ) as unknown as TableInsert<"interaction_plan_approval_requests">["plan_payload"],
      resolution_payload: jsonbValue(
        {}
      ) as unknown as TableInsert<"interaction_plan_approval_requests">["resolution_payload"],
    })
  )
}

async function insertRuntimeAuthorizationInteractionDetails(
  client: Queryable,
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
  }
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_runtime_authorization_requests").values({
      interaction_id: params.interactionId,
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
      ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["source_request_args"],
      requested_action: jsonbValue(
        params.requestedAction
      ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["requested_action"],
      grant_options: jsonbValue(
        params.grantOptions
      ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["grant_options"],
      available_presets: jsonbValue(
        params.availablePresets
      ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["available_presets"],
      resolution_payload: jsonbValue(
        {}
      ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["resolution_payload"],
      dedupe_key: params.dedupeKey,
    })
  )
}

async function updateInteractionConversationItemId(
  client: Queryable,
  interactionId: string,
  conversationItemId: string
) {
  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
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

async function updateInteractionRequestRow(
  client: Queryable,
  interactionId: string,
  values: Record<string, unknown>
) {
  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
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
  client: Queryable,
  interactionKind: InteractionRequestKind,
  interactionId: string,
  payload: Record<string, unknown>
) {
  if (interactionKind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    const result = await executeCompiledQuery(
      client,
      db
        .updateTable("interaction_user_input_requests")
        .set({
          resolution_payload: jsonbValue(
            payload
          ) as unknown as TableInsert<"interaction_user_input_requests">["resolution_payload"],
        })
        .where("interaction_id", "=", interactionId)
    )
    if (result.rowCount !== 1) {
      throw new Error(
        `Expected user_input details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`
      )
    }
    return
  }

  if (interactionKind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    const result = await executeCompiledQuery(
      client,
      db
        .updateTable("interaction_plan_approval_requests")
        .set({
          resolution_payload: jsonbValue(
            payload
          ) as unknown as TableInsert<"interaction_plan_approval_requests">["resolution_payload"],
        })
        .where("interaction_id", "=", interactionId)
    )
    if (result.rowCount !== 1) {
      throw new Error(
        `Expected plan_approval details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`
      )
    }
    return
  }

  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_runtime_authorization_requests")
      .set({
        resolution_payload: jsonbValue(
          payload
        ) as unknown as TableInsert<"interaction_runtime_authorization_requests">["resolution_payload"],
      })
      .where("interaction_id", "=", interactionId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected runtime_authorization details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

export async function createUserInputInteractionRequest(
  params: CreateUserInputInteractionParams
) {
  return transaction(async (client) => {
    const requestKey = buildTaskInteractionRequestKey(params.taskId)
    const existingInteractionId =
      (await findInteractionIdByTaskId(params.taskId, client)) ||
      (await findPendingInteractionIdByRequestKey(
        params.workspaceId,
        requestKey,
        client
      ))
    if (existingInteractionId) {
      const existing = await getInteractionRequestSummary(
        existingInteractionId,
        client
      )
      if (existing) {
        return existing
      }
    }

    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      requestKey,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })

    await insertUserInputInteractionDetails(client, {
      interactionId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
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

    interaction = await getInteractionRequestSummary(interactionId, client)
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
  return transaction(async (client) => {
    const requestKey = buildRemoteAgentInteractionRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
    })
    const existingInteractionId = await findPendingInteractionIdByRequestKey(
      params.workspaceId,
      requestKey,
      client
    )
    if (existingInteractionId) {
      const existing = await getInteractionRequestSummary(
        existingInteractionId,
        client
      )
      if (existing) {
        return existing
      }
    }

    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      remoteAgentRunId: params.remoteAgentRunId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      requestKey,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })

    await insertUserInputInteractionDetails(client, {
      interactionId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created remote agent input interaction")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
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

    interaction = await getInteractionRequestSummary(interactionId, client)
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
  return transaction(async (client) => {
    const requestKey = buildTaskInteractionRequestKey(params.taskId)
    const existingInteractionId =
      (await findInteractionIdByTaskId(params.taskId, client)) ||
      (await findPendingInteractionIdByRequestKey(
        params.workspaceId,
        requestKey,
        client
      ))
    if (existingInteractionId) {
      const existing = await getInteractionRequestSummary(
        existingInteractionId,
        client
      )
      if (existing) {
        return existing
      }
    }

    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      requestKey,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })

    await insertPlanApprovalInteractionDetails(client, {
      interactionId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
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

    interaction = await getInteractionRequestSummary(interactionId, client)
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
  return transaction(async (client) => {
    const requestKey = buildRemoteAgentInteractionRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
    })
    const existingInteractionId = await findPendingInteractionIdByRequestKey(
      params.workspaceId,
      requestKey,
      client
    )
    if (existingInteractionId) {
      const existing = await getInteractionRequestSummary(
        existingInteractionId,
        client
      )
      if (existing) {
        return existing
      }
    }

    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      remoteAgentRunId: params.remoteAgentRunId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      requestKey,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })

    await insertPlanApprovalInteractionDetails(client, {
      interactionId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created remote agent plan interaction")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
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
    const contextUpsert = await executeSqlOn<{ remote_agent_id: string }>(
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

    interaction = await getInteractionRequestSummary(interactionId, client)
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
  return transaction(async (client) => {
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
    })
    const requestKey = buildRuntimeAuthorizationInteractionRequestKey({
      conversationId: params.conversationId,
      requesterParticipantId: params.requesterParticipantId,
      dedupeKey,
    })
    const existingInteractionId =
      (await findInteractionIdByTaskId(params.taskId, client)) ||
      (await findPendingInteractionIdByRequestKey(
        params.workspaceId,
        requestKey,
        client
      ))
    if (existingInteractionId) {
      const existing = await getInteractionRequestSummary(
        existingInteractionId,
        client
      )
      if (existing) {
        return existing
      }
    }

    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      requestKey,
      expiresAt: params.expiresAt,
    })

    await insertRuntimeAuthorizationInteractionDetails(client, {
      interactionId,
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
      requestedAction: params.requestedAction,
      grantOptions: params.grantOptions,
      availablePresets: params.availablePresets,
      dedupeKey,
    })

    let interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to load created interaction request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      queryable: client,
    })

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id
    )

    interaction = await getInteractionRequestSummary(interactionId, client)
    if (!interaction) {
      throw new Error("Failed to reload created interaction request")
    }
    await syncInteractionEventPayload(interaction, client)
    await appendInteractionUpdatedSyncEvent(client, interaction)
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
  })
  const row = await db
    .selectFrom("interaction_requests as ir")
    .innerJoin(
      "interaction_runtime_authorization_requests as auth",
      "auth.interaction_id",
      "ir.id"
    )
    .select("ir.id")
    .where("ir.workspace_id", "=", params.workspaceId)
    .where("ir.conversation_id", "=", params.conversationId)
    .where(
      sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`
    )
    .where("ir.kind", "=", INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION)
    .where("ir.status", "=", "pending")
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
  return getInteractionRequestSummary(interactionId)
}

export async function getInteractionRequestSummary(
  interactionId: string,
  queryable?: Queryable
) {
  const row = await getInteractionRowById(interactionId, queryable)
  return row ? buildInteractionSummary(row) : null
}

export async function getInteractionRequestSummaryByTaskId(taskId: string) {
  const row = await db
    .selectFrom("interaction_requests")
    .select("id")
    .where("task_id", "=", taskId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()

  const interactionId = row?.id
  if (!interactionId) {
    return null
  }
  return getInteractionRequestSummary(interactionId)
}

export async function cancelInteractionRequestByTaskId(
  taskId: string,
  note?: string
) {
  const interaction = await getInteractionRequestSummaryByTaskId(taskId)
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

  if (existing.status !== "pending") {
    const current = await getInteractionRequestSummary(interactionId)
    if (!current) {
      throw new Error("Failed to reload interaction request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const interaction = await transaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      status: "cancelled",
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
    const nextInteraction = await getInteractionRequestSummary(
      interactionId,
      client
    )
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
    .selectFrom("interaction_requests as ir")
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
          eb("ir.kind", "in", [
            INTERACTION_REQUEST_KIND.USER_INPUT,
            INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
          ]),
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
          eb("ir.kind", "=", INTERACTION_REQUEST_KIND.RUNTIME_AUTHORIZATION),
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
  interaction: InteractionRequestSummary
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

    if (viewerMembership.conversation_kind === "private") {
      return true
    }

    const grant = await executeSql<{ workspace_member_id: string }>(
      `
        SELECT workspace_member_id
        FROM remote_agent_group_interaction_grants
        WHERE remote_agent_id = $1
          AND workspace_member_id = $2
        LIMIT 1
      `,
      [
        interaction.requester.remoteAgentId,
        viewerMembership.workspace_member_id,
      ]
    )

    return Boolean(grant.rows[0]?.workspace_member_id)
  }

  const deviceId = interaction.runtimeAuthorization?.deviceId
  const deviceCapabilityId = interaction.runtimeAuthorization?.deviceCapabilityId
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
  interaction: InteractionRequestSummary,
  userId?: string
): Promise<InteractionRequestSummary> {
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
  if (item.kind !== "event" || item.eventType !== "interaction_requested") {
    return item
  }

  const payload =
    item.payload as ConversationFeedEventPayloadMap["interaction_requested"]
  const interaction =
    payload.interaction && typeof payload.interaction === "object"
      ? (payload.interaction as InteractionRequestSummary)
      : null
  if (!interaction) {
    return item
  }

  return {
    ...item,
    payload: {
      ...payload,
      interaction: await enrichInteractionForUser(interaction, userId),
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

  const result = await transaction(async (client) => {
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
      const conversationRow = await executeTakeFirst(
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
      if (conversationRow.kind !== "private") {
        const grantRow = await executeSqlOn<{ workspace_member_id: string }>(
          client,
          `
            SELECT workspace_member_id
            FROM remote_agent_group_interaction_grants
            WHERE remote_agent_id = $1
              AND workspace_member_id = $2
            LIMIT 1
          `,
          [locked.requester_remote_agent_id, params.resolverWorkspaceMemberId]
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
    if (locked.status !== "pending" || lockedRevision !== params.baseRevision) {
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
        await executeSqlOn(
          client,
          `
            UPDATE remote_agent_conversation_contexts
            SET collaboration_mode = $3,
                collaboration_state = $4::jsonb,
                active_plan_approval_interaction_id = NULL,
                updated_at = NOW()
            WHERE remote_agent_id = $1
              AND conversation_id = $2
          `,
          [
            locked.requester_remote_agent_id,
            locked.conversation_id,
            nextStatus === "approved" ? "default" : "plan_drafting",
            JSON.stringify({}),
          ]
        )
      } else {
        if (!locked.task_id) {
          throw new Error(`Interaction ${locked.id} is missing task governance`)
        }
        const taskRow = await executeTakeFirst(
          client,
          db
            .selectFrom("tool_call_tasks")
            .select("session_id")
            .where("id", "=", locked.task_id)
            .limit(1)
        )
        if (!taskRow?.session_id) {
          throw new Error(
            `Plan approval interaction ${locked.id} is missing a session`
          )
        }
        const sessionRow = await executeTakeFirst(
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
            "Plan mode is only available in private conversations."
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
        throw new Error("preset is required when approving relay authorization")
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
            "selectedGrantOptionId is required when approving relay authorization"
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
            `preset ${params.preset || "once"} is not allowed for this relay authorization request`
          )
        }
        const selectedOption = grantOptions.find(
          (candidate) => candidate.id === selectedGrantOptionId
        )
        if (!selectedOption) {
          throw new Error(
            `Unknown relay authorization option "${selectedGrantOptionId}"`
          )
        }

        createdGrant = await createRuntimeAuthorizationGrant(
          {
            workspaceId: locked.workspace_id,
            deviceId: locked.device_id || "",
            deviceCapabilityId: locked.device_capability_id || "",
            deviceExposureId: locked.device_exposure_id || "",
            conversationId: locked.conversation_id,
            actorId: locked.requester_actor_id || undefined,
            createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
            sourceInteractionId: locked.id,
            sourceTaskId: locked.task_id || undefined,
            preset: params.preset || "once",
            sourceRetryNonce: locked.source_retry_nonce || undefined,
            sourceRuntimeSessionId:
              locked.source_runtime_session_id || undefined,
            sourceRequestArgs:
              locked.source_request_args &&
              typeof locked.source_request_args === "object"
                ? (locked.source_request_args as Record<string, unknown>)
                : {},
            grantSpec: selectedOption.grantSpec,
          },
          client
        )
        resolutionPayload = {
          ...resolutionPayload,
          approvedGrant: createdGrant,
        }
      }
    }

    await updateInteractionRequestRow(client, params.interactionId, {
      status: nextStatus,
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

    const nextInteraction = await getInteractionRequestSummary(
      params.interactionId,
      client
    )
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
    }
  })

  if (result.outcome !== "applied") {
    return {
      outcome: result.outcome,
      interaction: result.interaction,
    }
  }

  const interaction = result.interaction
  if (interaction.remoteAgentRunId) {
    const { notifyRemoteAgentInteractionResolved } =
      await import("../remote-agents/service.js")
    await notifyRemoteAgentInteractionResolved(interaction.id)
    return {
      outcome: result.outcome,
      interaction,
      createdGrant: result.createdGrant,
      createdGrants: result.createdGrant ? [result.createdGrant] : undefined,
    }
  }

  if (!interaction.taskId) {
    throw new Error(`Interaction ${interaction.id} is missing task governance`)
  }

  if (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    await completeToolCallTask(
      interaction.taskId,
      buildUserInputAsyncNotice(interaction)
    )
  } else if (interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    if (interaction.status === "approved") {
      await completeToolCallTask(
        interaction.taskId,
        buildPlanApprovalApprovedNotice(interaction)
      )
    } else {
      await failToolCallTask(
        interaction.taskId,
        buildPlanApprovalRevisionNotice(interaction)
      )
    }
  } else if (interaction.status === "rejected") {
    await failToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationRejectedNotice(interaction)
    )
  } else {
    await completeToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationApprovedNotice(interaction)
    )
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
    existing.status !== "pending"
  ) {
    const current = await getInteractionRequestSummary(interactionId)
    if (!current) {
      throw new Error("Failed to reload interaction request")
    }
    return current
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload)
  const interaction = await transaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      status: "superseded",
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
    const nextInteraction = await getInteractionRequestSummary(
      interactionId,
      client
    )
    if (!nextInteraction) {
      throw new Error("Failed to reload superseded interaction")
    }
    await syncInteractionEventPayload(nextInteraction, client)
    await appendInteractionUpdatedSyncEvent(client, nextInteraction)
    return nextInteraction
  })
  if (interaction.taskId) {
    await failToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationSupersededNotice(interaction)
    )
  }
  return interaction
}
