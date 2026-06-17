import { throwToolError } from "./tool-errors.js"

export type CreateMemoryToolInput = {
  content: string
  category: string
  spaceType: string
  importance: number
  confidence: number
  textDigest?: string
  tags: string[]
}

export type RenameSelfToolInput = {
  newName: string
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined
}

function requiredTrimmedString(value: unknown, fieldName: string): string {
  const result = optionalTrimmedString(value)
  if (!result) {
    throwToolError(`${fieldName} is required`)
  }
  return result
}

function finiteNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseCommaSeparatedTags(value: unknown): string[] {
  const tagInput = optionalTrimmedString(value)
  if (!tagInput) return []
  return tagInput
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
}

export function parseCreateMemoryToolInput(
  input: unknown
): CreateMemoryToolInput {
  const record = inputRecord(input)
  const spaceType =
    optionalTrimmedString(record.spaceType) ||
    optionalTrimmedString(record.scope) ||
    "participant_private"

  return {
    content: requiredTrimmedString(record.content, "content"),
    category: optionalTrimmedString(record.category) || "fact",
    spaceType,
    importance: finiteNumberOrDefault(record.importance, 0.5),
    confidence: finiteNumberOrDefault(record.confidence, 0.8),
    textDigest: optionalTrimmedString(record.textDigest),
    tags: parseCommaSeparatedTags(record.tags),
  }
}

export function parseRenameSelfToolInput(input: unknown): RenameSelfToolInput {
  const record = inputRecord(input)
  return {
    newName: requiredTrimmedString(record.newName, "newName"),
  }
}
