import { z } from "zod"
import {
  AUTOMATION_SCHEDULE_KINDS,
  type AutomationScheduleKind,
  type Timestamp,
} from "@synapse/shared"
import { isIsoInstantString } from "@synapse/shared/datetime"

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
const automationScheduleKindSet = new Set<string>(AUTOMATION_SCHEDULE_KINDS)
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

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : undefined
}

function parseAutomationScheduleKind(value: unknown): AutomationScheduleKind {
  const candidate = optionalTrimmedString(value)
  if (!candidate || !automationScheduleKindSet.has(candidate)) {
    throwToolError(
      `scheduleKind must be one of: ${AUTOMATION_SCHEDULE_KINDS.join(", ")}`
    )
  }
  return candidate as AutomationScheduleKind
}

function optionalIsoInstant(
  value: unknown,
  fieldName: string
): Timestamp | undefined {
  const candidate = optionalTrimmedString(value)
  if (!candidate) {
    return undefined
  }
  if (!isIsoInstantString(candidate)) {
    throwToolError(
      `${fieldName} must be a canonical UTC ISO-8601 instant string with millisecond precision`
    )
  }
  return candidate
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

export function parseScheduleSelfWakeupToolInput(input: unknown): {
  name: string
  scheduleKind: AutomationScheduleKind
  scheduleExpr: string
  intervalSeconds?: number
  timezone?: string
  message: string
  wakeReason?: string
  activeUntil?: Timestamp
  maxTriggerCount?: number
  startsAt?: Timestamp
} {
  const record = inputRecord(input)
  const name = optionalTrimmedString(record.name) || ""
  const message = optionalTrimmedString(record.message) || ""
  if (!name || !message) {
    throwToolError("name and message are required")
  }

  const scheduleKind = parseAutomationScheduleKind(record.scheduleKind)
  const scheduleExpr = optionalTrimmedString(record.scheduleExpr) || ""
  return {
    name,
    scheduleKind,
    scheduleExpr,
    intervalSeconds: finiteNumberOrUndefined(record.intervalSeconds),
    timezone: optionalTrimmedString(record.timezone),
    message,
    wakeReason: optionalTrimmedString(record.wakeReason),
    activeUntil: optionalIsoInstant(record.activeUntil, "activeUntil"),
    maxTriggerCount: positiveIntegerOrUndefined(record.maxTriggerCount),
    startsAt:
      scheduleKind === "at" && scheduleExpr
        ? optionalIsoInstant(scheduleExpr, "scheduleExpr")
        : undefined,
  }
}

export function parseSubscribeEventToolInput(input: unknown): {
  name: string
  eventSourceId: string
  matcher?: Record<string, unknown>
  message: string
  wakeReason?: string
  once: boolean
  activeUntil?: Timestamp
  maxTriggerCount?: number
} {
  const record = inputRecord(input)
  const name = optionalTrimmedString(record.name) || ""
  const eventSourceId = optionalTrimmedString(record.eventSourceId) || ""
  const message = optionalTrimmedString(record.message) || ""
  if (!name || !eventSourceId || !message) {
    throwToolError("name, eventSourceId, and message are required")
  }

  return {
    name,
    eventSourceId,
    matcher: parseSelfEventSubscriptionMatcherInput(record.matcher),
    message,
    wakeReason: optionalTrimmedString(record.wakeReason),
    once: record.once === true,
    activeUntil: optionalIsoInstant(record.activeUntil, "activeUntil"),
    maxTriggerCount: positiveIntegerOrUndefined(record.maxTriggerCount),
  }
}

export function parseRequestUserInputToolInput(input: unknown): {
  targetParticipantId?: string
  title: string
  instructions: string
  questions: unknown
} {
  const record = inputRecord(input)
  return {
    targetParticipantId: optionalTrimmedString(record.targetParticipantId),
    title: optionalTrimmedString(record.title) || "",
    instructions: optionalTrimmedString(record.instructions) || "",
    questions: record.questions,
  }
}

export function parseEnterPlanModeToolInput(input: unknown): {
  summary?: string
} {
  const record = inputRecord(input)
  const summary = optionalTrimmedString(record.summary)
  return {
    summary: summary || undefined,
  }
}

export function parseUpdatePlanToolInput(input: unknown): {
  plan: unknown
  explanation?: string
} {
  const record = inputRecord(input)
  const explanation = optionalTrimmedString(record.explanation)
  return {
    plan: record.plan,
    explanation: explanation || undefined,
  }
}

export function parseExitPlanModeToolInput(input: unknown): {
  targetParticipantId?: string
  title: string
  summary?: string
  planMarkdown: string
  checklist: unknown
} {
  const record = inputRecord(input)
  const summary = optionalTrimmedString(record.summary)
  return {
    targetParticipantId: optionalTrimmedString(record.targetParticipantId),
    title: optionalTrimmedString(record.title) || "",
    summary: summary || undefined,
    planMarkdown: optionalTrimmedString(record.planMarkdown) || "",
    checklist: record.checklist,
  }
}
