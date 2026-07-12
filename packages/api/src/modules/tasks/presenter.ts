import { TASK_INPUT_QUESTION_TYPES, TASK_REQUEST_KIND } from "@synapse/shared"
import type {
  ConversationEntityRef,
  PlanChecklistStep,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationTaskDetails,
  TaskInputAnswer,
  TaskInputOption,
  TaskInputQuestionDefinition,
  TaskInputQuestionSummary,
  TaskSummary,
} from "@synapse/shared/types"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import type { RawTaskRow } from "./repo.types.js"

export function toRevisionNumber(
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

export function requireTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
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

export function parseUserInputQuestionDefinitions(
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

export function parseUserInputAnswers(
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

function presentEntityRefFromRow(
  prefix: "requester" | "target" | "resolvedBy",
  row: RawTaskRow
): ConversationEntityRef | undefined {
  const participantType = row[`${prefix}ParticipantType` as keyof RawTaskRow]
  if (typeof participantType !== "string" || !participantType.trim()) {
    return undefined
  }
  const participantId = row[`${prefix}ParticipantId` as keyof RawTaskRow]
  let workspaceMemberId: RawTaskRow["requesterWorkspaceMemberId"]
  let actorId: RawTaskRow["requesterActorId"]
  let remoteAgentId: RawTaskRow["requesterRemoteAgentId"]
  switch (prefix) {
    case "requester":
      workspaceMemberId = row.requesterWorkspaceMemberId
      actorId = row.requesterActorId
      remoteAgentId = row.requesterRemoteAgentId
      break
    case "target":
      workspaceMemberId = row.targetWorkspaceMemberId
      actorId = row.targetActorId
      remoteAgentId = row.targetRemoteAgentId
      break
    case "resolvedBy":
      workspaceMemberId = row.resolvedByWorkspaceMemberId
      actorId = row.resolvedByActorId
      remoteAgentId = row.resolvedByRemoteAgentId
      break
  }
  const name = row[`${prefix}Name` as keyof RawTaskRow]
  const title = row[`${prefix}Title` as keyof RawTaskRow]
  const role = row[`${prefix}Role` as keyof RawTaskRow]
  const actorAvatarFileId =
    row[`${prefix}ActorAvatarFileId` as keyof RawTaskRow]
  const userAvatarFileId = row[`${prefix}UserAvatarFileId` as keyof RawTaskRow]
  const remoteAgentAvatarFileId =
    row[`${prefix}RemoteAgentAvatarFileId` as keyof RawTaskRow]
  const avatarEmoji = row[`${prefix}AvatarEmoji` as keyof RawTaskRow]

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

export function requireEntityRef(
  entity: ConversationEntityRef | undefined,
  label: string
): ConversationEntityRef {
  if (!entity?.participantId || !entity.participantType) {
    throw new Error(`${label} is missing a participant entity`)
  }
  return entity
}

export function presentTaskSummary(row: RawTaskRow): TaskSummary {
  const requester = requireEntityRef(
    presentEntityRefFromRow("requester", row),
    `Task ${row.id} requester`
  )
  const target = presentEntityRefFromRow("target", row)
  const resolvedBy = row.resolvedByParticipantId
    ? requireEntityRef(
        presentEntityRefFromRow("resolvedBy", row),
        `Task ${row.id} resolved_by`
      )
    : undefined
  const resolutionPayload = row.resolutionPayload

  const baseTask = {
    id: row.id,
    remoteAgentRunId: row.remoteAgentRunId || undefined,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    itemId: row.conversationItemId || undefined,
    lifecycleStatus: row.lifecycleStatus,
    outcome: row.outcome || undefined,
    revision: toRevisionNumber(row.revision, `Task ${row.id} revision`),
    requester,
    resolvedBy,
    resolutionNote:
      typeof resolutionPayload.note === "string"
        ? resolutionPayload.note.trim() || undefined
        : undefined,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
    resolvedAt: serializeOptionalInstant(row.resolvedAt),
    expiresAt: serializeOptionalInstant(row.expiresAt),
    viewerCanResolve: false,
  }

  if (row.kind === TASK_REQUEST_KIND.USER_INPUT) {
    const promptPayload = row.promptPayload
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
    const planPayload = row.planPayload
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

  const requestedAction = row.requestedAction
  if (!requestedAction) {
    throw new Error(`Task ${row.id} requested_action is required`)
  }
  const grantOptions = row.grantOptions ?? []
  const availablePresets = row.availablePresets ?? []
  const runtimeAuthorization: RuntimeAuthorizationTaskDetails = {
    requestedToolName: requireTrimmedString(
      row.requestedToolName,
      `Task ${row.id} requested_tool_name`
    ),
    runtimeToolStableKey: requireTrimmedString(
      row.runtimeToolStableKey,
      `Task ${row.id} runtime_tool_stable_key`
    ),
    requestedAction,
    reason: requireTrimmedString(
      row.reason,
      `Task ${row.id} runtime_authorization.reason`
    ),
    runtimeId: requireTrimmedString(row.runtimeId, `Task ${row.id} runtime_id`),
    runtimeDisplayName: requireTrimmedString(
      row.runtimeDisplayName,
      `Task ${row.id} device_display_name`
    ),
    runtimeCapabilityId: requireTrimmedString(
      row.runtimeCapabilityId,
      `Task ${row.id} runtime_capability_id`
    ),
    exposureId: requireTrimmedString(
      row.runtimeExposureId,
      `Task ${row.id} runtime_exposure_id`
    ),
    exposureDisplayName: requireTrimmedString(
      row.exposureDisplayName,
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
      row.requestMode === "blocking" || row.requestMode === "background"
        ? (row.requestMode as RuntimeAuthorizationRequestMode)
        : (() => {
            throw new Error(
              `Task ${row.id} runtime_authorization.requestMode is invalid`
            )
          })(),
    // Surface the persisted retry_nonce so the dedupe-reuse path in
    // runtime-authorizations/requests.ts can return the row's actual nonce
    // (the one that will match source_retry_nonce on the eventual grant)
    // instead of the freshly-generated nonce that no grant will ever match.
    sourceRetryNonce: row.sourceRetryNonce ?? undefined,
  }

  return {
    ...baseTask,
    kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    runtimeAuthorization,
  }
}
