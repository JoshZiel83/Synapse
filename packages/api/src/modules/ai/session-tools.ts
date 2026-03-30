import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import {
  describeAutomationDelivery,
  describeAutomationPolicy,
  describeAutomationTrigger,
  isThreadConversationKind,
  normalizeActorDocs,
  resolveThreadSemantics,
  summarizeActorForRole,
  textBlocks,
  type ActorDoc,
  type ToolDefinition,
  type ToolResolveContext,
  type RelayAuthorizationScope,
} from "@synapse/shared";
import type {
  ConversationMemberEntry,
  ConversationEntityRef,
  InteractionQuestionFieldDefinition,
  InteractionQuestionFieldType,
} from "@synapse/shared/types";
import {
  rethrowToolExecutionError,
  throwToolError,
} from "./tool-errors.js";
import { registerToolPlugin } from "./tool-plugins.js";
import { db } from "../../infrastructure/database/kysely.js";
import { sql } from "kysely";
import { getSession } from "../session/service.js";
import {
  sendConversationMessage,
  addMembersToConversation,
  getConversationMembers,
} from "../conversation/chat-service.js";
import { buildNormalizedMessageContent } from "../conversation/message-content.js";
import { buildDefaultUserMention } from "./inline-ref-resolver.js";
import { runMemorySearch } from "../memory/service.js";
import { readVisibleSkill } from "../skills/service.js";
import {
  listAutomationEventSources,
  listAutomationOccurrences,
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
} from "../automation/service.js";
import { actorSubject, authorizeAction } from "../access/service.js";
import {
  cancelToolCallTask,
  createToolCallTask,
  getToolCallTaskForSession,
  getToolCallTaskOutput,
  listToolCallTasksForSession,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js";
import {
  cancelInteractionRequestByTaskId,
  createQuestionInteractionRequest,
  createRelayAuthorizationInteractionRequest,
  findOpenRelayAuthorizationInteraction,
  getInteractionRequestSummaryByTaskId,
} from "../interactions/service.js";
import { resolveRelayTargetForNamespacedTool } from "../mcp-plugins/tool-resolver.js";
import { cancelRelayToolTask } from "../mcp-plugins/relay-manager.js";

type InviteableActor = {
  id: string;
  name: string;
  title?: string;
  role?: string;
  summary?: string;
};

type SendToCandidate = {
  type: "actor" | "user" | "external";
  memberId: string;
  participantId: string;
  actorId?: string;
  userId?: string;
  externalUserKey?: string;
  title?: string;
  role?: string;
  name: string;
  label: string;
  aliases: string[];
};

type UserInteractionCandidate = {
  memberId: string;
  userId: string;
  name: string;
  label: string;
};

type ToolQuestionFieldInput = {
  id?: string;
  type?: string;
  label?: string;
  description?: string;
  required?: boolean;
  options?: string[];
  allowOther?: boolean;
  otherLabel?: string;
  otherPlaceholder?: string;
  placeholder?: string;
  minSelections?: number;
  maxSelections?: number;
};

const sendToIntentSchema = z.enum(["reply", "request"]);
const sendToInputSchema = z
  .object({
    recipients: z.array(z.string().trim().min(1)).min(1).optional(),
    message: z.string().trim().min(1).max(12000),
    intent: sendToIntentSchema,
    summary: z.string().trim().min(1).max(240),
  })
  .strict();
const currentTimeInputSchema = z
  .object({
    timeZone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

function getToolContextConversationId(ctx: ToolResolveContext) {
  return ctx.conversationId;
}

function getToolContextConversationKind(ctx: ToolResolveContext) {
  return ctx.conversationKind;
}

function getToolContextConversationMembers(ctx: ToolResolveContext) {
  return ctx.conversationMembers;
}

function getThreadConversationId(session: {
  conversation_id?: string;
  conversation_kind?: string;
} | null | undefined) {
  return isThreadConversationKind(session?.conversation_kind)
    ? session?.conversation_id || null
    : null;
}

function normalizeRawSendToInput(input: Record<string, unknown>) {
  const rawRecipients = input.recipients;
  return {
    recipients: Array.isArray(rawRecipients)
      ? rawRecipients
      : typeof rawRecipients === "string"
        ? [rawRecipients]
        : rawRecipients,
    message: input.message,
    intent: input.intent,
    summary: input.summary ?? input.task,
  };
}

function formatUtcTimestamp(date: Date) {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function buildSendToDefinition(params: {
  conversationKind?: string;
  otherMembers: ConversationMemberEntry[];
}): ToolDefinition {
  const recipientNames = Array.from(
    new Set(params.otherMembers.map((member) => member.name)),
  );
  const rosterDesc = params.otherMembers
    .map((member) =>
      member.type === "user"
        ? `"${member.name}" (user)`
        : member.type === "external"
          ? `"${member.name}" (external${member.linkedUserName ? `, linked to workspace user ${member.linkedUserName}` : ""})`
          : `"${member.name}" (actor${member.title ? ", " + member.title : ""})`,
    )
    .join(", ");
  const semantics = resolveThreadSemantics({
    kind: params.conversationKind,
    otherParticipantCount: params.otherMembers.length,
  });

  if (
    semantics.addressingMode === "implicit_peer" &&
    params.otherMembers.length === 1
  ) {
    const peerName = params.otherMembers[0]!.name;
    return {
      name: "send_to",
      description: `Send a visible message to the other participant in this private thread. The recipient is implicit, so do not supply a recipients list unless you need to disambiguate a malformed roster. Current peer: ${rosterDesc}.`,
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Why you are sending this message.",
            enum: ["reply", "request"],
          },
          summary: {
            type: "string",
            description:
              "A concise structured summary. For reply, summarize what you are replying with. For request, summarize what you want the other participant to do or answer.",
          },
          message: {
            type: "string",
            description:
              `The visible message content sent directly to ${peerName}. To render a member reference clearly in the UI, use <Mention name="${peerName}"/> or an explicit id form like <Mention type="actor" id="..."/> whenever the sentence explicitly points to that person, such as ownership, responsibility, follow-up, or who to contact. Mention does not decide who the message is sent to. If a name is ambiguous, you must disambiguate with type+id or an explicit id attribute.`,
          },
        },
        required: ["intent", "summary", "message"],
      },
    };
  }

  return {
    name: "send_to",
    description: `Send a visible conversation message to one or more members in the current conversation. Mark whether it is a reply or a request, and provide a short summary for UI rendering. Recipients are the addressees. Inline mentions are rich body references for UI rendering and sentence clarity: use them when the message text explicitly points to a member, but do not add them mechanically just because someone is a recipient. Available recipients: ${rosterDesc}.`,
    parameters: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          description: "One or more member names to send the message to.",
          items: { type: "string", enum: recipientNames },
        },
        intent: {
          type: "string",
          description:
            'Use "reply" when you are replying back with information or a result. Use "request" when you are delegating, asking, or requesting action.',
          enum: ["reply", "request"],
        },
        summary: {
          type: "string",
          description:
            "A concise structured summary for the UI. For request, state the requested action or question. For reply, state the substantive reply.",
        },
        message: {
          type: "string",
          description:
            'The visible message content. To render a member reference clearly in the UI, use <Mention name="Alice"/> with the exact roster display name, or use an explicit id form like <Mention type="actor" id="..."/> whenever the sentence explicitly points to that person, such as ownership, responsibility, follow-up, or who to contact. Mention does not decide who the message is sent to, so do not add a mention only to mirror the recipient list. If a name matches multiple members, you must disambiguate with type+id or an explicit id attribute.',
        },
      },
      required: ["recipients", "intent", "summary", "message"],
    },
  };
}

function formatDateTimeInZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(date);
  const valueFor = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";

  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")} ${valueFor("hour")}:${valueFor("minute")}:${valueFor("second")} ${valueFor("timeZoneName")}`.trim();
}

function formatWeekdayInZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(date);
}

function buildSendToMention(candidate: SendToCandidate): ConversationEntityRef {
  return {
    memberId: candidate.memberId,
    participantId: candidate.participantId,
    memberType: candidate.type,
    actorId: candidate.actorId,
    userId: candidate.userId,
    externalUserKey: candidate.externalUserKey,
    name: candidate.name,
    title: candidate.title,
    role: candidate.role,
  };
}

function parseActorDocs(value: unknown): ActorDoc[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? normalizeActorDocs(parsed as ActorDoc[])
        : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? normalizeActorDocs(value as ActorDoc[]) : [];
}

function isGroupVisibleDoc(doc: ActorDoc): boolean {
  return (
    doc.visibility === "always" || doc.visibility === "multi_member_only"
  );
}

function summarizeInviteableActor(row: {
  title?: string | null;
  role?: string | null;
  actor_docs?: unknown;
}): string | undefined {
  const docs = parseActorDocs(row.actor_docs).filter(isGroupVisibleDoc);
  const summary = summarizeActorForRole(docs, row.title || row.role || "Actor")
    .replace(/\s+/g, " ")
    .trim();

  return summary || undefined;
}

function formatInviteableActor(actor: InviteableActor): string {
  const title = actor.title || actor.role || "Actor";
  return `${actor.name} (${title}) [${actor.id}]${actor.summary ? ` - ${actor.summary}` : ""}`;
}

function normalizeRecipientAlias(value: string) {
  return value.trim().toLowerCase();
}

function buildSendToCandidates(
  members: any[],
  currentActorId?: string,
): SendToCandidate[] {
  const candidates: SendToCandidate[] = [];

  for (const member of members) {
    if (member.state !== "active") continue;

    if (member.actor_id) {
      if (member.actor_id === currentActorId) continue;
      const name = member.actor_name || "Unknown actor";
      const title = member.actor_title || member.actor_role || "Actor";
      candidates.push({
        type: "actor",
        memberId: member.id,
        participantId: member.id,
        actorId: member.actor_id,
        title: member.actor_title || undefined,
        role: member.actor_role || undefined,
        name,
        label: `"${name}" (actor${title ? `, ${title}` : ""})`,
        aliases: [name],
      });
      continue;
    }

    if (member.user_id) {
      const name = member.user_name || "User";
      const transportKind =
        member.transport_kind === "feishu" || member.transport_kind === "weixin"
          ? member.transport_kind
          : undefined;
      const transportLabel = transportKind
        ? `, reachable via ${transportKind === "feishu" ? "Feishu" : "WeChat"}`
        : "";
      candidates.push({
        type: "user",
        memberId: member.id,
        participantId: member.id,
        userId: member.user_id,
        name,
        title: "Workspace user",
        label: `"${name}" (user${transportLabel})`,
        aliases: [name],
      });
      continue;
    }

    if (member.member_type === "external") {
      const linkedUserName =
        (member.linked_user_name as string | null) || undefined;
      const name =
        (member.transport_display_name as string | null) ||
        (member.display_name as string | null) ||
        linkedUserName ||
        "External participant";
      const aliases = Array.from(
        new Set(
          [name, linkedUserName].filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          ),
        ),
      );
      candidates.push({
        type: "external",
        memberId: member.id,
        participantId: member.id,
        externalUserKey:
          (member.transport_external_id as string | null) || undefined,
        name,
        title: linkedUserName
          ? `Linked workspace user: ${linkedUserName}`
          : "External participant",
        label:
          linkedUserName && linkedUserName !== name
            ? `"${name}" (external, linked to workspace user ${linkedUserName})`
            : `"${name}" (external)`,
        aliases,
      });
    }
  }

  return candidates;
}

