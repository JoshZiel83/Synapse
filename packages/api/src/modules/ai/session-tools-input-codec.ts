import { z } from "zod"

import { throwToolError } from "./tool-errors.js"

export const taskStatusFilterValues = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const

export type TaskStatusFilterValue = (typeof taskStatusFilterValues)[number]

export const taskOutputStreamValues = [
  "combined",
  "stdout",
  "stderr",
  "system",
] as const

export type TaskOutputStreamValue = (typeof taskOutputStreamValues)[number]

const taskStatusFilterValueSet = new Set<string>(taskStatusFilterValues)
const taskOutputStreamValueSet = new Set<string>(taskOutputStreamValues)
const selfEventSubscriptionMatcherSchema = z.record(z.string(), z.unknown())

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined
}

function requiredTrimmedString(value: unknown, fieldName: string): string {
  const result = typeof value === "string" ? value.trim() : ""
  if (!result) {
    throwToolError(`${fieldName} is required`)
  }
  return result
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback
}

function nonNegativeIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback
}

export function parseSelfEventSubscriptionMatcherInput(
  value: unknown
): Record<string, unknown> | undefined {
  const matcherInput = typeof value === "string" ? value.trim() : ""
  if (!matcherInput) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(matcherInput)
  } catch {
    throwToolError("matcher must be valid JSON")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwToolError("matcher must be a JSON object string")
  }

  const result = selfEventSubscriptionMatcherSchema.safeParse(parsed)
  if (!result.success) {
    throwToolError("matcher must be a JSON object string")
  }
  return result.data
}

export function parseListTasksToolInput(input: unknown): {
  statuses?: TaskStatusFilterValue[]
  limit: number
} {
  const record = inputRecord(input)
  const statuses = Array.isArray(record.statuses)
    ? record.statuses
        .map((value) => String(value || "").trim())
        .filter((value): value is TaskStatusFilterValue =>
          taskStatusFilterValueSet.has(value)
        )
    : []

  return {
    statuses: statuses.length > 0 ? statuses : undefined,
    limit: positiveIntegerOrDefault(record.limit, 20),
  }
}

export function parseGetTaskStatusToolInput(input: unknown): {
  taskId: string
} {
  const record = inputRecord(input)
  return {
    taskId: requiredTrimmedString(record.taskId, "taskId"),
  }
}

export function parseCancelTaskToolInput(input: unknown): {
  taskId: string
  reason?: string
} {
  const record = inputRecord(input)
  return {
    taskId: requiredTrimmedString(record.taskId, "taskId"),
    reason: optionalTrimmedString(record.reason),
  }
}

export function parseTailTaskOutputToolInput(input: unknown): {
  taskId: string
  afterSeq: number
  limit: number
  stream: TaskOutputStreamValue
} {
  const record = inputRecord(input)
  const stream = optionalTrimmedString(record.stream)
  return {
    taskId: requiredTrimmedString(record.taskId, "taskId"),
    afterSeq: nonNegativeIntegerOrDefault(record.afterSeq, 0),
    limit: positiveIntegerOrDefault(record.limit, 20),
    stream:
      stream && taskOutputStreamValueSet.has(stream)
        ? (stream as TaskOutputStreamValue)
        : "combined",
  }
}
