import {
  PLAN_CHECKLIST_STEP_STATUSES,
  TASK_INPUT_QUESTION_TYPES,
  type PlanChecklistStep,
  type TaskInputOption,
  type TaskInputQuestionDefinition,
  type TaskInputQuestionType,
} from "@synapse/shared"

const TASK_INPUT_TYPE_SET = new Set<string>(TASK_INPUT_QUESTION_TYPES)
const PLAN_CHECKLIST_STATUS_SET = new Set<string>(PLAN_CHECKLIST_STEP_STATUSES)

export class RemoteAgentTaskPayloadError extends Error {
  constructor(message: string) {
    super(`invalid remote-agent task payload: ${message}`)
    this.name = "RemoteAgentTaskPayloadError"
  }
}

function invalid(message: string): never {
  throw new RemoteAgentTaskPayloadError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readTrimmedString(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function normalizeQuestionType(
  value: unknown,
  hasOptions: boolean
): TaskInputQuestionType {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    if (TASK_INPUT_TYPE_SET.has(normalized)) {
      return normalized as TaskInputQuestionType
    }
    switch (normalized) {
      case "single":
      case "radio":
      case "select":
        return "single_select"
      case "multi":
      case "multiple":
      case "checkbox":
        return "multi_select"
      case "free_text":
      case "input":
      case "textarea":
        return "text"
    }
  }
  return hasOptions ? "single_select" : "text"
}

function buildQuestionOptions(
  questionId: string,
  rawOptions: unknown,
  questionIndex: number
): TaskInputOption[] {
  if (rawOptions === undefined) return []
  if (!Array.isArray(rawOptions)) {
    invalid(`question ${questionIndex + 1} options must be an array`)
  }

  const options: TaskInputOption[] = []
  const usedIds = new Set<string>()
  for (const [index, rawOption] of rawOptions.entries()) {
    let id = ""
    let label = ""
    let description: string | undefined
    let preview: string | undefined

    if (typeof rawOption === "string") {
      label = rawOption.trim()
    } else if (isRecord(rawOption)) {
      id = readTrimmedString(rawOption, ["id", "value"]) ?? ""
      label =
        readTrimmedString(rawOption, ["label", "text", "title", "value"]) ?? ""
      description = readTrimmedString(rawOption, ["description"])
      preview = readTrimmedString(rawOption, ["preview"])
    } else {
      invalid(`question ${questionIndex + 1} option ${index + 1} is invalid`)
    }

    if (!label) {
      invalid(
        `question ${questionIndex + 1} option ${index + 1} is missing label`
      )
    }
    if (!id || usedIds.has(id)) {
      id = `${questionId}_option_${index + 1}`
    }
    usedIds.add(id)
    const option: TaskInputOption = { id, label }
    if (description) option.description = description
    if (preview) option.preview = preview
    options.push(option)
  }
  return options
}

export function normalizeRemoteAgentUserInputQuestions(
  rawQuestions: unknown
): TaskInputQuestionDefinition[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    invalid("questions must contain at least one question")
  }
  if (rawQuestions.length > 4) {
    invalid("questions supports at most 4 items")
  }

  const questions: TaskInputQuestionDefinition[] = []
  const usedIds = new Set<string>()
  for (const [index, rawQuestion] of rawQuestions.entries()) {
    if (!isRecord(rawQuestion)) {
      invalid(`question ${index + 1} is invalid`)
    }

    const id = readTrimmedString(rawQuestion, ["id"]) ?? `question_${index + 1}`
    if (usedIds.has(id)) {
      invalid(`question id "${id}" is duplicated`)
    }

    const options = buildQuestionOptions(id, rawQuestion.options, index)
    const type = normalizeQuestionType(rawQuestion.type, options.length > 0)
    const prompt = readTrimmedString(rawQuestion, [
      "prompt",
      "question",
      "text",
      "label",
    ])
    if (!prompt) {
      invalid(`question ${index + 1} is missing prompt`)
    }
    if (type !== "text" && options.length === 0) {
      invalid(`question ${index + 1} requires at least one option`)
    }

    const question: TaskInputQuestionDefinition = {
      id,
      header:
        readTrimmedString(rawQuestion, ["header", "title"]) ?? `Q${index + 1}`,
      type,
      prompt,
      required:
        typeof rawQuestion.required === "boolean" ? rawQuestion.required : true,
    }
    const description = readTrimmedString(rawQuestion, ["description"])
    if (description) question.description = description

    if (type === "text") {
      const placeholder = readTrimmedString(rawQuestion, ["placeholder"])
      if (placeholder) question.placeholder = placeholder
      question.secret = rawQuestion.secret === true
    } else {
      question.options = options
      question.allowOther = rawQuestion.allowOther === true
    }

    if (
      type === "multi_select" &&
      typeof rawQuestion.minSelections === "number" &&
      Number.isFinite(rawQuestion.minSelections)
    ) {
      question.minSelections = Math.max(
        0,
        Math.trunc(rawQuestion.minSelections)
      )
    }
    if (
      type === "multi_select" &&
      typeof rawQuestion.maxSelections === "number" &&
      Number.isFinite(rawQuestion.maxSelections)
    ) {
      question.maxSelections = Math.max(
        1,
        Math.trunc(rawQuestion.maxSelections)
      )
    }

    usedIds.add(id)
    questions.push(question)
  }
  return questions
}

function normalizeChecklistStatus(
  rawItem: Record<string, unknown>,
  index: number
): PlanChecklistStep["status"] {
  if (typeof rawItem.status === "string") {
    const status = rawItem.status.trim()
    if (PLAN_CHECKLIST_STATUS_SET.has(status)) {
      return status as PlanChecklistStep["status"]
    }
    invalid(`checklist item ${index + 1} has invalid status`)
  }
  if (rawItem.done === true) return "completed"
  return "pending"
}

export function normalizeRemoteAgentPlanChecklist(
  rawChecklist: unknown
): PlanChecklistStep[] | undefined {
  if (rawChecklist === undefined) return undefined
  if (!Array.isArray(rawChecklist)) {
    invalid("checklist must be an array")
  }

  const checklist: PlanChecklistStep[] = []
  for (const [index, rawItem] of rawChecklist.entries()) {
    if (!isRecord(rawItem)) {
      invalid(`checklist item ${index + 1} is invalid`)
    }
    const step = readTrimmedString(rawItem, ["step", "text", "title"])
    if (!step) {
      invalid(`checklist item ${index + 1} is missing step`)
    }
    checklist.push({
      step,
      status: normalizeChecklistStatus(rawItem, index),
    })
  }
  return checklist
}