function buildUserInteractionCandidates(
  members: any[],
): UserInteractionCandidate[] {
  const candidates: UserInteractionCandidate[] = [];

  for (const member of members) {
    const state =
      typeof member.state === "string" && member.state.trim().length > 0
        ? member.state
        : "active";
    if (state !== "active") continue;

    const userId =
      typeof member.user_id === "string" && member.user_id.trim().length > 0
        ? member.user_id
        : typeof member.userId === "string" && member.userId.trim().length > 0
          ? member.userId
          : member.type === "user" &&
              typeof member.id === "string" &&
              member.id.trim().length > 0
            ? member.id
            : null;
    if (!userId) continue;

    const memberId =
      typeof member.participantId === "string" &&
      member.participantId.trim().length > 0
        ? member.participantId
        : typeof member.id === "string" && member.id.trim().length > 0
          ? member.id
          : null;
    if (!memberId) continue;

    const name =
      (typeof member.user_name === "string" && member.user_name.trim()) ||
      (typeof member.name === "string" && member.name.trim()) ||
      "User";
    candidates.push({
      memberId,
      userId,
      name,
      label: `"${name}" (user)`,
    });
  }

  return candidates;
}

function buildUserInteractionDirectory(candidates: UserInteractionCandidate[]) {
  return candidates
    .map((candidate) => `\`${candidate.memberId}\`: ${candidate.label}`)
    .join(", ");
}

function resolveUserInteractionCandidate(
  requestedMemberId: string,
  candidates: UserInteractionCandidate[],
) {
  const candidate =
    candidates.find((entry) => entry.memberId === requestedMemberId) || null;
  if (candidate) {
    return { candidate, error: null };
  }

  return {
    candidate: null,
    error: `targetMemberId must be one of: ${candidates.map((entry) => entry.memberId).join(", ")}`,
  };
}

async function createGovernedToolCallTask(params: {
  context: NonNullable<ReturnType<typeof getToolExecutionContext>>;
  executorKind:
    | "interaction_question"
    | "interaction_form"
    | "relay_authorization";
  deliveryPolicy: "human_interaction";
  requestPayload: Record<string, unknown>;
  summary: string;
  expiresAt?: string;
  supportsCancel?: boolean;
}) {
  const { context } = params;
  if (!context.toolCallId || !context.toolName) {
    throwToolError("No tool call context available for task governance");
  }
  if (!context.conversationId) {
    throwToolError(
      "Current tool call is not attached to a conversation that supports deferred follow-up",
    );
  }

  try {
    return await createToolCallTask({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      actorId: context.actorId,
      turnId: context.turnId,
      sourceToolCallId: context.toolCallId,
      sourceToolName: context.toolName,
      executorKind: params.executorKind,
      deliveryPolicy: params.deliveryPolicy,
      status: "input_required",
      statusMessage: params.summary,
      dispatchStatus: "input_requested",
      supportsCancel: params.supportsCancel === true,
      requestPayload: params.requestPayload,
      deadlineAt: params.expiresAt,
    });
  } catch (error) {
    throwToolError(
      error instanceof Error ? error.message : "Failed to create tool-call task",
    );
  }
}

function serializeTaskSummary(task: ToolCallTaskRecord) {
  return {
    taskId: task.id,
    toolName: task.sourceToolName,
    executorKind: task.executorKind,
    deliveryPolicy: task.deliveryPolicy,
    status: task.status,
    statusMessage: task.statusMessage,
    dispatchStatus: task.dispatchStatus,
    supportsCancel: task.supportsCancel,
    supportsOutputTail: task.supportsOutputTail,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    cancelRequestedAt: task.cancelRequestedAt,
    cancelReason: task.cancelReason,
    lastOutputSeq: task.lastOutputSeq,
    lastOutputAt: task.lastOutputAt,
  };
}

function serializeTaskDetails(task: ToolCallTaskRecord) {
  return {
    ...serializeTaskSummary(task),
    requestPayload: task.requestPayload,
    finalResultPayload: task.finalResultPayload,
    finalErrorPayload: task.finalErrorPayload,
    metadata: task.metadata,
  };
}

async function loadSessionTaskOrThrow(
  sessionId: string,
  taskId: string,
) {
  const task = await getToolCallTaskForSession(sessionId, taskId);
  if (!task) {
    throwToolError(`Task "${taskId}" was not found in this session.`);
  }
  return task;
}

async function cancelHumanInteractionTask(task: ToolCallTaskRecord, reason?: string) {
  const note = reason?.trim();
  const interaction = await cancelInteractionRequestByTaskId(task.id, note);
  const summary =
    note ||
    `Cancelled ${task.sourceToolName.replace(/_/g, " ")} before it completed.`;

  return cancelToolCallTask(task.id, {
    summary,
    finalResultPayload: {
      content: textBlocks(summary),
      isError: true,
    },
    finalErrorPayload: {
      code: "operation_cancelled",
      message: summary,
      interactionId: interaction?.id,
    },
    metadata: interaction?.id
      ? {
          interactionId: interaction.id,
        }
      : undefined,
  });
}

function normalizeQuestionFieldType(
  value: unknown,
): InteractionQuestionFieldType | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "single_select":
    case "single":
    case "radio":
      return "single_select";
    case "multi_select":
    case "multiple":
    case "checkbox":
      return "multi_select";
    case "text":
    case "input":
    case "textarea":
      return "text";
    default:
      return null;
  }
}

function buildQuestionFieldDefinition(
  rawField: ToolQuestionFieldInput,
  fallbackIndex: number,
): { field: InteractionQuestionFieldDefinition | null; error?: string } {
  const label = String(rawField.label || "").trim();
  if (!label) {
    return {
      field: null,
      error: `Field ${fallbackIndex + 1} is missing a label.`,
    };
  }

  const normalizedType = normalizeQuestionFieldType(rawField.type);
  const type =
    normalizedType ||
    (Array.isArray(rawField.options) ? "single_select" : "text");
  const id =
    String(rawField.id || `field_${fallbackIndex + 1}`).trim() ||
    `field_${fallbackIndex + 1}`;
  const field: InteractionQuestionFieldDefinition = {
    id,
    type,
    label,
    description:
      typeof rawField.description === "string"
        ? rawField.description.trim() || undefined
        : undefined,
    required: rawField.required !== false,
  };

  if (type === "text") {
    field.placeholder =
      typeof rawField.placeholder === "string"
        ? rawField.placeholder.trim() || undefined
        : undefined;
    return { field };
  }

  const optionLabels = Array.from(
    new Set(
      (Array.isArray(rawField.options) ? rawField.options : [])
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0),
    ),
  );
  if (optionLabels.length === 0) {
    return { field: null, error: `"${label}" requires at least one option.` };
  }

  field.options = optionLabels.map((optionLabel, optionIndex) => ({
    id: `${id}_option_${optionIndex + 1}`,
    label: optionLabel,
  }));
  field.allowOther = rawField.allowOther === true;
  field.otherLabel =
    typeof rawField.otherLabel === "string"
      ? rawField.otherLabel.trim() || undefined
      : undefined;
  field.otherPlaceholder =
    typeof rawField.otherPlaceholder === "string"
      ? rawField.otherPlaceholder.trim() || undefined
      : undefined;

  if (type === "multi_select") {
    if (
      typeof rawField.minSelections === "number" &&
      Number.isFinite(rawField.minSelections)
    ) {
      field.minSelections = Math.max(0, Math.trunc(rawField.minSelections));
    }
    if (
      typeof rawField.maxSelections === "number" &&
      Number.isFinite(rawField.maxSelections)
    ) {
      field.maxSelections = Math.max(1, Math.trunc(rawField.maxSelections));
    }
  }

  return { field };
}

const taskStatusFilterValues = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

const taskOutputStreamValues = [
  "combined",
  "stdout",
  "stderr",
  "system",
] as const;

function buildQuestionFieldDefinitions(rawFields: unknown): {
  fields: InteractionQuestionFieldDefinition[];
  error?: string;
} {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { fields: [], error: "fields must contain at least one question." };
  }

  const fields: InteractionQuestionFieldDefinition[] = [];
  const usedIds = new Set<string>();

  for (const [index, rawField] of rawFields.entries()) {
    if (!rawField || typeof rawField !== "object") {
      return { fields: [], error: `Field ${index + 1} is invalid.` };
    }
    const { field, error } = buildQuestionFieldDefinition(
      rawField as ToolQuestionFieldInput,
      index,
    );
    if (!field) {
      return { fields: [], error: error || `Field ${index + 1} is invalid.` };
    }
    if (usedIds.has(field.id)) {
      return { fields: [], error: `Field id "${field.id}" is duplicated.` };
    }
    usedIds.add(field.id);
    fields.push(field);
  }

  return { fields };
}

async function listInviteableActors(params: {
  workspaceId: string;
  conversationId: string;
  actorId: string;
}): Promise<InviteableActor[]> {
  const result = await db
    .selectFrom("actors as a")
    .leftJoin("actor_versions as current_version", (join) =>
      join
        .onRef("current_version.actor_id", "=", "a.id")
        .onRef("current_version.version", "=", "a.current_version"),
    )
    .select([
      "a.id",
      "a.name",
      "a.title",
      "a.role",
      sql`COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'key', avd.doc_key,
              'title', avd.title,
              'visibility', avd.visibility,
              'priority', avd.priority,
              'content', avd.content_blocks
            )
            ORDER BY avd.priority DESC, avd.created_at ASC
          )
          FROM actor_version_docs avd
          WHERE avd.actor_version_id = current_version.id
        ),
        '[]'::jsonb
      )`.as("actor_docs"),
    ])
    .where("a.workspace_id", "=", params.workspaceId)
    .where("a.is_active", "=", true)
    .where("a.id", "<>", params.actorId)
    .where(sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM conversation_members cm
      WHERE cm.conversation_id = ${params.conversationId}
        AND cm.actor_id = a.id
        AND cm.state = 'active'
    )`)
    .orderBy("a.name", "asc")
    .orderBy("a.id", "asc")
    .execute();

  return result.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    title: (row.title as string | null) || undefined,
    role: (row.role as string | null) || undefined,
    summary: summarizeInviteableActor(row),
  }));
}

function buildInviteActorDefinition(candidates: InviteableActor[]) {
  const candidateDirectory = candidates
    .map(
      (candidate) => `\`${candidate.id}\`: ${formatInviteableActor(candidate)}`,
    )
    .join("; ");

  return {
    name: "invite_actor",
    description:
      "Invite one or more new actors to join the current conversation. " +
      "Only the listed actors can be invited right now. " +
      `Available invite candidates: ${candidateDirectory}`,
    parameters: {
      type: "object",
      properties: {
        actorIds: {
          type: "array",
          description:
            "One or more actor IDs from the available invite candidate list.",
          items: {
            type: "string",
            enum: candidates.map((candidate) => candidate.id),
          },
          minItems: 1,
          uniqueItems: true,
        },
        reason: {
          type: "string",
          description:
            "Shared reason and initial instruction sent to every invited actor.",
        },
      },
      required: ["actorIds", "reason"],
    },
  };
}

