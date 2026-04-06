import {
  INTERACTION_INPUT_QUESTION_TYPES,
  INTERACTION_REQUEST_KIND,
  isTargetedInteractionKind,
  textBlocks,
} from "@synapse/shared";
import {
  isGroupConversationKind,
  isPlanAwaitingApprovalCollaborationMode,
} from "@synapse/shared/utils";
import { v4 as uuidv4 } from "uuid";
import type {
  ConversationFeedItem,
  ConversationFeedEventPayloadMap,
  ConversationEntityRef,
  InteractionDecision,
  InteractionInputAnswer,
  InteractionInputOption,
  InteractionInputQuestionDefinition,
  InteractionInputQuestionSummary,
  InteractionRequestKind,
  InteractionRequestStatus,
  InteractionRequestSummary,
  PlanApprovalDecision,
  PlanChecklistStep,
  RelayAuthorizationGrantOption,
  RelayAuthorizationGrantSpec,
  RelayAuthorizationInteractionSummary,
  RelayAuthorizationPreset,
  RelayAuthorizationRequestMode,
  RelayAuthorizationRequestedAction,
  SessionCollaborationState,
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
import { updateSessionCollaboration } from "../session/service.js";
import { authorizeAction, userSubject } from "../access/service.js";
import {
  createConversationEvent,
  listConversationRealtimeRecipients,
  updateConversationItemEventPayload,
} from "../chat/service.js";
import { getFileUrlById } from "../files/service.js";
import { sql } from "kysely";
import {
  createRelayAuthorizationGrant,
  type RelayAuthorizationGrantRecord,
} from "../relay-authorizations/service.js";
import {
  buildSessionPlanDraftState,
  parseSessionCollaborationState,
} from "../session/collaboration-state.js";

type RawInteractionRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  task_id: string | null;
  conversation_item_id: string | null;
  kind: InteractionRequestKind;
  status: InteractionRequestStatus;
  prompt_payload: unknown;
  plan_payload: unknown;
  requested_tool_name: string | null;
  reason: string | null;
  request_mode: string | null;
  requested_action: unknown;
  grant_options: unknown;
  available_presets: unknown;
  source_request_args: unknown;
  source_runtime_session_id: string | null;
  source_retry_nonce: string | null;
  resolution_payload: unknown;
  resolved_at: string | Date | null;
  expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  requester_participant_id: string | null;
  requester_workspace_member_id: string | null;
  requester_actor_id: string | null;
  target_actor_id: string | null;
  target_workspace_member_id: string | null;
  target_participant_id: string | null;
  resolved_by_actor_id: string | null;
  resolved_by_workspace_member_id: string | null;
  resolved_by_participant_id: string | null;
  relay_capability_id: string | null;
  relay_device_id: string | null;
  relay_exposure_id: string | null;
  relay_tool_stable_key: string | null;
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

export interface CreateUserInputInteractionParams {
  workspaceId: string;
  conversationId: string;
  taskId: string;
  requesterParticipantId: string;
  targetParticipantId: string;
  title: string;
  instructions?: string;
  questions: InteractionInputQuestionDefinition[];
  expiresAt?: string;
}

export interface CreatePlanApprovalInteractionParams {
  workspaceId: string;
  conversationId: string;
  sessionId: string;
  taskId: string;
  requesterParticipantId: string;
  targetParticipantId: string;
  title: string;
  summary?: string;
  planMarkdown: string;
  checklist?: PlanChecklistStep[];
  collaborationState: SessionCollaborationState;
  expiresAt?: string;
}

export interface CreateRelayAuthorizationInteractionParams {
  workspaceId: string;
  conversationId: string;
  taskId: string;
  requesterParticipantId: string;
  relayCapabilityId: string;
  relayDeviceId: string;
  relayExposureId: string;
  requestedToolName: string;
  runtimeSessionId: string;
  relayToolStableKey: string;
  reason: string;
  requestedAction: RelayAuthorizationRequestedAction;
  grantOptions: RelayAuthorizationGrantOption[];
  availablePresets: RelayAuthorizationPreset[];
  requestMode: RelayAuthorizationRequestMode;
  sourceRetryNonce?: string;
  sourceRequestArgs?: Record<string, unknown>;
  expiresAt?: string;
}

export interface ResolveInteractionRequestParams {
  interactionId: string;
  resolverWorkspaceMemberId: string;
  resolverParticipantId: string;
  answers?: InteractionInputAnswer[];
  decision?: InteractionDecision | PlanApprovalDecision;
  preset?: RelayAuthorizationPreset;
  selectedGrantOptionId?: string;
  note?: string;
}

export interface ResolveInteractionRequestResult {
  interaction: InteractionRequestSummary;
  createdGrant?: RelayAuthorizationGrantRecord;
  createdGrants?: RelayAuthorizationGrantRecord[];
}

export interface FindOpenRelayAuthorizationInteractionParams {
  workspaceId: string;
  conversationId: string;
  requesterParticipantId: string;
  relayCapabilityId: string;
  relayDeviceId: string;
  relayExposureId: string;
  requestedToolName: string;
  relayToolStableKey: string;
  requestedAction: RelayAuthorizationRequestedAction;
  grantOptions: RelayAuthorizationGrantOption[];
  availablePresets: RelayAuthorizationPreset[];
  requestMode: RelayAuthorizationRequestMode;
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

function requireJsonObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`);
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} is required`);
    }
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object`);
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && error.message === `${label} must be a JSON object`) {
        throw error;
      }
      throw new Error(`${label} must be a valid JSON object`);
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonArray<T>(value: unknown, label: string): T[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array`);
      }
      return parsed as T[];
    } catch (error) {
      if (error instanceof Error && error.message === `${label} must be a JSON array`) {
        throw error;
      }
      throw new Error(`${label} must be a valid JSON array`);
    }
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return value as T[];
}

function requireTrimmedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireIsoString(
  value: string | Date | null | undefined,
  label: string,
): string {
  const iso = toIsoString(value);
  if (!iso) {
    throw new Error(`${label} is required`);
  }
  return iso;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonbValue<T>(value: T) {
  return sql<T>`${JSON.stringify(value ?? null)}::jsonb`;
}

function buildRelayAuthorizationDedupeKey(params: {
  relayDeviceId: string;
  relayCapabilityId: string;
  relayExposureId: string;
  requestedToolName: string;
  relayToolStableKey: string;
  requestMode: RelayAuthorizationRequestMode;
  requestedAction: RelayAuthorizationRequestedAction;
  grantOptions: RelayAuthorizationGrantOption[];
  availablePresets: RelayAuthorizationPreset[];
}) {
  return stableJsonStringify({
    relayDeviceId: params.relayDeviceId,
    relayCapabilityId: params.relayCapabilityId,
    relayExposureId: params.relayExposureId,
    requestedToolName: params.requestedToolName,
    relayToolStableKey: params.relayToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
  });
}

function entityAvatarUrl(actorAvatarFileId?: string | null, userAvatarFileId?: string | null) {
  if (actorAvatarFileId) return getFileUrlById(actorAvatarFileId);
  if (userAvatarFileId) return getFileUrlById(userAvatarFileId);
  return undefined;
}

function parseInputOptions(
  value: unknown,
  optionListLabel = "options",
): InteractionInputOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: InteractionInputOption[] = [];
  const usedIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(
        `Option ${index + 1} in ${optionListLabel} must be an object`,
      );
    }
    const rawId = requireTrimmedString(
      (item as { id?: unknown }).id,
      `Option ${index + 1} id in ${optionListLabel}`,
    );
    const optionLabel = requireTrimmedString(
      (item as { label?: unknown }).label,
      `Option ${index + 1} label in ${optionListLabel}`,
    );
    const description =
      typeof (item as { description?: unknown }).description === "string"
        ? (item as { description: string }).description.trim()
        : undefined;
    const preview =
      typeof (item as { preview?: unknown }).preview === "string"
        ? (item as { preview: string }).preview.trim()
        : undefined;
    const id = rawId;
    if (usedIds.has(id)) {
      throw new Error(`Duplicate option id "${id}" in ${optionListLabel}`);
    }
    usedIds.add(id);
    options.push({
      id,
      label: optionLabel,
      description: description || undefined,
      preview: preview || undefined,
    });
  }
  return options;
}

function normalizeInputQuestionType(
  value: unknown,
): InteractionInputQuestionDefinition["type"] {
  if (
    typeof value === "string" &&
    (INTERACTION_INPUT_QUESTION_TYPES as readonly string[]).includes(value)
  ) {
    return value as InteractionInputQuestionDefinition["type"];
  }
  throw new Error(`Unsupported user input question type: ${String(value)}`);
}

function parseUserInputQuestionDefinitions(
  promptPayload: Record<string, unknown>,
): InteractionInputQuestionDefinition[] {
  const rawQuestions = promptPayload.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("user_input prompt_payload.questions must be a non-empty array");
  }
  const definitions: InteractionInputQuestionDefinition[] = [];
  const usedIds = new Set<string>();

  for (const [index, question] of rawQuestions.entries()) {
    if (!question || typeof question !== "object") {
      throw new Error(`Question ${index + 1} must be an object`);
    }
    const id = requireTrimmedString(
      (question as { id?: unknown }).id,
      `Question ${index + 1} id`,
    );
    if (usedIds.has(id)) {
      throw new Error(`Duplicate question id "${id}"`);
    }
    usedIds.add(id);

    const type = normalizeInputQuestionType(
      (question as { type?: unknown }).type,
    );
    const definition: InteractionInputQuestionDefinition = {
      id,
      header: requireTrimmedString(
        (question as { header?: unknown }).header,
        `Question ${index + 1} header`,
      ),
      type,
      prompt: requireTrimmedString(
        (question as { prompt?: unknown }).prompt,
        `Question ${index + 1} prompt`,
      ),
      description:
        typeof (question as { description?: unknown }).description === "string"
          ? (question as { description: string }).description.trim() || undefined
          : undefined,
      required: (() => {
        if (typeof (question as { required?: unknown }).required !== "boolean") {
          throw new Error(`Question "${id}" required must be a boolean`);
        }
        return Boolean((question as { required: boolean }).required);
      })(),
    };

    if (type === "text") {
      definition.placeholder =
        typeof (question as { placeholder?: unknown }).placeholder === "string"
          ? (question as { placeholder: string }).placeholder.trim() || undefined
          : undefined;
      if (typeof (question as { secret?: unknown }).secret !== "boolean") {
        throw new Error(`Question "${id}" secret must be a boolean`);
      }
      definition.secret =
        Boolean((question as { secret: boolean }).secret);
    } else {
      definition.options = parseInputOptions(
        (question as { options?: unknown }).options,
        `question "${id}" options`,
      );
      if (definition.options.length === 0) {
        throw new Error(`Question "${id}" requires at least one option`);
      }
      if (typeof (question as { allowOther?: unknown }).allowOther !== "boolean") {
        throw new Error(`Question "${id}" allowOther must be a boolean`);
      }
      definition.allowOther = Boolean(
        (question as { allowOther: boolean }).allowOther,
      );
      if (
        (question as { minSelections?: unknown }).minSelections !== undefined &&
        (typeof (question as { minSelections?: unknown }).minSelections !== "number" ||
          !Number.isFinite((question as { minSelections: number }).minSelections))
      ) {
        throw new Error(`Question "${id}" minSelections must be a finite number`);
      }
      if (
        (question as { maxSelections?: unknown }).maxSelections !== undefined &&
        (typeof (question as { maxSelections?: unknown }).maxSelections !== "number" ||
          !Number.isFinite((question as { maxSelections: number }).maxSelections))
      ) {
        throw new Error(`Question "${id}" maxSelections must be a finite number`);
      }
      definition.minSelections =
        typeof (question as { minSelections?: unknown }).minSelections === "number"
          ? Math.max(
              0,
              Math.trunc((question as { minSelections: number }).minSelections),
            )
          : undefined;
      definition.maxSelections =
        typeof (question as { maxSelections?: unknown }).maxSelections === "number"
          ? Math.max(
              1,
              Math.trunc((question as { maxSelections: number }).maxSelections),
            )
          : undefined;
    }

    definitions.push(definition);
  }

  return definitions;
}

