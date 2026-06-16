import {
  CONVERSATION_PARTICIPANT_TYPE,
  TASK_REQUEST_KIND,
  textBlocks,
  type SubjectRef,
} from "@synapse/shared"
import {
  isGroupConversationKind,
  isPlanAwaitingApprovalCollaborationMode,
} from "@synapse/shared/utils"
import { v4 as uuidv4 } from "uuid"
import type {
  CanonicalContentBlock,
  ChatTaskResolveInput,
  ChatTaskResolveOutcome,
  ConversationFeedItem,
  ConversationFeedEventPayloadMap,
  TaskDecision,
  TaskInputAnswer,
  TaskInputOption,
  TaskInputQuestionDefinition,
  TaskRequestKind,
  TaskSummary,
  PlanApprovalDecision,
  PlanChecklistStep,
  RuntimeAuthorizationGrantOption,
  SharedRuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
  SessionCollaborationState,
  Timestamp,
} from "@synapse/shared/types"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  deliverResolvedToolCallTask,
  recoverUndeliveredResolvedTask,
  insertToolCallTaskDeduped,
  findLiveToolCallTaskByRequestKey,
  type ToolCallTaskLifecycleStatus,
  type ToolCallTaskOutcome,
} from "../tool-call-tasks/service.js"
import { updateSessionCollaboration } from "../session/service.js"
import { userSubject, workspaceMemberSubject } from "../access/service.js"
import { authorizeActionDefault } from "../access/guards.js"
import {
  createConversationEvent,
  updateConversationItemEventPayload,
} from "../chat/event-write.js"
import { listConversationRealtimeRecipients } from "../chat/realtime-recipients.js"
import { appendWorkspaceMemberSyncEvent } from "../chat/sync-events.js"
import {
  createRuntimeAuthorizationGrant,
  type RuntimeAuthorizationGrantRecord,
} from "../runtime-authorizations/service.js"
import { autoDispatchRuntimeAuthorizationRetry } from "../runtime-authorizations/auto-retry.js"
import {
  buildSessionPlanDraftState,
  parseSessionCollaborationState,
} from "../session/collaboration-state.js"
import {
  parseUserInputQuestionDefinitions,
  presentTaskSummary,
  requireTrimmedString,
  toRevisionNumber,
} from "./presenter.js"
import {
  findConversationKindOn,
  findOpenRuntimeAuthorizationTaskId,
  findPendingTaskIdByRequestKey,
  findRemoteAgentGroupTaskGrant,
  findSessionPlanRowOn,
  findTaskIdByTaskId,
  findViewerConversationMembership,
  getTaskCommandRow,
  getTaskRowById,
  getTaskRowByIdForUpdate,
  insertRuntimeAuthorizationTaskDetails,
  insertTaskCommandRow,
  insertTaskRequest,
  isActiveTargetParticipantForUser,
  buildRuntimePrincipalContextDefault,
  clearRemoteAgentConversationContextOnResolve,
  decodeTaskPromptPayload,
  decodeTaskResolutionPayload,
  resolveParticipantSubjectId,
  taskViewableByUser,
  updateTaskConversationItemId,
  updateResolvedTaskRequestRow,
  updateTaskResolutionPayload,
  upsertTaskTransportProjection,
  upsertRemoteAgentConversationContextForPlan,
  withTaskTransaction,
} from "./repo.js"

export interface CreateUserInputTaskParams {
  workspaceId: string
  conversationId: string
  taskId: string
  requesterParticipantId: string
  targetParticipantId: string
  title: string
  instructions?: string
  questions: TaskInputQuestionDefinition[]
  expiresAt?: Timestamp
}

export interface CreateRemoteAgentUserInputTaskParams {
  workspaceId: string
  conversationId: string
  remoteAgentRunId: string
  requesterParticipantId: string
  targetParticipantId?: string
  title: string
  instructions?: string
  questions: TaskInputQuestionDefinition[]
  expiresAt?: Timestamp
}

export interface CreatePlanApprovalTaskParams {
  workspaceId: string
  conversationId: string
  sessionId: string
  taskId: string
  requesterParticipantId: string
  targetParticipantId: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
  collaborationState: SessionCollaborationState
  expiresAt?: Timestamp
}

export interface CreateRemoteAgentPlanApprovalTaskParams {
  workspaceId: string
  conversationId: string
  remoteAgentRunId: string
  requesterParticipantId: string
  targetParticipantId?: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: PlanChecklistStep[]
  collaborationMode?: string
  collaborationState?: Record<string, unknown>
  expiresAt?: Timestamp
}

export interface CreateRuntimeAuthorizationTaskParams {
  workspaceId: string
  conversationId: string
  /**
   * Optional. Actor principals create a
   * tool_call_task so the approval can drive a chat wakeup; remote_agent
   * principals leave it undefined — the bridged agent retries its own
   * tool call on the next round-trip.
   */
  taskId?: string
  requesterParticipantId: string
  deviceCapabilityId: string
  deviceId: string
  deviceExposureId: string
  requestedToolName: string
  runtimeSessionId: string
  deviceToolStableKey: string
  reason: string
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  requestMode: RuntimeAuthorizationRequestMode
  sourceRetryNonce?: string
  sourceRequestArgs?: Record<string, unknown>
  expiresAt?: Timestamp
  /**
   * subject-scope-refactor: principalSubjectId (NOT NULL) — the
   * access_subjects row for the principal that triggered the dispatch.
   * Caller resolves via upsertAccessSubject(actor/remote_agent/conversation)
   * before invoking this function.
   */
  principalSubjectId: string
  /**
   * Optional principal scope subject id (the conversation subject when the
   * triggering principal was an active participant); null otherwise.
   */
  principalScopeSubjectId?: string | null
  /**
   * @deprecated kept for transitional callers; not written to the DB.
   * The approval flow now uses principalSubjectId + presetToOwnerScope.
   */
  principalRemoteAgentId?: string
}

export type ResolveTaskRequestParams = ChatTaskResolveInput & {
  taskId: string
  resolverWorkspaceMemberId: string
  resolverParticipantId: string
}

export interface ResolveTaskRequestResult {
  outcome: ChatTaskResolveOutcome
  task: TaskSummary
  createdGrant?: RuntimeAuthorizationGrantRecord
  createdGrants?: RuntimeAuthorizationGrantRecord[]
}

export interface FindOpenRuntimeAuthorizationTaskParams {
  workspaceId: string
  conversationId: string
  requesterParticipantId: string
  deviceCapabilityId: string
  deviceId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  requestMode: RuntimeAuthorizationRequestMode
  /**
   * Source Agent session id (chat-runtime session.id). Must match the
   * value the caller would write via createRuntimeAuthorizationTaskRequest's
   * `runtimeSessionId` field so the dedupe key matches a previously-created
   * row. Pass the empty string when the caller has no session context (the
   * dedupe still works within that single bucket).
   */
  runtimeSessionId: string
}