/**
 * Register callable tool plugins.
 * Callable tools return results to the model for further reasoning.
 * Their `resolve(ctx)` determines availability per-session.
 */
export function registerCallableToolPlugins(): void {
  // ============ send_to (callable) ============
  registerToolPlugin({
    name: "read_skill",
    kind: "callable",
    definition: {
      name: "read_skill",
      description:
        "Read the description or an attachment of an installed skill package on demand. Use when a listed skill clearly matches the task and you need its detailed instructions or referenced text resources.",
      parameters: {
        type: "object",
        properties: {
          skillName: {
            type: "string",
            description: "The installed skill name/slug to read.",
          },
          path: {
            type: "string",
            description:
              "Optional relative attachment path inside the skill package. Omit it to read the skill description.",
          },
        },
        required: ["skillName"],
      },
    },
    resolve: (ctx) => {
      const availableSkills = ctx.availableSkills || [];
      if (availableSkills.length === 0) {
        return { active: false, definition: null as any };
      }
      const skillNames: string[] = Array.from(
        new Set(availableSkills.map((skill) => skill.slug)),
      );
      const skillList = availableSkills
        .map((skill) => `\`${skill.slug}\`: ${skill.description}`)
        .join("; ");
      return {
        active: true,
        definition: {
          name: "read_skill",
          description: `Read the contents of an installed skill package. Available skills: ${skillList}`,
          parameters: {
            type: "object",
            properties: {
              skillName: {
                type: "string",
                description: "The installed skill name/slug to read.",
                enum: skillNames,
              },
              path: {
                type: "string",
                description:
                  "Optional relative attachment path inside the skill package, for example references/checklist.md. Omit it to read the skill description.",
              },
            },
            required: ["skillName"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        throwToolError("Session not found");
      }

      const skillName = String((input as any).skillName || "").trim();
      const path =
        typeof (input as any).path === "string"
          ? String((input as any).path).trim()
          : undefined;
      if (!skillName) {
        throwToolError("skillName is required");
      }

      try {
        const result = await readVisibleSkill({
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          conversationId: session.conversation_id,
          skillName,
          assetPath: path || undefined,
        });

        return [
          `Skill: ${result.skill.name}`,
          `Slug: ${result.skill.slug}`,
          `Version: ${result.skill.version}`,
          `Path: ${result.asset.path}`,
          "",
          result.asset.textContent || "",
        ].join("\n");
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to read skill");
      }
    },
  });

  registerToolPlugin({
    name: "get_current_time",
    kind: "callable",
    definition: {
      name: "get_current_time",
      description:
        "Get the current wall-clock time. Returns ISO time, UTC time, the resolved timezone, a local formatted time string, weekday, and Unix milliseconds. Use when timing matters.",
      parameters: {
        type: "object",
        properties: {
          timeZone: {
            type: "string",
            description:
              "Optional IANA timezone such as Asia/Shanghai or America/Los_Angeles. Defaults to the server timezone.",
          },
        },
        required: [],
      },
    },
    execute: async (input) => {
      const parsed = currentTimeInputSchema.safeParse(input);
      if (!parsed.success) {
        throwToolError("Invalid input for get_current_time.", {
          details: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const now = new Date();
      const resolvedTimeZone =
        parsed.data.timeZone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC";

      try {
        const localTime = formatDateTimeInZone(now, resolvedTimeZone);
        const weekday = formatWeekdayInZone(now, resolvedTimeZone);
        return JSON.stringify({
          nowIso: now.toISOString(),
          utc: formatUtcTimestamp(now),
          unixMs: now.getTime(),
          timeZone: resolvedTimeZone,
          localTime,
          weekday,
        });
      } catch (error: any) {
        throwToolError(
          `Invalid timeZone "${resolvedTimeZone}". Use an IANA timezone such as Asia/Shanghai or America/Los_Angeles.`,
          {
            details: error?.message ? [error.message] : undefined,
          },
        );
      }
    },
  });

  registerToolPlugin({
    name: "send_to",
    kind: "callable",
    definition: {
      name: "send_to",
      description:
        "Send a visible conversation message in the current thread. In private threads the recipient is implicit; in group threads you must specify recipients. Always include whether this is a reply or a request, and include a short structured summary for UI rendering.",
      parameters: {
        type: "object",
        properties: {
          recipients: {
            type: "array",
            description:
              "Optional in private threads. Required in group threads. Member names to send to.",
            items: { type: "string" },
          },
          intent: {
            type: "string",
            description: "Why you are sending this message.",
            enum: ["reply", "request"],
          },
          summary: {
            type: "string",
            description:
              "A concise structured summary. For reply, summarize what you are replying with. For request, summarize what you want the recipient(s) to do or answer.",
          },
          message: {
            type: "string",
            description:
              'The visible message content. To render a member reference clearly in the UI, use <Mention name="Alice"/> or an explicit id form like <Mention type="actor" id="..."/> whenever the sentence explicitly points to that person, such as ownership, responsibility, follow-up, or who to contact. Mention does not decide who the message is sent to; recipients and mentions have different meanings. If a name is ambiguous, you must disambiguate with type+id or an explicit id attribute.',
          },
        },
        required: ["recipients", "intent", "summary", "message"],
      },
    },
    resolve: (ctx) => {
      const conversationId = getToolContextConversationId(ctx);
      const conversationMembers = getToolContextConversationMembers(ctx);
      if (!conversationId || !conversationMembers?.length) {
        return { active: false, definition: null as any };
      }
      const otherMembers = conversationMembers.filter(
        (m) => m.type === "user" || m.id !== ctx.actorId,
      );
      if (otherMembers.length === 0) {
        return { active: false, definition: null as any };
      }
      return {
        active: true,
        definition: buildSendToDefinition({
          conversationKind: getToolContextConversationKind(ctx),
          otherMembers,
        }),
      };
    },
    execute: async (input) => {
      const parsed = sendToInputSchema.safeParse(
        normalizeRawSendToInput(input as Record<string, unknown>),
      );
      if (!parsed.success) {
        throwToolError("Invalid input for send_to.", {
          details: parsed.error.issues.map((issue) => issue.message),
        });
      }
      const {
        intent,
        summary,
        message,
      } = parsed.data;

      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      const conversationId = getThreadConversationId(session);
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation",
        );
      }

      const allMembers = await getConversationMembers(conversationId);
      const candidates = buildSendToCandidates(allMembers, context.actorId);
      const threadSemantics = resolveThreadSemantics({
        kind: session.conversation_kind,
        otherParticipantCount: candidates.length,
      });
      const aliasMap = new Map<string, SendToCandidate[]>();
      for (const candidate of candidates) {
        for (const alias of candidate.aliases) {
          const normalized = normalizeRecipientAlias(alias);
          if (!normalized) continue;
          const existing = aliasMap.get(normalized) || [];
          existing.push(candidate);
          aliasMap.set(normalized, existing);
        }
      }

      const targetParticipantIds: string[] = [];
      const resolved: string[] = [];
      const errors: string[] = [];
      let hasNonActorRecipients = false;
      const parsedRecipientNames = parsed.data.recipients ?? [];
      const recipientNames =
        threadSemantics.addressingMode === "implicit_peer" &&
        candidates.length === 1 &&
        parsedRecipientNames.length === 0
          ? [candidates[0]!.name]
          : parsedRecipientNames;

      if (
        threadSemantics.addressingMode === "explicit_recipients" &&
        recipientNames.length === 0
      ) {
        throwToolError("send_to requires recipients in a group thread.");
      }
      if (
        threadSemantics.addressingMode === "implicit_peer" &&
        recipientNames.length > 1
      ) {
        throwToolError(
          "A private thread can only send to the other current participant.",
        );
      }
      if (
        threadSemantics.addressingMode === "implicit_peer" &&
        candidates.length > 1 &&
        recipientNames.length === 0
      ) {
        throwToolError(
          "This private thread roster is ambiguous. Specify the recipient explicitly.",
        );
      }

      for (const name of recipientNames) {
        const normalizedName = normalizeRecipientAlias(name);
        const exactMatches = aliasMap.get(normalizedName) || [];
        if (exactMatches.length > 1) {
          const options = Array.from(
            new Set(exactMatches.map((candidate) => candidate.label)),
          );
          errors.push(
            `"${name}" is ambiguous. Matches: ${options.join(", ")}.`,
          );
          continue;
        }

        let candidate = exactMatches[0];
        if (!candidate) {
          let bestMatch: { candidate: SendToCandidate; dist: number } | null =
            null;
          for (const currentCandidate of candidates) {
            const distance = Math.min(
              ...currentCandidate.aliases.map((alias) =>
                levenshtein(normalizedName, normalizeRecipientAlias(alias)),
              ),
            );
            if (distance <= 2 && (!bestMatch || distance < bestMatch.dist)) {
              bestMatch = { candidate: currentCandidate, dist: distance };
            }
          }
          if (bestMatch) {
            errors.push(
              `"${name}" not found. Did you mean ${bestMatch.candidate.label}?`,
            );
          } else {
            errors.push(`"${name}" is not a member of this conversation.`);
          }
          continue;
        }

        if (!targetParticipantIds.includes(candidate.participantId)) {
          targetParticipantIds.push(candidate.participantId);
        }
        if (candidate.type !== "actor") {
          hasNonActorRecipients = true;
        }
        resolved.push(candidate.label);
      }

      if (resolved.length === 0) {
        const available = candidates.map((candidate) => candidate.label);
        throwToolError("No valid recipients found.", {
          details: errors,
          extra: { availableMembers: available },
        });
      }

      const isCoordination = !hasNonActorRecipients;
      const normalizedMessage = await buildNormalizedMessageContent({
        content: message,
        inlineReferences: {
          mentionCandidates: candidates.map(buildSendToMention),
          defaultUser: buildDefaultUserMention({
            userId: context.userId,
            userName: "User",
          }),
        },
      });
      if (normalizedMessage.referenceWarnings.length > 0) {
        throwToolError("Invalid inline references in message.", {
          details: normalizedMessage.referenceWarnings,
        });
      }

      await sendConversationMessage({
        conversationId,
        senderType: "actor",
        senderActorId: context.actorId,
        senderSessionId: context.sessionId,
        targetParticipantIds,
        content: message,
        contentBlocks: normalizedMessage.contentBlocks,
        metadata: {
          ...(isCoordination ? { coordination: true } : {}),
          sendToIntent: intent,
          sendToSummary: summary,
        },
      });

      const result: Record<string, unknown> = {
        success: true,
        intent,
        summary,
        sentTo: resolved,
        message: `Message sent to ${resolved.join(", ")}.`,
      };
      if (errors.length > 0) {
        result.warnings = errors;
      }
      return JSON.stringify(result);
    },
  });

  registerToolPlugin({
    name: "ask_user_question",
    kind: "callable",
    definition: {
      name: "ask_user_question",
      description:
        "Ask one specific user in the current conversation a structured question. Supports single-select, multi-select, and an optional other input. Only that targeted user will be able to answer it.",
      parameters: {
        type: "object",
        properties: {
          targetMemberId: {
            type: "string",
            description:
              "The exact conversation member ID of the target user in the current conversation.",
          },
          question: {
            type: "string",
            description: "The question to ask.",
          },
          instructions: {
            type: "string",
            description: "Optional short instructions or context for the user.",
          },
          options: {
            type: "array",
            description: "One or more answer choices shown to the user.",
            items: { type: "string" },
          },
          selectionMode: {
            type: "string",
            description:
              "Whether the user may pick one option or multiple options.",
            enum: ["single_select", "multi_select"],
          },
          allowOther: {
            type: "boolean",
            description:
              'Whether to allow a free-text "other" response in addition to the listed options.',
          },
          otherLabel: {
            type: "string",
            description: 'Optional label for the free-text "other" response.',
          },
          otherPlaceholder: {
            type: "string",
            description:
              'Optional placeholder for the free-text "other" response.',
          },
          minSelections: {
            type: "number",
            description:
              "Minimum number of selections when selectionMode is multi_select.",
          },
          maxSelections: {
            type: "number",
            description:
              "Maximum number of selections when selectionMode is multi_select.",
          },
        },
        required: ["targetMemberId", "question", "options"],
      },
    },
    resolve: (ctx) => {
      const conversationMembers = getToolContextConversationMembers(ctx);
      if (!getToolContextConversationId(ctx) || !conversationMembers?.length) {
        return { active: false, definition: null as any };
      }
      const candidates = buildUserInteractionCandidates(conversationMembers);
      if (candidates.length === 0) {
        return { active: false, definition: null as any };
      }
      const candidateDirectory = buildUserInteractionDirectory(candidates);
      return {
        active: true,
        definition: {
          name: "ask_user_question",
          description: `Ask exactly one user in this conversation a structured question. Supports single-select, multi-select, and optional other input. Only the targeted user can answer it. Available targetMemberId values: ${candidateDirectory}.`,
          parameters: {
            type: "object",
            properties: {
              targetMemberId: {
                type: "string",
                description:
                  "The exact conversation member ID of the target user in the current conversation.",
                enum: candidates.map((candidate) => candidate.memberId),
              },
              question: {
                type: "string",
                description: "The question to ask.",
              },
              instructions: {
                type: "string",
                description:
                  "Optional short instructions or context for the user.",
              },
              options: {
                type: "array",
                description: "One or more answer choices shown to the user.",
                items: { type: "string" },
              },
              selectionMode: {
                type: "string",
                description:
                  "Whether the user may pick one option or multiple options.",
                enum: ["single_select", "multi_select"],
              },
              allowOther: {
                type: "boolean",
                description: 'Whether to allow a free-text "other" response.',
              },
              otherLabel: {
                type: "string",
                description:
                  'Optional label for the free-text "other" response.',
              },
              otherPlaceholder: {
                type: "string",
                description:
                  'Optional placeholder for the free-text "other" response.',
              },
              minSelections: {
                type: "number",
                description:
                  "Minimum number of selections when selectionMode is multi_select.",
              },
              maxSelections: {
                type: "number",
                description:
                  "Maximum number of selections when selectionMode is multi_select.",
              },
            },
            required: ["targetMemberId", "question", "options"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      const conversationId = getThreadConversationId(session);
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation",
        );
      }

      const allMembers = await getConversationMembers(conversationId);
      const requesterMember = allMembers.find(
        (member) =>
          member.actor_id === context.actorId && member.state === "active",
      );
      if (!requesterMember) {
        throwToolError(
          "Current actor is not an active member of this conversation",
        );
      }

      const candidates = buildUserInteractionCandidates(allMembers);
      if (candidates.length === 0) {
        throwToolError("There are no active user members in this conversation");
      }

      const targetMemberId = String((input as any).targetMemberId || "").trim();
      const resolution = resolveUserInteractionCandidate(
        targetMemberId,
        candidates,
      );
      if (!resolution.candidate) {
        throwToolError(resolution.error || "Target user not found");
      }

      const question = String((input as any).question || "").trim();
      if (!question) {
        throwToolError("question is required");
      }

      const instructions =
        typeof (input as any).instructions === "string"
          ? String((input as any).instructions).trim()
          : "";
      const rawOptions = Array.isArray((input as any).options)
        ? (input as any).options
        : [];
      const optionLabels: string[] = Array.from(
        new Set(
          rawOptions
            .map((value: unknown) => String(value || "").trim())
            .filter((value: string) => value.length > 0),
        ),
      );
      if (optionLabels.length < 1) {
        throwToolError("options must contain at least one non-empty choice");
      }

      const selectionMode =
        normalizeQuestionFieldType((input as any).selectionMode) ||
        "single_select";
      if (selectionMode === "text") {
        throwToolError(
          "selectionMode must be single_select or multi_select",
        );
      }

      const field: InteractionQuestionFieldDefinition = {
        id: "field_1",
        type: selectionMode,
        label: question,
        required: true,
        options: optionLabels.map((label, index) => ({
          id: `field_1_option_${index + 1}`,
          label,
        })),
        allowOther: (input as any).allowOther === true,
        otherLabel:
          typeof (input as any).otherLabel === "string"
            ? String((input as any).otherLabel).trim() || undefined
            : undefined,
        otherPlaceholder:
          typeof (input as any).otherPlaceholder === "string"
            ? String((input as any).otherPlaceholder).trim() || undefined
            : undefined,
      };

      if (
        selectionMode === "multi_select" &&
        typeof (input as any).minSelections === "number" &&
        Number.isFinite((input as any).minSelections)
      ) {
        field.minSelections = Math.max(
          0,
          Math.trunc(Number((input as any).minSelections)),
        );
      }
      if (
        selectionMode === "multi_select" &&
        typeof (input as any).maxSelections === "number" &&
        Number.isFinite((input as any).maxSelections)
      ) {
        field.maxSelections = Math.max(
          1,
          Math.trunc(Number((input as any).maxSelections)),
        );
      }

      const task = await createGovernedToolCallTask({
        context,
        executorKind: "interaction_question",
        deliveryPolicy: "human_interaction",
        supportsCancel: true,
        requestPayload: {
          targetMemberId: resolution.candidate.memberId,
          targetUserId: resolution.candidate.userId,
          question,
          instructions: instructions || undefined,
          fields: [field],
        },
        summary: `Waiting for ${resolution.candidate.name} to answer "${question}".`,
      });

      let interaction;
      try {
        interaction = await createQuestionInteractionRequest({
          workspaceId: context.workspaceId,
          conversationId,
          taskId: task.id,
          requesterMemberId: requesterMember.id,
          requesterActorId: context.actorId,
          requesterUserId: context.userId,
          targetMemberId: resolution.candidate.memberId,
          targetUserId: resolution.candidate.userId,
          prompt: question,
          instructions: instructions || undefined,
          fields: [field],
        });
      } catch (error) {
        await cancelToolCallTask(task.id, {
          summary: `Question request for ${resolution.candidate.name} failed before dispatch.`,
          finalErrorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
          notifyActor: false,
        });
        throw error;
      }

      return JSON.stringify({
        success: true,
        taskId: task.id,
        interactionId: interaction.id,
        targetUser: resolution.candidate.name,
        message: `Question sent to ${resolution.candidate.name}. Only that user can answer it.`,
      });
    },
  });

  registerToolPlugin({
    name: "ask_user_form",
    kind: "callable",
    definition: {
      name: "ask_user_form",
      description:
        "Ask one specific user in the current conversation a structured multi-question form. Supports single-select, multi-select, and text input fields. Only that targeted user can answer it.",
      parameters: {
        type: "object",
        properties: {
          targetMemberId: {
            type: "string",
            description:
              "The exact conversation member ID of the target user in the current conversation.",
          },
          title: {
            type: "string",
            description: "Short title or prompt shown at the top of the form.",
          },
          instructions: {
            type: "string",
            description: "Optional instructions or context for the whole form.",
          },
          fields: {
            type: "array",
            description: "The questions or inputs shown to the user.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                type: {
                  type: "string",
                  enum: ["single_select", "multi_select", "text"],
                },
                label: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" },
                options: {
                  type: "array",
                  items: { type: "string" },
                },
                allowOther: { type: "boolean" },
                otherLabel: { type: "string" },
                otherPlaceholder: { type: "string" },
                placeholder: { type: "string" },
                minSelections: { type: "number" },
                maxSelections: { type: "number" },
              },
              required: ["type", "label"],
            } as any,
          },
        },
        required: ["targetMemberId", "title", "fields"],
      },
    },
    resolve: (ctx) => {
      const conversationMembers = getToolContextConversationMembers(ctx);
      if (!getToolContextConversationId(ctx) || !conversationMembers?.length) {
        return { active: false, definition: null as any };
      }
      const candidates = buildUserInteractionCandidates(conversationMembers);
      if (candidates.length === 0) {
        return { active: false, definition: null as any };
      }
      const candidateDirectory = buildUserInteractionDirectory(candidates);
      return {
        active: true,
        definition: {
          name: "ask_user_form",
          description: `Ask exactly one user in this conversation a structured form with one or more fields. Only the targeted user can answer it. Available targetMemberId values: ${candidateDirectory}.`,
          parameters: {
            type: "object",
            properties: {
              targetMemberId: {
                type: "string",
                description:
                  "The exact conversation member ID of the target user in the current conversation.",
                enum: candidates.map((candidate) => candidate.memberId),
              },
              title: {
                type: "string",
                description:
                  "Short title or prompt shown at the top of the form.",
              },
              instructions: {
                type: "string",
                description:
                  "Optional instructions or context for the whole form.",
              },
              fields: {
                type: "array",
                description: "The questions or inputs shown to the user.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    type: {
                      type: "string",
                      enum: ["single_select", "multi_select", "text"],
                    },
                    label: { type: "string" },
                    description: { type: "string" },
                    required: { type: "boolean" },
                    options: {
                      type: "array",
                      items: { type: "string" },
                    },
                    allowOther: { type: "boolean" },
                    otherLabel: { type: "string" },
                    otherPlaceholder: { type: "string" },
                    placeholder: { type: "string" },
                    minSelections: { type: "number" },
                    maxSelections: { type: "number" },
                  },
                  required: ["type", "label"],
                } as any,
              },
            },
            required: ["targetMemberId", "title", "fields"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      const conversationId = getThreadConversationId(session);
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation",
        );
      }

      const allMembers = await getConversationMembers(conversationId);
      const requesterMember = allMembers.find(
        (member) =>
          member.actor_id === context.actorId && member.state === "active",
      );
      if (!requesterMember) {
        throwToolError(
          "Current actor is not an active member of this conversation",
        );
      }

      const candidates = buildUserInteractionCandidates(allMembers);
      if (candidates.length === 0) {
        throwToolError("There are no active user members in this conversation");
      }

      const targetMemberId = String((input as any).targetMemberId || "").trim();
      const resolution = resolveUserInteractionCandidate(
        targetMemberId,
        candidates,
      );
      if (!resolution.candidate) {
        throwToolError(resolution.error || "Target user not found");
      }

      const title = String((input as any).title || "").trim();
      if (!title) {
        throwToolError("title is required");
      }

      const instructions =
        typeof (input as any).instructions === "string"
          ? String((input as any).instructions).trim()
          : "";

      const { fields, error } = buildQuestionFieldDefinitions(
        (input as any).fields,
      );
      if (error) {
        throwToolError(error);
      }

      const task = await createGovernedToolCallTask({
        context,
        executorKind: "interaction_form",
        deliveryPolicy: "human_interaction",
        supportsCancel: true,
        requestPayload: {
          targetMemberId: resolution.candidate.memberId,
          targetUserId: resolution.candidate.userId,
          title,
          instructions: instructions || undefined,
          fields,
        },
        summary: `Waiting for ${resolution.candidate.name} to complete "${title}".`,
      });

      let interaction;
      try {
        interaction = await createQuestionInteractionRequest({
          workspaceId: context.workspaceId,
          conversationId,
          taskId: task.id,
          requesterMemberId: requesterMember.id,
          requesterActorId: context.actorId,
          requesterUserId: context.userId,
          targetMemberId: resolution.candidate.memberId,
          targetUserId: resolution.candidate.userId,
          prompt: title,
          instructions: instructions || undefined,
          fields,
        });
      } catch (error) {
        await cancelToolCallTask(task.id, {
          summary: `Form request for ${resolution.candidate.name} failed before dispatch.`,
          finalErrorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
          notifyActor: false,
        });
        throw error;
      }

      return JSON.stringify({
        success: true,
        taskId: task.id,
        interactionId: interaction.id,
        targetUser: resolution.candidate.name,
        message: `Form sent to ${resolution.candidate.name}. Only that user can answer it.`,
      });
    },
  });

  registerToolPlugin({
    name: "request_relay_authorization",
    kind: "callable",
    definition: {
      name: "request_relay_authorization",
      description:
        "Create a relay runtime access approval request for the current conversation. Any current conversation user with permission to authorize that relay device will be able to approve or reject it.",
      parameters: {
        type: "object",
        properties: {
          relayToolName: {
            type: "string",
            description:
              "The exact namespaced relay tool name this authorization is for.",
          },
          reason: {
            type: "string",
            description: "Explain why the access is needed right now.",
          },
          capability: {
            type: "string",
            description: "The kind of runtime access to request.",
            enum: ["filesystem", "cua", "chrome"],
          },
          duration: {
            type: "string",
            description: "How long the authorization should last.",
            enum: ["session", "persistent"],
          },
          path: {
            type: "string",
            description:
              "Required for filesystem requests: the absolute path prefix to authorize.",
          },
          access: {
            type: "string",
            description:
              "Required for filesystem requests: the access level to request.",
            enum: ["read", "write", "read_write"],
          },
        },
        required: ["relayToolName", "reason", "capability", "duration"],
      },
    },
    resolve: (ctx) => {
      const conversationMembers = getToolContextConversationMembers(ctx);
      if (!getToolContextConversationId(ctx) || !conversationMembers?.length) {
        return { active: false, definition: null as any };
      }
      const candidates = buildUserInteractionCandidates(conversationMembers);
      if (candidates.length === 0) {
        return { active: false, definition: null as any };
      }
      return {
        active: true,
        definition: {
          name: "request_relay_authorization",
          description:
            "Create a relay runtime access approval request. Any current conversation user who has permission to authorize the target relay device will be able to approve or reject it. Use the exact relay tool name you already called.",
          parameters: {
            type: "object",
            properties: {
              relayToolName: {
                type: "string",
                description:
                  "The exact namespaced relay tool name this authorization is for.",
              },
              reason: {
                type: "string",
                description: "Explain why the access is needed right now.",
              },
              capability: {
                type: "string",
                description: "The kind of runtime access to request.",
                enum: ["filesystem", "cua", "chrome"],
              },
              duration: {
                type: "string",
                description: "How long the authorization should last.",
                enum: ["session", "persistent"],
              },
              path: {
                type: "string",
                description:
                  "Required for filesystem requests: the absolute path prefix to authorize.",
              },
              access: {
                type: "string",
                description:
                  "Required for filesystem requests: the access level to request.",
                enum: ["read", "write", "read_write"],
              },
            },
            required: ["relayToolName", "reason", "capability", "duration"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      const conversationId = getThreadConversationId(session);
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation",
        );
      }

      const allMembers = await getConversationMembers(conversationId);
      const requesterMember = allMembers.find(
        (member) =>
          member.actor_id === context.actorId && member.state === "active",
      );
      if (!requesterMember) {
        throwToolError(
          "Current actor is not an active member of this conversation",
        );
      }

      const candidates = buildUserInteractionCandidates(allMembers);
      if (candidates.length === 0) {
        throwToolError(
          "This conversation has no active user who could receive a relay authorization request",
        );
      }

      const relayToolName = String((input as any).relayToolName || "").trim();
      if (!relayToolName) {
        throwToolError("relayToolName is required");
      }

      const relayTarget = await resolveRelayTargetForNamespacedTool({
        actorId: context.actorId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        conversationId,
        userId: context.userId,
        namespacedToolName: relayToolName,
      });
      if (!relayTarget) {
        throwToolError(
          `Relay tool "${relayToolName}" is not currently available in this conversation.`,
        );
      }
      if (!relayTarget.runtimeSessionId) {
        throwToolError(
          "This relay tool does not have an active runtime session yet. Call the relay tool first, then request authorization.",
        );
      }

      const requesterAllowed = await authorizeAction({
        subject: actorSubject(context.actorId),
        action: "relay_exposure.request_authorization",
        resourceId: relayTarget.exposureId,
      });
      if (!requesterAllowed) {
        throwToolError(
          "Current actor is not allowed to request authorization for this relay exposure",
        );
      }

      const capability = String((input as any).capability || "").trim();
      const duration =
        (input as any).duration === "persistent" ? "persistent" : "session";
      let requestedScope: RelayAuthorizationScope;

      if (capability === "filesystem") {
        const path = String((input as any).path || "").trim();
        const access = String((input as any).access || "").trim();
        if (!path) {
          throwToolError(
            "path is required for filesystem authorization requests",
          );
        }
        if (
          access !== "read" &&
          access !== "write" &&
          access !== "read_write"
        ) {
          throwToolError(
            "access must be read, write, or read_write for filesystem requests",
          );
        }
        requestedScope = {
          capability: "filesystem",
          path,
          access: access as "read" | "write" | "read_write",
        };
      } else if (capability === "cua") {
        requestedScope = {
          capability: "cua",
          mode: "control",
        };
      } else if (capability === "chrome") {
        if (duration !== "persistent") {
          throwToolError(
            "chrome authorization requests must use persistent duration",
          );
        }
        requestedScope = {
          capability: "chrome",
        };
      } else {
        throwToolError("capability must be filesystem, cua, or chrome");
      }

      const reason = String((input as any).reason || "").trim();
      if (!reason) {
        throwToolError("reason is required");
      }

      const existing = await findOpenRelayAuthorizationInteraction({
        workspaceId: context.workspaceId,
        conversationId,
        requesterMemberId: requesterMember.id,
        relayDeviceId: relayTarget.deviceId,
        relayExposureId: relayTarget.exposureId,
        runtimeSessionId: relayTarget.runtimeSessionId,
        duration,
        requestedScope,
      });
      if (existing) {
        return JSON.stringify({
          success: true,
          interactionId: existing.id,
          relayDevice: relayTarget.deviceDisplayName,
          relayExposure: relayTarget.exposureDisplayName,
          message:
            existing.status === "approved_pending_apply"
              ? "A matching authorization request has already been approved and is waiting for the relay to apply it."
              : "A matching authorization request is already pending in this conversation. Wait for an authorized user to approve or reject it.",
        });
      }

      const authorizerCandidates = await Promise.all(
        candidates.map(async (candidate) => ({
          candidate,
          allowed: await authorizeAction({
            subject: { type: "user", id: candidate.userId },
            action: "relay_device.authorize_runtime_access",
            resourceId: relayTarget.deviceId,
          }),
        })),
      );
      const availableAuthorizers = authorizerCandidates
        .filter((entry) => entry.allowed)
        .map((entry) => entry.candidate);
      if (availableAuthorizers.length === 0) {
        throwToolError(
          "No active user in this conversation is currently allowed to authorize runtime access for this relay device",
        );
      }

      const task = await createGovernedToolCallTask({
        context,
        executorKind: "relay_authorization",
        deliveryPolicy: "human_interaction",
        supportsCancel: true,
        requestPayload: {
          relayDeviceId: relayTarget.deviceId,
          relayExposureId: relayTarget.exposureId,
          runtimeSessionId: relayTarget.runtimeSessionId,
          relayToolName,
          reason,
          duration,
          requestedScope,
        },
        summary: `Waiting for a user to approve relay access for ${relayTarget.deviceDisplayName}.`,
      });

      let interaction;
      try {
        interaction = await createRelayAuthorizationInteractionRequest({
          workspaceId: context.workspaceId,
          conversationId,
          taskId: task.id,
          requesterMemberId: requesterMember.id,
          requesterActorId: context.actorId,
          requesterUserId: context.userId,
          relayDeviceId: relayTarget.deviceId,
          relayExposureId: relayTarget.exposureId,
          runtimeSessionId: relayTarget.runtimeSessionId,
          relayToolName,
          reason,
          duration,
          requestedScope,
        });
      } catch (error) {
        await cancelToolCallTask(task.id, {
          summary: `Relay authorization request for ${relayTarget.deviceDisplayName} failed before dispatch.`,
          finalErrorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
          notifyActor: false,
        });
        throw error;
      }

      return JSON.stringify({
        success: true,
        taskId: task.id,
        interactionId: interaction.id,
        approverCount: availableAuthorizers.length,
        relayDevice: relayTarget.deviceDisplayName,
        relayExposure: relayTarget.exposureDisplayName,
        message:
          availableAuthorizers.length === 1
            ? `Authorization request created. ${availableAuthorizers[0]!.name} can approve or reject it, and the relay will apply it locally if approved.`
            : `Authorization request created. ${availableAuthorizers.length} current conversation users can approve or reject it, and the relay will apply it locally if approved.`,
      });
    },
  });

  registerToolPlugin({
    name: "list_tasks",
    kind: "callable",
    definition: {
      name: "list_tasks",
      description:
        "List task-backed tool calls created in this session, including pending ask-user flows and async relay command execution.",
      parameters: {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            description:
              "Optional status filter. Omit it to list tasks of all statuses.",
            items: {
              type: "string",
              enum: [...taskStatusFilterValues],
            },
          },
          limit: {
            type: "number",
            description: "Optional maximum number of tasks to return.",
          },
        },
        required: [],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const statuses = Array.isArray((input as any).statuses)
        ? (input as any).statuses
            .map((value: unknown) => String(value || "").trim())
            .filter((value: string): value is (typeof taskStatusFilterValues)[number] =>
              (taskStatusFilterValues as readonly string[]).includes(value),
            )
        : [];
      const limit =
        typeof (input as any).limit === "number" &&
        Number.isFinite((input as any).limit)
          ? Math.max(1, Math.trunc(Number((input as any).limit)))
          : 20;

      const tasks = await listToolCallTasksForSession({
        sessionId: context.sessionId,
        statuses: statuses.length > 0 ? statuses : undefined,
        limit,
      });

      return JSON.stringify({
        success: true,
        tasks: tasks.map((task) => serializeTaskSummary(task)),
      });
    },
  });

  registerToolPlugin({
    name: "get_task_status",
    kind: "callable",
    definition: {
      name: "get_task_status",
      description:
        "Get the current status and final result metadata for one task in this session.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The exact task ID returned by a previous task-backed tool call.",
          },
        },
        required: ["taskId"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const taskId = String((input as any).taskId || "").trim();
      if (!taskId) {
        throwToolError("taskId is required");
      }

      const task = await loadSessionTaskOrThrow(context.sessionId, taskId);
      const interaction =
        task.executorKind === "interaction_question" ||
        task.executorKind === "interaction_form" ||
        task.executorKind === "relay_authorization"
          ? await getInteractionRequestSummaryByTaskId(task.id)
          : null;

      return JSON.stringify({
        success: true,
        task: serializeTaskDetails(task),
        interaction,
      });
    },
  });

  registerToolPlugin({
    name: "cancel_task",
    kind: "callable",
    definition: {
      name: "cancel_task",
      description:
        "Request cancellation for a task in this session. Human-interaction tasks cancel immediately; relay command tasks cancel best-effort.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The exact task ID returned by a previous task-backed tool call.",
          },
          reason: {
            type: "string",
            description: "Optional reason to record with the cancellation request.",
          },
        },
        required: ["taskId"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const taskId = String((input as any).taskId || "").trim();
      if (!taskId) {
        throwToolError("taskId is required");
      }

      const reason =
        typeof (input as any).reason === "string"
          ? String((input as any).reason).trim()
          : undefined;
      const task = await loadSessionTaskOrThrow(context.sessionId, taskId);

      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        return JSON.stringify({
          success: true,
          alreadyTerminal: true,
          task: serializeTaskDetails(task),
        });
      }

      if (!task.supportsCancel) {
        throwToolError(`Task "${task.id}" does not support cancellation.`);
      }

      const updated =
        task.executorKind === "relay_mcp"
          ? await cancelRelayToolTask(task.id, reason)
          : await cancelHumanInteractionTask(task, reason);
      const current = await loadSessionTaskOrThrow(context.sessionId, task.id);
      const interaction =
        current.executorKind === "interaction_question" ||
        current.executorKind === "interaction_form" ||
        current.executorKind === "relay_authorization"
          ? await getInteractionRequestSummaryByTaskId(current.id)
          : null;

      return JSON.stringify({
        success: true,
        message:
          updated?.status === "cancelled"
            ? `Task ${task.id} was cancelled.`
            : `Cancellation requested for task ${task.id}.`,
        task: serializeTaskDetails(current),
        interaction,
      });
    },
  });

  registerToolPlugin({
    name: "tail_task_output",
    kind: "callable",
    definition: {
      name: "tail_task_output",
      description:
        "Read the latest output chunks from a task-backed relay command execution in this session.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "The exact task ID returned by a previous async relay command call.",
          },
          afterSeq: {
            type: "number",
            description: "Optional cursor. Only return output chunks with seq greater than this value.",
          },
          limit: {
            type: "number",
            description: "Optional maximum number of output chunks to return.",
          },
          stream: {
            type: "string",
            description: "Optional output stream filter.",
            enum: [...taskOutputStreamValues],
          },
        },
        required: ["taskId"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const taskId = String((input as any).taskId || "").trim();
      if (!taskId) {
        throwToolError("taskId is required");
      }

      const task = await loadSessionTaskOrThrow(context.sessionId, taskId);
      if (!task.supportsOutputTail) {
        throwToolError(`Task "${task.id}" does not expose output tailing.`);
      }

      const afterSeq =
        typeof (input as any).afterSeq === "number" &&
        Number.isFinite((input as any).afterSeq)
          ? Math.max(0, Math.trunc(Number((input as any).afterSeq)))
          : 0;
      const limit =
        typeof (input as any).limit === "number" &&
        Number.isFinite((input as any).limit)
          ? Math.max(1, Math.trunc(Number((input as any).limit)))
          : 20;
      const stream =
        typeof (input as any).stream === "string" &&
        (taskOutputStreamValues as readonly string[]).includes(
          String((input as any).stream).trim(),
        )
          ? (String((input as any).stream).trim() as
              | "combined"
              | "stdout"
              | "stderr"
              | "system")
          : "combined";

      const chunks = await getToolCallTaskOutput({
        taskId: task.id,
        afterSeq,
        limit,
        stream,
      });

      return JSON.stringify({
        success: true,
        task: serializeTaskSummary(task),
        chunks,
        combinedText: chunks.map((chunk) => chunk.text).join("\n"),
        nextAfterSeq:
          chunks.length > 0 ? chunks[chunks.length - 1]!.seq : afterSeq,
      });
    },
  });

  // ============ invite_actor (callable) ============
  registerToolPlugin({
    name: "invite_actor",
    kind: "callable",
    definition: {
      name: "invite_actor",
      description:
        "Invite one or more new actors to join the current conversation.",
      parameters: {
        type: "object",
        properties: {
          actorIds: {
            type: "array",
            description: "Actor IDs to invite.",
            items: { type: "string" },
          },
          reason: {
            type: "string",
            description:
              "Reason for inviting / initial instruction for the actor(s)",
          },
        },
        required: ["actorIds", "reason"],
      },
    },
    resolve: async (ctx): Promise<{ active: boolean; definition: any }> => {
      const conversationId = getToolContextConversationId(ctx);
      if (!conversationId) {
        return { active: false, definition: null as any };
      }

      const candidates = await listInviteableActors({
        workspaceId: ctx.workspaceId,
        conversationId,
        actorId: ctx.actorId,
      });

      if (candidates.length === 0) {
        return { active: false, definition: null as any };
      }

      return {
        active: true,
        definition: buildInviteActorDefinition(candidates),
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      const conversationId = getThreadConversationId(session);
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation",
        );
      }

      const reason =
        typeof (input as any).reason === "string"
          ? String((input as any).reason).trim()
          : "";
      if (!reason) {
        throwToolError("reason is required");
      }

      const candidates = await listInviteableActors({
        workspaceId: session.workspace_id,
        conversationId,
        actorId: context.actorId,
      });
      const candidateById = new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
      );
      const candidatesByName = new Map<string, InviteableActor[]>();
      for (const candidate of candidates) {
        const key = candidate.name.trim().toLowerCase();
        const matches = candidatesByName.get(key) || [];
        matches.push(candidate);
        candidatesByName.set(key, matches);
      }

      const requestedActorIds = Array.isArray((input as any).actorIds)
        ? (input as any).actorIds
            .map((value: unknown) => String(value || "").trim())
            .filter(Boolean)
        : [];
      const fallbackNames = [
        typeof (input as any).actorName === "string"
          ? String((input as any).actorName).trim()
          : "",
        ...(Array.isArray((input as any).actorNames)
          ? (input as any).actorNames.map((value: unknown) =>
              String(value || "").trim(),
            )
          : []),
      ].filter(Boolean);

      const resolvedActors: InviteableActor[] = [];
      const resolutionErrors: string[] = [];

      for (const actorId of requestedActorIds) {
        const candidate = candidateById.get(actorId);
        if (!candidate) {
          resolutionErrors.push(
            `Actor ID "${actorId}" is not currently inviteable.`,
          );
          continue;
        }
        resolvedActors.push(candidate);
      }

      for (const actorName of fallbackNames) {
        const matches = candidatesByName.get(actorName.toLowerCase()) || [];
        if (matches.length === 0) {
          resolutionErrors.push(
            `Actor "${actorName}" is not currently inviteable.`,
          );
          continue;
        }
        if (matches.length > 1) {
          resolutionErrors.push(
            `Actor name "${actorName}" is ambiguous. Use actorIds instead: ${matches.map((candidate) => candidate.id).join(", ")}`,
          );
          continue;
        }
        resolvedActors.push(matches[0]!);
      }

      if (resolvedActors.length === 0) {
        throwToolError("No inviteable actors were resolved.", {
          details: resolutionErrors,
          extra: {
            availableCandidates: candidates.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              title: candidate.title || candidate.role || "Actor",
              summary: candidate.summary,
            })),
          },
        });
      }

      if (resolutionErrors.length > 0) {
        throwToolError("Some requested actors are invalid or ambiguous.", {
          details: resolutionErrors,
          extra: {
            availableCandidates: candidates.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              title: candidate.title || candidate.role || "Actor",
              summary: candidate.summary,
            })),
          },
        });
      }

      const uniqueActors = Array.from(
        new Map(
          resolvedActors.map((candidate) => [candidate.id, candidate]),
        ).values(),
      );

      try {
        const inviterMember = (await getConversationMembers(conversationId)).find(
          (member: any) =>
            member.actor_id === context.actorId && member.state === "active",
        );
        const inviterName = inviterMember?.actor_name || "Unknown";
        const addResult = await addMembersToConversation({
          conversationId,
          workspaceId: session.workspace_id,
          actorIds: uniqueActors.map((candidate) => candidate.id),
          initiator: {
            memberType: "actor",
            memberId: inviterMember?.id,
            actorId: context.actorId,
            name: inviterName,
          },
        });
        const invitedActorIds = new Set(
          (addResult.members || [])
            .filter((member: any) => member.type === "actor" && member.actorId)
            .map((member: any) => member.actorId as string),
        );
        const invitedActors = uniqueActors.filter((candidate) =>
          invitedActorIds.has(candidate.id),
        );
        const skippedActors = uniqueActors
          .filter((candidate) => !invitedActorIds.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            reason: "Actor already in conversation",
          }));

        if (invitedActors.length === 0) {
          throwToolError("No new actors were invited.", {
            extra: { skippedActors },
          });
        }

        await sendConversationMessage({
          conversationId,
          senderType: "actor",
          senderActorId: context.actorId,
          senderSessionId: context.sessionId,
          targetParticipantIds: invitedActors
            .map(
              (candidate) =>
                (addResult.members || []).find(
                  (member: any) =>
                    member.type === "actor" && member.actorId === candidate.id,
                )?.memberId,
            )
            .filter((memberId): memberId is string => Boolean(memberId)),
          content: reason,
        });

        return JSON.stringify({
          success: true,
          invitedActors: invitedActors.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            title: candidate.title || candidate.role || "Actor",
            summary: candidate.summary,
          })),
          skippedActors,
          message:
            invitedActors.length === 1
              ? `${invitedActors[0]!.name} has been invited to the conversation and notified.`
              : `${invitedActors.map((candidate) => candidate.name).join(", ")} have been invited to the conversation and notified.`,
        });
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to invite actor(s)");
      }
    },
  });

  // ============ memory_search (callable) ============
  registerToolPlugin({
    name: "memory_search",
    kind: "callable",
    definition: {
      name: "memory_search",
      description:
        "Search durable memories scoped to the current actor and conversation. Use when recalled memory is insufficient and you need deeper historical context.",
      parameters: {
        type: "object",
        properties: {
          queryText: {
            type: "string",
            description: "What you want to search for in memory.",
          },
          limit: {
            type: "string",
            description: "Optional result limit from 1 to 10.",
          },
        },
        required: ["queryText"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        throwToolError("Session not found");
      }

      const queryText = String((input as any).queryText || "").trim();
      const limit = Math.max(
        1,
        Math.min(10, parseInt(String((input as any).limit || "5"), 10) || 5),
      );
      if (!queryText) {
        throwToolError("queryText is required");
      }

      const result = await runMemorySearch(context.workspaceId, {
        queryText,
        actorId: context.actorId,
        conversationId: session.conversation_id,
        limit,
        metadata: {
          sessionId: context.sessionId,
          source: "memory_search_tool",
        },
      });

      return JSON.stringify({
        success: true,
        runId: result.run.id,
        results: result.memories.map((memory) => ({
          id: memory.id,
          ownerScope: memory.ownerScope,
          category: memory.category,
          textDigest: memory.textDigest,
          tags: memory.tags,
          finalScore: Number(memory.finalScore.toFixed(4)),
          matchedTerms: memory.matchedTerms || [],
        })),
      });
    },
  });

  registerToolPlugin({
    name: "schedule_self_wakeup",
    kind: "callable",
    definition: {
      name: "schedule_self_wakeup",
      description:
        "Create a scheduled automation that wakes this session in the future. The wakeup is delivered as a visible system notice in the current conversation and cannot impersonate a user.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short automation name." },
          scheduleKind: {
            type: "string",
            description: "Schedule type.",
            enum: ["cron", "at", "interval"],
          },
          scheduleExpr: {
            type: "string",
            description:
              "Cron expression when scheduleKind is cron, or an ISO timestamp when scheduleKind is at.",
          },
          intervalSeconds: {
            type: "number",
            description: "Interval in seconds when scheduleKind is interval.",
          },
          timezone: {
            type: "string",
            description:
              "IANA timezone for cron schedules, for example Asia/Shanghai.",
          },
          message: {
            type: "string",
            description: "System notice shown when the schedule fires.",
          },
          wakeReason: {
            type: "string",
            description:
              "Optional private wake reason injected into the session context when the schedule fires.",
          },
          activeUntil: {
            type: "string",
            description:
              "Optional ISO timestamp after which the schedule should stop triggering.",
          },
          maxTriggerCount: {
            type: "number",
            description:
              "Optional maximum number of times this schedule may trigger before it completes.",
          },
        },
        required: ["name", "scheduleKind", "message"],
      },
    },
    resolve: (ctx) => ({
      active: Boolean(ctx.sessionId),
      definition: {
        name: "schedule_self_wakeup",
        description:
          "Create a scheduled automation that wakes this session in the future as a visible system notice in the current conversation.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short automation name." },
            scheduleKind: {
              type: "string",
              description: "Schedule type.",
              enum: ["cron", "at", "interval"],
            },
            scheduleExpr: {
              type: "string",
              description:
                "Cron expression when scheduleKind is cron, or an ISO timestamp when scheduleKind is at.",
            },
            intervalSeconds: {
              type: "number",
              description: "Interval in seconds when scheduleKind is interval.",
            },
            timezone: {
              type: "string",
              description:
                "IANA timezone for cron schedules, for example Asia/Shanghai.",
            },
            message: {
              type: "string",
              description: "System notice shown when the schedule fires.",
            },
            wakeReason: {
              type: "string",
              description:
                "Optional private wake reason injected into the session context when the schedule fires.",
            },
            activeUntil: {
              type: "string",
              description:
                "Optional ISO timestamp after which the schedule should stop triggering.",
            },
            maxTriggerCount: {
              type: "number",
              description:
                "Optional maximum number of times this schedule may trigger before it completes.",
            },
          },
          required: ["name", "scheduleKind", "message"],
        },
      },
    }),
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        throwToolError("Session not found");
      }

      const name = String((input as any).name || "").trim();
      const scheduleKind = String((input as any).scheduleKind || "").trim();
      const scheduleExpr =
        typeof (input as any).scheduleExpr === "string"
          ? String((input as any).scheduleExpr).trim()
          : "";
      const intervalSeconds =
        typeof (input as any).intervalSeconds === "number"
          ? Number((input as any).intervalSeconds)
          : undefined;
      const timezone =
        typeof (input as any).timezone === "string"
          ? String((input as any).timezone).trim()
          : undefined;
      const message = String((input as any).message || "").trim();
      const wakeReason =
        typeof (input as any).wakeReason === "string"
          ? String((input as any).wakeReason).trim()
          : undefined;
      const activeUntil =
        typeof (input as any).activeUntil === "string"
          ? String((input as any).activeUntil).trim()
          : undefined;
      const maxTriggerCount =
        typeof (input as any).maxTriggerCount === "number"
          ? Number((input as any).maxTriggerCount)
          : undefined;

      if (!name || !message) {
        throwToolError("name and message are required");
      }

      try {
        const rule = await createAutomationRule(
          context.workspaceId,
          {
            kind: "session",
            userId: context.userId,
            actorId: context.actorId,
            sessionId: context.sessionId,
          },
          {
            name,
            description: `Self-scheduled wakeup for session ${context.sessionId}`,
            ownerConversationId: session.conversation_id,
            ownerSessionId: context.sessionId,
            trigger: {
              triggerKind: "schedule",
              scheduleKind: scheduleKind as any,
              scheduleExpr:
                scheduleKind === "at"
                  ? scheduleExpr
                  : scheduleExpr || undefined,
              scheduleTimezone: timezone || undefined,
              intervalSeconds,
              startsAt:
                scheduleKind === "at" ? scheduleExpr || undefined : undefined,
            },
            policy: {
              activeUntil: activeUntil || undefined,
              maxTriggerCount:
                Number.isInteger(maxTriggerCount) && (maxTriggerCount || 0) > 0
                  ? maxTriggerCount
                  : undefined,
            },
            delivery: {
              deliveryMode: "wake_session",
              sessionId: context.sessionId,
              message,
              wakeReason,
            },
          },
        );

        return JSON.stringify({
          success: true,
          automationId: rule.id,
          nextFireAt: rule.trigger.nextFireAt,
          message: `Scheduled self wakeup created: ${rule.name}.`,
        });
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to create schedule");
      }
    },
  });

  registerToolPlugin({
    name: "list_event_sources",
    kind: "callable",
    definition: {
      name: "list_event_sources",
      description:
        "List active automation event sources that this session can subscribe to.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    resolve: async (ctx) => {
      if (!ctx.sessionId) {
        return { active: false, definition: null as any };
      }
      const sources = await listAutomationEventSources(ctx.workspaceId, {
        status: "active",
      });
      if (sources.length === 0) {
        return { active: false, definition: null as any };
      }
      return {
        active: true,
        definition: {
          name: "list_event_sources",
          description: `List active automation event sources. ${sources.length} source(s) available in this workspace.`,
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      };
    },
    execute: async () => {
      const context = getToolExecutionContext();
      if (!context?.sessionId) {
        throwToolError("No session context available");
      }

      const sources = await listAutomationEventSources(context.workspaceId, {
        status: "active",
      });
      return JSON.stringify({
        success: true,
        eventSources: sources.map((source) => ({
          id: source.id,
          sourceKey: source.sourceKey,
          name: source.name,
          description: source.description,
          recommendedUsage: source.recommendedUsage,
          providerKind: source.providerKind,
          providerRef: source.providerRef,
        })),
      });
    },
  });

  registerToolPlugin({
    name: "subscribe_event",
    kind: "callable",
    definition: {
      name: "subscribe_event",
      description:
        "Subscribe this session to a registered event source. When the event matches, the current session will be woken with a visible system notice in the conversation.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short subscription name." },
          eventSourceId: {
            type: "string",
            description: "Registered event source ID.",
          },
          matcher: {
            type: "string",
            description:
              "Optional JSON object string used as a subset matcher against the incoming payload.",
          },
          message: {
            type: "string",
            description:
              "System notice shown when the event wakes this session.",
          },
          wakeReason: {
            type: "string",
            description:
              "Optional private wake reason injected into the session context when the event matches.",
          },
          once: {
            type: "boolean",
            description:
              "If true, automatically stop the subscription after the first matching event.",
          },
          activeUntil: {
            type: "string",
            description:
              "Optional ISO timestamp after which the subscription should expire.",
          },
          maxTriggerCount: {
            type: "number",
            description:
              "Optional maximum number of matched events before the subscription completes.",
          },
        },
        required: ["name", "eventSourceId", "message"],
      },
    },
    resolve: async (ctx) => {
      if (!ctx.sessionId) {
        return { active: false, definition: null as any };
      }
      const sources = await listAutomationEventSources(ctx.workspaceId, {
        status: "active",
      });
      if (sources.length === 0) {
        return { active: false, definition: null as any };
      }

      const directory = sources
        .map(
          (source) =>
            `\`${source.id}\`: ${source.name} (${source.providerKind}/${source.sourceKey}) - ${source.description}` +
            `${source.recommendedUsage ? ` Suggested usage: ${source.recommendedUsage}` : ""}`,
        )
        .join("; ");

      return {
        active: true,
        definition: {
          name: "subscribe_event",
          description: `Subscribe this session to an event source and wake it with a visible system notice when the event matches. Available sources: ${directory}`,
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short subscription name." },
              eventSourceId: {
                type: "string",
                description: "Registered event source ID.",
                enum: sources.map((source) => source.id),
              },
              matcher: {
                type: "string",
                description:
                  "Optional JSON object string used as a subset matcher against the incoming payload.",
              },
              message: {
                type: "string",
                description:
                  "System notice shown when the event wakes this session.",
              },
              wakeReason: {
                type: "string",
                description:
                  "Optional private wake reason injected into the session context when the event matches.",
              },
              once: {
                type: "boolean",
                description:
                  "If true, automatically stop the subscription after the first matching event.",
              },
              activeUntil: {
                type: "string",
                description:
                  "Optional ISO timestamp after which the subscription should expire.",
              },
              maxTriggerCount: {
                type: "number",
                description:
                  "Optional maximum number of matched events before the subscription completes.",
              },
            },
            required: ["name", "eventSourceId", "message"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        throwToolError("Session not found");
      }

      const name = String((input as any).name || "").trim();
      const eventSourceId = String((input as any).eventSourceId || "").trim();
      const matcherInput =
        typeof (input as any).matcher === "string"
          ? String((input as any).matcher).trim()
          : "";
      const message = String((input as any).message || "").trim();
      const wakeReason =
        typeof (input as any).wakeReason === "string"
          ? String((input as any).wakeReason).trim()
          : undefined;
      const once = Boolean((input as any).once);
      const activeUntil =
        typeof (input as any).activeUntil === "string"
          ? String((input as any).activeUntil).trim()
          : undefined;
      const maxTriggerCount =
        typeof (input as any).maxTriggerCount === "number"
          ? Number((input as any).maxTriggerCount)
          : undefined;

      if (!name || !eventSourceId || !message) {
        throwToolError("name, eventSourceId, and message are required");
      }

      let matcher: Record<string, unknown> | undefined;
      if (matcherInput) {
        try {
          const parsed = JSON.parse(matcherInput) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throwToolError("matcher must be a JSON object string");
          }
          matcher = parsed as Record<string, unknown>;
        } catch {
          throwToolError("matcher must be valid JSON");
        }
      }

      try {
        const rule = await createAutomationRule(
          context.workspaceId,
          {
            kind: "session",
            userId: context.userId,
            actorId: context.actorId,
            sessionId: context.sessionId,
          },
          {
            name,
            description: `Self event subscription for session ${context.sessionId}`,
            ownerConversationId: session.conversation_id,
            ownerSessionId: context.sessionId,
            trigger: {
              triggerKind: "event",
              eventSourceId,
              matcher,
            },
            policy: {
              activeUntil: activeUntil || undefined,
              maxTriggerCount: once
                ? 1
                : Number.isInteger(maxTriggerCount) &&
                    (maxTriggerCount || 0) > 0
                  ? maxTriggerCount
                  : undefined,
            },
            delivery: {
              deliveryMode: "wake_session",
              sessionId: context.sessionId,
              message,
              wakeReason,
            },
          },
        );

        return JSON.stringify({
          success: true,
          automationId: rule.id,
          eventSourceId: rule.trigger.eventSourceId,
          message: `Event subscription created: ${rule.name}.`,
        });
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to create event subscription");
      }
    },
  });

  registerToolPlugin({
    name: "view_event_source_history",
    kind: "callable",
    definition: {
      name: "view_event_source_history",
      description:
        "View recent historical occurrences for a registered event source.",
      parameters: {
        type: "object",
        properties: {
          eventSourceId: {
            type: "string",
            description: "Registered event source ID.",
          },
        },
        required: ["eventSourceId"],
      },
    },
    resolve: async (ctx) => {
      if (!ctx.sessionId) {
        return { active: false, definition: null as any };
      }
      const sources = await listAutomationEventSources(ctx.workspaceId);
      if (sources.length === 0) {
        return { active: false, definition: null as any };
      }
      return {
        active: true,
        definition: {
          name: "view_event_source_history",
          description:
            "View recent historical occurrences for a registered event source.",
          parameters: {
            type: "object",
            properties: {
              eventSourceId: {
                type: "string",
                description: "Registered event source ID.",
                enum: sources.map((source) => source.id),
              },
            },
            required: ["eventSourceId"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const eventSourceId = String((input as any).eventSourceId || "").trim();
      if (!eventSourceId) {
        throwToolError("eventSourceId is required");
      }

      const occurrences = await listAutomationOccurrences(context.workspaceId, {
        eventSourceId,
        limit: 20,
      });
      return JSON.stringify({
        success: true,
        eventSourceId,
        occurrences: occurrences.map((occurrence) => ({
          id: occurrence.id,
          occurredAt: occurrence.occurredAt,
          sourceKind: occurrence.sourceKind,
          eventSourceName: occurrence.eventSourceName,
          title: occurrence.displayTitle,
          summary: occurrence.displaySummary,
          description: occurrence.displayDescription,
          payload: occurrence.payload,
          sourceSnapshot: occurrence.sourceSnapshot,
        })),
      });
    },
  });

  registerToolPlugin({
    name: "list_automations",
    kind: "callable",
    definition: {
      name: "list_automations",
      description: "List the automations owned by the current session.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    resolve: (ctx) => ({
      active: Boolean(ctx.sessionId),
      definition: {
        name: "list_automations",
        description: "List the automations owned by the current session.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    }),
    execute: async () => {
      const context = getToolExecutionContext();
      if (!context?.sessionId) {
        throwToolError("No session context available");
      }

      const rules = await listAutomationRules(context.workspaceId, {
        ownerSessionId: context.sessionId,
      });
      return JSON.stringify({
        success: true,
        automations: rules.map((rule) => {
          const triggerDisplay = describeAutomationTrigger(rule.trigger);
          const policyDisplay = describeAutomationPolicy(rule.policy);
          const deliveryDisplay = describeAutomationDelivery(rule.delivery);
          return {
            id: rule.id,
            name: rule.name,
            category: rule.category,
            status: rule.status,
            triggerKind: rule.trigger.triggerKind,
            triggerTitle: triggerDisplay.title,
            triggerSummary: triggerDisplay.summary,
            triggerDescription: triggerDisplay.description,
            triggerDetails: triggerDisplay.details,
            policySummary: policyDisplay.summary,
            policyDescription: policyDisplay.description,
            policyDetails: policyDisplay.details,
            deliveryTitle: deliveryDisplay.title,
            deliverySummary: deliveryDisplay.summary,
            deliveryDescription: deliveryDisplay.description,
            deliveryDetails: deliveryDisplay.details,
            eventSourceId: rule.trigger.eventSourceId,
            eventSourceName: rule.trigger.eventSourceName,
            sourceKind: rule.trigger.sourceKind,
            matchKey: rule.trigger.matchKey,
            nextFireAt: rule.trigger.nextFireAt,
            deliveryMode: rule.delivery.deliveryMode,
          };
        }),
      });
    },
  });

  registerToolPlugin({
    name: "cancel_automation",
    kind: "callable",
    definition: {
      name: "cancel_automation",
      description:
        "Delete one of the automations owned by the current session.",
      parameters: {
        type: "object",
        properties: {
          automationId: {
            type: "string",
            description: "Automation ID to delete.",
          },
        },
        required: ["automationId"],
      },
    },
    resolve: async (ctx) => {
      if (!ctx.sessionId) {
        return { active: false, definition: null as any };
      }
      const rules = await listAutomationRules(ctx.workspaceId, {
        ownerSessionId: ctx.sessionId,
      });
      if (rules.length === 0) {
        return { active: false, definition: null as any };
      }
      return {
        active: true,
        definition: {
          name: "cancel_automation",
          description:
            "Delete one of the automations owned by the current session.",
          parameters: {
            type: "object",
            properties: {
              automationId: {
                type: "string",
                enum: rules.map((rule) => rule.id),
                description: "Automation ID to delete.",
              },
            },
            required: ["automationId"],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context?.sessionId) {
        throwToolError("No session context available");
      }
      const automationId = String((input as any).automationId || "").trim();
      if (!automationId) {
        throwToolError("automationId is required");
      }

      const rules = await listAutomationRules(context.workspaceId, {
        ownerSessionId: context.sessionId,
      });
      const rule = rules.find((entry) => entry.id === automationId);
      if (!rule) {
        throwToolError("Automation not found in this session scope");
      }

      await deleteAutomationRule(context.workspaceId, automationId, {
        userId: context.userId,
        actorId: context.actorId,
      });
      return JSON.stringify({
        success: true,
        automationId,
        message: `Automation deleted: ${rule.name}.`,
      });
    },
  });

  // ============ sleep (callable) ============
  registerToolPlugin({
    name: "sleep",
    kind: "callable",
    definition: {
      name: "sleep",
      description:
        "Enter idle/sleeping state after completing your current work. You will be woken up when someone sends you a message in this conversation.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "Brief summary of what you accomplished before sleeping",
          },
        },
        required: ["summary"],
      },
    },
    resolve: (ctx) => ({
      active: !!getToolContextConversationId(ctx),
      definition: {
        name: "sleep",
        description:
          "Enter idle/sleeping state after completing your current work. You will be woken up when someone sends you a message in this conversation.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description:
                "Brief summary of what you accomplished before sleeping",
            },
          },
          required: ["summary"],
        },
      },
    }),
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        throwToolError("No session context available");
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        throwToolError("Session not found");
      }

      const summary =
        typeof (input as any).summary === "string"
          ? String((input as any).summary).trim()
          : "";

      return JSON.stringify({
        success: true,
        summary,
        message:
          "Sleep requested. The session will return to idle after this turn completes.",
      });
    },
  });
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ============ Tool Execution Context ============
// Uses AsyncLocalStorage so each concurrent BullMQ job has its own context.

interface ToolExecutionContext {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  userId?: string;
  turnId?: string;
  conversationId?: string;
  toolCallId?: string;
  toolName?: string;
}

const contextStorage = new AsyncLocalStorage<ToolExecutionContext>();

/**
 * Run `fn` with the given tool execution context bound via AsyncLocalStorage.
 */
export function runWithToolContext<T>(
  ctx: ToolExecutionContext,
  fn: () => T,
): T {
  return contextStorage.run(ctx, fn);
}

/** @deprecated Use runWithToolContext instead. Kept only as no-op for call sites that still call it. */
export function setToolExecutionContext(_ctx: ToolExecutionContext | null) {
  // no-op — context is now set via runWithToolContext / AsyncLocalStorage
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return contextStorage.getStore() ?? null;
}
