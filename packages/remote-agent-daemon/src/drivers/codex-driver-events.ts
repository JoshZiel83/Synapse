import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js"
import type { ToolRequestUserInputResponse } from "../codex/generated/v2/ToolRequestUserInputResponse.js"
import type { TurnStartParams } from "../codex/generated/v2/TurnStartParams.js"
import type { PermissionDecision } from "./types.js"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value) || typeof value !== "number"
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

export function readCodexThreadStartedId(params: unknown): string | undefined {
  const thread = asRecord(asRecord(params).thread)
  return typeof thread.id === "string" ? thread.id : undefined
}

export function readCodexThreadResult(
  result: unknown,
  fallbackThreadId: string | undefined
): { threadId: string | undefined; model: string | undefined } {
  const record = asRecord(result)
  const thread = asRecord(record.thread)
  const resolveThreadId = (): string | undefined => {
    if (typeof thread.id === "string") return thread.id
    if (typeof thread.threadId === "string") return thread.threadId
    return fallbackThreadId
  }
  const threadId = resolveThreadId()
  return {
    threadId,
    model: typeof record.model === "string" ? record.model : undefined,
  }
}

export function parseCodexPlanUpdated(params: unknown): {
  explanation: string | undefined
  plan: Array<{ step: string; status: string }>
} {
  const record = asRecord(params)
  return {
    explanation:
      typeof record.explanation === "string" ? record.explanation : undefined,
    plan: Array.isArray(record.plan)
      ? record.plan
          .map((step) => {
            const item = asRecord(step)
            return {
              step: String(item.step ?? ""),
              status: String(item.status ?? "pending"),
            }
          })
          .filter((step) => Boolean(step.step))
      : [],
  }
}

export function readCodexTurnCompletedError(
  params: unknown
): string | undefined {
  const error = asRecord(asRecord(asRecord(params).turn).error)
  return typeof error.message === "string" ? error.message : undefined
}

export interface CodexUserInputRequestView {
  title: string
  questions: Array<Record<string, unknown>>
}

export function parseCodexUserInputRequest(
  params: unknown
): CodexUserInputRequestView {
  const rawQuestions = asRecord(params).questions
  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.filter(
        (question): question is Record<string, unknown> =>
          !!question && typeof question === "object" && !Array.isArray(question)
      )
    : []
  return {
    title:
      (typeof questions[0]?.question === "string"
        ? questions[0].question.trim()
        : "") || "Question from Codex",
    questions,
  }
}

export function readCodexUserInputAnswers(
  decision: PermissionDecision
): ToolRequestUserInputResponse["answers"] {
  if (decision.behavior !== "allow") return {}
  const answers = asRecord(decision.updatedInput).answers
  return asRecord(answers) as ToolRequestUserInputResponse["answers"]
}

export interface CodexElicitationRequestView {
  title: string
  questions: Array<Record<string, unknown>>
}

export function parseCodexElicitationRequest(
  params: unknown
): CodexElicitationRequestView {
  const record = asRecord(params)
  const requestedSchema = asRecord(record.requestedSchema)
  const properties = asRecord(requestedSchema.properties)
  const questions = Object.entries(properties).map(([key, raw], index) => {
    const prop = asRecord(raw)
    const enumValues = Array.isArray(prop.enum) ? prop.enum : undefined
    return {
      id: key,
      header:
        typeof prop.title === "string" ? prop.title : `Field ${index + 1}`,
      type: enumValues && enumValues.length > 0 ? "single_select" : "free_text",
      prompt:
        (typeof prop.description === "string" && prop.description) ||
        (typeof prop.title === "string" && prop.title) ||
        key,
      required: true,
      ...(enumValues
        ? {
            options: enumValues.map((value, optionIndex) => ({
              id: `option-${index + 1}-${optionIndex + 1}`,
              label: String(value),
            })),
          }
        : {}),
    }
  })
  const message =
    typeof record.message === "string" ? record.message.trim() : ""
  const serverName =
    typeof record.serverName === "string" && record.serverName
      ? record.serverName
      : "MCP server"
  return {
    title: message || `Codex ${serverName} needs input`,
    questions,
  }
}

export function readCodexElicitationContent(
  decision: PermissionDecision
): JsonValue | null {
  if (decision.behavior !== "allow") return null
  const answers = asRecord(decision.updatedInput).answers
  return isJsonValue(answers) ? answers : null
}

export function codexTurnStartParamsToRequestParams(
  params: TurnStartParams
): Record<string, unknown> {
  return { ...params }
}
