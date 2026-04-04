import { textBlocks } from "@synapse/shared";
import { v4 as uuidv4 } from "uuid";
import type {
  ConversationFeedItem,
  ConversationFeedEventPayloadMap,
  ConversationEntityRef,
  InteractionDecision,
  InteractionChoiceOption,
  InteractionQuestionFieldAnswer,
  InteractionQuestionFieldDefinition,
  InteractionQuestionFieldSummary,
  InteractionRequestKind,
  InteractionRequestStatus,
  InteractionRequestSummary,
  RuntimeAuthorizationInteractionSummary,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeGrantEffect,
} from "@synapse/shared/types";
import {
  enqueueTransactionalEventDeliveries,
  type Queryable,
} from "../../infrastructure/events/index.js";
import { transaction } from "../../infrastructure/database/index.js";
import {
  db,
  executeCompiledQuery,
  executeCompiledSql,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import {
  completeToolCallTask,
  failToolCallTask,
} from "../tool-call-tasks/service.js";
import { authorizeAction, userSubject } from "../access/service.js";
import {
  createConversationEvent,
  listConversationRealtimeRecipients,
  updateConversationItemEventPayload,
} from "../chat/service.js";
import { getFileUrlById } from "../files/service.js";
import { sql } from "kysely";
import {
  createRuntimeGrant,
  type RuntimeGrantRecord,
} from "../runtime-grants/service.js";

type RawInteractionRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  task_id: string | null;
  conversation_item_id: string | null;
  kind: InteractionRequestKind;
  status: InteractionRequestStatus;
  prompt_payload: unknown;
  requested_effect: unknown;
  request_payload: unknown;
  resolution_payload: unknown;
  resolved_at: string | Date | null;
  expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  requester_participant_id: string | null;
  requester_workspace_member_id: string | null;
  requester_actor_id: string | null;
  target_workspace_member_id: string | null;
  target_participant_id: string | null;
  resolved_by_workspace_member_id: string | null;
  resolved_by_participant_id: string | null;
  relay_capability_id: string | null;
  relay_device_id: string | null;
  relay_exposure_id: string | null;
  relay_tool_stable_key: string | null;
  contract_key: string | null;
  display_payload: unknown;
  device_display_name: string | null;
  exposure_display_name: string | null;
  exposure_stable_key: string | null;
  requester_participant_kind: string | null;
  requester_name: string | null;
  requester_title: string | null;
  requester_role: string | null;
  requester_actor_avatar_file_id: string | null;
  requester_user_avatar_file_id: string | null;
  requester_avatar_emoji: string | null;
  target_participant_kind: string | null;
  target_name: string | null;
  target_title: string | null;
  target_role: string | null;
  target_actor_avatar_file_id: string | null;
  target_user_avatar_file_id: string | null;
  target_avatar_emoji: string | null;
  resolved_by_participant_kind: string | null;
  resolved_by_name: string | null;
  resolved_by_title: string | null;
  resolved_by_role: string | null;
  resolved_by_actor_avatar_file_id: string | null;
  resolved_by_user_avatar_file_id: string | null;
  resolved_by_avatar_emoji: string | null;
};

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export interface CreateQuestionInteractionParams {
  workspaceId: string;
  conversationId: string;
  taskId: string;
  requesterParticipantId: string;
  requesterActorId?: string;
  requesterWorkspaceMemberId?: string;
  targetParticipantId: string;
  targetWorkspaceMemberId: string;
  prompt: string;
  instructions?: string;
  fields: InteractionQuestionFieldDefinition[];
  expiresAt?: string;
}

export interface CreateRuntimeAuthorizationInteractionParams {
  workspaceId: string;
  conversationId: string;
  taskId: string;
  requesterParticipantId: string;
  requesterActorId?: string;
  requesterWorkspaceMemberId?: string;
  relayCapabilityId: string;
  relayDeviceId: string;
  relayExposureId: string;
  runtimeSessionId: string;
  relayToolStableKey: string;
  contractKey: string;
  displayPayload: Record<string, unknown>;
  reason: string;
  requestedEffect: RuntimeGrantEffect;
  requestMode: RuntimeAuthorizationRequestMode;
  sourceRetryNonce?: string;
  sourceRequestArgs?: Record<string, unknown>;
  expiresAt?: string;
}

export interface ResolveInteractionRequestParams {
  interactionId: string;
  resolverWorkspaceMemberId: string;
  resolverParticipantId: string;
  answers?: InteractionQuestionFieldAnswer[];
  selectedOptionId?: string;
  decision?: InteractionDecision;
  preset?: RuntimeAuthorizationPreset;
  note?: string;
}

export interface ResolveInteractionRequestResult {
  interaction: InteractionRequestSummary;
  createdGrant?: RuntimeGrantRecord;
}

export interface FindOpenRuntimeAuthorizationInteractionParams {
  workspaceId: string;
  conversationId: string;
  requesterParticipantId: string;
  relayCapabilityId: string;
  relayDeviceId: string;
  relayExposureId: string;
  relayToolStableKey: string;
  contractKey: string;
  requestedEffect: RuntimeGrantEffect;
  requestMode: RuntimeAuthorizationRequestMode;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function entityAvatarUrl(actorAvatarFileId?: string | null, userAvatarFileId?: string | null) {
  if (actorAvatarFileId) return getFileUrlById(actorAvatarFileId);
  if (userAvatarFileId) return getFileUrlById(userAvatarFileId);
  return undefined;
}

function parseQuestionOptions(
  value: unknown,
  fallbackPrefix = "option",
): InteractionChoiceOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: InteractionChoiceOption[] = [];
  const usedIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item === "string") {
      const label = item.trim();
      if (!label) continue;
      const id = `${fallbackPrefix}_${index + 1}`;
      options.push({ id, label });
      usedIds.add(id);
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const rawId =
      typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id.trim()
        : "";
    const label =
      typeof (item as { label?: unknown }).label === "string"
        ? (item as { label: string }).label.trim()
        : "";
    const description =
      typeof (item as { description?: unknown }).description === "string"
        ? (item as { description: string }).description.trim()
        : undefined;
    if (!label) continue;
    let id = rawId || `${fallbackPrefix}_${index + 1}`;
    if (usedIds.has(id)) {
      id = `${fallbackPrefix}_${index + 1}`;
    }
    usedIds.add(id);
    options.push({
      id,
      label,
      description: description || undefined,
    });
  }
  return options;
}

