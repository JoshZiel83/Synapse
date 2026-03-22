import type {
  AutomationCompletionStatus,
  AutomationRule,
  AutomationSourceKind,
  AutomationDeliveryMode,
  AutomationScheduleKind,
  AutomationStatus,
  AutomationTargetPolicy,
  AutomationTriggerKind,
  CanonicalContentBlock,
} from "../types/index.js";

export interface AutomationRuleCreateTriggerPayload {
  triggerKind: AutomationTriggerKind;
  eventSourceId?: string;
  sourceKind?: AutomationSourceKind;
  sourceLocator?: string;
  matchKey?: string;
  matcher?: Record<string, unknown>;
  scheduleKind?: AutomationScheduleKind;
  scheduleExpr?: string;
  scheduleTimezone?: string;
  intervalSeconds?: number;
  startsAt?: string;
}

export interface AutomationRuleCreatePolicyPayload {
  activeFrom?: string;
  activeUntil?: string;
  maxTriggerCount?: number;
  completionStatus?: AutomationCompletionStatus;
}

export interface AutomationRuleCreateDeliveryPayload {
  deliveryMode: AutomationDeliveryMode;
  conversationId?: string;
  sessionId?: string;
  conversationTitle?: string;
  message?: string;
  wakeReason?: string;
  messageBlocks?: CanonicalContentBlock[];
  targetPolicy?: AutomationTargetPolicy;
  participantActorIds?: string[];
  participantUserIds?: string[];
  recipientActorIds?: string[];
  recipientUserIds?: string[];
}

export interface AutomationRuleCreatePayload {
  name: string;
  description?: string;
  status?: AutomationStatus;
  ownerConversationId?: string;
  ownerSessionId?: string;
  trigger: AutomationRuleCreateTriggerPayload;
  policy?: AutomationRuleCreatePolicyPayload;
  delivery: AutomationRuleCreateDeliveryPayload;
  metadata?: Record<string, unknown>;
}

export interface AutomationRuleUpdatePayload
  extends Partial<Omit<AutomationRuleCreatePayload, "trigger" | "delivery">> {
  trigger?: Partial<AutomationRuleCreateTriggerPayload>;
  policy?: Partial<AutomationRuleCreatePolicyPayload>;
  delivery?: Partial<AutomationRuleCreateDeliveryPayload>;
}

export interface AutomationRuleDraft {
  name: string;
  description: string;
  ownerConversationId: string;
  ownerSessionId: string;
  triggerKind: AutomationTriggerKind;
  scheduleKind: AutomationScheduleKind;
  scheduleExpr: string;
  scheduleTimezone: string;
  intervalSeconds: string;
  startsAt: string;
  activeFrom: string;
  activeUntil: string;
  maxTriggerCount: string;
  eventSourceId: string;
  matcherText: string;
  completionStatus: AutomationCompletionStatus;
  deliveryMode: AutomationDeliveryMode;
  conversationId: string;
  sessionId: string;
  conversationTitle: string;
  message: string;
  wakeReason: string;
  targetPolicy: AutomationTargetPolicy;
  participantActorIds: string;
  participantUserIds: string;
  recipientActorIds: string;
  recipientUserIds: string;
}

export interface AutomationRuleContractIssue {
  path: string;
  message: string;
}

export type AutomationRuleDraftBuildResult =
  | {
      ok: true;
      data: AutomationRuleCreatePayload;
    }
  | {
      ok: false;
      error: string;
      issues: AutomationRuleContractIssue[];
    };

function trimString(value: string | undefined) {
  const trimmed = (value || "").trim();
  return trimmed || undefined;
}

function cloneRecord(value: Record<string, unknown> | undefined) {
  return value ? { ...value } : undefined;
}

function cloneContentBlocks(value: CanonicalContentBlock[] | undefined) {
  return value ? [...value] : undefined;
}

