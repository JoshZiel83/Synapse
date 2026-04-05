import type { AutomationTargetPolicy } from "../types/index.js";

export interface AutomationDeliveryDisplayInput {
  targetPolicy?: AutomationTargetPolicy;
  messageText?: string;
  wakeReasonText?: string;
  targetParticipantIds?: string[];
}

export interface AutomationDeliveryDisplayDetail {
  label: string;
  value: string;
}

export interface AutomationDeliveryDisplay {
  title: string;
  summary: string;
  description?: string;
  details: AutomationDeliveryDisplayDetail[];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function summarizeAudience(
  targetPolicy: AutomationTargetPolicy | undefined,
  targetParticipantIds?: string[],
) {
  if (targetPolicy !== "specified_members") {
    return "All active participants";
  }
  return targetParticipantIds && targetParticipantIds.length > 0
    ? `${targetParticipantIds.length} participant(s)`
    : "Specified participants";
}

export function describeAutomationDelivery(
  input: AutomationDeliveryDisplayInput,
): AutomationDeliveryDisplay {
  const audience = summarizeAudience(
    input.targetPolicy,
    input.targetParticipantIds,
  );
  const messageText = readString(input.messageText);
  const wakeReasonText = readString(input.wakeReasonText);

  const details: AutomationDeliveryDisplayDetail[] = [
    { label: "Audience", value: audience },
  ];

  if (
    input.targetPolicy === "specified_members" &&
    input.targetParticipantIds &&
    input.targetParticipantIds.length > 0
  ) {
    details.push({
      label: "Target participants",
      value: input.targetParticipantIds.join(", "),
    });
  }
  if (messageText) {
    details.push({ label: "Visible message", value: messageText });
  }
  if (wakeReasonText) {
    details.push({ label: "Wake reason", value: wakeReasonText });
  }

  return {
    title: "Conversation notice",
    summary: audience,
    description:
      "Posts an automation notice into the owner conversation and optionally wakes targeted actor participants.",
    details,
  };
}