function normalizeQuestionFieldType(
  value: unknown,
  hasOptions: boolean,
): InteractionQuestionFieldDefinition["type"] {
  if (typeof value === "string") {
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
        break;
    }
  }

  return hasOptions ? "single_select" : "text";
}

function parseQuestionFieldDefinitions(
  promptPayload: Record<string, unknown>,
): InteractionQuestionFieldDefinition[] {
  const rawFields = Array.isArray(promptPayload.fields)
    ? promptPayload.fields
    : null;
  const definitions: InteractionQuestionFieldDefinition[] = [];
  const usedIds = new Set<string>();

  if (rawFields) {
    for (const [index, field] of rawFields.entries()) {
      if (!field || typeof field !== "object") {
        continue;
      }
      const rawOptions = parseQuestionOptions(
        (field as { options?: unknown }).options,
        `field_${index + 1}_option`,
      );
      const type = normalizeQuestionFieldType(
        (field as { type?: unknown }).type,
        rawOptions.length > 0,
      );
      const label =
        typeof (field as { label?: unknown }).label === "string"
          ? (field as { label: string }).label.trim()
          : "";
      if (!label) {
        continue;
      }
      let id =
        typeof (field as { id?: unknown }).id === "string"
          ? (field as { id: string }).id.trim()
          : "";
      if (!id || usedIds.has(id)) {
        id = `field_${index + 1}`;
      }
      usedIds.add(id);

      const definition: InteractionQuestionFieldDefinition = {
        id,
        type,
        label,
        description:
          typeof (field as { description?: unknown }).description === "string"
            ? (field as { description: string }).description.trim() || undefined
            : undefined,
        required:
          typeof (field as { required?: unknown }).required === "boolean"
            ? Boolean((field as { required: boolean }).required)
            : undefined,
      };

      if (type === "text") {
        definition.placeholder =
          typeof (field as { placeholder?: unknown }).placeholder === "string"
            ? (field as { placeholder: string }).placeholder.trim() || undefined
            : undefined;
      } else {
        definition.options = rawOptions;
        definition.allowOther =
          typeof (field as { allowOther?: unknown }).allowOther === "boolean"
            ? Boolean((field as { allowOther: boolean }).allowOther)
            : undefined;
        definition.otherLabel =
          typeof (field as { otherLabel?: unknown }).otherLabel === "string"
            ? (field as { otherLabel: string }).otherLabel.trim() || undefined
            : undefined;
        definition.otherPlaceholder =
          typeof (field as { otherPlaceholder?: unknown }).otherPlaceholder === "string"
            ? (field as { otherPlaceholder: string }).otherPlaceholder.trim() || undefined
            : undefined;
        definition.minSelections =
          typeof (field as { minSelections?: unknown }).minSelections === "number"
          && Number.isFinite((field as { minSelections: number }).minSelections)
            ? Math.max(0, Math.trunc((field as { minSelections: number }).minSelections))
            : undefined;
        definition.maxSelections =
          typeof (field as { maxSelections?: unknown }).maxSelections === "number"
          && Number.isFinite((field as { maxSelections: number }).maxSelections)
            ? Math.max(1, Math.trunc((field as { maxSelections: number }).maxSelections))
            : undefined;
      }

      definitions.push(definition);
    }
  }

  if (definitions.length > 0) {
    return definitions;
  }

  const legacyOptions = parseQuestionOptions(promptPayload.options, "option");
  if (legacyOptions.length === 0) {
    return [];
  }

  return [
    {
      id: "field_1",
      type: "single_select",
      label:
        typeof promptPayload.prompt === "string" && promptPayload.prompt.trim()
          ? promptPayload.prompt.trim()
          : "Question",
      required: true,
      options: legacyOptions,
    },
  ];
}

