import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import {
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_TYPE_MASK_PRESETS,
  describeAutomationDelivery,
  describeAutomationPolicy,
  describeAutomationTrigger,
  describeTransportKind,
  INTERACTION_INPUT_QUESTION_TYPES,
  isGroupConversationKind,
  isThreadConversationKind,
  isTransportKind,
  normalizeActorDocs,
  resolveThreadSemantics,
  SEND_TO_INTENTS,
  summarizeActorForRole,
  mentionBlock,
  textBlock,
  textBlocks,
  textResult,
  type ActorDoc,
  type ToolDefinition,
  type ToolResolveContext,
} from "@synapse/shared"
import type {
  CapabilityInvocationContext,
  ConversationParticipantEntry,
  ConversationEntityRef,
  InteractionInputOption,
  InteractionInputQuestionDefinition,
  InteractionInputQuestionType,
  PlanChecklistStep,
} from "@synapse/shared/types"
import { rethrowToolExecutionError, throwToolError } from "./tool-errors.js"
import { registerToolPlugin } from "./tool-plugins.js"
import {
  buildReplyToRefUsageGuidance,
  buildEnterPlanModeToolDescription,
  buildExitPlanModeToolDescription,
  buildRequestUserInputToolDescription,
  buildUpdatePlanToolDescription,
} from "./session-tool-guidance.js"
import {
  assertPlanModeConversationKind,
  canEnterPlanMode,
  canExitPlanMode,
  canUpdatePlan,
} from "./session-plan-mode.js"
import {
  buildUserInteractionCandidatesFromEntries,
  buildUserInteractionCandidatesFromRows,
  type UserInteractionCandidate,
} from "./session-tool-user-interactions.js"
import { db } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { sql } from "kysely"
import { getSession, updateSessionCollaboration } from "../session/service.js"
import { getTransportConnectorCapability } from "../im/connectors/index.js"
import {
  buildSessionPlanDraftState,
  requireSessionPlanDraftState,
} from "../session/collaboration-state.js"
import {
  addConversationParticipants,
  getConversationParticipant,
  listConversationParticipants,
  resolveConversationReplyRef,
  sendConversationMessageFromParticipant,
} from "../chat/service.js"
import { buildNormalizedMessageContent } from "../chat/message-content.js"
import { buildDefaultUserMention } from "./inline-ref-resolver.js"
import { runMemorySearch } from "../memory/service.js"
import { sortAvailableSkillsForDiscovery } from "../skills/discovery-order.js"
import { readVisibleSkill } from "../skills/service.js"
import {
  listAutomationEventSources,
  listAutomationOccurrences,
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
} from "../automation/service.js"
import { isActorActiveConversationParticipant } from "../access/subject-resolution.js"
import {
  cancelToolCallTask,
  createToolCallTask,
  deliverResolvedToolCallTask,
  getToolCallTaskForSession,
  getToolCallTaskOutput,
  listToolCallTasksForSession,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js"
import {
  cancelInteractionRequestByTaskId,
  createPlanApprovalInteractionRequest,
  createUserInputInteractionRequest,
  getInteractionRequestSummaryByTaskId,
} from "../interactions/service.js"

type InviteableActor = {
  id: string
  name: string
  title?: string
  role?: string
  summary?: string
}

type SendToCandidate = {
  participantType: "actor" | "workspace_member" | "external"
  participantId: string
  actorId?: string
  workspaceMemberId?: string
  userId?: string
  externalUserKey?: string
  title?: string
  role?: string
  name: string
  label: string
  aliases: string[]
}

type ToolUserInputOptionInput = {
  id?: string
  label?: string
  description?: string
  preview?: string
}

type ToolUserInputQuestionInput = {
  id?: string
  header?: string
  type?: string
  prompt?: string
  description?: string
  required?: boolean
  options?: Array<string | ToolUserInputOptionInput>
  allowOther?: boolean
  placeholder?: string
  minSelections?: number
  maxSelections?: number
  secret?: boolean
}

const sendToIntentSchema = z.enum(SEND_TO_INTENTS)
const userInputQuestionTypeOptions = [...INTERACTION_INPUT_QUESTION_TYPES]
const selectableQuestionFieldTypeOptions = userInputQuestionTypeOptions.filter(
  (
    value
  ): value is Exclude<
    (typeof INTERACTION_INPUT_QUESTION_TYPES)[number],
    "text"
  > => value !== "text"
)
const sendToInputSchema = z.strictObject({
  message: z.string().trim().min(1).max(12000),
  intent: sendToIntentSchema,
  summary: z.string().trim().min(1).max(240),
  replyToRef: z.string().trim().min(1).optional(),
})
const currentTimeInputSchema = z.strictObject({
  timeZone: z.string().trim().min(1).max(100).optional(),
})

function getToolContextConversationId(ctx: ToolResolveContext) {
  return ctx.conversationId
}

function getToolContextConversationKind(ctx: ToolResolveContext) {
  return ctx.conversationKind
}

function getToolContextIsImConversation(ctx: ToolResolveContext) {
  return ctx.isImConversation ?? false
}

function getToolContextConversationParticipants(ctx: ToolResolveContext) {
  return ctx.conversationParticipants
}

function getThreadConversationId(
  session:
    | {
        conversation_id?: string
        conversation_kind?: string
      }
    | null
    | undefined
) {
  return isThreadConversationKind(session?.conversation_kind)
    ? session?.conversation_id || null
    : null
}

function normalizeRawSendToInput(input: Record<string, unknown>) {
  return {
    message: input.message,
    intent: input.intent,
    summary: input.summary ?? input.task,
    replyToRef: input.replyToRef,
  }
}

function formatUtcTimestamp(date: Date) {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`
}

async function requireCurrentAutomationParticipant(params: {
  conversationId: string
  actorId?: string
}) {
  if (!params.actorId) {
    throwToolError("Automation tools require an actor session")
  }

  const participant = await getConversationParticipant({
    conversationId: params.conversationId,
    actorId: params.actorId,
  })
  if (!participant || participant.state !== "active") {
    throwToolError(
      "Current actor is not an active participant in this conversation"
    )
  }
  return participant
}

async function listCurrentSessionAutomationRules(params: {
  workspaceId: string
  sessionId: string
  actorId?: string
}) {
  const session = await getSession(params.sessionId)
  if (!session) {
    throwToolError("Session not found")
  }
  const participant = await requireCurrentAutomationParticipant({
    conversationId: session.conversation_id,
    actorId: params.actorId,
  })
  const rules = await listAutomationRules(params.workspaceId, {
    conversationId: session.conversation_id,
  })
  return rules.filter((rule) => rule.createdByParticipantId === participant.id)
}

function buildSendToDefinition(params: {
  conversationKind?: string
  otherParticipants: ConversationParticipantEntry[]
}): ToolDefinition {
  const rosterDesc = params.otherParticipants
    .map((member) =>
      member.participantType === CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER
        ? `"${member.name}" (workspace member)`
        : member.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL
          ? `"${member.name}" (external${member.linkedWorkspaceMemberName ? `, linked to workspace user ${member.linkedWorkspaceMemberName}` : ""})`
          : `"${member.name}" (actor${member.title ? ", " + member.title : ""})`
    )
    .join(", ")
  const semantics = resolveThreadSemantics({
    kind: params.conversationKind,
    otherParticipantCount: params.otherParticipants.length,
  })

  if (
    semantics.addressingMode === "implicit_peer" &&
    params.otherParticipants.length === 1
  ) {
    const peerName = params.otherParticipants[0]!.name
    return {
      name: "send_to",
      description: `Send a visible message to the other participant in this direct thread. The recipient is implicit. Current peer: ${rosterDesc}.`,
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Why you are sending this message.",
            enum: [...SEND_TO_INTENTS],
          },
          summary: {
            type: "string",
            description:
              "A concise structured summary. For reply, summarize what you are replying with. For request, summarize what you want the other participant to do or answer.",
          },
          replyToRef: {
            type: "string",
            description: buildReplyToRefUsageGuidance("direct"),
          },
          message: {
            type: "string",
            description: `The visible message content sent in this direct thread with ${peerName}. Prefer inline <mention participantId="..."/>. You may also use <mention name="${peerName}"/> when the name is unique in the roster. Mention only when the sentence itself explicitly points to a participant.`,
          },
        },
        required: ["intent", "summary", "message"],
      },
    }
  }

  return {
    name: "send_to",
    description: `Send a visible conversation message in the current conversation. Group messages stay visible to everyone. Use inline mentions inside the message body only when the sentence explicitly refers to a participant. Active roster: ${rosterDesc}.`,
    parameters: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          description:
            'Use "reply" when you are replying back with information or a result. Use "request" when you are delegating, asking, or requesting action.',
          enum: [...SEND_TO_INTENTS],
        },
        summary: {
          type: "string",
          description:
            "A concise structured summary for the UI. For request, state the requested action or question. For reply, state the substantive reply.",
        },
        replyToRef: {
          type: "string",
          description: buildReplyToRefUsageGuidance("group"),
        },
        message: {
          type: "string",
          description:
            'The visible message content. Prefer inline <mention participantId="..."/>. You may also use <mention name="..."/> when the name is unique in the roster. Do not mechanically mention people at the start of every group message.',
        },
      },
      required: ["intent", "summary", "message"],
    },
  }
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
  })
  const parts = formatter.formatToParts(date)
  const valueFor = (type: string) =>
    parts.find((part) => part.type === type)?.value || ""

  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")} ${valueFor("hour")}:${valueFor("minute")}:${valueFor("second")} ${valueFor("timeZoneName")}`.trim()
}

function formatWeekdayInZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).format(date)
}

