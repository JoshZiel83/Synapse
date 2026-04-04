import type {
  AutomationDeliveryMode,
  AutomationTargetEntityRef,
  AutomationTargetPolicy,
} from "../types/index.js";

export interface AutomationDeliveryDisplayInput {
  deliveryMode: AutomationDeliveryMode;
  targetPolicy?: AutomationTargetPolicy;
  conversationId?: string;
  sessionId?: string;
  reusedConversationId?: string;
  conversationTitle?: string;
  messageText?: string;
  wakeReasonText?: string;
  participants?: AutomationTargetEntityRef[];
  recipients?: AutomationTargetEntityRef[];
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

function formatEntityRefs(refs?: AutomationTargetEntityRef[]) {
  if (!refs || refs.length === 0) return null;
  return refs.map((ref) => `${ref.entityKind}:${ref.entityId}`).join(", ");
}

function summarizeAudience(
  targetPolicy: AutomationTargetPolicy | undefined,
  recipients?: AutomationTargetEntityRef[],
) {
  if (targetPolicy !== "specified_members") {
    return "All participants";
  }
  return formatEntityRefs(recipients) || "Specified participants";
}

function describeMode(mode: AutomationDeliveryMode) {
  switch (mode) {
    case "wake_session":
      return {
        title: "Wake session",
        description: "Wakes a specific session and injects the wake reason into context.",
      };
    case "conversation_notice":
      return {
        title: "Conversation notice",
        description: "Posts a system notice into an existing conversation.",
      };
    case "create_conversation_once":
      return {
        title: "Create conversation once",
        description: "Creates one conversation on first execution, then reuses it.",
      };
    case "create_conversation_each_time":
      return {
        title: "Create conversation each time",
        description: "Creates a fresh conversation every time the trigger fires.",
      };
    default:
      return {
        title: mode,
        description: undefined,
      };
  }
}

export function describeAutomationDelivery(
  input: AutomationDeliveryDisplayInput,
): AutomationDeliveryDisplay {
  const modeDisplay = describeMode(input.deliveryMode);
  const audience = summarizeAudience(input.targetPolicy, input.recipients);
  const sessionId = readString(input.sessionId);
  const conversationId = readString(input.conversationId);
  const reusedConversationId = readString(input.reusedConversationId);
  const conversationTitle = readString(input.conversationTitle);
  const participants = formatEntityRefs(input.participants);
  const recipients = formatEntityRefs(input.recipients);
  const messageText = readString(input.messageText);
  const wakeReasonText = readString(input.wakeReasonText);

  let summary = audience;
  if (input.deliveryMode === "wake_session" && sessionId) {
    summary = `Session ${sessionId}`;
  } else if (
    input.deliveryMode === "conversation_notice" &&
    conversationId
  ) {
    summary = `Conversation ${conversationId}`;
  } else if (conversationTitle) {
    summary = conversationTitle;
  }

  const details: AutomationDeliveryDisplayDetail[] = [
    { label: "Mode", value: modeDisplay.title },
    { label: "Audience", value: audience },
  ];

  if (sessionId) {
    details.push({ label: "Target session", value: sessionId });
  }
  if (conversationId) {
    details.push({ label: "Conversation", value: conversationId });
  }
  if (reusedConversationId) {
    details.push({ label: "Reused conversation", value: reusedConversationId });
  }
  if (conversationTitle) {
    details.push({ label: "Conversation title", value: conversationTitle });
  }
  if (participants) {
    details.push({ label: "Participants", value: participants });
  }
  if (input.targetPolicy === "specified_members" && recipients) {
    details.push({ label: "Recipients", value: recipients });
  }
  if (messageText) {
    details.push({ label: "Visible message", value: messageText });
  }
  if (wakeReasonText) {
    details.push({ label: "Wake reason", value: wakeReasonText });
  }

  return {
    title: modeDisplay.title,
    summary,
    description: modeDisplay.description,
    details,
  };
}