function parseQuestionAnswers(
  resolutionPayload: Record<string, unknown>,
  fields: InteractionQuestionFieldDefinition[],
): InteractionQuestionFieldAnswer[] {
  const answers: InteractionQuestionFieldAnswer[] = [];

  if (Array.isArray(resolutionPayload.answers)) {
    for (const answer of resolutionPayload.answers) {
      if (!answer || typeof answer !== "object") {
        continue;
      }
      const fieldId =
        typeof (answer as { fieldId?: unknown }).fieldId === "string"
          ? (answer as { fieldId: string }).fieldId.trim()
          : "";
      if (!fieldId) {
        continue;
      }
      const selectedOptionIds = Array.isArray(
        (answer as { selectedOptionIds?: unknown }).selectedOptionIds,
      )
        ? Array.from(
            new Set(
              ((answer as { selectedOptionIds: unknown[] }).selectedOptionIds || [])
                .map((optionId) =>
                  typeof optionId === "string" ? optionId.trim() : "",
                )
                .filter((optionId) => optionId.length > 0),
            ),
          )
        : undefined;
      const selectedOptionLabels = Array.isArray(
        (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels,
      )
        ? ((answer as { selectedOptionLabels: unknown[] }).selectedOptionLabels || [])
            .map((label) => (typeof label === "string" ? label.trim() : ""))
            .filter((label) => label.length > 0)
        : undefined;
      const otherText =
        typeof (answer as { otherText?: unknown }).otherText === "string"
          ? (answer as { otherText: string }).otherText.trim() || undefined
          : undefined;
      const text =
        typeof (answer as { text?: unknown }).text === "string"
          ? (answer as { text: string }).text.trim() || undefined
          : undefined;
      answers.push({
        fieldId,
        selectedOptionIds,
        selectedOptionLabels,
        otherText,
        text,
      });
    }
  }

  if (answers.length > 0) {
    return answers;
  }

  const legacySelectedOptionId =
    typeof resolutionPayload.selectedOptionId === "string"
      ? resolutionPayload.selectedOptionId.trim()
      : "";
  if (!legacySelectedOptionId || fields.length === 0) {
    return [];
  }
  const legacyField = fields[0];
  const legacyOption = (legacyField.options || []).find(
    (option: InteractionChoiceOption) => option.id === legacySelectedOptionId,
  );
  return [
    {
      fieldId: legacyField.id,
      selectedOptionIds: [legacySelectedOptionId],
      selectedOptionLabels: legacyOption ? [legacyOption.label] : undefined,
    },
  ];
}

function buildQuestionFieldSummaries(
  promptPayload: Record<string, unknown>,
  resolutionPayload: Record<string, unknown>,
): InteractionQuestionFieldSummary[] {
  const definitions = parseQuestionFieldDefinitions(promptPayload);
  const answers = parseQuestionAnswers(resolutionPayload, definitions);
  const answerMap = new Map<string, InteractionQuestionFieldAnswer>();
  for (const answer of answers) {
    answerMap.set(answer.fieldId, answer);
  }

  return definitions.map((field) => {
    const answer = answerMap.get(field.id);
    const labels =
      answer?.selectedOptionIds?.map(
        (selectedId: string) =>
          (field.options || []).find(
            (option: InteractionChoiceOption) => option.id === selectedId,
          )?.label ||
          selectedId,
      ) || undefined;
    return {
      ...field,
      required: field.required !== false,
      answer: answer
        ? {
            ...answer,
            selectedOptionLabels:
              answer.selectedOptionLabels && answer.selectedOptionLabels.length > 0
                ? answer.selectedOptionLabels
                : labels,
          }
        : undefined,
    };
  });
}

function summarizeQuestionAnswers(
  question: InteractionRequestSummary["question"],
): string {
  if (!question) {
    return "a response";
  }

  const parts: string[] = [];
  for (const field of question.fields) {
    const answer = field.answer;
    if (!answer) continue;
    const valueParts: string[] = [];
    if (answer.selectedOptionLabels?.length) {
      valueParts.push(answer.selectedOptionLabels.join(", "));
    }
    if (answer.otherText) {
      valueParts.push(answer.otherText);
    }
    if (answer.text) {
      valueParts.push(answer.text);
    }
    if (valueParts.length === 0) {
      continue;
    }
    parts.push(
      question.fields.length === 1
        ? valueParts.join(", ")
        : `${field.label}: ${valueParts.join(", ")}`,
    );
  }

  if (parts.length === 0) {
    return "a response";
  }
  return parts.join(" | ");
}

function mapEntityRefFromRow(
  prefix: "requester" | "target" | "resolved_by",
  row: RawInteractionRow,
): ConversationEntityRef | undefined {
  const participantKind =
    row[`${prefix}_participant_kind` as keyof RawInteractionRow];
  if (typeof participantKind !== "string" || !participantKind.trim()) {
    return undefined;
  }
  const participantId =
    row[`${prefix}_participant_id` as keyof RawInteractionRow];
  const workspaceMemberId =
    prefix === "requester"
      ? row.requester_workspace_member_id
      : prefix === "target"
        ? row.target_workspace_member_id
        : row.resolved_by_workspace_member_id;
  const actorId =
    prefix === "requester" ? row.requester_actor_id : null;
  const name = row[`${prefix}_name` as keyof RawInteractionRow];
  const title = row[`${prefix}_title` as keyof RawInteractionRow];
  const role = row[`${prefix}_role` as keyof RawInteractionRow];
  const actorAvatarFileId =
    row[`${prefix}_actor_avatar_file_id` as keyof RawInteractionRow];
  const userAvatarFileId =
    row[`${prefix}_user_avatar_file_id` as keyof RawInteractionRow];
  const avatarEmoji =
    row[`${prefix}_avatar_emoji` as keyof RawInteractionRow];

  return {
    participantId: typeof participantId === "string" ? participantId : undefined,
    participantType: participantKind as ConversationEntityRef["participantType"],
    actorId: typeof actorId === "string" ? actorId : undefined,
    workspaceMemberId:
      typeof workspaceMemberId === "string" ? workspaceMemberId : undefined,
    name: typeof name === "string" ? name : undefined,
    title: typeof title === "string" ? title : undefined,
    role: typeof role === "string" ? role : undefined,
    avatarUrl: entityAvatarUrl(
      typeof actorAvatarFileId === "string" ? actorAvatarFileId : null,
      typeof userAvatarFileId === "string" ? userAvatarFileId : null,
    ),
    avatarEmoji: typeof avatarEmoji === "string" ? avatarEmoji : undefined,
  };
}

function buildInteractionSummary(row: RawInteractionRow): InteractionRequestSummary {
  const promptPayload = parseJsonObject(row.prompt_payload);
  const requestedEffect = parseJsonObject(row.requested_effect);
  const resolutionPayload = parseJsonObject(row.resolution_payload);
  const target = mapEntityRefFromRow("target", row);
  if (row.kind === "question_choice" && !target) {
    throw new Error(`Interaction ${row.id} is missing a target entity`);
  }

  let question: InteractionRequestSummary["question"];
  let runtimeAuthorization:
    | RuntimeAuthorizationInteractionSummary
    | undefined;

  if (row.kind === "question_choice") {
    question = {
      prompt:
        typeof promptPayload.prompt === "string" ? promptPayload.prompt : "",
      instructions:
        typeof promptPayload.instructions === "string"
          ? promptPayload.instructions
          : undefined,
      fields: buildQuestionFieldSummaries(promptPayload, resolutionPayload),
    };
  } else {
    runtimeAuthorization = {
      relayToolStableKey:
        typeof requestedEffect.relayToolStableKey === "string"
          ? requestedEffect.relayToolStableKey
          : "",
      reason:
        typeof requestedEffect.reason === "string" ? requestedEffect.reason : "",
      contractKey:
        typeof requestedEffect.contractKey === "string"
          ? requestedEffect.contractKey
          : "",
      displayPayload:
        requestedEffect.displayPayload &&
        typeof requestedEffect.displayPayload === "object"
          ? (requestedEffect.displayPayload as Record<string, unknown>)
          : {},
      deviceId: row.relay_device_id || "",
      deviceDisplayName: row.device_display_name || "Relay Device",
      relayCapabilityId: row.relay_capability_id || "",
      exposureId: row.relay_exposure_id || "",
      exposureDisplayName: row.exposure_display_name || "Relay Exposure",
      requestedEffect:
        (requestedEffect.requestedEffect as RuntimeGrantEffect | undefined) ||
        ({ capability: "cua", mode: "control" } as RuntimeGrantEffect),
      approvedPreset:
        typeof resolutionPayload.approvedPreset === "string"
          ? (resolutionPayload.approvedPreset as RuntimeAuthorizationPreset)
          : undefined,
      approvedGrant:
        resolutionPayload.approvedGrant &&
        typeof resolutionPayload.approvedGrant === "object"
          ? (resolutionPayload.approvedGrant as RuntimeAuthorizationInteractionSummary["approvedGrant"])
          : undefined,
      requestMode:
        requestedEffect.requestMode === "blocking" ? "blocking" : "background",
    };
  }

  return {
    id: row.id,
    taskId: row.task_id || undefined,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.conversation_item_id || undefined,
    kind: row.kind,
    status: row.status,
    requester: mapEntityRefFromRow("requester", row),
    ...(target ? { target } : {}),
    resolvedBy: mapEntityRefFromRow("resolved_by", row),
    resolutionNote:
      typeof resolutionPayload.note === "string"
        ? resolutionPayload.note
        : undefined,
    question,
    runtimeAuthorization,
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
    resolvedAt: toIsoString(row.resolved_at),
    expiresAt: toIsoString(row.expires_at),
  };
}

async function getInteractionRowById(
  interactionId: string,
  queryable?: Queryable,
) {
  const compiled = sql<RawInteractionRow>`
    SELECT ir.*,
            question.prompt_payload AS prompt_payload,
            auth.requested_effect AS requested_effect,
            auth.request_payload AS request_payload,
            COALESCE(question.resolution_payload, auth.resolution_payload, '{}'::jsonb) AS resolution_payload,
            auth.relay_device_id,
            auth.relay_capability_id,
            auth.relay_exposure_id,
            auth.relay_tool_stable_key,
            auth.contract_key,
            auth.display_payload,
            requester.participant_kind AS requester_participant_kind,
            COALESCE(requester_actor.name, requester_user.name, requester.display_name) AS requester_name,
            requester_actor.title AS requester_title,
            requester_actor.role AS requester_role,
            requester_actor.avatar_file_id AS requester_actor_avatar_file_id,
            requester_user.avatar_file_id AS requester_user_avatar_file_id,
            requester_actor.avatar_emoji AS requester_avatar_emoji,
            target.participant_kind AS target_participant_kind,
            COALESCE(target_actor.name, target_user.name, target.display_name) AS target_name,
            target_actor.title AS target_title,
            target_actor.role AS target_role,
            target_actor.avatar_file_id AS target_actor_avatar_file_id,
            target_user.avatar_file_id AS target_user_avatar_file_id,
            target_actor.avatar_emoji AS target_avatar_emoji,
            resolver.participant_kind AS resolved_by_participant_kind,
            COALESCE(resolver_actor.name, resolver_user.name, resolver.display_name) AS resolved_by_name,
            resolver_actor.title AS resolved_by_title,
            resolver_actor.role AS resolved_by_role,
            resolver_actor.avatar_file_id AS resolved_by_actor_avatar_file_id,
            resolver_user.avatar_file_id AS resolved_by_user_avatar_file_id,
            resolver_actor.avatar_emoji AS resolved_by_avatar_emoji,
            device.title AS device_display_name,
            exposure.display_name AS exposure_display_name,
            exposure.stable_key AS exposure_stable_key
     FROM interaction_requests ir
     LEFT JOIN interaction_question_requests question
       ON question.interaction_id = ir.id
     LEFT JOIN interaction_runtime_authorization_requests auth
       ON auth.interaction_id = ir.id
     LEFT JOIN conversation_participants requester
       ON requester.id = ir.requester_participant_id
     LEFT JOIN actors requester_actor
       ON requester_actor.id = requester.actor_id
     LEFT JOIN workspace_members requester_wm
       ON requester_wm.id = requester.workspace_member_id
     LEFT JOIN users requester_user
       ON requester_user.id = requester_wm.user_id
     LEFT JOIN conversation_participants target
       ON target.id = ir.target_participant_id
     LEFT JOIN actors target_actor
       ON target_actor.id = target.actor_id
     LEFT JOIN workspace_members target_wm
       ON target_wm.id = target.workspace_member_id
     LEFT JOIN users target_user
       ON target_user.id = target_wm.user_id
     LEFT JOIN conversation_participants resolver
       ON resolver.id = ir.resolved_by_participant_id
     LEFT JOIN actors resolver_actor
       ON resolver_actor.id = resolver.actor_id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN relay_devices device
       ON device.id = auth.relay_device_id
     LEFT JOIN relay_exposures exposure
       ON exposure.id = auth.relay_exposure_id
     WHERE ir.id = ${interactionId}
     LIMIT 1
  `.compile(db);
  const result = queryable
    ? await executeCompiledSql<RawInteractionRow>(queryable, compiled)
    : await db.executeQuery(compiled);
  return result.rows[0] || null;
}

async function queueInteractionUpdatedEvent(
  queryable: Queryable,
  interaction: InteractionRequestSummary,
) {
  const recipients = await listConversationRealtimeRecipients(
    interaction.conversationId,
    queryable,
  );
  await enqueueTransactionalEventDeliveries(queryable, {
    type: "interaction.updated",
    payload: {
      conversationId: interaction.conversationId,
      interactionId: interaction.id,
      itemId: interaction.itemId,
      interaction,
    },
    timestamp: interaction.updatedAt,
    recipients,
  });
}

async function syncInteractionEventPayload(
  interaction: InteractionRequestSummary,
  queryable?: Queryable,
) {
  if (!interaction.itemId) return;
  await updateConversationItemEventPayload(
    interaction.itemId,
    { interaction },
    queryable,
  );
}

function buildQuestionAsyncNotice(interaction: InteractionRequestSummary) {
  const prompt = interaction.question?.prompt?.trim() || "Question";
  const answer = summarizeQuestionAnswers(interaction.question);
  const targetName = interaction.target?.name || "A user";
  const resolutionNote = interaction.resolutionNote?.trim();
  const summary = `${targetName} answered "${prompt}".`;
  const lines = [
    summary,
    `Answer: ${answer}.`,
    resolutionNote ? `Note: ${resolutionNote}` : "",
  ].filter(Boolean);
  const messageBlocks = textBlocks(lines.join("\n"));

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: false,
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  };
}