function parseUserInputAnswers(
  resolutionPayload: Record<string, unknown>,
  questions: InteractionInputQuestionDefinition[],
): InteractionInputAnswer[] {
  const answers: InteractionInputAnswer[] = [];
  const seenQuestionIds = new Set<string>();

  if (resolutionPayload.answers === undefined) {
    return answers;
  }
  if (!Array.isArray(resolutionPayload.answers)) {
    throw new Error("interaction resolution_payload.answers must be an array");
  }

  for (const [index, answer] of resolutionPayload.answers.entries()) {
    if (!answer || typeof answer !== "object") {
      throw new Error(`Answer ${index + 1} must be an object`);
    }
    const questionId = requireTrimmedString(
      (answer as { questionId?: unknown }).questionId,
      `Answer ${index + 1} questionId`,
    );
    if (!questions.some((question) => question.id === questionId)) {
      throw new Error(`Answer references unknown question "${questionId}"`);
    }
    if (seenQuestionIds.has(questionId)) {
      throw new Error(`Duplicate answer for question "${questionId}"`);
    }
    seenQuestionIds.add(questionId);
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
    if (
      (answer as { selectedOptionIds?: unknown }).selectedOptionIds !== undefined &&
      !Array.isArray((answer as { selectedOptionIds?: unknown }).selectedOptionIds)
    ) {
      throw new Error(`Answer "${questionId}" selectedOptionIds must be an array`);
    }
    const selectedOptionLabels = Array.isArray(
      (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels,
    )
      ? ((answer as { selectedOptionLabels: unknown[] }).selectedOptionLabels || [])
          .map((label) => (typeof label === "string" ? label.trim() : ""))
          .filter((label) => label.length > 0)
      : undefined;
    if (
      (answer as { selectedOptionLabels?: unknown }).selectedOptionLabels !== undefined &&
      !Array.isArray((answer as { selectedOptionLabels?: unknown }).selectedOptionLabels)
    ) {
      throw new Error(
        `Answer "${questionId}" selectedOptionLabels must be an array`,
      );
    }
    const otherText =
      typeof (answer as { otherText?: unknown }).otherText === "string"
        ? (answer as { otherText: string }).otherText.trim() || undefined
        : undefined;
    if (
      (answer as { otherText?: unknown }).otherText !== undefined &&
      typeof (answer as { otherText?: unknown }).otherText !== "string"
    ) {
      throw new Error(`Answer "${questionId}" otherText must be a string`);
    }
    const text =
      typeof (answer as { text?: unknown }).text === "string"
        ? (answer as { text: string }).text.trim() || undefined
        : undefined;
    if (
      (answer as { text?: unknown }).text !== undefined &&
      typeof (answer as { text?: unknown }).text !== "string"
    ) {
      throw new Error(`Answer "${questionId}" text must be a string`);
    }
    answers.push({
      questionId,
      selectedOptionIds,
      selectedOptionLabels,
      otherText,
      text,
    });
  }
  return answers;
}

function buildUserInputQuestionSummaries(
  promptPayload: Record<string, unknown>,
  resolutionPayload: Record<string, unknown>,
): InteractionInputQuestionSummary[] {
  const definitions = parseUserInputQuestionDefinitions(promptPayload);
  const answers = parseUserInputAnswers(resolutionPayload, definitions);
  const answerMap = new Map<string, InteractionInputAnswer>();
  for (const answer of answers) {
    answerMap.set(answer.questionId, answer);
  }

  return definitions.map((question) => {
    const answer = answerMap.get(question.id);
    const labels =
      answer?.selectedOptionIds?.map(
        (selectedId: string) =>
          (question.options || []).find(
            (option: InteractionInputOption) => option.id === selectedId,
          )?.label ||
          selectedId,
      ) || undefined;
    return {
      ...question,
      required: question.required === true,
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

function summarizeUserInputAnswers(
  userInput: InteractionRequestSummary["userInput"],
): string {
  if (!userInput) {
    return "a response";
  }

  const parts: string[] = [];
  for (const question of userInput.questions) {
    const answer = question.answer;
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
      userInput.questions.length === 1
        ? valueParts.join(", ")
        : `${question.prompt}: ${valueParts.join(", ")}`,
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
    prefix === "requester"
      ? row.requester_actor_id
      : prefix === "target"
        ? row.target_actor_id
        : row.resolved_by_actor_id;
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

function requireEntityRef(
  entity: ConversationEntityRef | undefined,
  label: string,
): ConversationEntityRef {
  if (!entity?.participantId || !entity.participantType) {
    throw new Error(`${label} is missing a participant entity`);
  }
  return entity;
}

function buildInteractionSummary(row: RawInteractionRow): InteractionRequestSummary {
  const requester = requireEntityRef(
    mapEntityRefFromRow("requester", row),
    `Interaction ${row.id} requester`,
  );
  const target = isTargetedInteractionKind(row.kind)
    ? requireEntityRef(
        mapEntityRefFromRow("target", row),
        `Interaction ${row.id} target`,
      )
    : undefined;
  const resolvedBy = row.resolved_by_participant_id
    ? requireEntityRef(
        mapEntityRefFromRow("resolved_by", row),
        `Interaction ${row.id} resolved_by`,
      )
    : undefined;
  const resolutionPayload = requireJsonObject(
    row.resolution_payload,
    `Interaction ${row.id} resolution_payload`,
  );

  let userInput: InteractionRequestSummary["userInput"];
  let planApproval: InteractionRequestSummary["planApproval"];
  let relayAuthorization:
    | RelayAuthorizationInteractionSummary
    | undefined;

  if (row.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    const promptPayload = requireJsonObject(
      row.prompt_payload,
      `Interaction ${row.id} prompt_payload`,
    );
    userInput = {
      title: requireTrimmedString(
        promptPayload.title,
        `Interaction ${row.id} user_input.title`,
      ),
      instructions:
        typeof promptPayload.instructions === "string"
          ? promptPayload.instructions.trim() || undefined
          : undefined,
      questions: buildUserInputQuestionSummaries(promptPayload, resolutionPayload),
    };
  } else if (row.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    const planPayload = requireJsonObject(
      row.plan_payload,
      `Interaction ${row.id} plan_payload`,
    );
    planApproval = {
      title: requireTrimmedString(
        planPayload.title,
        `Interaction ${row.id} plan_approval.title`,
      ),
      summary:
        typeof planPayload.summary === "string"
          ? planPayload.summary.trim() || undefined
          : undefined,
      planMarkdown: requireTrimmedString(
        planPayload.planMarkdown,
        `Interaction ${row.id} plan_approval.planMarkdown`,
      ),
      checklist: Array.isArray(planPayload.checklist)
        ? (planPayload.checklist as PlanChecklistStep[])
        : undefined,
    };
  } else {
    const requestedAction = requireJsonObject(
      row.requested_action,
      `Interaction ${row.id} requested_action`,
    ) as unknown as RelayAuthorizationRequestedAction;
    const grantOptions = parseJsonArray<RelayAuthorizationGrantOption>(
      row.grant_options,
      `Interaction ${row.id} grant_options`,
    );
    const availablePresets = parseJsonArray<RelayAuthorizationPreset>(
      row.available_presets,
      `Interaction ${row.id} available_presets`,
    );
    relayAuthorization = {
      requestedToolName: requireTrimmedString(
        row.requested_tool_name,
        `Interaction ${row.id} requested_tool_name`,
      ),
      relayToolStableKey: requireTrimmedString(
        row.relay_tool_stable_key,
        `Interaction ${row.id} relay_tool_stable_key`,
      ),
      requestedAction,
      reason: requireTrimmedString(
        row.reason,
        `Interaction ${row.id} relay_authorization.reason`,
      ),
      deviceId: requireTrimmedString(
        row.relay_device_id,
        `Interaction ${row.id} relay_device_id`,
      ),
      deviceDisplayName: requireTrimmedString(
        row.device_display_name,
        `Interaction ${row.id} device_display_name`,
      ),
      relayCapabilityId: requireTrimmedString(
        row.relay_capability_id,
        `Interaction ${row.id} relay_capability_id`,
      ),
      exposureId: requireTrimmedString(
        row.relay_exposure_id,
        `Interaction ${row.id} relay_exposure_id`,
      ),
      exposureDisplayName: requireTrimmedString(
        row.exposure_display_name,
        `Interaction ${row.id} exposure_display_name`,
      ),
      grantOptions,
      availablePresets,
      approvedPreset:
        typeof resolutionPayload.approvedPreset === "string"
          ? (resolutionPayload.approvedPreset as RelayAuthorizationPreset)
          : undefined,
      approvedGrant:
        resolutionPayload.approvedGrant &&
        typeof resolutionPayload.approvedGrant === "object" &&
        !Array.isArray(resolutionPayload.approvedGrant)
          ? (resolutionPayload.approvedGrant as RelayAuthorizationInteractionSummary["approvedGrant"])
          : undefined,
      requestMode:
        row.request_mode === "blocking" ||
        row.request_mode === "background"
          ? (row.request_mode as RelayAuthorizationRequestMode)
          : (() => {
              throw new Error(
                `Interaction ${row.id} relay_authorization.requestMode is invalid`,
              );
            })(),
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
    requester,
    ...(target ? { target } : {}),
    resolvedBy,
    resolutionNote:
      typeof resolutionPayload.note === "string"
        ? resolutionPayload.note.trim() || undefined
        : undefined,
    userInput,
    planApproval,
    relayAuthorization,
    createdAt: requireIsoString(row.created_at, `Interaction ${row.id} created_at`),
    updatedAt: requireIsoString(row.updated_at, `Interaction ${row.id} updated_at`),
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
            user_input.prompt_payload AS prompt_payload,
            plan.plan_payload AS plan_payload,
            auth.requested_tool_name AS requested_tool_name,
            auth.reason AS reason,
            auth.request_mode AS request_mode,
            auth.requested_action AS requested_action,
            auth.grant_options AS grant_options,
            auth.available_presets AS available_presets,
            auth.source_request_args AS source_request_args,
            auth.source_runtime_session_id AS source_runtime_session_id,
            auth.source_retry_nonce AS source_retry_nonce,
            COALESCE(
              user_input.resolution_payload,
              plan.resolution_payload,
              auth.resolution_payload,
              '{}'::jsonb
            ) AS resolution_payload,
            auth.relay_device_id,
            auth.relay_capability_id,
            auth.relay_exposure_id,
            auth.relay_tool_stable_key,
            requester.workspace_member_id AS requester_workspace_member_id,
            requester.actor_id AS requester_actor_id,
            requester.participant_kind AS requester_participant_kind,
            COALESCE(requester_actor.name, requester_user.name, requester.display_name) AS requester_name,
            requester_actor.title AS requester_title,
            requester_actor.role AS requester_role,
            requester_actor.avatar_file_id AS requester_actor_avatar_file_id,
            requester_user.avatar_file_id AS requester_user_avatar_file_id,
            requester_actor.avatar_emoji AS requester_avatar_emoji,
            target.workspace_member_id AS target_workspace_member_id,
            target.actor_id AS target_actor_id,
            target.participant_kind AS target_participant_kind,
            COALESCE(target_actor.name, target_user.name, target.display_name) AS target_name,
            target_actor.title AS target_title,
            target_actor.role AS target_role,
            target_actor.avatar_file_id AS target_actor_avatar_file_id,
            target_user.avatar_file_id AS target_user_avatar_file_id,
            target_actor.avatar_emoji AS target_avatar_emoji,
            resolver.workspace_member_id AS resolved_by_workspace_member_id,
            resolver.actor_id AS resolved_by_actor_id,
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
     LEFT JOIN interaction_user_input_requests user_input
       ON user_input.interaction_id = ir.id
     LEFT JOIN interaction_plan_approval_requests plan
       ON plan.interaction_id = ir.id
     LEFT JOIN interaction_relay_authorization_requests auth
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
  const allRecipients = await listConversationRealtimeRecipients(
    interaction.conversationId,
    queryable,
  );
  const recipients =
    interaction.kind === INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION
      ? allRecipients
      : allRecipients.filter((recipient) =>
          recipient.workspaceMemberId === interaction.target?.workspaceMemberId ||
          recipient.workspaceMemberId === interaction.requester?.workspaceMemberId,
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

function buildUserInputAsyncNotice(interaction: InteractionRequestSummary) {
  const prompt = interaction.userInput?.title?.trim() || "Input request";
  const answer = summarizeUserInputAnswers(interaction.userInput);
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

function buildPlanApprovalApprovedNotice(interaction: InteractionRequestSummary) {
  const resolverName = interaction.resolvedBy?.name || "A user";
  const title = interaction.planApproval?.title?.trim() || "Plan";
  const summary = `${resolverName} approved "${title}".`;
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

function buildPlanApprovalRevisionNotice(interaction: InteractionRequestSummary) {
  const resolverName = interaction.resolvedBy?.name || "A user";
  const title = interaction.planApproval?.title?.trim() || "Plan";
  const summary = `${resolverName} requested revisions for "${title}".`;
  const lines = [
    summary,
    interaction.resolutionNote?.trim()
      ? `Feedback: ${interaction.resolutionNote.trim()}`
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
      reason: "plan_revision_requested",
    },
    metadata: {
      interactionId: interaction.id,
      interactionKind: interaction.kind,
      interactionStatus: interaction.status,
    },
  };
}

function buildRelayAuthorizationRejectedNotice(
  interaction: InteractionRequestSummary,
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user";
  const deviceName =
    interaction.relayAuthorization?.deviceDisplayName || "relay device";
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

function buildRelayAuthorizationApprovedNotice(
  interaction: InteractionRequestSummary,
) {
  const resolverName = interaction.resolvedBy?.name || "An authorized user";
  const deviceName =
    interaction.relayAuthorization?.deviceDisplayName || "relay device";
  const approvedPreset =
    interaction.relayAuthorization?.approvedPreset || "conversation";
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

function buildRelayAuthorizationSupersededNotice(
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
  kind: InteractionRequestKind;
  targetParticipantId?: string;
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
        kind,
        status,
        target_participant_id,
        expires_at
      )
      VALUES (
        ${interactionId},
        ${params.workspaceId},
        ${params.conversationId},
        ${params.taskId},
        ${params.requesterParticipantId},
        ${params.kind},
        'pending',
        ${params.targetParticipantId || null},
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

async function insertUserInputInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string;
    promptPayload: Record<string, unknown>;
  },
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_user_input_requests").values({
      interaction_id: params.interactionId,
      prompt_payload:
        jsonbValue(params.promptPayload) as unknown as TableInsert<"interaction_user_input_requests">["prompt_payload"],
      resolution_payload:
        jsonbValue({}) as unknown as TableInsert<"interaction_user_input_requests">["resolution_payload"],
    }),
  );
}

async function insertPlanApprovalInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string;
    planPayload: Record<string, unknown>;
  },
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_plan_approval_requests").values({
      interaction_id: params.interactionId,
      plan_payload:
        jsonbValue(params.planPayload) as unknown as TableInsert<"interaction_plan_approval_requests">["plan_payload"],
      resolution_payload:
        jsonbValue({}) as unknown as TableInsert<"interaction_plan_approval_requests">["resolution_payload"],
    }),
  );
}

async function insertRelayAuthorizationInteractionDetails(
  client: Queryable,
  params: {
    interactionId: string;
    relayDeviceId: string;
    relayCapabilityId: string;
    relayExposureId: string;
    requestedToolName: string;
    relayToolStableKey: string;
    reason: string;
    requestMode: RelayAuthorizationRequestMode;
    sourceRuntimeSessionId?: string;
    sourceRetryNonce?: string;
    sourceRequestArgs: Record<string, unknown>;
    requestedAction: RelayAuthorizationRequestedAction;
    grantOptions: RelayAuthorizationGrantOption[];
    availablePresets: RelayAuthorizationPreset[];
    dedupeKey: string;
  },
) {
  await executeCompiledQuery(
    client,
    db.insertInto("interaction_relay_authorization_requests").values({
      interaction_id: params.interactionId,
      relay_device_id: params.relayDeviceId,
      relay_capability_id: params.relayCapabilityId,
      relay_exposure_id: params.relayExposureId,
      requested_tool_name: params.requestedToolName,
      relay_tool_stable_key: params.relayToolStableKey,
      reason: params.reason,
      request_mode: params.requestMode,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_retry_nonce: params.sourceRetryNonce || null,
      source_request_args:
        jsonbValue(params.sourceRequestArgs) as unknown as TableInsert<"interaction_relay_authorization_requests">["source_request_args"],
      requested_action:
        jsonbValue(params.requestedAction) as unknown as TableInsert<"interaction_relay_authorization_requests">["requested_action"],
      grant_options:
        jsonbValue(params.grantOptions) as unknown as TableInsert<"interaction_relay_authorization_requests">["grant_options"],
      available_presets:
        jsonbValue(params.availablePresets) as unknown as TableInsert<"interaction_relay_authorization_requests">["available_presets"],
      resolution_payload:
        jsonbValue({}) as unknown as TableInsert<"interaction_relay_authorization_requests">["resolution_payload"],
      dedupe_key: params.dedupeKey,
    }),
  );
}

async function updateInteractionConversationItemId(
  client: Queryable,
  interactionId: string,
  conversationItemId: string,
) {
  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
      .set({
        conversation_item_id: conversationItemId,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", interactionId),
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update conversation item for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`,
    );
  }
}

async function updateInteractionRequestRow(
  client: Queryable,
  interactionId: string,
  values: Record<string, unknown>,
) {
  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_requests")
      .set(values)
      .where("id", "=", interactionId),
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`,
    );
  }
}

async function updateInteractionResolutionPayload(
  client: Queryable,
  interactionKind: InteractionRequestKind,
  interactionId: string,
  payload: Record<string, unknown>,
) {
  if (interactionKind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    const result = await executeCompiledQuery(
      client,
      db
        .updateTable("interaction_user_input_requests")
        .set({
          resolution_payload:
            jsonbValue(payload) as unknown as TableInsert<"interaction_user_input_requests">["resolution_payload"],
        })
        .where("interaction_id", "=", interactionId),
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `Expected user_input details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`,
      );
    }
    return;
  }

  if (interactionKind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    const result = await executeCompiledQuery(
      client,
      db
        .updateTable("interaction_plan_approval_requests")
        .set({
          resolution_payload:
            jsonbValue(payload) as unknown as TableInsert<"interaction_plan_approval_requests">["resolution_payload"],
        })
        .where("interaction_id", "=", interactionId),
    );
    if (result.rowCount !== 1) {
      throw new Error(
        `Expected plan_approval details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`,
      );
    }
    return;
  }

  const result = await executeCompiledQuery(
    client,
    db
      .updateTable("interaction_relay_authorization_requests")
      .set({
        resolution_payload:
          jsonbValue(payload) as unknown as TableInsert<"interaction_relay_authorization_requests">["resolution_payload"],
      })
      .where("interaction_id", "=", interactionId),
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected relay_authorization details for interaction ${interactionId}, but affected ${result.rowCount ?? 0} rows`,
    );
  }
}

export async function createUserInputInteractionRequest(
  params: CreateUserInputInteractionParams,
) {
  return transaction(async (client) => {
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.USER_INPUT,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    });

    await insertUserInputInteractionDetails(client, {
      interactionId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
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

export async function createPlanApprovalInteractionRequest(
  params: CreatePlanApprovalInteractionParams,
) {
  return transaction(async (client) => {
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    });

    await insertPlanApprovalInteractionDetails(client, {
      interactionId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
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
    const collaborationState = parseSessionCollaborationState(
      params.collaborationState,
    );
    if (!collaborationState.planDraft) {
      throw new Error(
        "Plan approval interactions require collaborationState.planDraft",
      );
    }
    await updateSessionCollaboration(
      {
        sessionId: params.sessionId,
        collaborationMode: "plan_awaiting_approval",
        collaborationState,
        activePlanApprovalInteractionId: interactionId,
      },
      client,
    );
    await syncInteractionEventPayload(interaction, client);
    return interaction;
  });
}

export async function createRelayAuthorizationInteractionRequest(
  params: CreateRelayAuthorizationInteractionParams,
) {
  return transaction(async (client) => {
    const interactionId = await insertInteractionRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION,
      expiresAt: params.expiresAt,
    });

    await insertRelayAuthorizationInteractionDetails(client, {
      interactionId,
      relayDeviceId: params.relayDeviceId,
      relayCapabilityId: params.relayCapabilityId,
      relayExposureId: params.relayExposureId,
      requestedToolName: params.requestedToolName,
      relayToolStableKey: params.relayToolStableKey,
      reason: params.reason,
      requestMode: params.requestMode,
      sourceRuntimeSessionId: params.runtimeSessionId,
      sourceRetryNonce: params.sourceRetryNonce,
      sourceRequestArgs: params.sourceRequestArgs || {},
      requestedAction: params.requestedAction,
      grantOptions: params.grantOptions,
      availablePresets: params.availablePresets,
      dedupeKey: buildRelayAuthorizationDedupeKey({
        relayDeviceId: params.relayDeviceId,
        relayCapabilityId: params.relayCapabilityId,
        relayExposureId: params.relayExposureId,
        requestedToolName: params.requestedToolName,
        relayToolStableKey: params.relayToolStableKey,
        requestMode: params.requestMode,
        requestedAction: params.requestedAction,
        grantOptions: params.grantOptions,
        availablePresets: params.availablePresets,
      }),
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

export async function findOpenRelayAuthorizationInteraction(
  params: FindOpenRelayAuthorizationInteractionParams,
) {
  const dedupeKey = buildRelayAuthorizationDedupeKey({
    relayDeviceId: params.relayDeviceId,
    relayCapabilityId: params.relayCapabilityId,
    relayExposureId: params.relayExposureId,
    requestedToolName: params.requestedToolName,
    relayToolStableKey: params.relayToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
  });
  const row = await db
    .selectFrom("interaction_requests as ir")
    .innerJoin(
      "interaction_relay_authorization_requests as auth",
      "auth.interaction_id",
      "ir.id",
    )
    .select("ir.id")
    .where("ir.workspace_id", "=", params.workspaceId)
    .where("ir.conversation_id", "=", params.conversationId)
    .where(sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`)
    .where("ir.kind", "=", INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION)
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
    .where("auth.requested_tool_name", "=", params.requestedToolName)
    .where(
      sql<boolean>`auth.relay_tool_stable_key = ${params.relayToolStableKey}`,
    )
    .where("auth.request_mode", "=", params.requestMode)
    .where("auth.dedupe_key", "=", dedupeKey)
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
          FROM conversation_participants cp
          JOIN workspace_members wm
            ON wm.id = cp.workspace_member_id
          WHERE cp.id = ir.requester_participant_id
            AND wm.user_id = ${params.userId}
        )`,
        eb.and([
          eb("ir.kind", "in", [
            INTERACTION_REQUEST_KIND.USER_INPUT,
            INTERACTION_REQUEST_KIND.PLAN_APPROVAL,
          ]),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM conversation_participants cp
            JOIN workspace_members wm
              ON wm.id = cp.workspace_member_id
            WHERE cp.id = ir.target_participant_id
              AND wm.user_id = ${params.userId}
          )`,
        ]),
        eb.and([
          eb("ir.kind", "=", INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION),
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

  if (isTargetedInteractionKind(interaction.kind)) {
    const targetParticipantId = interaction.target?.participantId;
    if (!targetParticipantId) {
      return false;
    }

    const viewerParticipant = await db
      .selectFrom("conversation_participants as cp")
      .innerJoin("workspace_members as wm", "wm.id", "cp.workspace_member_id")
      .select("cp.id")
      .where("cp.id", "=", targetParticipantId)
      .where("cp.state", "=", "active")
      .where("wm.user_id", "=", userId)
      .limit(1)
      .executeTakeFirst();

    return Boolean(viewerParticipant?.id);
  }

  const deviceId = interaction.relayAuthorization?.deviceId;
  if (!deviceId) {
    return false;
  }

  return authorizeAction({
    subject: userSubject(userId),
    action: "relay_device.authorize_relay_authorization",
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

function buildSubmittedUserInputAnswers(
  params: ResolveInteractionRequestParams,
  questions: InteractionInputQuestionDefinition[],
): InteractionInputAnswer[] {
  if (Array.isArray(params.answers) && params.answers.length > 0) {
    return params.answers.map((answer) => ({
      questionId: String(answer.questionId || "").trim(),
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
  return questions.map((question) => ({
    questionId: question.id,
  }));
}

function validateUserInputAnswers(
  questions: InteractionInputQuestionDefinition[],
  submittedAnswers: InteractionInputAnswer[],
) {
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const answerMap = new Map<string, InteractionInputAnswer>();

  for (const answer of submittedAnswers) {
    if (!answer.questionId) {
      throw new Error("Each answer requires a questionId");
    }
    if (!questionMap.has(answer.questionId)) {
      throw new Error(`Unknown question "${answer.questionId}"`);
    }
    if (answerMap.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}"`);
    }
    answerMap.set(answer.questionId, answer);
  }

  const normalized: InteractionInputAnswer[] = [];

  for (const question of questions) {
    const answer = answerMap.get(question.id);
    const required = question.required !== false;

    if (question.type === "text") {
      const text = answer?.text?.trim() || undefined;
      if (required && !text) {
        throw new Error(`"${question.prompt}" requires a response`);
      }
      if (text) {
        normalized.push({
          questionId: question.id,
          text,
        });
      }
      continue;
    }

    const allowedOptions = question.options || [];
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
          (option: InteractionInputOption) => option.id === selectedOptionId,
        )
      ) {
        throw new Error(`"${question.prompt}" contains an invalid option`);
      }
    }

    const otherText = answer?.otherText?.trim() || undefined;
    if (otherText && !question.allowOther) {
      throw new Error(`"${question.prompt}" does not allow other input`);
    }

    const effectiveCount = selectedOptionIds.length + (otherText ? 1 : 0);
    const minSelections =
      question.type === "multi_select"
        ? question.minSelections ?? (required ? 1 : 0)
        : required
          ? 1
          : 0;
    const maxSelections =
      question.type === "multi_select"
        ? question.maxSelections ?? Number.MAX_SAFE_INTEGER
        : 1;

    if (maxSelections < minSelections) {
      throw new Error(`"${question.prompt}" has an invalid selection range`);
    }
    if (effectiveCount < minSelections) {
      throw new Error(`"${question.prompt}" requires more selections`);
    }
    if (effectiveCount > maxSelections) {
      throw new Error(`"${question.prompt}" has too many selections`);
    }
    if (question.type === "single_select" && effectiveCount > 1) {
      throw new Error(`"${question.prompt}" only allows one response`);
    }

    if (effectiveCount > 0) {
      normalized.push({
        questionId: question.id,
        selectedOptionIds:
          selectedOptionIds.length > 0 ? selectedOptionIds : undefined,
        selectedOptionLabels:
          selectedOptionIds.length > 0
            ? selectedOptionIds.map(
                (selectedOptionId) =>
                  allowedOptions.find(
                    (option: InteractionInputOption) =>
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
    isTargetedInteractionKind(existing.kind) &&
    existing.target_participant_id !== params.resolverParticipantId
  ) {
    throw new Error("Only the targeted user can resolve this interaction");
  }
  if (existing.status !== "pending") {
    throw new Error("Interaction request is no longer pending");
  }

  const promptPayload = parseJsonObject(existing.prompt_payload);
  let nextStatus: InteractionRequestStatus;
  let resolutionPayload: Record<string, unknown>;
  let createdGrant: RelayAuthorizationGrantRecord | undefined;

  if (existing.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    const questions = parseUserInputQuestionDefinitions(promptPayload);
    if (questions.length === 0) {
      throw new Error("User input request is invalid");
    }
    const submittedAnswers = buildSubmittedUserInputAnswers(params, questions);
    const answers = validateUserInputAnswers(questions, submittedAnswers);
    if (answers.length === 0) {
      throw new Error("A valid response is required");
    }

    nextStatus = "answered";
    resolutionPayload = {
      answers,
      note: params.note?.trim() || undefined,
    };
  } else if (existing.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    if (params.decision !== "approve" && params.decision !== "revise") {
      throw new Error("decision must be approve or revise");
    }
    nextStatus = params.decision === "approve" ? "approved" : "rejected";
    resolutionPayload = {
      decision: params.decision,
      note: params.note?.trim() || undefined,
    };
  } else {
    if (params.decision !== "approve" && params.decision !== "reject") {
      throw new Error("decision must be approve or reject");
    }
    if (params.decision === "approve" && !params.preset) {
      throw new Error("preset is required when approving relay authorization");
    }
    nextStatus = params.decision === "approve" ? "approved" : "rejected";
    resolutionPayload = {
      decision: params.decision,
      approvedPreset:
        params.decision === "approve"
          ? params.preset
          : undefined,
      selectedGrantOptionId:
        params.decision === "approve" &&
        typeof params.selectedGrantOptionId === "string" &&
        params.selectedGrantOptionId.trim().length > 0
          ? params.selectedGrantOptionId.trim()
          : undefined,
      note: params.note?.trim() || undefined,
    };
  }

  const interaction = await transaction(async (client) => {
    if (existing.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
      if (!existing.task_id) {
        throw new Error(
          `Interaction ${existing.id} is missing task governance`,
        );
      }
      const taskRow = await executeTakeFirst(
        client,
        db
          .selectFrom("tool_call_tasks")
          .select("session_id")
          .where("id", "=", existing.task_id)
          .limit(1),
      );
      if (!taskRow?.session_id) {
        throw new Error(
          `Plan approval interaction ${existing.id} is missing a session`,
        );
      }
      const sessionRow = await executeTakeFirst(
        client,
        db
          .selectFrom("sessions as s")
          .innerJoin("conversations as c", "c.id", "s.conversation_id")
          .select([
            "s.collaboration_state",
            "s.collaboration_mode",
            "s.active_plan_approval_interaction_id",
            "c.kind as conversation_kind",
          ])
          .where("s.id", "=", taskRow.session_id)
          .limit(1),
      );
      if (!sessionRow) {
        throw new Error(`Session ${taskRow.session_id} not found`);
      }
      if (isGroupConversationKind(sessionRow.conversation_kind)) {
        throw new Error("Plan mode is only available in private conversations.");
      }
      if (
        !isPlanAwaitingApprovalCollaborationMode(sessionRow.collaboration_mode)
      ) {
        throw new Error(
          `Session ${taskRow.session_id} must be in plan_awaiting_approval before resolving plan approval.`,
        );
      }
      if (!sessionRow.active_plan_approval_interaction_id) {
        throw new Error(
          `Session ${taskRow.session_id} is missing active_plan_approval_interaction_id`,
        );
      }
      if (sessionRow.active_plan_approval_interaction_id !== existing.id) {
        throw new Error(
          `Session ${taskRow.session_id} points to ${sessionRow.active_plan_approval_interaction_id}, not ${existing.id}`,
        );
      }

      const collaborationState = parseSessionCollaborationState(
        sessionRow.collaboration_state == null
          ? {}
          : requireJsonObject(
              sessionRow.collaboration_state,
              `Session ${taskRow.session_id} collaboration_state`,
            ),
      );
      const existingDraft = collaborationState.planDraft;
      if (!existingDraft) {
        throw new Error(
          `Session ${taskRow.session_id} is missing collaborationState.planDraft`,
        );
      }

      await updateSessionCollaboration(
        {
          sessionId: taskRow.session_id,
          collaborationMode:
            nextStatus === "approved" ? "default" : "plan_drafting",
          collaborationState:
            nextStatus === "approved"
              ? {}
              : {
                  planDraft: buildSessionPlanDraftState({
                    summary: existingDraft.summary,
                    checklist: existingDraft.checklist,
                    explanation: existingDraft.explanation,
                    enteredAt: existingDraft.enteredAt,
                  }),
                },
          activePlanApprovalInteractionId: null,
        },
        client,
      );
    }

    if (
      existing.kind === INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION &&
      params.decision === "approve"
    ) {
      const selectedGrantOptionId =
        typeof params.selectedGrantOptionId === "string"
          ? params.selectedGrantOptionId.trim()
          : "";
      if (!selectedGrantOptionId) {
        throw new Error("selectedGrantOptionId is required when approving relay authorization");
      }

      const grantOptions = parseJsonArray<RelayAuthorizationGrantOption>(
        existing.grant_options,
        `Interaction ${existing.id} grant_options`,
      );
      const availablePresets = parseJsonArray<RelayAuthorizationPreset>(
        existing.available_presets,
        `Interaction ${existing.id} available_presets`,
      );
      if (!availablePresets.includes(params.preset || "once")) {
        throw new Error(
          `preset ${(params.preset || "once")} is not allowed for this relay authorization request`,
        );
      }
      const selectedOption = grantOptions.find(
        (candidate) => candidate.id === selectedGrantOptionId,
      );
      if (!selectedOption) {
        throw new Error(
          `Unknown relay authorization option "${selectedGrantOptionId}"`,
        );
      }

      createdGrant = await createRelayAuthorizationGrant(
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
          sourceRetryNonce: existing.source_retry_nonce || undefined,
          sourceRuntimeSessionId: existing.source_runtime_session_id || undefined,
          sourceRequestArgs:
            existing.source_request_args &&
            typeof existing.source_request_args === "object"
              ? (existing.source_request_args as Record<string, unknown>)
              : {},
          grantSpec: selectedOption.grantSpec,
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

  if (interaction.kind === INTERACTION_REQUEST_KIND.USER_INPUT) {
    await completeToolCallTask(
      interaction.taskId,
      buildUserInputAsyncNotice(interaction),
    );
  } else if (interaction.kind === INTERACTION_REQUEST_KIND.PLAN_APPROVAL) {
    if (interaction.status === "approved") {
      await completeToolCallTask(
        interaction.taskId,
        buildPlanApprovalApprovedNotice(interaction),
      );
    } else {
      await failToolCallTask(
        interaction.taskId,
        buildPlanApprovalRevisionNotice(interaction),
      );
    }
  } else if (interaction.status === "rejected") {
    await failToolCallTask(
      interaction.taskId,
      buildRelayAuthorizationRejectedNotice(interaction),
    );
  } else {
    await completeToolCallTask(
      interaction.taskId,
      buildRelayAuthorizationApprovedNotice(interaction),
    );
  }

  return {
    interaction,
    createdGrant,
    createdGrants: createdGrant ? [createdGrant] : undefined,
  };
}

export async function markRelayAuthorizationInteractionSuperseded(
  interactionId: string,
  note?: string,
) {
  const existing = await getInteractionRowById(interactionId);
  if (!existing) {
    throw new Error("Interaction request not found");
  }
  if (
    existing.kind !== INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION ||
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
      status: "superseded",
      resolved_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    });
    await updateInteractionResolutionPayload(
      client,
      INTERACTION_REQUEST_KIND.RELAY_AUTHORIZATION,
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
      buildRelayAuthorizationSupersededNotice(interaction),
    );
  }
  return interaction;
}