function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`
  }
  if (isJsonObjectRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)
    )
    return `{${entries
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function isJsonObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Build the dedupe key used to merge identical pending runtime-authorization
 * requests. Exported for unit-testing the per-session isolation contract —
 * two callers differing only in runtimeSessionId MUST produce different
 * keys so concurrent Agent sessions never share a single pending task
 * (and, post-approval, never inherit each other's source_runtime_session_id).
 */
export function buildRuntimeAuthorizationDedupeKey(params: {
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  requestMode: RuntimeAuthorizationRequestMode
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
  availablePresets: RuntimeAuthorizationPreset[]
  /**
   * Source Agent session id. Included in the dedupe key so two Agent
   * sessions making the same tool call don't merge into a single pending
   * task — critical for CUA where the per-session focusStore would
   * end up keyed off whichever session wrote the row first, then the
   * auto-retry would stamp the WRONG cua_focus_scope_id into the approved
   * envelope. Non-cua capabilities also benefit from per-session approval
   * isolation (different sessions = different audit-trail intent). Pass
   * the empty string for legacy callers that don't have it; the dedupe
   * still works within that single "no-session" bucket.
   */
  runtimeSessionId: string
}) {
  return stableJsonStringify({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
}

function buildTaskRequestKey(taskId: string) {
  return `task:${taskId}`
}

function buildRemoteAgentTaskRequestKey(params: {
  remoteAgentRunId: string
  kind: TaskRequestKind
}) {
  return `remote-agent-run:${params.remoteAgentRunId}:${params.kind}`
}

export function buildRuntimeAuthorizationRequestKey(params: {
  conversationId: string
  requesterParticipantId: string
  dedupeKey: string
}) {
  return stableJsonStringify({
    conversationId: params.conversationId,
    requesterParticipantId: params.requesterParticipantId,
    kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
    dedupeKey: params.dedupeKey,
  })
}

function summarizeUserInputAnswers(
  userInput: TaskSummary["userInput"]
): string {
  if (!userInput) {
    return "a response"
  }

  const parts: string[] = []
  for (const question of userInput.questions) {
    const answer = question.answer
    if (!answer) continue
    const valueParts: string[] = []
    if (answer.selectedOptionLabels?.length) {
      valueParts.push(answer.selectedOptionLabels.join(", "))
    }
    if (answer.otherText) {
      valueParts.push(answer.otherText)
    }
    if (answer.text) {
      valueParts.push(answer.text)
    }
    if (valueParts.length === 0) {
      continue
    }
    parts.push(
      userInput.questions.length === 1
        ? valueParts.join(", ")
        : `${question.prompt}: ${valueParts.join(", ")}`
    )
  }

  if (parts.length === 0) {
    return "a response"
  }
  return parts.join(" | ")
}

type TaskResolutionStatus =
  | "answered"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "superseded"

function isOpenTaskLifecycle(lifecycle: ToolCallTaskLifecycleStatus): boolean {
  switch (lifecycle) {
    case "submitted":
    case "working":
    case "input_required":
    case "auth_required":
      return true
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return false
  }
}

type StoredTaskResolvePayload = {
  outcome: ChatTaskResolveOutcome
  task: TaskSummary
}

function requireTaskResolveOutcome(
  value: unknown,
  label: string
): ChatTaskResolveOutcome {
  if (value === "applied" || value === "duplicate" || value === "conflict") {
    return value
  }
  throw new Error(`${label} is invalid`)
}

function parseStoredTaskResolvePayload(
  payload: Record<string, unknown>,
  label: string
): StoredTaskResolvePayload {
  const outcome = requireTaskResolveOutcome(payload.outcome, `${label}.outcome`)
  if (!payload.task || typeof payload.task !== "object") {
    throw new Error(`${label}.task is required`)
  }
  return {
    outcome,
    task: payload.task as TaskSummary,
  }
}

async function appendTaskUpdatedSyncEvent(
  queryable: Executor,
  task: TaskSummary
) {
  const allRecipients = await listConversationRealtimeRecipients(
    task.conversationId,
    queryable
  )
  const recipients =
    task.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    (task.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
      !task.target)
      ? allRecipients
      : allRecipients.filter(
          (recipient) =>
            recipient.workspaceMemberId === task.target?.workspaceMemberId ||
            recipient.workspaceMemberId === task.requester?.workspaceMemberId
        )
  for (const recipient of recipients) {
    await appendWorkspaceMemberSyncEvent(queryable, {
      workspaceId: recipient.workspaceId,
      workspaceMemberId: recipient.workspaceMemberId,
      conversationId: task.conversationId,
      itemId: task.itemId,
      eventType: "task.updated",
      payload: {
        conversationId: task.conversationId,
        taskId: task.id,
        itemId: task.itemId,
        task,
      },
    })
  }
}

async function syncTaskEventPayload(task: TaskSummary, queryable?: Executor) {
  if (!task.itemId) return
  await updateConversationItemEventPayload(task.itemId, { task }, queryable)
}

function buildUserInputAsyncNotice(task: TaskSummary) {
  const prompt = task.userInput?.title?.trim() || "Input request"
  const answer = summarizeUserInputAnswers(task.userInput)
  const targetName = task.target?.name || "A user"
  const resolutionNote = task.resolutionNote?.trim()
  const summary = `${targetName} answered "${prompt}".`
  const lines = [
    summary,
    `Answer: ${answer}.`,
    resolutionNote ? `Note: ${resolutionNote}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildPlanApprovalApprovedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "A user"
  const title = task.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} approved "${title}".`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildPlanApprovalRevisionNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "A user"
  const title = task.planApproval?.title?.trim() || "Plan"
  const summary = `${resolverName} requested revisions for "${title}".`
  const lines = [
    summary,
    task.resolutionNote?.trim()
      ? `Feedback: ${task.resolutionNote.trim()}`
      : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "plan_revision_requested",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildRuntimeAuthorizationRejectedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "An authorized user"
  const deviceName =
    task.runtimeAuthorization?.deviceDisplayName || "the device"
  const summary = `${resolverName} rejected access for ${deviceName}.`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "rejected_by_user",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

function buildRuntimeAuthorizationApprovedNotice(task: TaskSummary) {
  const resolverName = task.resolvedBy?.name || "An authorized user"
  const deviceName =
    task.runtimeAuthorization?.deviceDisplayName || "the device"
  const approvedPreset =
    task.runtimeAuthorization?.approvedPreset || "conversation"
  const summary = `${resolverName} approved ${approvedPreset} access for ${deviceName}.`
  const lines = [
    summary,
    task.resolutionNote?.trim() ? `Note: ${task.resolutionNote.trim()}` : "",
  ].filter(Boolean)
  const messageBlocks = textBlocks(lines.join("\n"))

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: false,
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

/**
 * After a runtime_authorization task is approved, try to re-issue
 * the original tool call server-side using the persisted args + the grant
 * that was just created. The result becomes the task's finalResultPayload
 * so the model sees the actual tool output instead of a placeholder
 * "approved by ..." string. Returns null when the auto-retry can't be
 * performed (no source args persisted, device offline, etc.) — caller
 * falls back to buildRuntimeAuthorizationApprovedNotice.
 *
 * This is the load-bearing fix that makes runtime_authorization not depend
 * on the model "noticing" the approval and "guessing" a magic retry_nonce
 * arg. The dispatch envelope carries retry_nonce as a structured field
 * (envelope.runtime_authorization.retry_nonce) so the device can match
 * the once-grant safely.
 */
async function maybeAutoRetryAfterApproval(args: {
  task: TaskSummary
  sourceRequestArgs?: Record<string, unknown>
  sourceRetryNonce?: string
  sourceTaskId?: string
  createdGrant?: RuntimeAuthorizationGrantRecord
  lockedPrincipalSubject?: SubjectRef
  lockedPrincipalScopeSubjectId?: string
  resolverWorkspaceMemberId?: string
}) {
  if (args.task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
    return null
  }
  const runtimeAuth = args.task.runtimeAuthorization
  if (!runtimeAuth) return null
  if (!args.createdGrant) return null
  if (!args.sourceRetryNonce) return null
  if (!args.sourceRequestArgs) return null
  if (!args.sourceTaskId) return null
  if (!args.lockedPrincipalSubject) return null

  // subject-scope-refactor: rebuild the principal runtime subject set
  // post-commit (Kysely form — pg transaction is closed). buildRuntime
  // PrincipalContext applies the same active-participant guard the
  // transaction-time rebuild used. If the actor lost participation between
  // approval commit and now, activeConversationSubjectId will be undefined
  // — selectAndClaimRuntimeAuthorizationGrant then refuses to claim any
  // scoped grant and the auto-retry skips (best-effort semantics, not an
  // approval failure since the grant is already in the DB).
  const { deriveOperationPrincipalAudit } =
    await import("../devices/operations.js")
  let ctx
  try {
    ctx = await buildRuntimePrincipalContextDefault({
      principal: args.lockedPrincipalSubject,
      workspaceId: args.task.workspaceId,
      conversationId: args.task.conversationId ?? null,
    })
  } catch {
    return null
  }
  // Post-commit scope mismatch: same equality rule as the transaction-time
  // gate. Mismatch here is "best-effort skip" rather than throw — the
  // approval already committed; we just don't auto-retry.
  if (
    (args.lockedPrincipalScopeSubjectId ?? null) !==
    (ctx.activeConversationSubjectId ?? null)
  ) {
    return null
  }

  let audit
  try {
    audit = deriveOperationPrincipalAudit(ctx)
  } catch {
    return null
  }

  const visibleToolName =
    runtimeAuth.deviceToolStableKey || runtimeAuth.requestedToolName
  const retry = await autoDispatchRuntimeAuthorizationRetry({
    deviceCapabilityId: runtimeAuth.deviceCapabilityId,
    visibleToolName,
    sourceRequestArgs: args.sourceRequestArgs,
    sourceRetryNonce: args.sourceRetryNonce,
    sourceTaskId: args.sourceTaskId,
    approvedGrant: args.createdGrant,
    runtimeSubjectIds: ctx.runtimeSubjectIds,
    runtimeScopeSubjectIds: ctx.runtimeScopeSubjectIds,
    audit: {
      workspaceId: args.task.workspaceId,
      conversationId: args.task.conversationId,
      principalKind: audit.principalKind,
      principalSubjectId: audit.principalSubjectId,
      // Thread the source Agent session id from the persisted grant
      // (originally written via capability-projection at request creation
      // time). auto-retry's cuaFocusScopeForAutoRetry consumes it to stamp
      // the same cua_focus_scope_id the projection dispatch would have used.
      // Falls back to null for non-cua tools or pre-existing grants missing
      // the field — the helper handles undefined safely.
      initiatedBySessionId: args.createdGrant.sourceRuntimeSessionId ?? null,
      initiatedByWorkspaceMemberId: args.resolverWorkspaceMemberId ?? null,
    },
  }).catch((err) => ({
    ok: false as const,
    errorCode: "runtime_constraint",
    errorMessage: `auto-retry threw: ${(err as Error).message}`,
  }))
  if (!retry.ok || !retry.result) return null
  const contentBlocks = Array.isArray(retry.result.content)
    ? (retry.result.content as CanonicalContentBlock[])
    : []
  const summary = `Authorization approved — re-ran ${visibleToolName}.`
  return {
    summary,
    messageBlocks: contentBlocks,
    finalResultPayload: {
      content: contentBlocks,
      isError: retry.result.isError,
      structuredContent: {
        taskId: args.task.id,
        task: args.task,
        synapseRetry: {
          autoRedispatched: true,
          retryNonce: args.sourceRetryNonce,
          toolName: visibleToolName,
        },
        ...(retry.result.metadata && typeof retry.result.metadata === "object"
          ? { toolMeta: retry.result.metadata }
          : {}),
      },
    },
    metadata: {
      taskId: args.task.id,
      taskKind: args.task.kind,
      taskLifecycleStatus: args.task.lifecycleStatus,
      taskOutcome: args.task.outcome,
      synapseRetry: {
        autoRedispatched: true,
      },
    },
  }
}

function buildRuntimeAuthorizationSupersededNotice(task: TaskSummary) {
  const summary =
    "This authorization request was superseded by a newer user message."
  const messageBlocks = textBlocks(summary)

  return {
    summary,
    messageBlocks,
    finalResultPayload: {
      content: messageBlocks,
      structuredContent: {
        taskId: task.id,
        task,
      },
      isError: true,
    },
    finalErrorPayload: {
      taskId: task.id,
      reason: "superseded",
    },
    metadata: {
      taskId: task.id,
      taskKind: task.kind,
      taskLifecycleStatus: task.lifecycleStatus,
      taskOutcome: task.outcome,
    },
  }
}

/**
 * Resolve the existing-pending-task id that won an INSERT race
 * against `insertTaskRequest` (which returned null on conflict).
 * Centralized here so every caller does the same lookup the same way —
 * critical for the dedupe contract: the row we return must be exactly
 * the one the conflicting unique index pinned.
 */
async function resolveInsertConflictWinner(
  client: Executor,
  params: { workspaceId: string; requestKey: string; taskId?: string }
): Promise<string | null> {
  // Prefer the task-keyed lookup when available — for plan_approval /
  // runtime_authorization the request_key is derived from the task so
  // both lookups would return the same row, but staying consistent with
  // the pre-INSERT lookup ordering avoids surprising any cross-callsite
  // assumption.
  if (params.taskId) {
    const byTask = await findTaskIdByTaskId(params.taskId, client)
    if (byTask) return byTask
  }
  return findPendingTaskIdByRequestKey(
    params.workspaceId,
    params.requestKey,
    client
  )
}

async function insertUserInputTaskDetails(
  _client: Executor,
  _params: {
    taskId: string
    promptPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the prompt payload lives in
  // tool_call_tasks.request_payload (written at task creation). human_input has
  // no CTI detail table.
}

async function insertPlanApprovalTaskDetails(
  _client: Executor,
  _params: {
    taskId: string
    planPayload: Record<string, unknown>
  }
) {
  // No-op under the task unification: the plan payload lives in
  // tool_call_tasks.request_payload. plan_approval has no CTI detail table.
}

/**
 * Write the runtime_authorization CTI detail row for a freshly-minted task,
 * INSIDE the caller's transaction (createToolCallTaskDeduped's onCreatedInTx).
 * This must run in the same tx as the parent INSERT so the deferred CTI
 * consistency trigger sees exactly one detail row at COMMIT. Computes the
 * content dedupe_key (also used by findOpenRuntimeAuthorizationTask).
 */
export async function writeRuntimeAuthorizationTaskDetailInTx(
  client: Executor,
  params: {
    taskId: string
    deviceId: string
    deviceCapabilityId: string
    deviceExposureId: string
    requestedToolName: string
    deviceToolStableKey: string
    reason: string
    requestMode: RuntimeAuthorizationRequestMode
    runtimeSessionId: string
    sourceRetryNonce?: string
    sourceRequestArgs: Record<string, unknown>
    principalSubjectId: string
    principalScopeSubjectId?: string | null
    requestedAction: RuntimeAuthorizationRequestedAction
    grantOptions: RuntimeAuthorizationGrantOption[]
    availablePresets: RuntimeAuthorizationPreset[]
  }
) {
  const dedupeKey = buildRuntimeAuthorizationDedupeKey({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
  await insertRuntimeAuthorizationTaskDetails(client, {
    taskId: params.taskId,
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    reason: params.reason,
    requestMode: params.requestMode,
    sourceRuntimeSessionId: params.runtimeSessionId,
    sourceRetryNonce: params.sourceRetryNonce,
    sourceRequestArgs: params.sourceRequestArgs || {},
    principalSubjectId: params.principalSubjectId,
    principalScopeSubjectId: params.principalScopeSubjectId,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    dedupeKey,
  })
}

/**
 * Translate a resolver's business decision into the task lifecycle/outcome
 * fields stored on tool_call_tasks.
 */
function taskResolutionStatusToFields(
  status: TaskResolutionStatus,
  kind: TaskRequestKind
): {
  lifecycleStatus: ToolCallTaskLifecycleStatus
  outcome: ToolCallTaskOutcome | null
} {
  switch (status) {
    case "answered":
      return { lifecycleStatus: "completed", outcome: "answered" }
    case "approved":
      return {
        lifecycleStatus: "completed",
        outcome:
          kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "granted"
            : "approved",
      }
    case "rejected":
      return {
        lifecycleStatus: "completed",
        outcome:
          kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION
            ? "denied"
            : "revision_requested",
      }
    case "cancelled":
      return { lifecycleStatus: "cancelled", outcome: null }
    case "superseded":
      return { lifecycleStatus: "cancelled", outcome: null }
    case "expired":
      return { lifecycleStatus: "expired", outcome: null }
  }
}

export async function createUserInputTaskRequest(
  params: CreateUserInputTaskParams
) {
  return withTaskTransaction(async (client) => {
    // Task unification: the caller (session-tools createGovernedToolCallTask)
    // already minted the fresh task (deduped at the task layer). Attach the
    // participant fields and create the feed item — no second dedupe.
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.USER_INPUT,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "User-input task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertUserInputTaskDetails(client, {
      taskId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRemoteAgentUserInputTaskRequest(
  params: CreateRemoteAgentUserInputTaskParams
) {
  return withTaskTransaction(async (client) => {
    const requestKey = buildRemoteAgentTaskRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: TASK_REQUEST_KIND.USER_INPUT,
    })
    // Task unification: the remote-agent path has no caller-minted task, so we
    // mint it here with delivery_kind=remote_agent_channel. The principal is the
    // requesting remote_agent (its participant's subject). Dedupe via the task's
    // request_key ON CONFLICT (run-derived).
    const principalSubjectId = await resolveParticipantSubjectId(
      client,
      params.requesterParticipantId
    )
    const minted = await insertToolCallTaskDeduped(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      executorKind: "user_input",
      deliveryKind: "remote_agent_channel",
      humanSurface: "needs_response",
      principalSubjectId,
      remoteAgentRunId: params.remoteAgentRunId,
      sourceToolName: "request_user_input",
      requestKey,
      requesterParticipantId: params.requesterParticipantId,
      targetParticipantId: params.targetParticipantId,
      lifecycleStatus: "input_required",
      supportsCancel: true,
      requestPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
      expiresAt: params.expiresAt,
    })
    if (!minted) {
      const winner = await findLiveToolCallTaskByRequestKey(
        client,
        params.workspaceId,
        requestKey
      )
      const existing = winner ? await getTaskSummary(winner.id, client) : null
      if (existing) {
        return existing
      }
      throw new Error(
        "Remote-agent user-input dedupe hit but no live winner found"
      )
    }
    const taskId = minted.id

    await insertUserInputTaskDetails(client, {
      taskId,
      promptPayload: {
        title: params.title,
        instructions: params.instructions,
        questions: params.questions,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created remote agent input task")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: targeted ? "targeted_members" : "all_members",
      contextPolicy: targeted ? "targeted_members" : "shared",
      restrictedAudienceParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      contextTargetParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created remote agent input task")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createPlanApprovalTaskRequest(
  params: CreatePlanApprovalTaskParams
) {
  return withTaskTransaction(async (client) => {
    // Task unification: caller already minted the fresh deduped task.
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
      requestKey: "",
      targetParticipantId: params.targetParticipantId,
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "Plan-approval task was concurrently resolved before its detail could be written"
        )
      }
      return current
    }

    await insertPlanApprovalTaskDetails(client, {
      taskId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "targeted_members",
      contextPolicy: "targeted_members",
      restrictedAudienceParticipantIds: [params.targetParticipantId],
      contextTargetParticipantIds: [params.targetParticipantId],
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    const collaborationState = parseSessionCollaborationState(
      params.collaborationState
    )
    if (!collaborationState.planDraft) {
      throw new Error(
        "Plan approval tasks require collaborationState.planDraft"
      )
    }
    await updateSessionCollaboration(
      {
        sessionId: params.sessionId,
        collaborationMode: "plan_awaiting_approval",
        collaborationState,
        activePlanApprovalTaskId: taskId,
      },
      client
    )
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRemoteAgentPlanApprovalTaskRequest(
  params: CreateRemoteAgentPlanApprovalTaskParams
) {
  return withTaskTransaction(async (client) => {
    const requestKey = buildRemoteAgentTaskRequestKey({
      remoteAgentRunId: params.remoteAgentRunId,
      kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
    })
    // Task unification: mint the remote-agent task (delivery_kind=
    // remote_agent_channel) here; the principal is the requesting remote_agent.
    const principalSubjectId = await resolveParticipantSubjectId(
      client,
      params.requesterParticipantId
    )
    const minted = await insertToolCallTaskDeduped(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      executorKind: "plan_approval",
      deliveryKind: "remote_agent_channel",
      humanSurface: "needs_response",
      principalSubjectId,
      remoteAgentRunId: params.remoteAgentRunId,
      sourceToolName: "submit_plan",
      requestKey,
      requesterParticipantId: params.requesterParticipantId,
      targetParticipantId: params.targetParticipantId,
      lifecycleStatus: "input_required",
      supportsCancel: true,
      requestPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
      expiresAt: params.expiresAt,
    })
    if (!minted) {
      const winner = await findLiveToolCallTaskByRequestKey(
        client,
        params.workspaceId,
        requestKey
      )
      const existing = winner ? await getTaskSummary(winner.id, client) : null
      if (existing) {
        return existing
      }
      throw new Error(
        "Remote-agent plan-approval dedupe hit but no live winner found"
      )
    }
    const taskId = minted.id

    await insertPlanApprovalTaskDetails(client, {
      taskId,
      planPayload: {
        title: params.title,
        summary: params.summary,
        planMarkdown: params.planMarkdown,
        checklist: params.checklist,
      },
    })

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created remote agent plan task")
    }

    const targeted = Boolean(params.targetParticipantId)
    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: targeted ? "targeted_members" : "all_members",
      contextPolicy: targeted ? "targeted_members" : "shared",
      restrictedAudienceParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      contextTargetParticipantIds: targeted
        ? [params.targetParticipantId!]
        : undefined,
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)
    const upsertedRemoteAgentId =
      await upsertRemoteAgentConversationContextForPlan(client, {
        conversationId: params.conversationId,
        collaborationState: params.collaborationState,
        taskId,
        requesterParticipantId: params.requesterParticipantId,
      })
    if (!upsertedRemoteAgentId) {
      throw new Error("Remote agent requester participant is invalid")
    }

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created remote agent plan task")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)
    return task
  })
}

export async function createRuntimeAuthorizationTaskRequest(
  params: CreateRuntimeAuthorizationTaskParams
) {
  return withTaskTransaction(async (client) => {
    // Task unification: the caller (runtime-authorizations/requests.ts) minted
    // the tool_call_tasks parent AND wrote the runtime_authorization CTI detail
    // row in ONE transaction (createToolCallTaskDeduped's onCreatedInTx
    // callback) so the deferred consistency trigger passes at that commit. Here
    // we only attach the human-facing participant fields and the feed item —
    // neither is CTI-gated, so a separate tx is fine.
    if (!params.taskId) {
      throw new Error("createRuntimeAuthorizationTaskRequest requires a taskId")
    }
    const taskId = await insertTaskRequest(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      taskId: params.taskId,
      requesterParticipantId: params.requesterParticipantId,
      kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
      requestKey: "",
      expiresAt: params.expiresAt,
    })
    if (taskId === null) {
      // The task was concurrently terminalized (cancelled / expired) between
      // mint and feed-item creation — surface the current summary.
      const current = await getTaskSummary(params.taskId, client)
      if (!current) {
        throw new Error(
          "Runtime authorization task was concurrently resolved before its feed item could be written"
        )
      }
      return current
    }

    let task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to load created task request")
    }

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "task_requested",
      authorParticipantId: params.requesterParticipantId,
      eventPayload: { task },
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      queryable: client,
    })

    await updateTaskConversationItemId(client, taskId, created.item.id)

    task = await getTaskSummary(taskId, client)
    if (!task) {
      throw new Error("Failed to reload created task request")
    }
    await syncTaskEventPayload(task, client)
    await appendTaskUpdatedSyncEvent(client, task)

    // G5: enqueue durable projection so the task can be rendered
    // onto any supporting IM transport (v1: QQ only). The worker
    // consumes this asynchronously; the dashboard / API caller doesn't
    // wait on transport delivery.
    await upsertTaskTransportProjection(client, {
      taskId,
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
    })

    return task
  })
}

export async function findOpenRuntimeAuthorizationTask(
  params: FindOpenRuntimeAuthorizationTaskParams
) {
  const dedupeKey = buildRuntimeAuthorizationDedupeKey({
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.requestedAction,
    grantOptions: params.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeSessionId,
  })
  const taskId = await findOpenRuntimeAuthorizationTaskId({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    requesterParticipantId: params.requesterParticipantId,
    deviceId: params.deviceId,
    deviceCapabilityId: params.deviceCapabilityId,
    deviceExposureId: params.deviceExposureId,
    requestedToolName: params.requestedToolName,
    deviceToolStableKey: params.deviceToolStableKey,
    requestMode: params.requestMode,
    dedupeKey,
  })
  if (!taskId) {
    return null
  }
  return getTaskSummary(taskId)
}

export async function getTaskSummary(taskId: string, queryable?: Executor) {
  const row = await getTaskRowById(taskId, queryable)
  return row ? presentTaskSummary(row) : null
}

export async function getTaskSummaryByTaskId(taskId: string) {
  return getTaskSummary(taskId)
}

export async function cancelTaskRequestByTaskId(taskId: string, note?: string) {
  const task = await getTaskSummaryByTaskId(taskId)
  if (!task) {
    return null
  }
  return cancelTaskRequest(task.id, note)
}

export async function cancelTaskRequest(taskId: string, note?: string) {
  const existing = await getTaskRowById(taskId)
  if (!existing) {
    throw new Error("Task request not found")
  }

  if (!isOpenTaskLifecycle(existing.lifecycle_status)) {
    const current = await getTaskSummary(taskId)
    if (!current) {
      throw new Error("Failed to reload task request")
    }
    return current
  }

  const resolutionPayload = decodeTaskResolutionPayload(existing)
  const task = await withTaskTransaction(async (client) => {
    await updateResolvedTaskRequestRow(client, taskId, {
      lifecycleStatus: "cancelled",
    })

    const payload = {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      cancelled: true,
    }

    await updateTaskResolutionPayload(client, taskId, payload)
    const nextTask = await getTaskSummary(taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload cancelled task")
    }
    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)
    return nextTask
  })

  return task
}

export async function canUserViewTask(params: {
  taskId: string
  userId: string
}) {
  return taskViewableByUser(params)
}

export async function canUserResolveTask(params: {
  task: TaskSummary
  userId: string
}) {
  const { task, userId } = params
  if (!isOpenTaskLifecycle(task.lifecycleStatus)) {
    return false
  }

  if (
    task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    task.target?.participantId
  ) {
    const targetParticipantId = task.target?.participantId
    return isActiveTargetParticipantForUser({
      targetParticipantId,
      userId,
    })
  }

  if (
    task.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
    task.requester?.participantType ===
      CONVERSATION_PARTICIPANT_TYPE.REMOTE_AGENT &&
    task.requester.remoteAgentId
  ) {
    const viewerMembership = await findViewerConversationMembership({
      conversationId: task.conversationId,
      userId,
    })

    if (!viewerMembership?.workspaceMemberId) {
      return false
    }

    if (viewerMembership.conversationKind === "direct") {
      return true
    }

    return findRemoteAgentGroupTaskGrant({
      remoteAgentId: task.requester.remoteAgentId,
      workspaceMemberId: viewerMembership.workspaceMemberId,
    })
  }

  const deviceId = task.runtimeAuthorization?.deviceId
  const deviceCapabilityId = task.runtimeAuthorization?.deviceCapabilityId
  if (!deviceId || !deviceCapabilityId) {
    return false
  }

  return authorizeActionDefault({
    subject: userSubject(userId),
    action: "device_capability.request_runtime_authorization",
    resourceId: deviceCapabilityId,
  })
}

export async function enrichTaskForUser(
  task: TaskSummary,
  userId?: string
): Promise<TaskSummary> {
  if (!userId) {
    return {
      ...task,
      viewerCanResolve: task.viewerCanResolve ?? false,
    }
  }

  return {
    ...task,
    viewerCanResolve: await canUserResolveTask({
      task,
      userId,
    }),
  }
}

export async function enrichFeedItemTasksForUser(
  item: ConversationFeedItem,
  userId?: string
): Promise<ConversationFeedItem> {
  if (item.kind !== "event" || item.eventType !== "task_requested") {
    return item
  }

  const payload =
    item.payload as ConversationFeedEventPayloadMap["task_requested"]
  const task =
    payload.task && typeof payload.task === "object"
      ? (payload.task as TaskSummary)
      : null
  if (!task) {
    return item
  }

  return {
    ...item,
    payload: {
      ...payload,
      task: await enrichTaskForUser(task, userId),
    },
  }
}

function buildSubmittedUserInputAnswers(
  params: ResolveTaskRequestParams,
  questions: TaskInputQuestionDefinition[]
): TaskInputAnswer[] {
  if (Array.isArray(params.answers) && params.answers.length > 0) {
    return params.answers.map((answer) => ({
      questionId: String(answer.questionId || "").trim(),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? Array.from(
            new Set(
              answer.selectedOptionIds
                .map((optionId: string) => String(optionId || "").trim())
                .filter((optionId: string) => optionId.length > 0)
            )
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
    }))
  }
  return questions.map((question) => ({
    questionId: question.id,
  }))
}

function validateUserInputAnswers(
  questions: TaskInputQuestionDefinition[],
  submittedAnswers: TaskInputAnswer[]
) {
  const questionMap = new Map(
    questions.map((question) => [question.id, question])
  )
  const answerMap = new Map<string, TaskInputAnswer>()

  for (const answer of submittedAnswers) {
    if (!answer.questionId) {
      throw new Error("Each answer requires a questionId")
    }
    if (!questionMap.has(answer.questionId)) {
      throw new Error(`Unknown question "${answer.questionId}"`)
    }
    if (answerMap.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}"`)
    }
    answerMap.set(answer.questionId, answer)
  }

  const normalized: TaskInputAnswer[] = []

  for (const question of questions) {
    const answer = answerMap.get(question.id)
    const required = question.required !== false

    if (question.type === "text") {
      const text = answer?.text?.trim() || undefined
      if (required && !text) {
        throw new Error(`"${question.prompt}" requires a response`)
      }
      if (text) {
        normalized.push({
          questionId: question.id,
          text,
        })
      }
      continue
    }

    const allowedOptions = question.options || []
    const selectedOptionIds = Array.from(
      new Set(
        (answer?.selectedOptionIds || []).filter((optionId: string) => optionId)
      )
    )
    for (const selectedOptionId of selectedOptionIds) {
      if (
        !allowedOptions.some(
          (option: TaskInputOption) => option.id === selectedOptionId
        )
      ) {
        throw new Error(`"${question.prompt}" contains an invalid option`)
      }
    }

    const otherText = answer?.otherText?.trim() || undefined
    if (otherText && !question.allowOther) {
      throw new Error(`"${question.prompt}" does not allow other input`)
    }

    const effectiveCount = selectedOptionIds.length + (otherText ? 1 : 0)
    const minSelections =
      question.type === "multi_select"
        ? (question.minSelections ?? (required ? 1 : 0))
        : required
          ? 1
          : 0
    const maxSelections =
      question.type === "multi_select"
        ? (question.maxSelections ?? Number.MAX_SAFE_INTEGER)
        : 1

    if (maxSelections < minSelections) {
      throw new Error(`"${question.prompt}" has an invalid selection range`)
    }
    if (effectiveCount < minSelections) {
      throw new Error(`"${question.prompt}" requires more selections`)
    }
    if (effectiveCount > maxSelections) {
      throw new Error(`"${question.prompt}" has too many selections`)
    }
    if (question.type === "single_select" && effectiveCount > 1) {
      throw new Error(`"${question.prompt}" only allows one response`)
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
                    (option: TaskInputOption) => option.id === selectedOptionId
                  )?.label || selectedOptionId
              )
            : undefined,
        otherText,
      })
    }
  }

  return normalized
}

function normalizeTaskCommandAnswers(
  answers?: TaskInputAnswer[]
): TaskInputAnswer[] | undefined {
  if (!Array.isArray(answers) || answers.length === 0) {
    return undefined
  }
  return answers
    .map((answer) => ({
      questionId: String(answer.questionId || "").trim(),
      selectedOptionIds: Array.isArray(answer.selectedOptionIds)
        ? Array.from(
            new Set(
              answer.selectedOptionIds
                .map((optionId) => String(optionId || "").trim())
                .filter((optionId) => optionId.length > 0)
            )
          ).sort()
        : undefined,
      otherText:
        typeof answer.otherText === "string"
          ? answer.otherText.trim() || undefined
          : undefined,
      text:
        typeof answer.text === "string"
          ? answer.text.trim() || undefined
          : undefined,
    }))
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
}

function buildNormalizedTaskCommandPayload(
  params: ResolveTaskRequestParams
): Record<string, unknown> {
  return {
    answers: normalizeTaskCommandAnswers(params.answers),
    decision: params.decision,
    preset: params.preset,
    selectedGrantOptionId:
      typeof params.selectedGrantOptionId === "string"
        ? params.selectedGrantOptionId.trim() || undefined
        : undefined,
    note:
      typeof params.note === "string"
        ? params.note.trim() || undefined
        : undefined,
  }
}

export async function resolveTaskRequest(
  params: ResolveTaskRequestParams
): Promise<ResolveTaskRequestResult> {
  const normalizedCommandPayload = buildNormalizedTaskCommandPayload(params)

  const result = await withTaskTransaction(async (client) => {
    const locked = await getTaskRowByIdForUpdate(params.taskId, client)
    if (!locked) {
      throw new Error("Task request not found")
    }

    const existingCommand = await getTaskCommandRow(
      params.taskId,
      params.commandId,
      client
    )
    if (existingCommand) {
      if (
        stableJsonStringify(existingCommand.request_payload) !==
        stableJsonStringify(normalizedCommandPayload)
      ) {
        throw new Error(
          `commandId ${params.commandId} was already used with a different task payload`
        )
      }

      const storedPayload = parseStoredTaskResolvePayload(
        existingCommand.response_payload,
        `Task command ${existingCommand.id} response_payload`
      )
      return {
        outcome:
          storedPayload.outcome === "applied"
            ? ("duplicate" as const)
            : storedPayload.outcome,
        task: storedPayload.task,
        createdGrant: undefined,
      }
    }

    if (
      locked.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
      locked.target_participant_id &&
      locked.target_participant_id !== params.resolverParticipantId
    ) {
      throw new Error("Only the targeted user can resolve this task")
    }

    if (
      locked.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION &&
      !locked.target_participant_id &&
      locked.requester_remote_agent_id
    ) {
      const conversationRow = await findConversationKindOn(
        client,
        locked.conversation_id
      )
      if (!conversationRow) {
        throw new Error(`Conversation ${locked.conversation_id} not found`)
      }
      if (conversationRow.kind !== "direct") {
        const hasGrant = await findRemoteAgentGroupTaskGrant(
          {
            remoteAgentId: locked.requester_remote_agent_id,
            workspaceMemberId: params.resolverWorkspaceMemberId,
          },
          client
        )
        if (!hasGrant) {
          throw new Error(
            "You are not allowed to resolve this remote agent task"
          )
        }
      }
    }

    if (locked.kind === TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION) {
      const deviceId = locked.device_id || ""
      if (!deviceId) {
        throw new Error(`Task ${locked.id} is missing device_id`)
      }
      const deviceCapabilityId = locked.device_capability_id || ""
      if (!deviceCapabilityId) {
        throw new Error(`Task ${locked.id} is missing device_capability_id`)
      }
      const canResolveRuntimeAuthorization = await authorizeActionDefault({
        subject: workspaceMemberSubject(params.resolverWorkspaceMemberId),
        action: "device_capability.request_runtime_authorization",
        resourceId: deviceCapabilityId,
      })
      if (!canResolveRuntimeAuthorization) {
        throw new Error(
          "You are not allowed to resolve this runtime authorization task"
        )
      }
    }

    const lockedRevision = toRevisionNumber(
      locked.revision,
      `Task ${locked.id} revision`
    )
    if (
      !isOpenTaskLifecycle(locked.lifecycle_status) ||
      lockedRevision !== params.baseRevision
    ) {
      const currentTask = presentTaskSummary(locked)
      const responsePayload: StoredTaskResolvePayload = {
        outcome: "conflict",
        task: currentTask,
      }
      await insertTaskCommandRow(client, {
        taskId: params.taskId,
        commandId: params.commandId,
        baseRevision: params.baseRevision,
        outcome: "conflict",
        requestPayload: normalizedCommandPayload,
        responsePayload,
        createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
      })
      return {
        outcome: "conflict" as const,
        task: currentTask,
        createdGrant: undefined,
      }
    }

    let nextStatus: TaskResolutionStatus
    let resolutionPayload: Record<string, unknown>
    let createdGrant: RuntimeAuthorizationGrantRecord | undefined
    let lockedPrincipalSubjectForReturn: SubjectRef | undefined

    if (locked.kind === TASK_REQUEST_KIND.USER_INPUT) {
      const promptPayload = decodeTaskPromptPayload(locked)
      const questions = parseUserInputQuestionDefinitions(promptPayload)
      if (questions.length === 0) {
        throw new Error("User input request is invalid")
      }
      const submittedAnswers = buildSubmittedUserInputAnswers(params, questions)
      const answers = validateUserInputAnswers(questions, submittedAnswers)
      if (answers.length === 0) {
        throw new Error("A valid response is required")
      }

      nextStatus = "answered"
      resolutionPayload = {
        answers,
        note: params.note?.trim() || undefined,
      }
    } else if (locked.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
      if (params.decision !== "approve" && params.decision !== "revise") {
        throw new Error("decision must be approve or revise")
      }

      nextStatus = params.decision === "approve" ? "approved" : "rejected"
      resolutionPayload = {
        decision: params.decision,
        note: params.note?.trim() || undefined,
      }

      if (locked.remote_agent_run_id && locked.requester_remote_agent_id) {
        await clearRemoteAgentConversationContextOnResolve(client, {
          remoteAgentId: locked.requester_remote_agent_id,
          conversationId: locked.conversation_id,
          approved: nextStatus === "approved",
        })
      } else {
        // Task unification: locked IS the task row, so session_id is on it.
        if (!locked.session_id) {
          throw new Error(`Task ${locked.id} is missing task governance`)
        }
        const taskRow = { session_id: locked.session_id }
        const sessionRow = await findSessionPlanRowOn(
          client,
          taskRow.session_id
        )
        if (!sessionRow) {
          throw new Error(`Session ${taskRow.session_id} not found`)
        }
        if (isGroupConversationKind(sessionRow.conversationKind)) {
          throw new Error(
            "Plan mode is only available in direct conversations."
          )
        }
        if (
          !isPlanAwaitingApprovalCollaborationMode(sessionRow.collaborationMode)
        ) {
          throw new Error(
            `Session ${taskRow.session_id} must be in plan_awaiting_approval before resolving plan approval.`
          )
        }
        if (!sessionRow.activePlanApprovalTaskId) {
          throw new Error(
            `Session ${taskRow.session_id} is missing active_plan_approval_task_id`
          )
        }
        if (sessionRow.activePlanApprovalTaskId !== locked.id) {
          throw new Error(
            `Session ${taskRow.session_id} points to ${sessionRow.activePlanApprovalTaskId}, not ${locked.id}`
          )
        }

        const collaborationState = parseSessionCollaborationState(
          sessionRow.collaborationState
        )
        const existingDraft = collaborationState.planDraft
        if (!existingDraft) {
          throw new Error(
            `Session ${taskRow.session_id} is missing collaborationState.planDraft`
          )
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
            activePlanApprovalTaskId: null,
          },
          client
        )
      }
    } else {
      if (params.decision !== "approve" && params.decision !== "reject") {
        throw new Error("decision must be approve or reject")
      }
      if (params.decision === "approve" && !params.preset) {
        throw new Error(
          "preset is required when approving runtime authorization"
        )
      }

      nextStatus = params.decision === "approve" ? "approved" : "rejected"
      resolutionPayload = {
        decision: params.decision,
        approvedPreset:
          params.decision === "approve" ? params.preset : undefined,
        selectedGrantOptionId:
          params.decision === "approve" &&
          typeof params.selectedGrantOptionId === "string" &&
          params.selectedGrantOptionId.trim().length > 0
            ? params.selectedGrantOptionId.trim()
            : undefined,
        note: params.note?.trim() || undefined,
      }

      if (params.decision === "approve") {
        const selectedGrantOptionId =
          typeof params.selectedGrantOptionId === "string"
            ? params.selectedGrantOptionId.trim()
            : ""
        if (!selectedGrantOptionId) {
          throw new Error(
            "selectedGrantOptionId is required when approving runtime authorization"
          )
        }

        const grantOptions = locked.grant_options ?? []
        const availablePresets = locked.available_presets ?? []
        if (!availablePresets.includes(params.preset || "once")) {
          throw new Error(
            `preset ${params.preset || "once"} is not allowed for this runtime authorization request`
          )
        }
        const selectedOption = grantOptions.find(
          (candidate) => candidate.id === selectedGrantOptionId
        )
        if (!selectedOption) {
          throw new Error(
            `Unknown runtime authorization option "${selectedGrantOptionId}"`
          )
        }

        // subject-scope-refactor: presetToOwnerScope translates the wire
        // preset + locked request context into the new (subject, scope?,
        // retention) triple that createRuntimeAuthorizationGrant accepts.
        // The principal subject is reconstructed from the locked row, then
        // a FULL RuntimePrincipalContext is rebuilt via the pg-form helper
        // `buildRuntimePrincipalContextOn(client, ...)` so the same Decision-8
        // / active-participant invariants that govern dispatch also govern
        // grant creation at approval time.
        const { presetToOwnerScope, UnsupportedGrantTargetError } =
          await import("../runtime-authorizations/service.js")
        const { loadAccessSubjectOn } =
          await import("../access/subject-registry.js")
        const { buildRuntimePrincipalContextOn } =
          await import("../access/subject-resolution.js")
        const lockedPrincipalSubject = await loadAccessSubjectOn(
          client,
          locked.principal_subject_id
        )
        if (!lockedPrincipalSubject) {
          throw new Error(
            `task ${locked.id}: principal subject ${locked.principal_subject_id} not found`
          )
        }
        lockedPrincipalSubjectForReturn = lockedPrincipalSubject
        // Rebuild RuntimePrincipalContext inside the SAME pg transaction
        // so subject upserts / participant checks see consistent state and
        // the result reflects current participation (an actor who left the
        // conversation between request and approval gets `activeConversation
        // SubjectId === undefined` here, even if the locked row froze one).
        const rebuiltCtx = await buildRuntimePrincipalContextOn(client, {
          principal: lockedPrincipalSubject,
          workspaceId: locked.workspace_id,
          conversationId: locked.conversation_id ?? null,
        })
        // ScopeRebuildMismatchError — explicit equality check between the
        // locked principal_scope_subject_id (frozen at request time) and the
        // rebuilt active conversation scope. Three cases must all match:
        //  (a) locked = null AND rebuilt = undefined  → unscoped, OK
        //  (b) locked = X    AND rebuilt = X          → same scope, OK
        //  (c) locked = X    AND rebuilt = Y or null  → DRIFT, reject
        // Without this gate, an actor that lost their conversation
        // participation between request and approval could still mint a
        // `actor + scope=conversation` grant via the locked snapshot.
        const lockedScopeId = locked.principal_scope_subject_id ?? null
        const rebuiltScopeId = rebuiltCtx.activeConversationSubjectId ?? null
        if (lockedScopeId !== rebuiltScopeId) {
          throw new Error(
            `ScopeRebuildMismatchError: task ${locked.id} locked principal_scope_subject_id=${lockedScopeId ?? "NULL"} but rebuilt activeConversationSubjectId=${rebuiltScopeId ?? "NULL"} — principal scope drifted between request and approval`
          )
        }
        const presetTriple = presetToOwnerScope(
          params.preset || "once",
          rebuiltCtx,
          locked.workspace_id
        )
        createdGrant = await createRuntimeAuthorizationGrant(
          {
            workspaceId: locked.workspace_id,
            deviceId: locked.device_id || "",
            deviceCapabilityId: locked.device_capability_id || "",
            deviceExposureId: locked.device_exposure_id || "",
            subject: presetTriple.subject,
            scope: presetTriple.scope,
            retention: presetTriple.retention,
            createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
            sourceTaskId: locked.id || undefined,
            sourceRetryNonce: locked.source_retry_nonce || undefined,
            sourceRuntimeSessionId:
              locked.source_runtime_session_id || undefined,
            sourceRequestArgs: locked.source_request_args ?? {},
            policy: selectedOption.grantSpec,
          },
          client
        )
        resolutionPayload = {
          ...resolutionPayload,
          approvedGrant: createdGrant,
        }
      }
    }

    // Task unification (design §3.4): the in-tx update records the human
    // resolution (resolver, revision bump, resolution payload) but does NOT
    // flip the lifecycle to terminal. The post-commit fan-out below does the
    // SINGLE terminal flip + delivery via completeToolCallTask/failToolCallTask
    // (so runtime-auth auto-retry can run first and its result drives the
    // Task unification (design §3.4, corrected): flip the task to its terminal
    // lifecycle + outcome IN-TX, so every in-tx-derived view is correct — the
    // reloaded summary, the task.updated broadcast, the HTTP response,
    // and the command-idempotency row all see the resolved state. Delivery
    // (notice + wakeup/push) and runtime-auth auto-retry happen post-commit
    // (auto-retry writes only final_result_payload, which is NOT terminal-
    // guarded, so it lands on the already-terminal row).
    const taskFields = taskResolutionStatusToFields(nextStatus, locked.kind)
    await updateResolvedTaskRequestRow(client, params.taskId, {
      lifecycleStatus: taskFields.lifecycleStatus,
      outcome: taskFields.outcome,
      resolvedByParticipantId: params.resolverParticipantId,
    })

    await updateTaskResolutionPayload(client, params.taskId, resolutionPayload)

    const nextTask = await getTaskSummary(params.taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload resolved task")
    }

    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)

    await insertTaskCommandRow(client, {
      taskId: params.taskId,
      commandId: params.commandId,
      baseRevision: params.baseRevision,
      outcome: "applied",
      requestPayload: normalizedCommandPayload,
      responsePayload: {
        outcome: "applied",
        task: nextTask,
      },
      createdByWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })

    return {
      outcome: "applied" as const,
      task: nextTask,
      createdGrant,
      // Surface the original args + retry_nonce to the outer scope so the
      // post-commit auto-retry path (autoDispatchRuntimeAuthorizationRetry)
      // can re-issue the original tool call without the model having to
      // notice the approval. Drops to undefined for non-runtime-authorization
      // tasks (these fields are only populated when locked.kind is
      // RUNTIME_AUTHORIZATION).
      lockedSourceRequestArgs: locked.source_request_args ?? undefined,
      lockedSourceRetryNonce: locked.source_retry_nonce ?? undefined,
      lockedSourceTaskId: locked.id ?? undefined,
      // subject-scope-refactor: skip-task gate is now keyed on
      // principal_subj.kind (resolved via JOIN at SELECT time), not the
      // dropped principal_remote_agent_id column. principal_subject_kind
      // is the legitimate signal; principal_remote_agent_id is kept on
      // the row type only as a derived alias for dashboard consumers.
      lockedPrincipalSubjectKind: locked.principal_subject_kind ?? undefined,
      // subject-scope-refactor: forward the locked principal triple so the
      // post-commit auto-retry can re-build the RuntimePrincipalContext via
      // buildRuntimePrincipalContext (Kysely-form, since the pg transaction
      // is closed by the time we get there) and pass runtimeSubjectIds /
      // runtimeScopeSubjectIds to selectAndClaimRuntimeAuthorizationGrant.
      lockedPrincipalSubjectId: locked.principal_subject_id,
      lockedPrincipalScopeSubjectId:
        locked.principal_scope_subject_id ?? undefined,
      lockedPrincipalSubject: lockedPrincipalSubjectForReturn,
      // Task unification: the decision (task vocabulary) computed in-tx,
      // so the post-commit delivery fan-out can branch on it without relying on
      // the (still non-terminal) lifecycle_status.
      nextStatus,
    }
  })

  if (result.outcome !== "applied") {
    // Crash-recovery (P0): a duplicate-command retry means a prior resolve
    // committed the terminal task but may have crashed before post-commit
    // delivery ran. Re-fire delivery from the persisted task state; it is
    // idempotent (skips if a session_wakeup notice already exists), so a
    // genuinely-already-delivered task is a no-op and a lost wakeup is recovered.
    if (result.task?.id) {
      await recoverUndeliveredResolvedTask(result.task.id).catch(
        () => undefined
      )
    }
    return {
      outcome: result.outcome,
      task: result.task,
    }
  }

  const task = result.task

  // Task unification: the lifecycle/outcome were flipped IN-TX (so result.
  // task already reads resolved). Here we only DELIVER (notice + wakeup
  // for session_wakeup; machine-WS push for remote_agent_channel) — no second
  // flip. P1: a human "no" (plan
  // revision / authz deny) is completed+outcome 'revision_requested'/'denied',
  // never a machinery failure.
  if (task.kind === TASK_REQUEST_KIND.USER_INPUT) {
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...buildUserInputAsyncNotice(task),
      outcome: "answered",
    })
  } else if (task.kind === TASK_REQUEST_KIND.PLAN_APPROVAL) {
    if (result.nextStatus === "approved") {
      await deliverResolvedToolCallTask(task.id, "completed", {
        ...buildPlanApprovalApprovedNotice(task),
        outcome: "approved",
      })
    } else {
      await deliverResolvedToolCallTask(task.id, "completed", {
        ...buildPlanApprovalRevisionNotice(task),
        outcome: "revision_requested",
      })
    }
  } else if (result.nextStatus === "rejected") {
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...buildRuntimeAuthorizationRejectedNotice(task),
      outcome: "denied",
    })
  } else {
    // Approved runtime authorization: re-dispatch the original tool call
    // server-side using the persisted sourceRequestArgs + retry_nonce + the
    // grant we just created (design §3.4: auto-retry runs post-commit; its
    // result drives the completion notice's final_result_payload — written via
    // the unguarded payload update inside deliverResolvedToolCallTask). Falls
    // back to a plain approval notice if auto-retry can't run.
    const approvedRetry = await maybeAutoRetryAfterApproval({
      task,
      sourceRequestArgs: result.lockedSourceRequestArgs,
      sourceRetryNonce: result.lockedSourceRetryNonce,
      sourceTaskId: result.lockedSourceTaskId,
      createdGrant: result.createdGrant,
      lockedPrincipalSubject: result.lockedPrincipalSubject,
      lockedPrincipalScopeSubjectId: result.lockedPrincipalScopeSubjectId,
      resolverWorkspaceMemberId: params.resolverWorkspaceMemberId,
    })
    await deliverResolvedToolCallTask(task.id, "completed", {
      ...(approvedRetry ?? buildRuntimeAuthorizationApprovedNotice(task)),
      outcome: "granted",
    })
  }

  return {
    outcome: result.outcome,
    task,
    createdGrant: result.createdGrant,
    createdGrants: result.createdGrant ? [result.createdGrant] : undefined,
  }
}

export async function markRuntimeAuthorizationTaskSuperseded(
  taskId: string,
  note?: string
) {
  const existing = await getTaskRowById(taskId)
  if (!existing) {
    throw new Error("Task request not found")
  }
  if (
    existing.kind !== TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION ||
    !isOpenTaskLifecycle(existing.lifecycle_status)
  ) {
    const current = await getTaskSummary(taskId)
    if (!current) {
      throw new Error("Failed to reload task request")
    }
    return current
  }

  const resolutionPayload = decodeTaskResolutionPayload(existing)
  const task = await withTaskTransaction(async (client) => {
    await updateResolvedTaskRequestRow(client, taskId, {
      lifecycleStatus: "cancelled",
    })
    await updateTaskResolutionPayload(client, taskId, {
      ...resolutionPayload,
      note: note?.trim() || resolutionPayload.note,
      superseded: true,
    })
    const nextTask = await getTaskSummary(taskId, client)
    if (!nextTask) {
      throw new Error("Failed to reload superseded task")
    }
    await syncTaskEventPayload(nextTask, client)
    await appendTaskUpdatedSyncEvent(client, nextTask)
    return nextTask
  })
  // Lifecycle already flipped to cancelled in-tx; deliver the supersede notice.
  await deliverResolvedToolCallTask(task.id, "cancelled", {
    ...buildRuntimeAuthorizationSupersededNotice(task),
  })
  return task
}