function buildRuntimeAuthorizationRejectedNotice(
  interaction: InteractionRequestSummary,
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user";
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "relay device";
  const summary = `${resolverName} rejected access for ${deviceName}.`;
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Note: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean);
  const messageBlocks = textBlocks(lines.join("\n"));

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: true,
    },
    finalErrorPayload: {
      interactionId: interaction.id,
      reason: "rejected_by_user",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  };
}

function buildRuntimeAuthorizationApprovedNotice(
  interaction: InteractionRequestSummary,
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user";
  const deviceName =
    interaction.runtimeAuthorization?.deviceDisplayName || "relay device";
  const approvedPreset =
    interaction.runtimeAuthorization?.approvedPreset || "conversation";
  const summary = `${resolverName} approved ${approvedPreset} access for ${deviceName}.`;
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Note: ${interaction.resolutionNote.trim()}`
      : "",
  ].filter(Boolean);
  const messageBlocks = textBlocks(lines.join("\n"));

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: false,
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  };
}

function buildRuntimeAuthorizationSupersededNotice(
  interaction: InteractionRequestSummary,
) {
  const summary =
    "This authorization request was superseded by a newer user message.";
  const messageBlocks = textBlocks(summary);

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        interactionId: interaction.id,
        interaction,
      },
      isError: true,
    },
    finalErrorPayload: {
      interactionId: interaction.id,
      reason: "superseded",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  };
}

async function insertInteractionRequest(
  client: Queryable,
  params: {
  workspaceId: string;
  conversationId: string;
  taskId: string;
  requesterParticipantId: string;
  requesterWorkspaceMemberId?: string;
  requesterActorId?: string;
  kind: InteractionRequestKind;
  targetParticipantId?: string;
  targetWorkspaceMemberId?: string;
  expiresAt?: string;
}) {
  const interactionId = uuidv4();
  const created = await executeCompiledSql<{ id: string }>(
    client,
    sql<{ id: string }>`
      INSERT INTO interaction_requests (
        id,
        workspace_id,
        conversation_id,
        task_id,
        requester_participant_id,
        requester_workspace_member_id,
        requester_actor_id,
        kind,
        status,
        target_participant_id,
        target_workspace_member_id,
        expires_at
      )
      VALUES (
        ${interactionId},
        ${params.workspaceId},
        ${params.conversationId},
        ${params.taskId},
        ${params.requesterParticipantId},
        ${params.requesterWorkspaceMemberId || null},
        ${params.requesterActorId || null},
        ${params.kind},
        'pending',
        ${params.targetParticipantId || null},
        ${params.targetWorkspaceMemberId || null},
        ${params.expiresAt || null}
      )
      RETURNING id
    `.compile(db),
  );
  if (!created.rows[0]?.id) {
    throw new Error("Failed to create interaction request");
  }
  return created.rows[0]!.id;
}

async function insertQuestionInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string;
    promptPayload: Record<string, unknown>;
  },
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_question_requests").values({
      interaction_id: params.interactionId,
      prompt_payload:
        params.promptPayload as TableInsert<"interaction_question_requests">["prompt_payload"],
      resolution_payload:
        {} as TableInsert<"interaction_question_requests">["resolution_payload"],
    }),
  );
}

async function insertRuntimeAuthorizationInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string;
    relayDeviceId: string;
    relayCapabilityId: string;
    relayExposureId: string;
    relayToolStableKey: string;
    contractKey: string;
    requestedEffect: Record<string, unknown>;
    displayPayload: Record<string, unknown>;
    requestPayload: Record<string, unknown>;
  },
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_runtime_authorization_requests").values({
      interaction_id: params.interactionId,
      relay_device_id: params.relayDeviceId,
      relay_capability_id: params.relayCapabilityId,
      relay_exposure_id: params.relayExposureId,
      relay_tool_stable_key: params.relayToolStableKey,
      contract_key: params.contractKey,
      requested_effect:
        params.requestedEffect as TableInsert<"interaction_runtime_authorization_requests">["requested_effect"],
      display_payload:
        params.displayPayload as TableInsert<"interaction_runtime_authorization_requests">["display_payload"],
      request_payload:
        params.requestPayload as TableInsert<"interaction_runtime_authorization_requests">["request_payload"],
      resolution_payload:
        {} as TableInsert<"interaction_runtime_authorization_requests">["resolution_payload"],
    }),
  );
}

async function updateInteractionConversationItemId(
  client: Queryable,
  interactionId: string,
  conversationItemId: string,
) {
  await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
      .set({
        conversation_item_id: conversationItemId,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", interactionId),
  );
}

async function updateInteractionRequestRow(
  client: Queryable,
  interactionId: string,
  values: Record<string, unknown>,
) {
  await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
      .set(values)
      .where("id", "=", interactionId),
  );
}

async function updateInteractionResolutionPayload(
  client: Queryable,
  interactionKind: InteractionRequestKind,
  interactionId: string,
  payload: Record<string, unknown>,
) {
  if (interactionKind === "question_choice") {
    await executeCompiledQuery(
      client,
      db
        .updateTable("interaction_question_requests")
        .set({
          resolution_payload:
            payload as TableInsert<"interaction_question_requests">["resolution_payload"],
        })
        .where("interaction_id", "=", interactionId),
    );
    return;
  }

  await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_runtime_authorization_requests")
      .set({
        resolution_payload:
          payload as TableInsert<"interaction_runtime_authorization_requests">["resolution_payload"],
      })
      .where("interaction_id", "=", interactionId),
  );
}

export async function createQuestionInteractionRequest(
  params: CreateQuestionInteractionParams,
) {
  return transaction(async (client) => {
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      requesterActorId: params.requesterActorId,
      requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
      kind: "question_choice",
      targetParticipantId: params.targetParticipantId,
      targetWorkspaceMemberId: params.targetWorkspaceMemberId,
      expiresAt: params.expiresAt,
    });

    await insertQuestionInteractionDetails(client, {
      interactionId,
      promptPayload: {
        prompt: params.prompt,
        instructions: params.instructions,
        fields: params.fields,
      },
    });

    let interaction = await getInteractionRequestSummary(interactionId, client);
    if (!interaction) {
      throw new Error("Failed to load created interaction request");
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    });

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id,
    );

    interaction = await getInteractionRequestSummary(interactionId, client);
    if (!interaction) {
      throw new Error("Failed to reload created interaction request");
    }
    await syncInteractionEventPayload(interaction, client);
    return interaction;
  });
}

export async function createRuntimeAuthorizationInteractionRequest(
  params: CreateRuntimeAuthorizationInteractionParams,
) {
  return transaction(async (client) => {
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      requesterActorId: params.requesterActorId,
      requesterWorkspaceMemberId: params.requesterWorkspaceMemberId,
      kind: "runtime_authorization",
      expiresAt: params.expiresAt,
    });

    await insertRuntimeAuthorizationInteractionDetails(client, {
      interactionId,
      relayDeviceId: params.relayDeviceId,
      relayCapabilityId: params.relayCapabilityId,
      relayExposureId: params.relayExposureId,
      relayToolStableKey: params.relayToolStableKey,
      contractKey: params.contractKey,
      requestedEffect: {
        runtimeSessionId: params.runtimeSessionId,
        relayToolStableKey: params.relayToolStableKey,
        contractKey: params.contractKey,
        displayPayload: params.displayPayload,
        reason: params.reason,
        requestMode: params.requestMode,
        requestedEffect: params.requestedEffect,
      },
      displayPayload: params.displayPayload,
      requestPayload: {
        sourceRetryNonce: params.sourceRetryNonce,
        sourceRequestArgs: params.sourceRequestArgs || {},
      },
    });

    let interaction = await getInteractionRequestSummary(interactionId, client);
    if (!interaction) {
      throw new Error("Failed to load created interaction request");
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "interaction_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { interaction },
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      queryable: client,
    });

    await updateInteractionConversationItemId(
      client,
      interactionId,
      created.item.id,
    );

    interaction = await getInteractionRequestSummary(interactionId, client);
    if (!interaction) {
      throw new Error("Failed to reload created interaction request");
    }
    await syncInteractionEventPayload(interaction, client);
    return interaction;
  });
}

export async function findOpenRuntimeAuthorizationInteraction(
  params: FindOpenRuntimeAuthorizationInteractionParams,
) {
  const row = await db
    .selectFrom("interaction_requests as ir")
    .innerJoin(
      "interaction_runtime_authorization_requests as auth",
      "auth.interaction_id",
      "ir.id",
    )
    .select("ir.id")
    .where("ir.workspace_id", "=", params.workspaceId)
    .where("ir.conversation_id", "=", params.conversationId)
    .where(sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`)
    .where("ir.kind", "=", "runtime_authorization")
    .where("ir.status", "=", "pending")
    .where((eb) =>
      eb.or([
        eb("ir.expires_at", "is", null),
        eb("ir.expires_at", ">", new Date()),
      ]),
    )
    .where("auth.relay_device_id", "=", params.relayDeviceId)
    .where("auth.relay_capability_id", "=", params.relayCapabilityId)
    .where("auth.relay_exposure_id", "=", params.relayExposureId)
    .where(
      sql<boolean>`auth.relay_tool_stable_key = ${params.relayToolStableKey}`,
    )
    .where("auth.contract_key", "=", params.contractKey)
    .where(
      sql<boolean>`auth.requested_effect->'requestedEffect' = ${JSON.stringify(params.requestedEffect)}::jsonb`,
    )
    .where(
      sql<boolean>`auth.requested_effect->>'requestMode' = ${params.requestMode}`,
    )
    .orderBy("ir.updated_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const interactionId = row?.id;
  if (!interactionId) {
    return null;
  }
  return getInteractionRequestSummary(interactionId);
}