function toDateTimeLocalInput(value: string | undefined) {
  const trimmed = trimString(value);
  if (!trimmed) return "";

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function extractEntityIds(
  rule: AutomationRule,
  entityKind: "actor" | "user",
  targetKind: "participants" | "recipients",
) {
  const entries =
    targetKind === "participants" ? rule.delivery.participants : rule.delivery.recipients;
  return entries
    .filter((entry) => entry.entityKind === entityKind)
    .map((entry) => entry.entityId);
}

function toIsoString(value: string | undefined, label: string) {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be a valid date/time`);
  }
  return parsed.toISOString();
}

export function parseAutomationIdList(input: string) {
  return Array.from(
    new Set(
      input
        .split(/[\n,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

export function parseAutomationJsonObjectText(input: string, label: string) {
  const trimmed = input.trim();
  if (!trimmed) return {};

  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function createEmptyAutomationRuleDraft(
  timezone = "UTC",
): AutomationRuleDraft {
  return {
    name: "",
    description: "",
    ownerConversationId: "",
    ownerSessionId: "",
    triggerKind: "schedule",
    scheduleKind: "at",
    scheduleExpr: "",
    scheduleTimezone: timezone,
    intervalSeconds: "300",
    startsAt: "",
    activeFrom: "",
    activeUntil: "",
    maxTriggerCount: "",
    eventSourceId: "",
    matcherText: "{}",
    completionStatus: "completed",
    deliveryMode: "wake_session",
    conversationId: "",
    sessionId: "",
    conversationTitle: "",
    message: "",
    wakeReason: "",
    targetPolicy: "all_members",
    participantActorIds: "",
    participantUserIds: "",
    recipientActorIds: "",
    recipientUserIds: "",
  };
}

export function buildAutomationRuleCreatePayloadFromRule(
  rule: AutomationRule,
): AutomationRuleCreatePayload {
  return {
    name: rule.name,
    description: rule.description,
    status: rule.status,
    ownerConversationId: rule.ownerConversationId,
    ownerSessionId: rule.ownerSessionId,
    trigger: {
      triggerKind: rule.trigger.triggerKind,
      eventSourceId: rule.trigger.eventSourceId,
      sourceKind: rule.trigger.sourceKind,
      sourceLocator: rule.trigger.sourceLocator,
      matchKey: rule.trigger.matchKey,
      matcher: cloneRecord(rule.trigger.matcher),
      scheduleKind: rule.trigger.scheduleKind,
      scheduleExpr: rule.trigger.scheduleExpr,
      scheduleTimezone: rule.trigger.scheduleTimezone,
      intervalSeconds: rule.trigger.intervalSeconds,
      startsAt: rule.trigger.startsAt,
    },
    policy: {
      activeFrom: rule.policy.activeFrom,
      activeUntil: rule.policy.activeUntil,
      maxTriggerCount: rule.policy.maxTriggerCount,
      completionStatus: rule.policy.completionStatus,
    },
    delivery: {
      deliveryMode: rule.delivery.deliveryMode,
      conversationId: rule.delivery.conversationId,
      sessionId: rule.delivery.sessionId,
      conversationTitle: rule.delivery.conversationTitle,
      message: rule.delivery.messageText,
      wakeReason: rule.delivery.wakeReasonText,
      messageBlocks: cloneContentBlocks(rule.delivery.messageBlocks),
      targetPolicy: rule.delivery.targetPolicy,
      participantActorIds: extractEntityIds(rule, "actor", "participants"),
      participantUserIds: extractEntityIds(rule, "user", "participants"),
      recipientActorIds: extractEntityIds(rule, "actor", "recipients"),
      recipientUserIds: extractEntityIds(rule, "user", "recipients"),
    },
    metadata: cloneRecord(rule.metadata),
  };
}

export function buildAutomationRuleDraftFromRule(
  rule: AutomationRule,
): AutomationRuleDraft {
  return {
    name: rule.name,
    description: rule.description,
    ownerConversationId: rule.ownerConversationId || "",
    ownerSessionId: rule.ownerSessionId || "",
    triggerKind: rule.trigger.triggerKind,
    scheduleKind: rule.trigger.scheduleKind || "at",
    scheduleExpr: rule.trigger.scheduleExpr || "",
    scheduleTimezone: rule.trigger.scheduleTimezone || "UTC",
    intervalSeconds: rule.trigger.intervalSeconds
      ? String(rule.trigger.intervalSeconds)
      : "300",
    startsAt: toDateTimeLocalInput(rule.trigger.startsAt),
    activeFrom: toDateTimeLocalInput(rule.policy.activeFrom),
    activeUntil: toDateTimeLocalInput(rule.policy.activeUntil),
    maxTriggerCount: rule.policy.maxTriggerCount
      ? String(rule.policy.maxTriggerCount)
      : "",
    eventSourceId: rule.trigger.eventSourceId || "",
    matcherText: JSON.stringify(rule.trigger.matcher || {}, null, 2),
    completionStatus: rule.policy.completionStatus,
    deliveryMode: rule.delivery.deliveryMode,
    conversationId: rule.delivery.conversationId || "",
    sessionId: rule.delivery.sessionId || "",
    conversationTitle: rule.delivery.conversationTitle || "",
    message: rule.delivery.messageText || "",
    wakeReason: rule.delivery.wakeReasonText || "",
    targetPolicy: rule.delivery.targetPolicy,
    participantActorIds: extractEntityIds(rule, "actor", "participants").join("\n"),
    participantUserIds: extractEntityIds(rule, "user", "participants").join("\n"),
    recipientActorIds: extractEntityIds(rule, "actor", "recipients").join("\n"),
    recipientUserIds: extractEntityIds(rule, "user", "recipients").join("\n"),
  };
}

export function mergeAutomationRuleUpdatePayload(
  rule: AutomationRule,
  patch: AutomationRuleUpdatePayload,
): AutomationRuleCreatePayload {
  const base = buildAutomationRuleCreatePayloadFromRule(rule);

  return {
    name: patch.name !== undefined ? patch.name : base.name,
    description:
      patch.description !== undefined ? patch.description : base.description,
    status: patch.status !== undefined ? patch.status : base.status,
    ownerConversationId:
      patch.ownerConversationId !== undefined
        ? patch.ownerConversationId
        : base.ownerConversationId,
    ownerSessionId:
      patch.ownerSessionId !== undefined
        ? patch.ownerSessionId
        : base.ownerSessionId,
    trigger: {
      triggerKind:
        patch.trigger?.triggerKind !== undefined
          ? patch.trigger.triggerKind
          : base.trigger.triggerKind,
      eventSourceId:
        patch.trigger?.eventSourceId !== undefined
          ? patch.trigger.eventSourceId
          : base.trigger.eventSourceId,
      sourceKind:
        patch.trigger?.sourceKind !== undefined
          ? patch.trigger.sourceKind
          : base.trigger.sourceKind,
      sourceLocator:
        patch.trigger?.sourceLocator !== undefined
          ? patch.trigger.sourceLocator
          : base.trigger.sourceLocator,
      matchKey:
        patch.trigger?.matchKey !== undefined
          ? patch.trigger.matchKey
          : base.trigger.matchKey,
      matcher:
        patch.trigger?.matcher !== undefined
          ? cloneRecord(patch.trigger.matcher)
          : cloneRecord(base.trigger.matcher),
      scheduleKind:
        patch.trigger?.scheduleKind !== undefined
          ? patch.trigger.scheduleKind
          : base.trigger.scheduleKind,
      scheduleExpr:
        patch.trigger?.scheduleExpr !== undefined
          ? patch.trigger.scheduleExpr
          : base.trigger.scheduleExpr,
      scheduleTimezone:
        patch.trigger?.scheduleTimezone !== undefined
          ? patch.trigger.scheduleTimezone
          : base.trigger.scheduleTimezone,
      intervalSeconds:
        patch.trigger?.intervalSeconds !== undefined
          ? patch.trigger.intervalSeconds
          : base.trigger.intervalSeconds,
      startsAt:
        patch.trigger?.startsAt !== undefined
          ? patch.trigger.startsAt
          : base.trigger.startsAt,
    },
    policy: {
      activeFrom:
        patch.policy?.activeFrom !== undefined
          ? patch.policy.activeFrom
          : base.policy?.activeFrom,
      activeUntil:
        patch.policy?.activeUntil !== undefined
          ? patch.policy.activeUntil
          : base.policy?.activeUntil,
      maxTriggerCount:
        patch.policy?.maxTriggerCount !== undefined
          ? patch.policy.maxTriggerCount
          : base.policy?.maxTriggerCount,
      completionStatus:
        patch.policy?.completionStatus !== undefined
          ? patch.policy.completionStatus
          : base.policy?.completionStatus,
    },
    delivery: {
      deliveryMode:
        patch.delivery?.deliveryMode !== undefined
          ? patch.delivery.deliveryMode
          : base.delivery.deliveryMode,
      conversationId:
        patch.delivery?.conversationId !== undefined
          ? patch.delivery.conversationId
          : base.delivery.conversationId,
      sessionId:
        patch.delivery?.sessionId !== undefined
          ? patch.delivery.sessionId
          : base.delivery.sessionId,
      conversationTitle:
        patch.delivery?.conversationTitle !== undefined
          ? patch.delivery.conversationTitle
          : base.delivery.conversationTitle,
      message:
        patch.delivery?.message !== undefined
          ? patch.delivery.message
          : base.delivery.message,
      wakeReason:
        patch.delivery?.wakeReason !== undefined
          ? patch.delivery.wakeReason
          : base.delivery.wakeReason,
      messageBlocks:
        patch.delivery?.messageBlocks !== undefined
          ? cloneContentBlocks(patch.delivery.messageBlocks)
          : cloneContentBlocks(base.delivery.messageBlocks),
      targetPolicy:
        patch.delivery?.targetPolicy !== undefined
          ? patch.delivery.targetPolicy
          : base.delivery.targetPolicy,
      participantActorIds:
        patch.delivery?.participantActorIds !== undefined
          ? [...patch.delivery.participantActorIds]
          : base.delivery.participantActorIds,
      participantUserIds:
        patch.delivery?.participantUserIds !== undefined
          ? [...patch.delivery.participantUserIds]
          : base.delivery.participantUserIds,
      recipientActorIds:
        patch.delivery?.recipientActorIds !== undefined
          ? [...patch.delivery.recipientActorIds]
          : base.delivery.recipientActorIds,
      recipientUserIds:
        patch.delivery?.recipientUserIds !== undefined
          ? [...patch.delivery.recipientUserIds]
          : base.delivery.recipientUserIds,
    },
    metadata:
      patch.metadata !== undefined ? cloneRecord(patch.metadata) : base.metadata,
  };
}

export function validateAutomationRuleCreatePayload(
  payload: AutomationRuleCreatePayload,
): AutomationRuleContractIssue[] {
  const issues: AutomationRuleContractIssue[] = [];

  if (!trimString(payload.name)) {
    issues.push({ path: "name", message: "Name is required" });
  }
  if (!trimString(payload.delivery.message)) {
    issues.push({ path: "delivery.message", message: "Visible system message is required" });
  }

  if (payload.trigger.triggerKind === "event") {
    if (!trimString(payload.trigger.eventSourceId)) {
      issues.push({
        path: "trigger.eventSourceId",
        message: "Event trigger requires an event source",
      });
    }
  } else {
    const scheduleKind =
      payload.trigger.scheduleKind ||
      (trimString(payload.trigger.startsAt)
        ? "at"
        : payload.trigger.intervalSeconds
          ? "interval"
          : "cron");
    if (scheduleKind === "cron" && !trimString(payload.trigger.scheduleExpr)) {
      issues.push({
        path: "trigger.scheduleExpr",
        message: "Cron triggers require a cron expression",
      });
    }
    if (
      scheduleKind === "interval" &&
      (!payload.trigger.intervalSeconds || payload.trigger.intervalSeconds <= 0)
    ) {
      issues.push({
        path: "trigger.intervalSeconds",
        message: "Interval triggers require a positive interval in seconds",
      });
    }
    if (
      scheduleKind === "at" &&
      !trimString(payload.trigger.startsAt)
    ) {
      issues.push({
        path: "trigger.startsAt",
        message: "Point-in-time schedules require a fire time",
      });
    }
  }

  if (
    payload.policy?.maxTriggerCount !== undefined &&
    (!Number.isInteger(payload.policy.maxTriggerCount) ||
      payload.policy.maxTriggerCount <= 0)
  ) {
    issues.push({
      path: "policy.maxTriggerCount",
      message: "maxTriggerCount must be a positive integer",
    });
  }

  if (
    trimString(payload.policy?.activeFrom) &&
    trimString(payload.policy?.activeUntil) &&
    new Date(payload.policy!.activeFrom!).getTime() >
      new Date(payload.policy!.activeUntil!).getTime()
  ) {
    issues.push({
      path: "policy.activeUntil",
      message: "activeUntil must be later than activeFrom",
    });
  }

  if (
    payload.trigger.triggerKind === "schedule" &&
    payload.trigger.scheduleKind === "at" &&
    trimString(payload.trigger.startsAt) &&
    trimString(payload.policy?.activeFrom) &&
    new Date(payload.trigger.startsAt!).getTime() <
      new Date(payload.policy!.activeFrom!).getTime()
  ) {
    issues.push({
      path: "trigger.startsAt",
      message: "Point-in-time schedule must not fire before activeFrom",
    });
  }

  if (
    payload.trigger.triggerKind === "schedule" &&
    payload.trigger.scheduleKind === "at" &&
    trimString(payload.trigger.startsAt) &&
    trimString(payload.policy?.activeUntil) &&
    new Date(payload.trigger.startsAt!).getTime() >
      new Date(payload.policy!.activeUntil!).getTime()
  ) {
    issues.push({
      path: "policy.activeUntil",
      message: "activeUntil must not be earlier than the scheduled fire time",
    });
  }

  if (
    payload.delivery.deliveryMode === "wake_session" &&
    !trimString(payload.delivery.sessionId)
  ) {
    issues.push({
      path: "delivery.sessionId",
      message: "wake_session requires a target session ID",
    });
  }

  if (
    payload.delivery.deliveryMode === "conversation_notice" &&
    !trimString(payload.delivery.conversationId)
  ) {
    issues.push({
      path: "delivery.conversationId",
      message: "conversation_notice requires a target conversation ID",
    });
  }

  if (
    payload.delivery.targetPolicy === "specified_members" &&
    (payload.delivery.recipientActorIds?.length || 0) +
      (payload.delivery.recipientUserIds?.length || 0) ===
      0
  ) {
    issues.push({
      path: "delivery.recipients",
      message: "specified_members requires at least one recipient",
    });
  }

  return issues;
}

export function buildAutomationRuleCreatePayloadFromDraft(
  draft: AutomationRuleDraft,
): AutomationRuleDraftBuildResult {
  try {
    const trigger: AutomationRuleCreateTriggerPayload =
      draft.triggerKind === "event"
        ? {
            triggerKind: "event",
            eventSourceId: trimString(draft.eventSourceId),
            matcher: parseAutomationJsonObjectText(draft.matcherText, "matcher"),
          }
        : {
            triggerKind: "schedule",
            scheduleKind: draft.scheduleKind,
            scheduleExpr:
              draft.scheduleKind === "cron"
                ? trimString(draft.scheduleExpr)
                : undefined,
            scheduleTimezone:
              draft.scheduleKind === "cron"
                ? trimString(draft.scheduleTimezone) || "UTC"
                : undefined,
            intervalSeconds:
              draft.scheduleKind === "interval"
                ? Number.parseInt(draft.intervalSeconds, 10) || undefined
                : undefined,
            startsAt: toIsoString(draft.startsAt, "First fire"),
          };

    const payload: AutomationRuleCreatePayload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      ownerConversationId: trimString(draft.ownerConversationId),
      ownerSessionId: trimString(draft.ownerSessionId),
      trigger,
      policy: {
        activeFrom: toIsoString(draft.activeFrom, "Active from"),
        activeUntil: toIsoString(draft.activeUntil, "Active until"),
        maxTriggerCount: trimString(draft.maxTriggerCount)
          ? Number.parseInt(draft.maxTriggerCount, 10) || undefined
          : undefined,
        completionStatus: draft.completionStatus,
      },
      delivery: {
        deliveryMode: draft.deliveryMode,
        conversationId: trimString(draft.conversationId),
        sessionId: trimString(draft.sessionId),
        conversationTitle: trimString(draft.conversationTitle),
        message: draft.message.trim(),
        wakeReason: trimString(draft.wakeReason),
        targetPolicy: draft.targetPolicy,
        participantActorIds: parseAutomationIdList(draft.participantActorIds),
        participantUserIds: parseAutomationIdList(draft.participantUserIds),
        recipientActorIds: parseAutomationIdList(draft.recipientActorIds),
        recipientUserIds: parseAutomationIdList(draft.recipientUserIds),
      },
    };

    const issues = validateAutomationRuleCreatePayload(payload);
    if (issues.length > 0) {
      return {
        ok: false,
        error: issues[0]!.message,
        issues,
      };
    }

    return {
      ok: true,
      data: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid trigger configuration";
    return {
      ok: false,
      error: message,
      issues: [{ path: "draft", message }],
    };
  }
}
