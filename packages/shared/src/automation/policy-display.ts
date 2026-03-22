import type {
  AutomationCompletionStatus,
  AutomationPolicy,
} from "../types/index.js";

export interface AutomationPolicyDisplayInput {
  activeFrom?: string;
  activeUntil?: string;
  maxTriggerCount?: number;
  triggerCount?: number;
  completionStatus?: AutomationCompletionStatus;
  completedAt?: string;
}

export interface AutomationPolicyDisplayOptions {
  formatTimestamp?: (value: string) => string;
}

export interface AutomationPolicyDisplayDetail {
  label: string;
  value: string;
}

export interface AutomationPolicyDisplay {
  title: string;
  summary: string;
  description?: string;
  details: AutomationPolicyDisplayDetail[];
}

function formatTimestamp(
  value: string | undefined,
  options?: AutomationPolicyDisplayOptions,
) {
  if (!value) return null;
  return options?.formatTimestamp ? options.formatTimestamp(value) : value;
}

function formatCountLimit(maxTriggerCount?: number, triggerCount = 0) {
  if (!maxTriggerCount || maxTriggerCount <= 0) {
    return `No trigger cap (${triggerCount} fired)`;
  }
  return `${triggerCount}/${maxTriggerCount} triggers used`;
}

export function describeAutomationPolicy(
  input: AutomationPolicy | AutomationPolicyDisplayInput,
  options?: AutomationPolicyDisplayOptions,
): AutomationPolicyDisplay {
  const activeFrom = formatTimestamp(input.activeFrom, options);
  const activeUntil = formatTimestamp(input.activeUntil, options);
  const completedAt = formatTimestamp(input.completedAt, options);
  const triggerCount = input.triggerCount || 0;
  const maxTriggerCount = input.maxTriggerCount;
  const completionStatus = input.completionStatus || "completed";
  const limitLabel = formatCountLimit(maxTriggerCount, triggerCount);

  let summary = limitLabel;
  if (activeUntil) {
    summary = `${limitLabel}, until ${activeUntil}`;
  } else if (activeFrom) {
    summary = `${limitLabel}, from ${activeFrom}`;
  }

  const details: AutomationPolicyDisplayDetail[] = [
    { label: "Trigger count", value: String(triggerCount) },
    {
      label: "Max triggers",
      value: maxTriggerCount ? String(maxTriggerCount) : "Unlimited",
    },
    {
      label: "On completion",
      value: completionStatus,
    },
  ];

  if (activeFrom) {
    details.push({ label: "Active from", value: activeFrom });
  }
  if (activeUntil) {
    details.push({ label: "Active until", value: activeUntil });
  }
  if (completedAt) {
    details.push({ label: "Completed at", value: completedAt });
  }

  return {
    title: "Policy",
    summary,
    description:
      maxTriggerCount && maxTriggerCount > 0
        ? `Stops after ${maxTriggerCount} matched trigger${maxTriggerCount === 1 ? "" : "s"} and transitions to ${completionStatus}.`
        : activeUntil
          ? `Remains active until ${activeUntil}.`
          : "Runs until paused, archived, or expired by policy.",
    details,
  };
}