export async function getInteractionRequestSummary(
  interactionId: string,
  queryable?: Queryable,
) {
  const row = await getInteractionRowById(interactionId, queryable);
  return row ? buildInteractionSummary(row) : null;
}

export async function getInteractionRequestSummaryByTaskId(taskId: string) {
  const row = await db
    .selectFrom("interaction_requests")
    .select("id")
    .where("task_id", "=", taskId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();

  const interactionId = row?.id;
  if (!interactionId) {
    return null;
  }
  return getInteractionRequestSummary(interactionId);
}

export async function cancelInteractionRequestByTaskId(
  taskId: string,
  note?: string,
) {
  const interaction = await getInteractionRequestSummaryByTaskId(taskId);
  if (!interaction) {
    return null;
  }
  return cancelInteractionRequest(interaction.id, note);
}

export async function cancelInteractionRequest(
  interactionId: string,
  note?: string,
) {
  const existing = await getInteractionRowById(interactionId);
  if (!existing) {
    throw new Error("Interaction request not found");
  }

  if (
    existing.status !== "pending"
  ) {
    const current = await getInteractionRequestSummary(interactionId);
    if (!current) {
      throw new Error("Failed to reload interaction request");
    }
    return current;
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload);
  const interaction = await transaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      status: "cancelled",
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    });

    const payload = {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      cancelled: true,
    };

    await updateInteractionResolutionPayload(
      client,
      existing.kind,
      interactionId,
      payload,
    );
    const nextInteraction = await getInteractionRequestSummary(interactionId, client);
    if (!nextInteraction) {
      throw new Error("Failed to reload cancelled interaction");
    }
    await syncInteractionEventPayload(nextInteraction, client);
    await queueInteractionUpdatedEvent(client, nextInteraction);
    return nextInteraction;
  });

  return interaction;
}