function buildSendToMention(candidate: SendToCandidate): ConversationEntityRef {
  return {
    participantId: candidate.participantId,
    participantType: candidate.participantType,
    actorId: candidate.actorId,
    workspaceMemberId: candidate.workspaceMemberId,
    externalUserKey: candidate.externalUserKey,
    name: candidate.name,
    title: candidate.title,
    role: candidate.role,
  }
}

function parseActorDocs(value: unknown): ActorDoc[] {
  if (!value) return []
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? normalizeActorDocs(parsed as ActorDoc[])
        : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? normalizeActorDocs(value as ActorDoc[]) : []
}

function isGroupVisibleDoc(doc: ActorDoc): boolean {
  return doc.visibility === "always" || doc.visibility === "multi_member_only"
}

function summarizeInviteableActor(row: {
  title?: string | null
  role?: string | null
  actor_docs?: unknown
}): string | undefined {
  const docs = parseActorDocs(row.actor_docs).filter(isGroupVisibleDoc)
  const summary = summarizeActorForRole(docs, row.title || row.role || "Actor")
    .replace(/\s+/g, " ")
    .trim()

  return summary || undefined
}

function formatInviteableActor(actor: InviteableActor): string {
  const title = actor.title || actor.role || "Actor"
  return `${actor.name} (${title}) [${actor.id}]${actor.summary ? ` - ${actor.summary}` : ""}`
}

function normalizeRecipientAlias(value: string) {
  return value.trim().toLowerCase()
}

function buildSendToCandidates(
  participants: any[],
  currentActorId?: string
): SendToCandidate[] {
  const candidates: SendToCandidate[] = []

  for (const participant of participants) {
    if (participant.state !== "active") continue

    if (participant.actor_id) {
      if (participant.actor_id === currentActorId) continue
      const name = participant.actor_name || "Unknown actor"
      const title = participant.actor_title || participant.actor_role || "Actor"
      candidates.push({
        participantType: "actor",
        participantId: participant.id,
        actorId: participant.actor_id,
        title: participant.actor_title || undefined,
        role: participant.actor_role || undefined,
        name,
        label: `"${name}" (actor${title ? `, ${title}` : ""})`,
        aliases: [name],
      })
      continue
    }

    if (participant.user_id) {
      const name = participant.user_name || "User"
      const transportKind = isTransportKind(participant.transport_kind)
        ? participant.transport_kind
        : undefined
      const transportLabel = transportKind
        ? `, reachable via ${
            getTransportConnectorCapability(transportKind)?.displayName ??
            describeTransportKind(transportKind)
          }`
        : ""
      candidates.push({
        participantType: "workspace_member",
        participantId: participant.id,
        workspaceMemberId: participant.workspace_member_id,
        name,
        title: "Workspace member",
        label: `"${name}" (workspace member${transportLabel})`,
        aliases: [name],
      })
      continue
    }

    if (participant.participant_type === "external") {
      const linkedWorkspaceMemberName =
        (participant.linked_user_name as string | null) || undefined
      const name =
        (participant.transport_display_name as string | null) ||
        (participant.display_name as string | null) ||
        linkedWorkspaceMemberName ||
        "External participant"
      const aliases = Array.from(
        new Set(
          [name, linkedWorkspaceMemberName].filter(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0
          )
        )
      )
      candidates.push({
        participantType: "external",
        participantId: participant.id,
        externalUserKey:
          (participant.transport_external_id as string | null) || undefined,
        name,
        title: linkedWorkspaceMemberName
          ? `Linked workspace user: ${linkedWorkspaceMemberName}`
          : "External participant",
        label:
          linkedWorkspaceMemberName && linkedWorkspaceMemberName !== name
            ? `"${name}" (external, linked to workspace user ${linkedWorkspaceMemberName})`
            : `"${name}" (external)`,
        aliases,
      })
    }
  }

  return candidates
}

function buildUserInteractionDirectory(candidates: UserInteractionCandidate[]) {
  return candidates
    .map((candidate) => `\`${candidate.participantId}\`: ${candidate.label}`)
    .join(", ")
}

function resolveUserInteractionCandidate(
  requestedParticipantId: string,
  candidates: UserInteractionCandidate[]
) {
  const candidate =
    candidates.find(
      (entry) => entry.participantId === requestedParticipantId
    ) || null
  if (candidate) {
    return { candidate, error: null }
  }

  return {
    candidate: null,
    error: `targetParticipantId must be one of: ${candidates.map((entry) => entry.participantId).join(", ")}`,
  }
}

function resolveHumanInteractionTarget(params: {
  requestedParticipantId?: string
  conversationKind?: string
  candidates: UserInteractionCandidate[]
}) {
  const requestedParticipantId = params.requestedParticipantId?.trim() || ""
  const isDirectConversation =
    params.conversationKind === "direct" && params.candidates.length === 1

  if (isDirectConversation) {
    const implicitCandidate = params.candidates[0] || null
    if (!implicitCandidate) {
      return {
        candidate: null,
        error: "There is no active user participant available.",
      }
    }
    if (
      requestedParticipantId &&
      requestedParticipantId !== implicitCandidate.participantId
    ) {
      return {
        candidate: null,
        error: `targetParticipantId must be omitted or set to ${implicitCandidate.participantId} in a direct conversation.`,
      }
    }
    return { candidate: implicitCandidate, error: null }
  }

  if (!requestedParticipantId) {
    return {
      candidate: null,
      error: "targetParticipantId is required in this conversation.",
    }
  }

  return resolveUserInteractionCandidate(
    requestedParticipantId,
    params.candidates
  )
}

function parsePlanChecklist(rawPlan: unknown): {
  checklist: PlanChecklistStep[]
  error?: string
} {
  if (!Array.isArray(rawPlan)) {
    return { checklist: [], error: "plan must be an array." }
  }

  const checklist: PlanChecklistStep[] = []
  for (const [index, rawItem] of rawPlan.entries()) {
    if (!rawItem || typeof rawItem !== "object") {
      return {
        checklist: [],
        error: `plan item ${index + 1} is invalid.`,
      }
    }
    const step =
      typeof (rawItem as { step?: unknown }).step === "string"
        ? (rawItem as { step: string }).step.trim()
        : ""
    const status =
      typeof (rawItem as { status?: unknown }).status === "string"
        ? (rawItem as { status: string }).status.trim()
        : ""
    if (!step) {
      return {
        checklist: [],
        error: `plan item ${index + 1} is missing step.`,
      }
    }
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed"
    ) {
      return {
        checklist: [],
        error: `plan item ${index + 1} has invalid status.`,
      }
    }
    checklist.push({
      step,
      status: status as PlanChecklistStep["status"],
    })
  }

  return { checklist }
}

async function createGovernedToolCallTask(params: {
  context: NonNullable<ReturnType<typeof getToolExecutionContext>>
  executorKind: "user_input" | "plan_approval" | "runtime_authorization"
  requestPayload: Record<string, unknown>
  summary: string
  expiresAt?: string
  supportsCancel?: boolean
}) {
  const { context } = params
  if (!context.toolCallId || !context.toolName) {
    throwToolError("No tool call context available for task governance")
  }
  if (!context.conversationId) {
    throwToolError(
      "Current tool call is not attached to a conversation that supports deferred follow-up"
    )
  }
  if (!context.actorId) {
    throwToolError("No actor context available for task governance")
  }

  try {
    // The waiter is the in-session actor → session_wakeup delivery, and these
    // are all human-answerable → needs_response. The principal subject is the
    // actor's access_subjects row (the delivery key). request_key is derived
    // from the originating tool call so a retried turn dedupes onto one task.
    const principalSubjectId = await upsertAccessSubject(db, {
      kind: "actor",
      actorId: context.actorId,
    })
    return await createToolCallTask({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      executorKind: params.executorKind,
      deliveryKind: "session_wakeup",
      humanSurface: "needs_response",
      principalSubjectId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      sourceToolCallId: context.toolCallId,
      sourceToolName: context.toolName,
      requestKey: `tool-call:${context.toolCallId}`,
      lifecycleStatus: "input_required",
      statusMessage: params.summary,
      supportsCancel: params.supportsCancel === true,
      requestPayload: params.requestPayload,
      deadlineAt: params.expiresAt,
      expiresAt: params.expiresAt,
    })
  } catch (error) {
    throwToolError(
      error instanceof Error ? error.message : "Failed to create tool-call task"
    )
  }
}

