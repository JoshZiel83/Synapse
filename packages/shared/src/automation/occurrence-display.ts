import type { AutomationSourceKind } from "../types/index.js"
import { buildAutomationOccurrenceDisplay as buildEventOccurrenceDisplay } from "./event-definitions/index.js"
import type {
  AutomationOccurrenceDisplay,
  AutomationOccurrenceDisplayContext,
} from "./event-definitions/types.js"
import { formatAutomationIntervalDuration } from "./trigger-display.js"

export interface ResolveAutomationOccurrenceDisplayInput extends AutomationOccurrenceDisplayContext {
  sourceKind: AutomationSourceKind
  eventDefinitionKey?: string
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function buildClockOccurrenceDisplay(
  input: ResolveAutomationOccurrenceDisplayInput
): AutomationOccurrenceDisplay | null {
  const scheduleKind = readString(input.sourceSnapshot.scheduleKind)
  const ruleName =
    readString(input.sourceSnapshot.ruleName) || readString(input.sourceName)
  const scheduledAt =
    readString(input.sourceSnapshot.scheduledAt) || readString(input.occurredAt)

  if (scheduleKind === "at") {
    return {
      title: ruleName ? `${ruleName} fired` : "Point-in-time schedule fired",
      summary: "point-in-time schedule",
      description: scheduledAt
        ? `Point-in-time schedule reached its configured run time at ${scheduledAt}.`
        : "Point-in-time schedule reached its configured run time.",
    }
  }

  if (scheduleKind === "interval") {
    const intervalSeconds = readNumber(input.sourceSnapshot.intervalSeconds)
    const intervalLabel = intervalSeconds
      ? formatAutomationIntervalDuration(intervalSeconds)
      : null
    return {
      title: ruleName ? `${ruleName} fired` : "Interval schedule fired",
      summary: intervalLabel ? `every ${intervalLabel}` : "interval schedule",
      description: intervalLabel
        ? `Interval schedule fired after waiting ${intervalLabel}.`
        : "Interval schedule fired.",
    }
  }

  if (scheduleKind === "cron") {
    const scheduleExpr = readString(input.sourceSnapshot.scheduleExpr)
    const scheduleTimezone =
      readString(input.sourceSnapshot.scheduleTimezone) || "UTC"
    return {
      title: ruleName ? `${ruleName} fired` : "Cron schedule fired",
      summary: scheduleExpr
        ? `cron ${scheduleExpr} (${scheduleTimezone})`
        : "cron schedule",
      description: scheduleExpr
        ? `Cron schedule matched "${scheduleExpr}" in ${scheduleTimezone}.`
        : `Cron schedule matched in ${scheduleTimezone}.`,
    }
  }

  return {
    title: ruleName ? `${ruleName} fired` : "Scheduled automation fired",
    summary: "scheduled trigger",
    description: scheduledAt
      ? `Scheduled automation fired at ${scheduledAt}.`
      : "Scheduled automation fired.",
  }
}

export function resolveAutomationOccurrenceDisplay(
  input: ResolveAutomationOccurrenceDisplayInput
): AutomationOccurrenceDisplay | null {
  if (input.eventDefinitionKey) {
    return buildEventOccurrenceDisplay(input.eventDefinitionKey, {
      sourceName: input.sourceName,
      providerRef: input.providerRef,
      sourceSnapshot: input.sourceSnapshot,
      payload: input.payload,
      occurredAt: input.occurredAt,
    })
  }

  if (input.sourceKind === "clock") {
    return buildClockOccurrenceDisplay(input)
  }

  return null
}