export async function canUserViewInteraction(params: {
  interactionId: string;
  userId: string;
}) {
  const row = await db
    .selectFrom("interaction_requests as ir")
    .select("ir.id")
    .where("ir.id", "=", params.interactionId)
    .where((eb) =>
        eb.or([
        sql<boolean>`EXISTS (
          SELECT 1
          FROM workspace_members wm
          WHERE wm.id = ir.requester_workspace_member_id
            AND wm.user_id = ${params.userId}
        )`,
        eb.and([
          eb("ir.kind", "=", "question_choice"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = ir.target_workspace_member_id
              AND wm.user_id = ${params.userId}
          )`,
        ]),
        eb.and([
          eb("ir.kind", "=", "runtime_authorization"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM conversation_participants cm
            JOIN workspace_members wm
              ON wm.id = cm.workspace_member_id
            WHERE cm.conversation_id = ir.conversation_id
              AND wm.user_id = ${params.userId}
              AND cm.state = 'active'
          )`,
        ]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export async function canUserResolveInteraction(params: {
  interaction: InteractionRequestSummary;
  userId: string;
}) {
  const { interaction, userId } = params;
  if (interaction.status !== "pending") {
    return false;
  }

  if (interaction.kind === "question_choice") {
    const targetWorkspaceMemberId = interaction.target?.workspaceMemberId;
    if (!targetWorkspaceMemberId) {
      return false;
    }

    const viewerWorkspaceMember = await db
      .selectFrom("workspace_members")
      .select("id")
      .where("workspace_id", "=", interaction.workspaceId)
      .where("user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();

    return viewerWorkspaceMember?.id === targetWorkspaceMemberId;
  }

  const deviceId = interaction.runtimeAuthorization?.deviceId;
  if (!deviceId) {
    return false;
  }

  return authorizeAction({
    subject: userSubject(userId),
    action: "relay_device.authorize_runtime_access",
    resourceId: deviceId,
  });
}

export async function enrichInteractionForUser(
  interaction: InteractionRequestSummary,
  userId?: string,
): Promise<InteractionRequestSummary> {
  if (!userId) {
    if (interaction.viewerCanResolve === undefined) {
      return interaction;
    }
    const { viewerCanResolve, ...rest } = interaction;
    return rest;
  }

  return {
    ...interaction,
    viewerCanResolve: await canUserResolveInteraction({
      interaction,
      userId,
    }),
  };
}

export async function enrichFeedItemInteractionsForUser(
  item: ConversationFeedItem,
  userId?: string,
): Promise<ConversationFeedItem> {
  if (item.kind !== "event" || item.eventType !== "interaction_requested") {
    return item;
  }

  const payload = item.payload as ConversationFeedEventPayloadMap["interaction_requested"];
  const interaction =
    payload.interaction && typeof payload.interaction === "object"
      ? (payload.interaction as InteractionRequestSummary)
      : null;
  if (!interaction) {
    return item;
  }

  return {
    ...item,
    payload: {
      ...payload,
      interaction: await enrichInteractionForUser(interaction, userId),
    },
  };
}

function buildSubmittedQuestionAnswers(
  params: ResolveInteractionRequestParams,
  fields: InteractionQuestionFieldDefinition[],
): InteractionQuestionFieldAnswer[] {
  if (Array.isArray(params.answers) && params.answers.length > 0) {
    return params.answers.map((answer) => ({
      fieldId: String(answer.fieldId || "").trim(),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? Array.from(
            new Set(
              answer.selectedOptionIds
                .map((optionId: string) => String(optionId || "").trim())
                .filter((optionId: string) => optionId.length > 0),
            ),
          )
        : undefined,
      otherText:
        typeof answer.otherText === "string"
          ? answer.otherText.trim() || undefined
          : undefined,
      text:
        typeof answer.text === "string"
          ? answer.text.trim() || undefined
          : undefined,
    }));
  }

  const legacyField = fields[0];
  const selectedOptionId = String(params.selectedOptionId || "").trim();
  if (!legacyField || !selectedOptionId) {
    return [];
  }
  return [
    {
      fieldId: legacyField.id,
      selectedOptionIds: [selectedOptionId],
    },
  ];
}

function validateQuestionAnswers(
  fields: InteractionQuestionFieldDefinition[],
  submittedAnswers: InteractionQuestionFieldAnswer[],
) {
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const answerMap = new Map<string, InteractionQuestionFieldAnswer>();

  for (const answer of submittedAnswers) {
    if (!answer.fieldId) {
      throw new Error("Each answer requires a fieldId");
    }
    if (!fieldMap.has(answer.fieldId)) {
      throw new Error(`Unknown question field "${answer.fieldId}"`);
    }
    if (answerMap.has(answer.fieldId)) {
      throw new Error(`Duplicate answer for question field "${answer.fieldId}"`);
    }
    answerMap.set(answer.fieldId, answer);
  }

  const normalized: InteractionQuestionFieldAnswer[] = [];

  for (const field of fields) {
    const answer = answerMap.get(field.id);
    const required = field.required !== false;

    if (field.type === "text") {
      const text = answer?.text?.trim() || undefined;
      if (required && !text) {
        throw new Error(`"${field.label}" requires a response`);
      }
      if (text) {
        normalized.push({
          fieldId: field.id,
          text,
        });
      }
      continue;
    }

    const allowedOptions = field.options || [];
    const selectedOptionIds = Array.from(
      new Set(
        (answer?.selectedOptionIds || []).filter(
          (optionId: string) => optionId,
        ),
      ),
    );
    for (const selectedOptionId of selectedOptionIds) {
      if (
        !allowedOptions.some(
          (option: InteractionChoiceOption) => option.id === selectedOptionId,
        )
      ) {
        throw new Error(`"${field.label}" contains an invalid option`);
      }
    }

    const otherText = answer?.otherText?.trim() || undefined;
    if (otherText && !field.allowOther) {
      throw new Error(`"${field.label}" does not allow other input`);
    }

    const effectiveCount = selectedOptionIds.length + (otherText ? 1 : 0);
    const minSelections =
      field.type === "multi_select"
        ? field.minSelections ?? (required ? 1 : 0)
        : required
          ? 1
          : 0;
    const maxSelections =
      field.type === "multi_select"
        ? field.maxSelections ?? Number.MAX_SAFE_INTEGER
        : 1;

    if (maxSelections < minSelections) {
      throw new Error(`"${field.label}" has an invalid selection range`);
    }
    if (effectiveCount < minSelections) {
      throw new Error(`"${field.label}" requires more selections`);
    }
    if (effectiveCount > maxSelections) {
      throw new Error(`"${field.label}" has too many selections`);
    }
    if (field.type === "single_select" && effectiveCount > 1) {
      throw new Error(`"${field.label}" only allows one response`);
    }

    if (effectiveCount > 0) {
      normalized.push({
        fieldId: field.id,
        selectedOptionIds:
          selectedOptionIds.length > 0 ? selectedOptionIds : undefined,
          selectedOptionLabels:
          selectedOptionIds.length > 0
            ? selectedOptionIds.map(
                (selectedOptionId) =>
                  allowedOptions.find(
                    (option: InteractionChoiceOption) =>
                      option.id === selectedOptionId,
                  )?.label || selectedOptionId,
              )
            : undefined,
        otherText,
      });
    }
  }

  return normalized;
}

export async function resolveInteractionRequest(
  params: ResolveInteractionRequestParams,
): Promise<ResolveInteractionRequestResult> {
  const existing = await getInteractionRowById(params.interactionId);
  if (!existing) {
    throw new Error("Interaction request not found");
  }
  if (
    existing.kind === "question_choice" &&
    existing.target_workspace_member_id !== params.resolverWorkspaceMemberId
  ) {
    throw new Error("Only the targeted user can resolve this interaction");
  }
  if (existing.status !== "pending") {
    throw new Error("Interaction request is no longer pending");
  }

  const promptPayload = parseJsonObject(existing.prompt_payload);
  const requestPayload = parseJsonObject(existing.request_payload);
  let nextStatus: InteractionRequestStatus;
  let resolutionPayload: Record<string, unknown>;
  let createdGrant: RuntimeGrantRecord | undefined;

  if (existing.kind === "question_choice") {
    const fields = parseQuestionFieldDefinitions(promptPayload);
    if (fields.length === 0) {
      throw new Error("Question form is invalid");
    }
    const submittedAnswers = buildSubmittedQuestionAnswers(params, fields);
    const answers = validateQuestionAnswers(fields, submittedAnswers);
    if (answers.length === 0) {
      throw new Error("A valid response is required");
    }

    nextStatus = "answered";
    const legacySingleField =
      fields.length === 1 &&
      fields[0].type === "single_select" &&
      !answers[0]?.otherText &&
      (answers[0]?.selectedOptionIds?.length || 0) === 1
        ? answers[0]
        : undefined;
    resolutionPayload = {
      answers,
      selectedOptionId: legacySingleField?.selectedOptionIds?.[0],
      selectedOptionLabel: legacySingleField?.selectedOptionLabels?.[0],
      note: params.note?.trim() || undefined,
    };
  } else {
    if (params.decision !== "approve" && params.decision !== "reject") {
      throw new Error("decision must be approve or reject");
    }
    if (params.decision === "approve" && !params.preset) {
      throw new Error("preset is required when approving runtime authorization");
    }
    nextStatus = params.decision === "approve" ? "approved" : "rejected";
    const requestedEffect = parseJsonObject(existing.requested_effect);
    resolutionPayload = {
      decision: params.decision,
      approvedPreset:
        params.decision === "approve"
          ? params.preset
          : undefined,
      note: params.note?.trim() || undefined,
    };
  }

  const interaction = await transaction(async (client) => {
    if (existing.kind === "runtime_authorization" && params.decision === "approve") {
      const requestedEffect = parseJsonObject(existing.requested_effect);
      createdGrant = await createRuntimeGrant(
        {
          workspaceId: existing.workspace_id,
          relayDeviceId: existing.relay_device_id || "",
          relayCapabilityId: existing.relay_capability_id || "",
          relayExposureId: existing.relay_exposure_id || "",
          conversationId: existing.conversation_id,
          actorId: existing.requester_actor_id || undefined,
          createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
          sourceInteractionId: existing.id,
          sourceTaskId: existing.task_id || undefined,
          preset: params.preset || "once",
          relayToolStableKey:
            typeof requestedEffect.relayToolStableKey === "string"
              ? requestedEffect.relayToolStableKey
              : "",
          contractKey:
            typeof requestedEffect.contractKey === "string"
              ? requestedEffect.contractKey
              : "",
          sourceRetryNonce:
            typeof requestPayload.sourceRetryNonce === "string"
              ? requestPayload.sourceRetryNonce
              : undefined,
          sourceRuntimeSessionId:
            typeof requestedEffect.runtimeSessionId === "string"
              ? requestedEffect.runtimeSessionId
              : undefined,
          sourceRequestArgs:
            requestPayload.sourceRequestArgs &&
            typeof requestPayload.sourceRequestArgs === "object"
              ? (requestPayload.sourceRequestArgs as Record<string, unknown>)
              : {},
          effect:
            (requestedEffect.requestedEffect as RuntimeGrantEffect | undefined) ||
            ({ capability: "cua", mode: "control" } as RuntimeGrantEffect),
          displayPayload:
            requestedEffect.displayPayload &&
            typeof requestedEffect.displayPayload === "object"
              ? (requestedEffect.displayPayload as Record<string, unknown>)
              : {},
        },
        client,
      );
      resolutionPayload = {
        ...resolutionPayload,
        approvedGrant: createdGrant,
      };
    }

    await updateInteractionRequestRow(client, params.interactionId, {
      status: nextStatus,
      resolved_by_participant_id: params.resolverParticipantId,
      resolved_by_workspace_member_id: params.resolverWorkspaceMemberId,
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    });

    await updateInteractionResolutionPayload(
      client,
      existing.kind,
      params.interactionId,
      resolutionPayload,
    );

    const nextInteraction = await getInteractionRequestSummary(
      params.interactionId,
      client,
    );
    if (!nextInteraction) {
      throw new Error("Failed to reload resolved interaction");
    }

    await syncInteractionEventPayload(nextInteraction, client);
    await queueInteractionUpdatedEvent(client, nextInteraction);
    return nextInteraction;
  });

  if (!interaction.taskId) {
    throw new Error(`Interaction ${interaction.id} is missing task governance`);
  }

  if (interaction.kind === "question_choice") {
    await completeToolCallTask(
      interaction.taskId,
      buildQuestionAsyncNotice(interaction),
    );
  } else if (interaction.status === "rejected") {
    await failToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationRejectedNotice(interaction),
    );
  } else {
    await completeToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationApprovedNotice(interaction),
    );
  }

  return {
    interaction,
    createdGrant,
  };
}

export async function markRuntimeAuthorizationInteractionSuperseded(
  interactionId: string,
  note?: string,
) {
  const existing = await getInteractionRowById(interactionId);
  if (!existing) {
    throw new Error("Interaction request not found");
  }
  if (existing.kind !== "runtime_authorization" || existing.status !== "pending") {
    const current = await getInteractionRequestSummary(interactionId);
    if (!current) {
      throw new Error("Failed to reload interaction request");
    }
    return current;
  }

  const resolutionPayload = parseJsonObject(existing.resolution_payload);
  const interaction = await transaction(async (client) => {
    await updateInteractionRequestRow(client, interactionId, {
      status: "superseded",
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    });
    await updateInteractionResolutionPayload(
      client,
      "runtime_authorization",
      interactionId,
      {
        ...resolutionPayload,
        note: note?.trim() || resolutionPayload.note,
        superseded: true,
      },
    );
    const nextInteraction = await getInteractionRequestSummary(
      interactionId,
      client,
    );
    if (!nextInteraction) {
      throw new Error("Failed to reload superseded interaction");
    }
    await syncInteractionEventPayload(nextInteraction, client);
    await queueInteractionUpdatedEvent(client, nextInteraction);
    return nextInteraction;
  });
  if (interaction.taskId) {
    await failToolCallTask(
      interaction.taskId,
      buildRuntimeAuthorizationSupersededNotice(interaction),
    );
  }
  return interaction;
}
