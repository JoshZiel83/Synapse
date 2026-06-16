import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import type { PermissionDecision } from "./types.js"

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function extractAssistantText(message: unknown): string {
  const content = asRecord(asRecord(message).message).content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text)
    }
  }
  return parts.join("")
}

export function readClaudeResultErrorMessage(message: unknown): string | null {
  const record = asRecord(message)
  if (record.is_error !== true || record.stop_reason === "max_tokens") {
    return null
  }
  const errors = record.errors
  return String(
    record.result ||
      (Array.isArray(errors) ? errors[0] : undefined) ||
      "Claude execution failed"
  )
}

export interface ClaudeAskUserQuestionInputView {
  title: string
  questions: Array<Record<string, unknown>>
  originalInput: Record<string, unknown>
}

export function parseAskUserQuestionInput(
  input: unknown
): ClaudeAskUserQuestionInputView {
  const originalInput = asRecord(input)
  const questions = Array.isArray(originalInput.questions)
    ? originalInput.questions.filter(
        (question): question is Record<string, unknown> =>
          !!question && typeof question === "object" && !Array.isArray(question)
      )
    : []
  return {
    title:
      (typeof questions[0]?.question === "string"
        ? questions[0].question.trim()
        : "") || "Question from Claude",
    questions,
    originalInput,
  }
}

export interface ClaudePlanApprovalInputView {
  planMarkdown: string
  originalInput: Record<string, unknown>
}

export function parsePlanApprovalInput(
  input: unknown
): ClaudePlanApprovalInputView {
  const originalInput = asRecord(input)
  return {
    planMarkdown:
      typeof originalInput.plan === "string"
        ? originalInput.plan
        : "Claude did not include a plan body.",
    originalInput,
  }
}

export function buildPermissionResultForDecision(
  decision: PermissionDecision,
  toolUseID: string
): PermissionResult {
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput ?? {},
      toolUseID,
    }
  }
  return {
    behavior: "deny",
    message: decision.message,
    toolUseID,
  }
}