function serializeTaskSummary(task: ToolCallTaskRecord) {
  return {
    taskId: task.id,
    toolName: task.sourceToolName,
    executorKind: task.executorKind,
    deliveryKind: task.deliveryKind,
    humanSurface: task.humanSurface,
    lifecycleStatus: task.lifecycleStatus,
    outcome: task.outcome,
    statusMessage: task.statusMessage,
    supportsCancel: task.supportsCancel,
    supportsOutputTail: task.supportsOutputTail,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    cancelRequestedAt: task.cancelRequestedAt,
    cancelReason: task.cancelReason,
    lastOutputSeq: task.lastOutputSeq,
    lastOutputAt: task.lastOutputAt,
  }
}

function serializeTaskDetails(task: ToolCallTaskRecord) {
  return {
    ...serializeTaskSummary(task),
    requestPayload: task.requestPayload,
    finalResultPayload: task.finalResultPayload,
    finalErrorPayload: task.finalErrorPayload,
    metadata: task.metadata,
  }
}

async function loadSessionTaskOrThrow(sessionId: string, taskId: string) {
  const task = await getToolCallTaskForSession(sessionId, taskId)
  if (!task) {
    throwToolError(`Task "${taskId}" was not found in this session.`)
  }
  return task
}

async function cancelHumanInteractionTask(
  task: ToolCallTaskRecord,
  reason?: string
) {
  const note = reason?.trim()
  // cancelInteractionRequestByTaskId flips lifecycle=cancelled in-tx; here we
  // just persist the cancellation payload (the agent is the canceller, so no
  // self-wakeup is needed → notifyActor:false).
  const interaction = await cancelInteractionRequestByTaskId(task.id, note)
  const summary =
    note ||
    `Cancelled ${task.sourceToolName.replace(/_/g, " ")} before it completed.`

  return deliverResolvedToolCallTask(task.id, "cancelled", {
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
    notifyActor: false,
  })
}

// Device-runtime v3: relay subsystem removed. The previous
// `resolveRuntimeAuthorizationPlanOrThrow` helper and the `request_runtime_authorization`
// callable plugin were deleted alongside the relay tables in PR #20.

function normalizeUserInputQuestionType(
  value: unknown
): InteractionInputQuestionType | null {
  if (typeof value !== "string") return null
  switch (value.trim().toLowerCase()) {
    case "single_select":
    case "single":
    case "radio":
      return "single_select"
    case "multi_select":
    case "multiple":
    case "checkbox":
      return "multi_select"
    case "text":
    case "input":
    case "textarea":
      return "text"
    default:
      return null
  }
}

function buildUserInputOptionDefinitions(
  questionId: string,
  rawOptions: ToolUserInputQuestionInput["options"]
): InteractionInputOption[] {
  const options: InteractionInputOption[] = []
  const usedIds = new Set<string>()

  for (const [index, rawOption] of (rawOptions || []).entries()) {
    if (typeof rawOption === "string") {
      const label = rawOption.trim()
      if (!label) continue
      const id = `${questionId}_option_${index + 1}`
      usedIds.add(id)
      options.push({ id, label })
      continue
    }
    if (!rawOption || typeof rawOption !== "object") continue
    const label =
      typeof rawOption.label === "string" ? rawOption.label.trim() : ""
    if (!label) continue
    let id = typeof rawOption.id === "string" ? rawOption.id.trim() : ""
    if (!id || usedIds.has(id)) {
      id = `${questionId}_option_${index + 1}`
    }
    usedIds.add(id)
    options.push({
      id,
      label,
      description:
        typeof rawOption.description === "string"
          ? rawOption.description.trim() || undefined
          : undefined,
      preview:
        typeof rawOption.preview === "string"
          ? rawOption.preview.trim() || undefined
          : undefined,
    })
  }

  return options
}

function buildUserInputQuestionDefinition(
  rawQuestion: ToolUserInputQuestionInput,
  fallbackIndex: number
): { question: InteractionInputQuestionDefinition | null; error?: string } {
  const prompt = String(rawQuestion.prompt || "").trim()
  if (!prompt) {
    return {
      question: null,
      error: `Question ${fallbackIndex + 1} is missing a prompt.`,
    }
  }

  const normalizedType = normalizeUserInputQuestionType(rawQuestion.type)
  const type =
    normalizedType ||
    (Array.isArray(rawQuestion.options) ? "single_select" : "text")
  const id =
    String(rawQuestion.id || `question_${fallbackIndex + 1}`).trim() ||
    `question_${fallbackIndex + 1}`
  const question: InteractionInputQuestionDefinition = {
    id,
    header:
      typeof rawQuestion.header === "string"
        ? rawQuestion.header.trim() || `Q${fallbackIndex + 1}`
        : `Q${fallbackIndex + 1}`,
    type,
    prompt,
    description:
      typeof rawQuestion.description === "string"
        ? rawQuestion.description.trim() || undefined
        : undefined,
    required: rawQuestion.required !== false,
  }

  if (type === "text") {
    question.placeholder =
      typeof rawQuestion.placeholder === "string"
        ? rawQuestion.placeholder.trim() || undefined
        : undefined
    question.secret = rawQuestion.secret === true
    return { question }
  }

  const options = buildUserInputOptionDefinitions(id, rawQuestion.options)
  if (options.length === 0) {
    return {
      question: null,
      error: `"${prompt}" requires at least one option.`,
    }
  }

  question.options = options
  question.allowOther = rawQuestion.allowOther === true

  if (type === "multi_select") {
    if (
      typeof rawQuestion.minSelections === "number" &&
      Number.isFinite(rawQuestion.minSelections)
    ) {
      question.minSelections = Math.max(
        0,
        Math.trunc(rawQuestion.minSelections)
      )
    }
    if (
      typeof rawQuestion.maxSelections === "number" &&
      Number.isFinite(rawQuestion.maxSelections)
    ) {
      question.maxSelections = Math.max(
        1,
        Math.trunc(rawQuestion.maxSelections)
      )
    }
  }

  return { question }
}

const taskStatusFilterValues = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const

const taskOutputStreamValues = [
  "combined",
  "stdout",
  "stderr",
  "system",
] as const

function buildUserInputQuestionDefinitions(rawQuestions: unknown): {
  questions: InteractionInputQuestionDefinition[]
  error?: string
} {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return {
      questions: [],
      error: "questions must contain at least one question.",
    }
  }
  if (rawQuestions.length > 4) {
    return {
      questions: [],
      error: "questions supports at most 4 items.",
    }
  }

  const questions: InteractionInputQuestionDefinition[] = []
  const usedIds = new Set<string>()

  for (const [index, rawQuestion] of rawQuestions.entries()) {
    if (!rawQuestion || typeof rawQuestion !== "object") {
      return { questions: [], error: `Question ${index + 1} is invalid.` }
    }
    const { question, error } = buildUserInputQuestionDefinition(
      rawQuestion as ToolUserInputQuestionInput,
      index
    )
    if (!question) {
      return {
        questions: [],
        error: error || `Question ${index + 1} is invalid.`,
      }
    }
    if (usedIds.has(question.id)) {
      return {
        questions: [],
        error: `Question id "${question.id}" is duplicated.`,
      }
    }
    usedIds.add(question.id)
    questions.push(question)
  }

  return { questions }
}

