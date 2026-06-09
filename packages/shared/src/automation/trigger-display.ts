import type {
  AutomationEventProviderKind,
  AutomationEventSourceIntegration,
  AutomationIntegrationProvider,
  AutomationScheduleKind,
  AutomationSourceKind,
  AutomationTriggerKind,
  Timestamp,
} from "../types/index.js"

export interface AutomationTriggerDisplayInput {
  triggerKind: AutomationTriggerKind
  sourceKind?: AutomationSourceKind
  eventSourceName?: string
  eventSourceKey?: string
  eventProviderKind?: AutomationEventProviderKind
  eventProviderRef?: string
  eventSourceIntegration?: AutomationEventSourceIntegration
  eventIntegrationProvider?: AutomationIntegrationProvider
  eventIntegrationTargetLabel?: string
  matcher?: Record<string, unknown>
  scheduleKind?: AutomationScheduleKind
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: Timestamp
  nextFireAt?: Timestamp
}

export interface AutomationTriggerDisplay {
  title: string
  summary: string
  description?: string
  details: AutomationTriggerDisplayDetail[]
}

export interface AutomationTriggerDisplayOptions {
  formatTimestamp?: (value: Timestamp) => string
}

export interface AutomationTriggerDisplayDetail {
  label: string
  value: string
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function countMatcherFields(matcher?: Record<string, unknown>) {
  return matcher ? Object.keys(matcher).length : 0
}

export function formatAutomationIntervalDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s"
  if (totalSeconds < 60) return `${totalSeconds}s`
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function formatTimestamp(
  value: Timestamp | undefined,
  options?: AutomationTriggerDisplayOptions
) {
  if (!value) return null
  return options?.formatTimestamp ? options.formatTimestamp(value) : value
}

function describeEventTrigger(
  input: AutomationTriggerDisplayInput
): AutomationTriggerDisplay {
  const title =
    readString(input.eventSourceName) ||
    readString(input.eventSourceKey) ||
    "Event subscription"
  const providerKind =
    readString(input.eventSourceIntegration?.provider) ||
    readString(input.eventIntegrationProvider) ||
    (input.eventProviderKind === "integration"
      ? null
      : readString(input.eventProviderKind)) ||
    readString(input.sourceKind) ||
    "event"
  const providerRef =
    readString(input.eventSourceIntegration?.targetLabel) ||
    readString(input.eventIntegrationTargetLabel) ||
    readString(input.eventProviderRef)
  const matcherFieldCount = countMatcherFields(input.matcher)
  const providerLabel = providerRef
    ? `${providerKind} / ${providerRef}`
    : providerKind
  const matcherLabel =
    matcherFieldCount > 0
      ? `${matcherFieldCount} configured field${matcherFieldCount === 1 ? "" : "s"}`
      : "No payload filter"

  return {
    title,
    summary: providerLabel,
    description:
      matcherFieldCount > 0
        ? `Triggers when the incoming payload matches ${matcherFieldCount} configured field${matcherFieldCount === 1 ? "" : "s"}.`
        : "Triggers whenever this event source reports an occurrence.",
    details: [
      { label: "Kind", value: "Event subscription" },
      { label: "Event source", value: title },
      { label: "Provider", value: providerLabel },
      { label: "Matcher", value: matcherLabel },
    ],
  }
}

function describeScheduleTrigger(
  input: AutomationTriggerDisplayInput,
  options?: AutomationTriggerDisplayOptions
): AutomationTriggerDisplay {
  const scheduleKind = input.scheduleKind || "cron"

  if (scheduleKind === "at") {
    const scheduledAt =
      formatTimestamp(
        input.startsAt || input.nextFireAt || undefined,
        options
      ) || readString(input.scheduleExpr)
    const summary = scheduledAt ? `At ${scheduledAt}` : "Point-in-time schedule"
    return {
      title: "Point-in-time schedule",
      summary,
      description: scheduledAt
        ? `Runs when the configured time ${scheduledAt} is reached.`
        : "Runs when the configured time is reached.",
      details: [
        { label: "Kind", value: "Schedule" },
        { label: "Schedule type", value: "at" },
        { label: "Schedule", value: summary },
      ],
    }
  }

  if (scheduleKind === "interval") {
    const intervalLabel = formatAutomationIntervalDuration(
      input.intervalSeconds || 0
    )
    const nextFireAt = formatTimestamp(input.nextFireAt || undefined, options)
    const summary = `Every ${intervalLabel}`
    return {
      title: "Interval schedule",
      summary,
      description: nextFireAt
        ? `Repeats every ${intervalLabel}. Next run at ${nextFireAt}.`
        : `Repeats every ${intervalLabel}.`,
      details: [
        { label: "Kind", value: "Schedule" },
        { label: "Schedule type", value: "interval" },
        { label: "Schedule", value: summary },
        ...(nextFireAt ? [{ label: "Next fire", value: nextFireAt }] : []),
      ],
    }
  }

  const scheduleExpr = readString(input.scheduleExpr)
  const scheduleTimezone = readString(input.scheduleTimezone) || "UTC"
  const nextFireAt = formatTimestamp(input.nextFireAt || undefined, options)
  const summary = scheduleExpr
    ? `Cron ${scheduleExpr} (${scheduleTimezone})`
    : `Cron schedule (${scheduleTimezone})`
  return {
    title: "Cron schedule",
    summary,
    description: nextFireAt
      ? `Evaluates in ${scheduleTimezone}. Next run at ${nextFireAt}.`
      : `Evaluates in ${scheduleTimezone}.`,
    details: [
      { label: "Kind", value: "Schedule" },
      { label: "Schedule type", value: "cron" },
      { label: "Schedule", value: summary },
      { label: "Timezone", value: scheduleTimezone },
      ...(nextFireAt ? [{ label: "Next fire", value: nextFireAt }] : []),
    ],
  }
}

export function describeAutomationTrigger(
  input: AutomationTriggerDisplayInput,
  options?: AutomationTriggerDisplayOptions
): AutomationTriggerDisplay {
  if (input.triggerKind === "event") {
    return describeEventTrigger(input)
  }

  return describeScheduleTrigger(input, options)
}