async function listInviteableActors(params: {
  workspaceId: string
  conversationId: string
  actorId: string
}): Promise<InviteableActor[]> {
  const result = await db
    .selectFrom("actors as a")
    .leftJoin("actor_versions as current_version", (join) =>
      join
        .onRef("current_version.actor_id", "=", "a.id")
        .onRef("current_version.version", "=", "a.current_version")
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
    .where(
      sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM conversation_participants cp
      JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      WHERE cp.conversation_id = ${params.conversationId}
        AND cpsubj.actor_id = a.id
        AND cp.state = 'active'
    )`
    )
    .orderBy("a.name", "asc")
    .orderBy("a.id", "asc")
    .execute()

  return result.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    title: (row.title as string | null) || undefined,
    role: (row.role as string | null) || undefined,
    summary: summarizeInviteableActor(row),
  }))
}

async function canActorUseInviteActorTool(params: {
  actorId: string
  conversationId: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
}) {
  // invite_actor is restricted to NATIVE (in-app) group conversations. Actors
  // must not pull additional actors into an IM-bridged group chat (preserves the
  // pre-refactor "internal group only" behavior; the bit-mask equivalent is the
  // native `group` bit, NOT GROUP_ONLY which also includes im_group).
  if (
    !params.conversationId ||
    !isGroupConversationKind(params.conversationKind) ||
    params.isImConversation
  ) {
    return false
  }

  return isActorActiveConversationParticipant(
    db,
    params.conversationId,
    params.actorId
  )
}

function buildInviteActorDefinition(candidates: InviteableActor[]) {
  const candidateDirectory = candidates
    .map(
      (candidate) => `\`${candidate.id}\`: ${formatInviteableActor(candidate)}`
    )
    .join("; ")

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
  }
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
    definition: {
      name: "read_skill",
      description:
        "Read the description or an attachment of an available skill package on demand. Use when a listed skill clearly matches the task and you need its detailed instructions or referenced text resources.",
      parameters: {
        type: "object",
        properties: {
          skillName: {
            type: "string",
            description: "The available skill name/slug to read.",
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
      const availableSkills = sortAvailableSkillsForDiscovery(
        ctx.availableSkills || []
      )
      if (availableSkills.length === 0) {
        return { active: false, definition: null as any }
      }
      const skillNames: string[] = Array.from(
        new Set(availableSkills.map((skill) => skill.slug))
      )
      const previewSkills = skillNames
        .slice(0, 12)
        .map((skill) => `\`${skill}\``)
      const moreCount = skillNames.length - previewSkills.length
      const availabilityHint =
        moreCount > 0
          ? `${previewSkills.join(", ")}, and ${moreCount} more listed in the Available Skills section.`
          : `${previewSkills.join(", ")}.`
      return {
        active: true,
        definition: {
          name: "read_skill",
          description:
            `Read the contents of an available skill package. ` +
            `Use the exact slug from the Available Skills section. ` +
            `Currently available: ${availabilityHint}`,
          parameters: {
            type: "object",
            properties: {
              skillName: {
                type: "string",
                description: "The available skill name/slug to read.",
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
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }
      const actorParticipant = await requireCurrentAutomationParticipant({
        conversationId: session.conversation_id,
        actorId: context.actorId,
      })

      const skillName = String((input as any).skillName || "").trim()
      const path =
        typeof (input as any).path === "string"
          ? String((input as any).path).trim()
          : undefined
      if (!skillName) {
        throwToolError("skillName is required")
      }

      try {
        const result = await readVisibleSkill({
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          sessionId: context.sessionId,
          conversationId: session.conversation_id,
          conversationKind: session.conversation_kind,
          isImConversation: session.isImConversation,
          skillName,
          assetPath: path || undefined,
        })

        return textResult(
          [
            `Skill: ${result.skill.name}`,
            `Slug: ${result.skill.slug}`,
            `Version: ${result.skill.version}`,
            `Path: ${result.asset.path}`,
            "",
            result.asset.textContent || "",
          ].join("\n")
        )
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to read skill")
      }
    },
  })

  registerToolPlugin({
    name: "get_current_time",
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
      const parsed = currentTimeInputSchema.safeParse(input)
      if (!parsed.success) {
        throwToolError("Invalid input for get_current_time.", {
          details: parsed.error.issues.map((issue) => issue.message),
        })
      }

      const now = new Date()
      const resolvedTimeZone =
        parsed.data.timeZone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        "UTC"

      try {
        const localTime = formatDateTimeInZone(now, resolvedTimeZone)
        const weekday = formatWeekdayInZone(now, resolvedTimeZone)
        return textResult(
          JSON.stringify({
            nowIso: now.toISOString(),
            utc: formatUtcTimestamp(now),
            unixMs: now.getTime(),
            timeZone: resolvedTimeZone,
            localTime,
            weekday,
          })
        )
      } catch (error: any) {
        throwToolError(
          `Invalid timeZone "${resolvedTimeZone}". Use an IANA timezone such as Asia/Shanghai or America/Los_Angeles.`,
          {
            details: error?.message ? [error.message] : undefined,
          }
        )
      }
    },
  })

  registerToolPlugin({
    name: "send_to",
    definition: {
      name: "send_to",
      description:
        "Send a visible conversation message in the current thread. Messages remain visible to the whole conversation. Include whether this is a reply or a request, and include a short structured summary for UI rendering.",
      parameters: {
        type: "object",
        properties: {
          intent: {
            type: "string",
            description: "Why you are sending this message.",
            enum: [...SEND_TO_INTENTS],
          },
          summary: {
            type: "string",
            description:
              "A concise structured summary. For reply, summarize what you are replying with. For request, summarize what you want someone to do or answer.",
          },
          replyToRef: {
            type: "string",
            description:
              'Optional short message reference such as "m_1775264233848001" from the XML context when you are replying to a specific message.',
          },
          message: {
            type: "string",
            description:
              'The visible message content. Prefer inline <mention participantId="..."/>. You may also use <mention name="..."/> when the name is unique in the roster. Mention only when the sentence itself explicitly points to a participant.',
          },
        },
        required: ["intent", "summary", "message"],
      },
    },
    resolve: (ctx) => {
      const conversationId = getToolContextConversationId(ctx)
      const conversationParticipants =
        getToolContextConversationParticipants(ctx)
      if (!conversationId || !conversationParticipants?.length) {
        return { active: false, definition: null as any }
      }
      const otherParticipants = conversationParticipants.filter(
        (m) =>
          m.participantType ===
            CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER ||
          m.id !== ctx.actorId
      )
      if (otherParticipants.length === 0) {
        return { active: false, definition: null as any }
      }
      return {
        active: true,
        definition: buildSendToDefinition({
          conversationKind: getToolContextConversationKind(ctx),
          otherParticipants,
        }),
      }
    },
    execute: async (input) => {
      const parsed = sendToInputSchema.safeParse(
        normalizeRawSendToInput(input as Record<string, unknown>)
      )
      if (!parsed.success) {
        throwToolError("Invalid input for send_to.", {
          details: parsed.error.issues.map((issue) => issue.message),
        })
      }
      const { intent, summary, message, replyToRef } = parsed.data

      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      const conversationId = getThreadConversationId(session)
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation"
        )
      }

      const allMembers = await listConversationParticipants(conversationId)
      const senderParticipant = allMembers.find(
        (member: any) =>
          member.actor_id === context.actorId && member.state === "active"
      )
      if (!senderParticipant?.id) {
        throwToolError(
          "Current actor is not an active participant in this conversation."
        )
      }
      const mentionCandidates = buildSendToCandidates(allMembers)
      const normalizedMessage = await buildNormalizedMessageContent({
        content: message,
        inlineReferences: {
          mentionCandidates: mentionCandidates.map(buildSendToMention),
          defaultUser: buildDefaultUserMention({
            workspaceMemberId: context.workspaceMemberId,
            userName: "User",
          }),
        },
      })
      if (normalizedMessage.referenceWarnings.length > 0) {
        throwToolError("Invalid inline references in message.", {
          details: normalizedMessage.referenceWarnings,
        })
      }
      const replyTarget = await resolveConversationReplyRef({
        conversationId,
        participantId: senderParticipant.id,
        replyRef: replyToRef,
      })

      await sendConversationMessageFromParticipant({
        workspaceId: session.workspace_id,
        conversationId,
        senderParticipantId: senderParticipant.id,
        sessionId: context.sessionId,
        role: "assistant",
        contentBlocks: normalizedMessage.contentBlocks,
        replyToItemId: replyTarget?.itemId,
        metadata: {
          sendToIntent: intent,
          sendToSummary: summary,
        },
      })

      const result: Record<string, unknown> = {
        success: true,
        intent,
        summary,
        replyToRef: replyTarget?.ref,
        message: "Message sent.",
      }
      return textResult(JSON.stringify(result))
    },
  })

  registerToolPlugin({
    name: "request_user_input",
    definition: {
      name: "request_user_input",
      description: buildRequestUserInputToolDescription({ kind: "generic" }),
      parameters: {
        type: "object",
        properties: {
          targetParticipantId: {
            type: "string",
            description:
              "Required in group conversations. Omit in a direct conversation with one user.",
          },
          title: {
            type: "string",
            description: "Short title for the overall input request.",
          },
          instructions: {
            type: "string",
            description: "Optional short instructions for the user.",
          },
          questions: {
            type: "array",
            description: "One to four questions shown to the user.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                header: { type: "string" },
                type: {
                  type: "string",
                  enum: [...userInputQuestionTypeOptions],
                },
                prompt: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    anyOf: [
                      { type: "string" },
                      {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          label: { type: "string" },
                          description: { type: "string" },
                          preview: { type: "string" },
                        },
                        required: ["label"],
                      },
                    ],
                  },
                },
                allowOther: { type: "boolean" },
                placeholder: { type: "string" },
                minSelections: { type: "number" },
                maxSelections: { type: "number" },
                secret: { type: "boolean" },
              },
              required: ["prompt"],
            } as any,
          },
        },
        required: ["title", "questions"],
      },
    },
    resolve: (ctx) => {
      const conversationParticipants =
        getToolContextConversationParticipants(ctx)
      if (
        !getToolContextConversationId(ctx) ||
        !conversationParticipants?.length
      ) {
        return { active: false, definition: null as any }
      }
      const candidates = buildUserInteractionCandidatesFromEntries(
        conversationParticipants
      )
      if (candidates.length === 0) {
        return { active: false, definition: null as any }
      }
      const isDirectConversation =
        getToolContextConversationKind(ctx) === "direct" &&
        candidates.length === 1
      const candidateDirectory = buildUserInteractionDirectory(candidates)
      return {
        active: true,
        definition: {
          name: "request_user_input",
          description: isDirectConversation
            ? buildRequestUserInputToolDescription({
                kind: "direct",
                recipientLabel: candidates[0]!.label,
              })
            : buildRequestUserInputToolDescription({
                kind: "group",
                candidateDirectory,
              }),
          parameters: {
            type: "object",
            properties: {
              ...(isDirectConversation
                ? {}
                : {
                    targetParticipantId: {
                      type: "string",
                      description:
                        "The exact participant ID of the target user.",
                      enum: candidates.map(
                        (candidate) => candidate.participantId
                      ),
                    },
                  }),
              title: {
                type: "string",
                description: "Short title for the overall input request.",
              },
              instructions: {
                type: "string",
                description: "Optional short instructions for the user.",
              },
              questions: {
                type: "array",
                description: "One to four questions shown to the user.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    header: { type: "string" },
                    type: {
                      type: "string",
                      enum: [...userInputQuestionTypeOptions],
                    },
                    prompt: { type: "string" },
                    description: { type: "string" },
                    required: { type: "boolean" },
                    options: {
                      type: "array",
                      items: {
                        anyOf: [
                          { type: "string" },
                          {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              label: { type: "string" },
                              description: { type: "string" },
                              preview: { type: "string" },
                            },
                            required: ["label"],
                          },
                        ],
                      },
                    },
                    allowOther: { type: "boolean" },
                    placeholder: { type: "string" },
                    minSelections: { type: "number" },
                    maxSelections: { type: "number" },
                    secret: { type: "boolean" },
                  },
                  required: ["prompt"],
                } as any,
              },
            },
            required: ["title", "questions"],
          },
        },
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      const conversationId = getThreadConversationId(session)
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation"
        )
      }

      const allMembers = await listConversationParticipants(conversationId)
      const requesterMember = allMembers.find(
        (member) =>
          member.actor_id === context.actorId && member.state === "active"
      )
      if (!requesterMember) {
        throwToolError(
          "Current actor is not an active participant of this conversation"
        )
      }

      const candidates = buildUserInteractionCandidatesFromRows(allMembers)
      if (candidates.length === 0) {
        throwToolError(
          "There are no active user participants in this conversation"
        )
      }

      const resolution = resolveHumanInteractionTarget({
        requestedParticipantId:
          typeof (input as any).targetParticipantId === "string"
            ? String((input as any).targetParticipantId)
            : undefined,
        conversationKind: session.conversation_kind,
        candidates,
      })
      if (!resolution.candidate) {
        throwToolError(resolution.error || "Target user not found")
      }

      const title = String((input as any).title || "").trim()
      if (!title) {
        throwToolError("title is required")
      }

      const instructions =
        typeof (input as any).instructions === "string"
          ? String((input as any).instructions).trim()
          : ""

      const { questions, error } = buildUserInputQuestionDefinitions(
        (input as any).questions
      )
      if (error) {
        throwToolError(error)
      }

      const task = await createGovernedToolCallTask({
        context,
        executorKind: "user_input",
        supportsCancel: true,
        requestPayload: {
          targetParticipantId: resolution.candidate.participantId,
          title,
          instructions: instructions || undefined,
          questions,
        },
        summary: `Waiting for ${resolution.candidate.name} to complete "${title}".`,
      })

      let interaction
      try {
        interaction = await createUserInputInteractionRequest({
          workspaceId: context.workspaceId,
          conversationId,
          taskId: task.id,
          requesterParticipantId: requesterMember.id,
          targetParticipantId: resolution.candidate.participantId,
          title,
          instructions: instructions || undefined,
          questions,
        })
      } catch (error) {
        await cancelToolCallTask(task.id, {
          summary: `Input request for ${resolution.candidate.name} failed before dispatch.`,
          finalErrorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
          notifyActor: false,
        })
        throw error
      }

      return textResult(
        JSON.stringify({
          success: true,
          taskId: task.id,
          interactionId: interaction.id,
          targetMember: resolution.candidate.name,
          message: `Input request sent to ${resolution.candidate.name}. Only that participant can answer it.`,
        })
      )
    },
  })

  registerToolPlugin({
    name: "enter_plan_mode",
    definition: {
      name: "enter_plan_mode",
      description: buildEnterPlanModeToolDescription(),
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Optional short summary of what the plan will cover.",
          },
        },
        required: [],
      },
    },
    resolve: (ctx) => ({
      active:
        Boolean(getToolContextConversationId(ctx)) &&
        canEnterPlanMode(
          ctx.collaborationMode,
          getToolContextConversationKind(ctx)
        ),
      definition: {
        name: "enter_plan_mode",
        description: buildEnterPlanModeToolDescription(),
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description:
                "Optional short summary of what the plan will cover.",
            },
          },
          required: [],
        },
      },
    }),
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session || !getThreadConversationId(session)) {
        throwToolError(
          "Current session is not attached to a thread conversation"
        )
      }
      assertPlanModeConversationKind(session.conversation_kind)
      if (session.collaborationMode !== "default") {
        throwToolError(
          "enter_plan_mode is only available when the session is in default mode."
        )
      }

      const summary =
        typeof (input as any).summary === "string"
          ? String((input as any).summary).trim() || undefined
          : undefined

      await updateSessionCollaboration({
        sessionId: context.sessionId,
        collaborationMode: "plan_drafting",
        collaborationState: {
          planDraft: buildSessionPlanDraftState({
            summary,
            checklist: [],
            enteredAt: new Date().toISOString(),
          }),
        },
        activePlanApprovalInteractionId: null,
      })

      return textResult(
        JSON.stringify({
          success: true,
          collaborationMode: "plan_drafting",
          message: "Plan mode enabled.",
        })
      )
    },
  })

  registerToolPlugin({
    name: "update_plan",
    definition: {
      name: "update_plan",
      description: buildUpdatePlanToolDescription(),
      parameters: {
        type: "object",
        properties: {
          explanation: {
            type: "string",
            description:
              "Optional short explanation for the latest plan update.",
          },
          plan: {
            type: "array",
            description: "Checklist steps to store for the current plan.",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["step", "status"],
            } as any,
          },
        },
        required: ["plan"],
      },
    },
    resolve: (ctx) => ({
      active: canUpdatePlan(
        ctx.collaborationMode,
        getToolContextConversationKind(ctx)
      ),
      definition: {
        name: "update_plan",
        description: buildUpdatePlanToolDescription(),
        parameters: {
          type: "object",
          properties: {
            explanation: {
              type: "string",
              description:
                "Optional short explanation for the latest plan update.",
            },
            plan: {
              type: "array",
              description: "Checklist steps to store for the current plan.",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed"],
                  },
                },
                required: ["step", "status"],
              } as any,
            },
          },
          required: ["plan"],
        },
      },
    }),
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }
      assertPlanModeConversationKind(session.conversation_kind)
      if (session.collaborationMode !== "plan_drafting") {
        throwToolError("update_plan is only available while drafting a plan.")
      }

      const { checklist, error } = parsePlanChecklist((input as any).plan)
      if (error) {
        throwToolError(error)
      }
      const explanation =
        typeof (input as any).explanation === "string"
          ? String((input as any).explanation).trim() || undefined
          : undefined
      const existingDraft = requireSessionPlanDraftState(session)

      await updateSessionCollaboration({
        sessionId: context.sessionId,
        collaborationState: {
          planDraft: buildSessionPlanDraftState({
            summary: existingDraft.summary,
            checklist,
            explanation,
            enteredAt: existingDraft.enteredAt,
          }),
        },
      })

      return textResult(
        JSON.stringify({
          success: true,
          collaborationMode: "plan_drafting",
          checklist,
        })
      )
    },
  })

  registerToolPlugin({
    name: "exit_plan_mode",
    definition: {
      name: "exit_plan_mode",
      description: buildExitPlanModeToolDescription({ kind: "generic" }),
      parameters: {
        type: "object",
        properties: {
          targetParticipantId: {
            type: "string",
            description:
              "Required in group conversations. Omit in a direct conversation with one user.",
          },
          title: {
            type: "string",
            description: "Short title shown on the approval card.",
          },
          summary: {
            type: "string",
            description: "Optional one-line plan summary.",
          },
          planMarkdown: {
            type: "string",
            description: "The plan content to approve, in Markdown.",
          },
          checklist: {
            type: "array",
            description:
              "Optional checklist snapshot. Omit to reuse the current plan checklist from update_plan.",
            items: {
              type: "object",
              properties: {
                step: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                },
              },
              required: ["step", "status"],
            } as any,
          },
        },
        required: ["title", "planMarkdown"],
      },
    },
    resolve: (ctx) => {
      const conversationParticipants =
        getToolContextConversationParticipants(ctx)
      if (
        !canExitPlanMode(
          ctx.collaborationMode,
          getToolContextConversationKind(ctx)
        ) ||
        !getToolContextConversationId(ctx) ||
        !conversationParticipants?.length
      ) {
        return { active: false, definition: null as any }
      }
      const candidates = buildUserInteractionCandidatesFromEntries(
        conversationParticipants
      )
      if (candidates.length === 0) {
        return { active: false, definition: null as any }
      }
      const isDirectConversation =
        getToolContextConversationKind(ctx) === "direct" &&
        candidates.length === 1
      const candidateDirectory = buildUserInteractionDirectory(candidates)
      return {
        active: true,
        definition: {
          name: "exit_plan_mode",
          description: isDirectConversation
            ? buildExitPlanModeToolDescription({
                kind: "direct",
                recipientLabel: candidates[0]!.label,
              })
            : buildExitPlanModeToolDescription({
                kind: "group",
                candidateDirectory,
              }),
          parameters: {
            type: "object",
            properties: {
              ...(isDirectConversation
                ? {}
                : {
                    targetParticipantId: {
                      type: "string",
                      description:
                        "The exact participant ID of the target user.",
                      enum: candidates.map(
                        (candidate) => candidate.participantId
                      ),
                    },
                  }),
              title: {
                type: "string",
                description: "Short title shown on the approval card.",
              },
              summary: {
                type: "string",
                description: "Optional one-line plan summary.",
              },
              planMarkdown: {
                type: "string",
                description: "The plan content to approve, in Markdown.",
              },
              checklist: {
                type: "array",
                description:
                  "Optional checklist snapshot. Omit to reuse the current plan checklist from update_plan.",
                items: {
                  type: "object",
                  properties: {
                    step: { type: "string" },
                    status: {
                      type: "string",
                      enum: ["pending", "in_progress", "completed"],
                    },
                  },
                  required: ["step", "status"],
                } as any,
              },
            },
            required: ["title", "planMarkdown"],
          },
        },
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      const conversationId = getThreadConversationId(session)
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation"
        )
      }
      assertPlanModeConversationKind(session.conversation_kind)
      if (session.collaborationMode !== "plan_drafting") {
        throwToolError(
          "exit_plan_mode is only available while drafting a plan."
        )
      }

      const allMembers = await listConversationParticipants(conversationId)
      const requesterMember = allMembers.find(
        (member) =>
          member.actor_id === context.actorId && member.state === "active"
      )
      if (!requesterMember) {
        throwToolError(
          "Current actor is not an active participant of this conversation"
        )
      }

      const candidates = buildUserInteractionCandidatesFromRows(allMembers)
      if (candidates.length === 0) {
        throwToolError(
          "There are no active user participants in this conversation"
        )
      }

      const resolution = resolveHumanInteractionTarget({
        requestedParticipantId:
          typeof (input as any).targetParticipantId === "string"
            ? String((input as any).targetParticipantId)
            : undefined,
        conversationKind: session.conversation_kind,
        candidates,
      })
      if (!resolution.candidate) {
        throwToolError(resolution.error || "Target user not found")
      }

      const title = String((input as any).title || "").trim()
      if (!title) {
        throwToolError("title is required")
      }
      const summary =
        typeof (input as any).summary === "string"
          ? String((input as any).summary).trim() || undefined
          : undefined
      const planMarkdown = String((input as any).planMarkdown || "").trim()
      if (!planMarkdown) {
        throwToolError("planMarkdown is required")
      }

      let checklist: PlanChecklistStep[] | undefined
      if (Array.isArray((input as any).checklist)) {
        const parsed = parsePlanChecklist((input as any).checklist)
        if (parsed.error) {
          throwToolError(parsed.error)
        }
        checklist = parsed.checklist
      } else {
        checklist = requireSessionPlanDraftState(session).checklist
      }
      const existingDraft = requireSessionPlanDraftState(session)

      const task = await createGovernedToolCallTask({
        context,
        executorKind: "plan_approval",
        supportsCancel: true,
        requestPayload: {
          targetParticipantId: resolution.candidate.participantId,
          title,
          summary,
          planMarkdown,
          checklist,
        },
        summary: `Waiting for ${resolution.candidate.name} to review "${title}".`,
      })

      let interaction
      try {
        interaction = await createPlanApprovalInteractionRequest({
          workspaceId: context.workspaceId,
          conversationId,
          sessionId: context.sessionId,
          taskId: task.id,
          requesterParticipantId: requesterMember.id,
          targetParticipantId: resolution.candidate.participantId,
          title,
          summary,
          planMarkdown,
          checklist,
          collaborationState: {
            planDraft: buildSessionPlanDraftState({
              summary: existingDraft.summary,
              checklist: checklist || [],
              explanation: existingDraft.explanation,
              enteredAt: existingDraft.enteredAt,
            }),
          },
        })
      } catch (error) {
        await cancelToolCallTask(task.id, {
          summary: `Plan approval request for ${resolution.candidate.name} failed before dispatch.`,
          finalErrorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
          notifyActor: false,
        })
        throw error
      }

      return textResult(
        JSON.stringify({
          success: true,
          taskId: task.id,
          interactionId: interaction.id,
          collaborationMode: "plan_awaiting_approval",
          targetMember: resolution.candidate.name,
          message: `Plan submitted to ${resolution.candidate.name} for approval.`,
        })
      )
    },
  })

  registerToolPlugin({
    name: "list_tasks",
    definition: {
      name: "list_tasks",
      description:
        "List task-backed tool calls created in this session, including pending ask-user flows and async device command execution.",
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
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const statuses = Array.isArray((input as any).statuses)
        ? (input as any).statuses
            .map((value: unknown) => String(value || "").trim())
            .filter(
              (
                value: string
              ): value is (typeof taskStatusFilterValues)[number] =>
                (taskStatusFilterValues as readonly string[]).includes(value)
            )
        : []
      const limit =
        typeof (input as any).limit === "number" &&
        Number.isFinite((input as any).limit)
          ? Math.max(1, Math.trunc(Number((input as any).limit)))
          : 20

      const tasks = await listToolCallTasksForSession({
        sessionId: context.sessionId,
        statuses: statuses.length > 0 ? statuses : undefined,
        limit,
      })

      return textResult(
        JSON.stringify({
          success: true,
          tasks: tasks.map((task) => serializeTaskSummary(task)),
        })
      )
    },
  })

  registerToolPlugin({
    name: "get_task_status",
    definition: {
      name: "get_task_status",
      description:
        "Get the current status and final result metadata for one task in this session.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The exact task ID returned by a previous task-backed tool call.",
          },
        },
        required: ["taskId"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const taskId = String((input as any).taskId || "").trim()
      if (!taskId) {
        throwToolError("taskId is required")
      }

      const task = await loadSessionTaskOrThrow(context.sessionId, taskId)
      const interaction =
        task.executorKind === "user_input" ||
        task.executorKind === "plan_approval" ||
        task.executorKind === "runtime_authorization"
          ? await getInteractionRequestSummaryByTaskId(task.id)
          : null

      return textResult(
        JSON.stringify({
          success: true,
          task: serializeTaskDetails(task),
          interaction,
        })
      )
    },
  })

  registerToolPlugin({
    name: "cancel_task",
    definition: {
      name: "cancel_task",
      description:
        "Request cancellation for a task in this session. Human-interaction tasks cancel immediately; device command tasks cancel best-effort.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The exact task ID returned by a previous task-backed tool call.",
          },
          reason: {
            type: "string",
            description:
              "Optional reason to record with the cancellation request.",
          },
        },
        required: ["taskId"],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const taskId = String((input as any).taskId || "").trim()
      if (!taskId) {
        throwToolError("taskId is required")
      }

      const reason =
        typeof (input as any).reason === "string"
          ? String((input as any).reason).trim()
          : undefined
      const task = await loadSessionTaskOrThrow(context.sessionId, taskId)

      if (
        task.lifecycleStatus === "completed" ||
        task.lifecycleStatus === "failed" ||
        task.lifecycleStatus === "cancelled"
      ) {
        return textResult(
          JSON.stringify({
            success: true,
            alreadyTerminal: true,
            task: serializeTaskDetails(task),
          })
        )
      }

      if (!task.supportsCancel) {
        throwToolError(`Task "${task.id}" does not support cancellation.`)
      }

      // Only human-interaction tasks (runtime_authorization, interaction_user_input,
      // plan_approval) are created with supportsCancel: true, so past the guard above
      // the task is necessarily one of those. device_mcp tasks never set supportsCancel
      // and are rejected by the guard before reaching here.
      const updated = await cancelHumanInteractionTask(task, reason)
      const current = await loadSessionTaskOrThrow(context.sessionId, task.id)
      const interaction =
        current.executorKind === "user_input" ||
        current.executorKind === "plan_approval" ||
        current.executorKind === "runtime_authorization"
          ? await getInteractionRequestSummaryByTaskId(current.id)
          : null

      return textResult(
        JSON.stringify({
          success: true,
          message:
            updated?.lifecycleStatus === "cancelled"
              ? `Task ${task.id} was cancelled.`
              : `Cancellation requested for task ${task.id}.`,
          task: serializeTaskDetails(current),
          interaction,
        })
      )
    },
  })

  registerToolPlugin({
    name: "tail_task_output",
    definition: {
      name: "tail_task_output",
      description:
        "Read the latest output chunks from a task-backed device command execution in this session.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description:
              "The exact task ID returned by a previous async device command call.",
          },
          afterSeq: {
            type: "number",
            description:
              "Optional cursor. Only return output chunks with seq greater than this value.",
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
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const taskId = String((input as any).taskId || "").trim()
      if (!taskId) {
        throwToolError("taskId is required")
      }

      const task = await loadSessionTaskOrThrow(context.sessionId, taskId)
      if (!task.supportsOutputTail) {
        throwToolError(`Task "${task.id}" does not expose output tailing.`)
      }

      const afterSeq =
        typeof (input as any).afterSeq === "number" &&
        Number.isFinite((input as any).afterSeq)
          ? Math.max(0, Math.trunc(Number((input as any).afterSeq)))
          : 0
      const limit =
        typeof (input as any).limit === "number" &&
        Number.isFinite((input as any).limit)
          ? Math.max(1, Math.trunc(Number((input as any).limit)))
          : 20
      const stream =
        typeof (input as any).stream === "string" &&
        (taskOutputStreamValues as readonly string[]).includes(
          String((input as any).stream).trim()
        )
          ? (String((input as any).stream).trim() as
              | "combined"
              | "stdout"
              | "stderr"
              | "system")
          : "combined"

      const chunks = await getToolCallTaskOutput({
        taskId: task.id,
        afterSeq,
        limit,
        stream,
      })

      return textResult(
        JSON.stringify({
          success: true,
          task: serializeTaskSummary(task),
          chunks,
          combinedText: chunks.map((chunk) => chunk.text).join("\n"),
          nextAfterSeq:
            chunks.length > 0 ? chunks[chunks.length - 1]!.seq : afterSeq,
        })
      )
    },
  })

  // ============ invite_actor (callable) ============
  registerToolPlugin({
    name: "invite_actor",
    conversationTypeMask: CONVERSATION_TYPE_MASK_PRESETS.NATIVE_GROUP_ONLY,
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
      const conversationId = getToolContextConversationId(ctx)
      const requesterAllowed = conversationId
        ? await canActorUseInviteActorTool({
            actorId: ctx.actorId,
            conversationId,
            conversationKind: getToolContextConversationKind(ctx),
            isImConversation: getToolContextIsImConversation(ctx),
          })
        : false
      if (!requesterAllowed) {
        return { active: false, definition: null as any }
      }

      const candidates = await listInviteableActors({
        workspaceId: ctx.workspaceId,
        conversationId: conversationId!,
        actorId: ctx.actorId,
      })

      if (candidates.length === 0) {
        return { active: false, definition: null as any }
      }

      return {
        active: true,
        definition: buildInviteActorDefinition(candidates),
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      const conversationId = getThreadConversationId(session)
      if (!session || !conversationId) {
        throwToolError(
          "Current session is not attached to a thread conversation"
        )
      }
      if (!isGroupConversationKind(session.conversation_kind)) {
        throwToolError("invite_actor is only available in group conversations.")
      }
      if (session.isImConversation) {
        throwToolError(
          "invite_actor is not available in IM group conversations."
        )
      }
      const requesterAllowed = await canActorUseInviteActorTool({
        actorId: context.actorId,
        conversationId,
        conversationKind: session.conversation_kind,
        isImConversation: session.isImConversation,
      })
      if (!requesterAllowed) {
        throwToolError(
          "Actor is not allowed to invite participants into this conversation."
        )
      }

      const reason =
        typeof (input as any).reason === "string"
          ? String((input as any).reason).trim()
          : ""
      if (!reason) {
        throwToolError("reason is required")
      }

      const candidates = await listInviteableActors({
        workspaceId: session.workspace_id,
        conversationId,
        actorId: context.actorId,
      })
      const candidateById = new Map(
        candidates.map((candidate) => [candidate.id, candidate])
      )
      const candidatesByName = new Map<string, InviteableActor[]>()
      for (const candidate of candidates) {
        const key = candidate.name.trim().toLowerCase()
        const matches = candidatesByName.get(key) || []
        matches.push(candidate)
        candidatesByName.set(key, matches)
      }

      const requestedActorIds = Array.isArray((input as any).actorIds)
        ? (input as any).actorIds
            .map((value: unknown) => String(value || "").trim())
            .filter(Boolean)
        : []
      const fallbackNames = [
        typeof (input as any).actorName === "string"
          ? String((input as any).actorName).trim()
          : "",
        ...(Array.isArray((input as any).actorNames)
          ? (input as any).actorNames.map((value: unknown) =>
              String(value || "").trim()
            )
          : []),
      ].filter(Boolean)

      const resolvedActors: InviteableActor[] = []
      const resolutionErrors: string[] = []

      for (const actorId of requestedActorIds) {
        const candidate = candidateById.get(actorId)
        if (!candidate) {
          resolutionErrors.push(
            `Actor ID "${actorId}" is not currently inviteable.`
          )
          continue
        }
        resolvedActors.push(candidate)
      }

      for (const actorName of fallbackNames) {
        const matches = candidatesByName.get(actorName.toLowerCase()) || []
        if (matches.length === 0) {
          resolutionErrors.push(
            `Actor "${actorName}" is not currently inviteable.`
          )
          continue
        }
        if (matches.length > 1) {
          resolutionErrors.push(
            `Actor name "${actorName}" is ambiguous. Use actorIds instead: ${matches.map((candidate) => candidate.id).join(", ")}`
          )
          continue
        }
        resolvedActors.push(matches[0]!)
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
        })
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
        })
      }

      const uniqueActors = Array.from(
        new Map(
          resolvedActors.map((candidate) => [candidate.id, candidate])
        ).values()
      )

      try {
        const inviterMember = (
          await listConversationParticipants(conversationId)
        ).find(
          (member: any) =>
            member.actor_id === context.actorId && member.state === "active"
        )
        if (!inviterMember?.id) {
          throwToolError(
            "Current actor is not an active participant in this conversation."
          )
        }
        const addResult = await addConversationParticipants({
          conversationId,
          workspaceId: session.workspace_id,
          actorIds: uniqueActors.map((candidate) => candidate.id),
        })
        const invitedActorIds = new Set(
          addResult
            .filter((member: any) => member.actor_id)
            .map((member: any) => member.actor_id as string)
        )
        const invitedActors = uniqueActors.filter((candidate) =>
          invitedActorIds.has(candidate.id)
        )
        const skippedActors = uniqueActors
          .filter((candidate) => !invitedActorIds.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            reason: "Actor already in conversation",
          }))

        if (invitedActors.length === 0) {
          throwToolError("No new actors were invited.", {
            extra: { skippedActors },
          })
        }

        await sendConversationMessageFromParticipant({
          workspaceId: session.workspace_id,
          conversationId,
          senderParticipantId: inviterMember?.id,
          sessionId: context.sessionId,
          role: "assistant",
          contentBlocks: [
            ...invitedActors.flatMap((candidate, index) => {
              const participant = addResult.find(
                (member: any) => member.actor_id === candidate.id
              )
              if (!participant?.id) {
                return []
              }
              const mention = mentionBlock({
                mention: {
                  participantId: participant.id,
                  participantType: "actor",
                  actorId: candidate.id,
                  name: candidate.name,
                  title: candidate.title,
                  role: candidate.role,
                },
              })
              const needsSpacer =
                index < invitedActors.length - 1 || reason.trim().length > 0
              return needsSpacer ? [mention, textBlock(" ")] : [mention]
            }),
            ...textBlocks(reason),
          ],
        })

        return textResult(
          JSON.stringify({
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
          })
        )
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to invite actor(s)")
      }
    },
  })

  // ============ memory_search (callable) ============
  registerToolPlugin({
    name: "memory_search",
    definition: {
      name: "memory_search",
      description:
        "Search durable memories across all memory spaces you can currently read in this workspace. In direct one-to-one chats with a user, this also searches that user's personal workspace memory. Use when recalled memory is insufficient and you need deeper historical context.",
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
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }

      const queryText = String((input as any).queryText || "").trim()
      const limit = Math.max(
        1,
        Math.min(10, parseInt(String((input as any).limit || "5"), 10) || 5)
      )
      if (!queryText) {
        throwToolError("queryText is required")
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
      })

      return textResult(
        JSON.stringify({
          success: true,
          runId: result.run.id,
          results: result.memories.map((memory) => ({
            id: memory.id,
            ownerKind: memory.owner.kind,
            scopeKind: memory.scope?.kind,
            namespaceKey: memory.namespaceKey,
            category: memory.category,
            textDigest: memory.textDigest,
            tags: memory.tags,
            finalScore: Number(memory.finalScore.toFixed(4)),
            matchedTerms: memory.matchedTerms || [],
          })),
        })
      )
    },
  })

  registerToolPlugin({
    name: "schedule_self_wakeup",
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
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }
      const actorParticipant = await requireCurrentAutomationParticipant({
        conversationId: session.conversation_id,
        actorId: context.actorId,
      })

      const name = String((input as any).name || "").trim()
      const scheduleKind = String((input as any).scheduleKind || "").trim()
      const scheduleExpr =
        typeof (input as any).scheduleExpr === "string"
          ? String((input as any).scheduleExpr).trim()
          : ""
      const intervalSeconds =
        typeof (input as any).intervalSeconds === "number"
          ? Number((input as any).intervalSeconds)
          : undefined
      const timezone =
        typeof (input as any).timezone === "string"
          ? String((input as any).timezone).trim()
          : undefined
      const message = String((input as any).message || "").trim()
      const wakeReason =
        typeof (input as any).wakeReason === "string"
          ? String((input as any).wakeReason).trim()
          : undefined
      const activeUntil =
        typeof (input as any).activeUntil === "string"
          ? String((input as any).activeUntil).trim()
          : undefined
      const maxTriggerCount =
        typeof (input as any).maxTriggerCount === "number"
          ? Number((input as any).maxTriggerCount)
          : undefined

      if (!name || !message) {
        throwToolError("name and message are required")
      }

      try {
        const rule = await createAutomationRule(
          context.workspaceId,
          {
            kind: "session",
            workspaceMemberId: context.workspaceMemberId,
            actorId: context.actorId,
            sessionId: context.sessionId,
          },
          {
            name,
            description: `Self-scheduled wakeup for session ${context.sessionId}`,
            conversationId: session.conversation_id,
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
              message,
              wakeReason,
              targetPolicy: "specified_members",
              targetParticipantIds: [actorParticipant.id],
            },
          }
        )

        return textResult(
          JSON.stringify({
            success: true,
            automationId: rule.id,
            nextFireAt: rule.trigger.nextFireAt,
            message: `Scheduled self wakeup created: ${rule.name}.`,
          })
        )
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to create schedule")
      }
    },
  })

  registerToolPlugin({
    name: "list_event_sources",
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
        return { active: false, definition: null as any }
      }
      const sources = await listAutomationEventSources(
        ctx.workspaceId,
        {
          status: "active",
        },
        {
          conversationId: ctx.conversationId!,
          actorId: ctx.actorId,
        }
      )
      if (sources.length === 0) {
        return { active: false, definition: null as any }
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
      }
    },
    execute: async () => {
      const context = getToolExecutionContext()
      if (!context?.sessionId) {
        throwToolError("No session context available")
      }
      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }

      const sources = await listAutomationEventSources(
        context.workspaceId,
        {
          status: "active",
        },
        {
          conversationId: session.conversation_id,
          actorId: context.actorId,
        }
      )
      return textResult(
        JSON.stringify({
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
        })
      )
    },
  })

  registerToolPlugin({
    name: "subscribe_event",
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
        return { active: false, definition: null as any }
      }
      const sources = await listAutomationEventSources(
        ctx.workspaceId,
        {
          status: "active",
        },
        {
          conversationId: ctx.conversationId!,
          actorId: ctx.actorId,
        }
      )
      if (sources.length === 0) {
        return { active: false, definition: null as any }
      }

      const directory = sources
        .map(
          (source) =>
            `\`${source.id}\`: ${source.name} (${source.providerKind}/${source.sourceKey}) - ${source.description}` +
            `${source.recommendedUsage ? ` Suggested usage: ${source.recommendedUsage}` : ""}`
        )
        .join("; ")

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
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }
      const actorParticipant = await requireCurrentAutomationParticipant({
        conversationId: session.conversation_id,
        actorId: context.actorId,
      })

      const name = String((input as any).name || "").trim()
      const eventSourceId = String((input as any).eventSourceId || "").trim()
      const matcherInput =
        typeof (input as any).matcher === "string"
          ? String((input as any).matcher).trim()
          : ""
      const message = String((input as any).message || "").trim()
      const wakeReason =
        typeof (input as any).wakeReason === "string"
          ? String((input as any).wakeReason).trim()
          : undefined
      const once = Boolean((input as any).once)
      const activeUntil =
        typeof (input as any).activeUntil === "string"
          ? String((input as any).activeUntil).trim()
          : undefined
      const maxTriggerCount =
        typeof (input as any).maxTriggerCount === "number"
          ? Number((input as any).maxTriggerCount)
          : undefined

      if (!name || !eventSourceId || !message) {
        throwToolError("name, eventSourceId, and message are required")
      }

      let matcher: Record<string, unknown> | undefined
      if (matcherInput) {
        try {
          const parsed = JSON.parse(matcherInput) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throwToolError("matcher must be a JSON object string")
          }
          matcher = parsed as Record<string, unknown>
        } catch {
          throwToolError("matcher must be valid JSON")
        }
      }

      try {
        const rule = await createAutomationRule(
          context.workspaceId,
          {
            kind: "session",
            workspaceMemberId: context.workspaceMemberId,
            actorId: context.actorId,
            sessionId: context.sessionId,
          },
          {
            name,
            description: `Self event subscription for session ${context.sessionId}`,
            conversationId: session.conversation_id,
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
              message,
              wakeReason,
              targetPolicy: "specified_members",
              targetParticipantIds: [actorParticipant.id],
            },
          }
        )

        return textResult(
          JSON.stringify({
            success: true,
            automationId: rule.id,
            eventSourceId: rule.trigger.eventSourceId,
            message: `Event subscription created: ${rule.name}.`,
          })
        )
      } catch (err: any) {
        rethrowToolExecutionError(err, "Failed to create event subscription")
      }
    },
  })

  registerToolPlugin({
    name: "view_event_source_history",
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
        return { active: false, definition: null as any }
      }
      const sources = await listAutomationEventSources(
        ctx.workspaceId,
        undefined,
        {
          conversationId: ctx.conversationId!,
          actorId: ctx.actorId,
        }
      )
      if (sources.length === 0) {
        return { active: false, definition: null as any }
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
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const eventSourceId = String((input as any).eventSourceId || "").trim()
      if (!eventSourceId) {
        throwToolError("eventSourceId is required")
      }

      const occurrences = await listAutomationOccurrences(context.workspaceId, {
        eventSourceId,
        limit: 20,
      })
      return textResult(
        JSON.stringify({
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
        })
      )
    },
  })

  registerToolPlugin({
    name: "list_automations",
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
      const context = getToolExecutionContext()
      if (!context?.sessionId) {
        throwToolError("No session context available")
      }

      const rules = await listCurrentSessionAutomationRules({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        actorId: context.actorId,
      })
      return textResult(
        JSON.stringify({
          success: true,
          automations: rules.map((rule) => {
            const triggerDisplay = describeAutomationTrigger(rule.trigger)
            const policyDisplay = describeAutomationPolicy(rule.policy)
            const deliveryDisplay = describeAutomationDelivery(rule.delivery)
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
              conversationId: rule.conversationId,
              targetParticipantIds: rule.delivery.targetParticipantIds,
            }
          }),
        })
      )
    },
  })

  registerToolPlugin({
    name: "cancel_automation",
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
        return { active: false, definition: null as any }
      }
      const rules = await listCurrentSessionAutomationRules({
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        actorId: ctx.actorId,
      })
      if (rules.length === 0) {
        return { active: false, definition: null as any }
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
      }
    },
    execute: async (input) => {
      const context = getToolExecutionContext()
      if (!context?.sessionId) {
        throwToolError("No session context available")
      }
      const automationId = String((input as any).automationId || "").trim()
      if (!automationId) {
        throwToolError("automationId is required")
      }

      const rules = await listCurrentSessionAutomationRules({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        actorId: context.actorId,
      })
      const rule = rules.find((entry) => entry.id === automationId)
      if (!rule) {
        throwToolError("Automation not found in this session scope")
      }

      await deleteAutomationRule(context.workspaceId, automationId, {
        workspaceMemberId: context.workspaceMemberId,
        actorId: context.actorId,
      })
      return textResult(
        JSON.stringify({
          success: true,
          automationId,
          message: `Automation deleted: ${rule.name}.`,
        })
      )
    },
  })

  // ============ sleep (callable) ============
  registerToolPlugin({
    name: "sleep",
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
      const context = getToolExecutionContext()
      if (!context) {
        throwToolError("No session context available")
      }

      const session = await getSession(context.sessionId)
      if (!session) {
        throwToolError("Session not found")
      }

      const summary =
        typeof (input as any).summary === "string"
          ? String((input as any).summary).trim()
          : ""

      return textResult(
        JSON.stringify({
          success: true,
          summary,
          message:
            "Sleep requested. The session will return to idle after this turn completes.",
        })
      )
    },
  })
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  )
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

// ============ Tool Execution Context ============
// Uses AsyncLocalStorage so each concurrent BullMQ job has its own context.

type ToolExecutionContext = CapabilityInvocationContext & {
  sessionId: string
  actorId: string
  workspaceId: string
}

const contextStorage = new AsyncLocalStorage<ToolExecutionContext>()

/**
 * Run `fn` with the given tool execution context bound via AsyncLocalStorage.
 */
export function runWithToolContext<T>(
  ctx: ToolExecutionContext,
  fn: () => T
): T {
  return contextStorage.run(ctx, fn)
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return contextStorage.getStore() ?? null
}
