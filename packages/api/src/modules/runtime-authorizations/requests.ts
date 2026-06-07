import type {
  TaskSummary,
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
} from "@synapse/shared/types"
import { textBlocks } from "@synapse/shared"
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import { sleep } from "../../infrastructure/async/index.js"
import { randomUUID } from "node:crypto"
import { authorizeAction } from "../access/service.js"
import { buildUserInteractionCandidatesFromRows } from "../ai/session-tool-user-interactions.js"
import { listConversationParticipants } from "../chat/service.js"
import {
  buildRuntimeAuthorizationDedupeKey,
  buildRuntimeAuthorizationRequestKey,
  createRuntimeAuthorizationInteractionRequest,
  findOpenRuntimeAuthorizationInteraction,
  getTaskSummary,
  markRuntimeAuthorizationInteractionSuperseded,
  writeRuntimeAuthorizationTaskDetailInTx,
} from "../interactions/service.js"
import {
  cancelToolCallTask,
  createToolCallTaskDeduped,
  getToolCallTask,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js"

export interface RuntimeAuthorizationRequestSource {
  workspaceId: string
  conversationId: string
  sessionId: string
  /**
   * subject-scope-refactor: principal subject_id (NOT NULL on
   * interaction_runtime_authorization_requests). Caller resolves the
   * triggering principal to an access_subjects row via
   * upsertAccessSubject(actor / remote_agent / conversation) and passes the
   * id here.
   */
  principalSubjectId: string
  /**
   * Optional principal scope subject id (set when the triggering principal
   * was an active conversation participant).
   */
  principalScopeSubjectId?: string | null
  /**
   * @deprecated subject-scope-refactor: resolved into principalSubjectId
   * upstream. Kept as a hint for inbound resolver glue (e.g. to identify
   * the bridged remote_agent participant of the conversation).
   */
  actorId?: string
  /** @deprecated see actorId */
  remoteAgentId?: string
  sourceToolName: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  workspaceMemberId?: string
  turnId?: string
  sourceToolCallId?: string
}

export interface RuntimeAuthorizationRequestTarget {
  deviceCapabilityId: string
  deviceId: string
  deviceExposureId: string
  requestedToolName: string
  deviceToolStableKey: string
  runtimeSessionId: string
  deviceDisplayName?: string
  exposureDisplayName?: string
}

export interface RuntimeAuthorizationRequestPlanSnapshot {
  requestedAction: RuntimeAuthorizationRequestedAction
  grantOptions: RuntimeAuthorizationGrantOption[]
}

export interface CreateRuntimeAuthorizationRequestParams {
  source: RuntimeAuthorizationRequestSource
  runtimeTarget: RuntimeAuthorizationRequestTarget
  authorizationPlan: RuntimeAuthorizationRequestPlanSnapshot
  requestMode: RuntimeAuthorizationRequestMode
  availablePresets: RuntimeAuthorizationPreset[]
  reason: string
  sourceRequestArgs: Record<string, unknown>
  retryNonce?: string
}

/**
 * Pick the retry_nonce to surface to the caller. When the interaction was
 * reused from the dedupe lookup (either the outer background-mode dedupe in
 * createRuntimeAuthorizationRequest or the inner request-key dedupe in
 * createRuntimeAuthorizationInteractionRequest) we MUST return the
 * persisted nonce on the row — that's the only value the post-approval
 * grant will be created with, and the only value the device's grant
 * matcher will accept on retry. Surfacing a freshly-generated nonce in the
 * reused branch would hand the model a token no grant ever validates and
 * the once-grant would silently expire unused. Falls back to the fresh
 * nonce only when the row truly lacks one (legacy data, defense in depth).
 */
export function pickPersistedRetryNonce(
  interaction: TaskSummary,
  freshNonce: string
): string {
  if (
    interaction.kind === "runtime_authorization" &&
    interaction.runtimeAuthorization?.sourceRetryNonce
  ) {
    return interaction.runtimeAuthorization.sourceRetryNonce
  }
  return freshNonce
}

/**
 * Detect whether the createRuntimeAuthorizationInteractionRequest inner
 * dedupe (taskId or requestKey match) returned a pre-existing row. The
 * outer caller passes `reused: false` until it can prove otherwise — this
 * helper proves it by checking whether the row's persisted retry_nonce
 * matches the one the caller just generated.
 */
export function didInnerDedupeReuseRow(
  interaction: TaskSummary,
  freshNonce: string
): boolean {
  if (interaction.kind !== "runtime_authorization") return false
  const persisted = interaction.runtimeAuthorization?.sourceRetryNonce
  return Boolean(persisted && persisted !== freshNonce)
}

export interface RuntimeAuthorizationRequestResult {
  interaction: TaskSummary
  // Task unification: every runtime-authorization IS a task, including a
  // background request that reuses an existing live authorization task. This is
  // never null — the create, dedupe, and reuse paths all surface the task so
  // consumers can read authorization_task_id (capability-projection stamps it
  // into the synapse_error envelope the agent retries against).
  task: ToolCallTaskRecord
  availableAuthorizerCount: number
  availableAuthorizers: Array<{
    participantId: string
    workspaceMemberId: string
    name: string
    label: string
  }>
  requesterParticipantId: string
  reused: boolean
  retryNonce: string
}

export interface WaitForRuntimeAuthorizationResolutionParams<T> {
  interactionId: string
  conversationId: string
  createdAt: string
  onApproved: (interaction: TaskSummary) => Promise<T>
  maxWaitMs?: number
}

export type RuntimeAuthorizationWaitResult<T> =
  | {
      status: "approved"
      interaction: TaskSummary
      approvedValue: T
    }
  | {
      status: "superseded" | "rejected" | "cancelled" | "expired"
      interaction: TaskSummary | null
    }

function buildWaitingSummary(deviceDisplayName?: string) {
  return `Waiting for a user to authorize ${deviceDisplayName?.trim() || "the device"}.`
}

async function loadConversationKindAndBoundary(
  conversationId: string,
  fallback?: Pick<RuntimeAuthorizationRequestSource, "conversationKind">
) {
  if (fallback?.conversationKind) {
    return {
      kind: fallback.conversationKind,
    }
  }

  return db
    .selectFrom("conversations")
    .select(["kind"])
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
}

async function loadDeviceCapabilityRequestState(capabilityId: string) {
  return db
    .selectFrom("device_capabilities as capability")
    .innerJoin(
      "device_exposures as exposure",
      "exposure.id",
      "capability.exposure_id"
    )
    .innerJoin("devices as device", "device.id", "exposure.device_id")
    .select([
      "capability.id as capability_id",
      "capability.status as capability_status",
      "exposure.id as exposure_id",
      "exposure.runtime_status as exposure_runtime_status",
      "device.workspace_id as owner_workspace_id",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM device_control_plane_sessions session_row
        WHERE session_row.device_id = device.id
          AND session_row.status = 'active'
      )`.as("has_active_device_session"),
    ])
    .where("capability.id", "=", capabilityId)
    .limit(1)
    .executeTakeFirst()
}

async function canActorRequestRuntimeAuthorization(
  params: CreateRuntimeAuthorizationRequestParams
) {
  const conversation = await loadConversationKindAndBoundary(
    params.source.conversationId,
    params.source
  )
  if (!conversation) {
    return false
  }

  const capabilityState = await loadDeviceCapabilityRequestState(
    params.runtimeTarget.deviceCapabilityId
  )
  if (
    !capabilityState ||
    capabilityState.capability_status !== "active" ||
    capabilityState.exposure_runtime_status !== "healthy" ||
    !capabilityState.has_active_device_session
  ) {
    return false
  }

  // Device-runtime v3: per-capability access binding gating happens
  // upstream via the access subsystem; this helper only verifies the
  // device/exposure/capability is reachable.
  return true
}

async function hasNewUserFacingConversationMessage(
  conversationId: string,
  afterIso: string
) {
  const row = await db
    .selectFrom("conversation_items as ci")
    .leftJoin(
      "conversation_participants as cp",
      "cp.id",
      "ci.author_participant_id"
    )
    .leftJoin("access_subjects as cpsubj", "cpsubj.id", "cp.subject_id")
    .select("ci.id")
    .where("ci.conversation_id", "=", conversationId)
    .where("ci.item_type", "=", "message")
    .where("ci.created_at", ">", new Date(afterIso))
    .where((eb) =>
      eb.or([
        eb("ci.role", "=", "user"),
        eb("cpsubj.kind", "in", ["workspace_member", "external"]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export function buildRuntimeAuthorizationRetryNonce() {
  return randomUUID()
}

export async function createRuntimeAuthorizationRequest(
  params: CreateRuntimeAuthorizationRequestParams
): Promise<RuntimeAuthorizationRequestResult> {
  const allMembers = await listConversationParticipants(
    params.source.conversationId
  )
  // Resolve the requester by whichever principal id the caller supplied.
  // actor principals match on actor_id; remote_agent
  // principals match on remote_agent_id (the bridged participant of the
  // conversation). The interaction needs a participant id either way so
  // the dashboard knows whose request this is.
  const requesterMember = allMembers.find((member) => {
    if (member.state !== "active") return false
    if (params.source.remoteAgentId) {
      return member.remote_agent_id === params.source.remoteAgentId
    }
    if (params.source.actorId) {
      return member.actor_id === params.source.actorId
    }
    return false
  })
  if (!requesterMember) {
    throw new Error(
      "Current principal is not an active participant of this conversation"
    )
  }

  const requesterAllowed = await canActorRequestRuntimeAuthorization(params)
  if (!requesterAllowed) {
    throw new Error(
      "Current actor is not allowed to request authorization for this device capability"
    )
  }

  const candidates = buildUserInteractionCandidatesFromRows(allMembers)
  if (candidates.length === 0) {
    throw new Error(
      "This conversation has no active user who could receive a runtime authorization request"
    )
  }

  const authorizerCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      allowed: await authorizeAction(db, {
        subject: { type: "workspace_member", id: candidate.workspaceMemberId },
        action: "device_capability.request_runtime_authorization",
        resourceId: params.runtimeTarget.deviceCapabilityId,
      }),
    }))
  )
  const availableAuthorizers = authorizerCandidates
    .filter((entry) => entry.allowed)
    .map((entry) => entry.candidate)
  if (availableAuthorizers.length === 0) {
    throw new Error(
      "No active user in this conversation is currently allowed to approve runtime authorization for this device"
    )
  }

  const retryNonce =
    params.retryNonce?.trim() || buildRuntimeAuthorizationRetryNonce()

  if (params.requestMode === "background") {
    const existing = await findOpenRuntimeAuthorizationInteraction({
      workspaceId: params.source.workspaceId,
      conversationId: params.source.conversationId,
      requesterParticipantId: requesterMember.id,
      deviceCapabilityId: params.runtimeTarget.deviceCapabilityId,
      deviceId: params.runtimeTarget.deviceId,
      deviceExposureId: params.runtimeTarget.deviceExposureId,
      requestedToolName: params.runtimeTarget.requestedToolName,
      deviceToolStableKey: params.runtimeTarget.deviceToolStableKey,
      requestedAction: params.authorizationPlan.requestedAction,
      grantOptions: params.authorizationPlan.grantOptions,
      availablePresets: params.availablePresets,
      requestMode: params.requestMode,
      // Per-session dedupe: matches the value the create path writes to
      // interaction_runtime_authorization_requests.source_runtime_session_id
      // and bakes into the dedupe key. Without this match two Agent
      // sessions issuing the same CUA call would reuse one another's
      // pending interaction, and the post-approval auto-retry would stamp
      // the wrong cua_focus_scope_id into the dispatched envelope.
      runtimeSessionId: params.runtimeTarget.runtimeSessionId,
    })

    if (existing) {
      // Task unification: the reused interaction IS a live task. Reload its
      // task record so the caller gets a real authorization_task_id (the
      // interaction summary always carries taskId; this surfaces the full
      // record consistently with the create/dedupe branches). Returning null
      // here would drop the id capability-projection stamps into the
      // synapse_error envelope the agent retries against.
      if (!existing.taskId) {
        throw new Error(
          "Reused runtime-authorization interaction has no taskId (task unification invariant)"
        )
      }
      const existingTask = await getToolCallTask(existing.taskId)
      if (!existingTask) {
        throw new Error(
          `Reused runtime-authorization task ${existing.taskId} not found`
        )
      }
      return {
        interaction: existing,
        task: existingTask,
        availableAuthorizerCount: availableAuthorizers.length,
        availableAuthorizers,
        requesterParticipantId: requesterMember.id,
        reused: true,
        // CRITICAL: return the EXISTING row's persisted retry_nonce, not
        // the freshly-generated `retryNonce` above. The post-approval grant
        // is created with the old row's source_retry_nonce so the grant
        // matcher will only ever honor that value — surfacing a new nonce
        // to the caller would hand the model a token no grant will accept,
        // and the once-grant would silently expire unused. The helper falls
        // back to the freshly-generated nonce for legacy rows without one.
        retryNonce: pickPersistedRetryNonce(existing, retryNonce),
      }
    }
  }

  // Task unification: every runtime-authorization is a task. The waiter is the
  // triggering principal (actor → session_wakeup; remote_agent →
  // remote_agent_channel). The request_key is content-derived so concurrent
  // dispatches dedupe onto one task (partial-unique on tool_call_tasks).
  const isRemoteAgent = !!params.source.remoteAgentId
  const dedupeKey = buildRuntimeAuthorizationDedupeKey({
    deviceId: params.runtimeTarget.deviceId,
    deviceCapabilityId: params.runtimeTarget.deviceCapabilityId,
    deviceExposureId: params.runtimeTarget.deviceExposureId,
    requestedToolName: params.runtimeTarget.requestedToolName,
    deviceToolStableKey: params.runtimeTarget.deviceToolStableKey,
    requestMode: params.requestMode,
    requestedAction: params.authorizationPlan.requestedAction,
    grantOptions: params.authorizationPlan.grantOptions,
    availablePresets: params.availablePresets,
    runtimeSessionId: params.runtimeTarget.runtimeSessionId,
  })
  const requestKey = buildRuntimeAuthorizationRequestKey({
    conversationId: params.source.conversationId,
    requesterParticipantId: requesterMember.id,
    dedupeKey,
  })
  const { task, deduped } = await createToolCallTaskDeduped(
    {
      workspaceId: params.source.workspaceId,
      conversationId: params.source.conversationId,
      executorKind: "runtime_authorization",
      deliveryKind: isRemoteAgent ? "remote_agent_channel" : "session_wakeup",
      humanSurface: "needs_response",
      principalSubjectId: params.source.principalSubjectId,
      sessionId: isRemoteAgent ? undefined : params.source.sessionId,
      turnId: params.source.turnId,
      sourceToolCallId: params.source.sourceToolCallId,
      sourceToolName: params.source.sourceToolName,
      requestKey,
      requesterParticipantId: requesterMember.id,
      lifecycleStatus: "auth_required",
      statusMessage: buildWaitingSummary(
        params.runtimeTarget.deviceDisplayName
      ),
      supportsCancel: true,
      requestPayload: {
        deviceCapabilityId: params.runtimeTarget.deviceCapabilityId,
        deviceId: params.runtimeTarget.deviceId,
        deviceExposureId: params.runtimeTarget.deviceExposureId,
        runtimeSessionId: params.runtimeTarget.runtimeSessionId,
        requestedToolName: params.runtimeTarget.requestedToolName,
        deviceToolStableKey: params.runtimeTarget.deviceToolStableKey,
        reason: params.reason,
        requestMode: params.requestMode,
        requestedAction: params.authorizationPlan.requestedAction,
        grantOptions: params.authorizationPlan.grantOptions,
        availablePresets: params.availablePresets,
        sourceRetryNonce: retryNonce,
        sourceRequestArgs: params.sourceRequestArgs,
      },
    },
    // CTI: write the runtime_authorization detail row in the SAME tx as the
    // parent so the deferred consistency trigger passes at COMMIT (P0 fix).
    async (createdTask, trx) => {
      await writeRuntimeAuthorizationTaskDetailInTx(trx, {
        taskId: createdTask.id,
        deviceId: params.runtimeTarget.deviceId,
        deviceCapabilityId: params.runtimeTarget.deviceCapabilityId,
        deviceExposureId: params.runtimeTarget.deviceExposureId,
        requestedToolName: params.runtimeTarget.requestedToolName,
        deviceToolStableKey: params.runtimeTarget.deviceToolStableKey,
        reason: params.reason,
        requestMode: params.requestMode,
        runtimeSessionId: params.runtimeTarget.runtimeSessionId,
        sourceRetryNonce: retryNonce,
        sourceRequestArgs: params.sourceRequestArgs,
        principalSubjectId: params.source.principalSubjectId,
        principalScopeSubjectId: params.source.principalScopeSubjectId,
        requestedAction: params.authorizationPlan.requestedAction,
        grantOptions: params.authorizationPlan.grantOptions,
        availablePresets: params.availablePresets,
      })
    }
  )

  try {
    // Task unification: if the task mint deduped onto an existing live task, the
    // interaction detail + feed item already exist — return the existing summary
    // without re-creating (no orphan-task cleanup; the loser never materialized).
    if (deduped) {
      const existing = await getTaskSummary(task.id)
      if (!existing) {
        throw new Error(
          "Deduped runtime-authorization task has no interaction summary"
        )
      }
      return {
        interaction: existing,
        task,
        availableAuthorizerCount: availableAuthorizers.length,
        availableAuthorizers,
        requesterParticipantId: requesterMember.id,
        reused: true,
        retryNonce: pickPersistedRetryNonce(existing, retryNonce),
      }
    }

    const interaction = await createRuntimeAuthorizationInteractionRequest({
      workspaceId: params.source.workspaceId,
      conversationId: params.source.conversationId,
      taskId: task.id,
      requesterParticipantId: requesterMember.id,
      deviceCapabilityId: params.runtimeTarget.deviceCapabilityId,
      deviceId: params.runtimeTarget.deviceId,
      deviceExposureId: params.runtimeTarget.deviceExposureId,
      requestedToolName: params.runtimeTarget.requestedToolName,
      runtimeSessionId: params.runtimeTarget.runtimeSessionId,
      deviceToolStableKey: params.runtimeTarget.deviceToolStableKey,
      reason: params.reason,
      requestedAction: params.authorizationPlan.requestedAction,
      grantOptions: params.authorizationPlan.grantOptions,
      availablePresets: params.availablePresets,
      requestMode: params.requestMode,
      sourceRetryNonce: retryNonce,
      sourceRequestArgs: params.sourceRequestArgs,
      principalSubjectId: params.source.principalSubjectId,
      principalScopeSubjectId: params.source.principalScopeSubjectId,
      principalRemoteAgentId: params.source.remoteAgentId,
    })

    return {
      interaction,
      task,
      availableAuthorizerCount: availableAuthorizers.length,
      availableAuthorizers,
      requesterParticipantId: requesterMember.id,
      reused: false,
      retryNonce: pickPersistedRetryNonce(interaction, retryNonce),
    }
  } catch (error) {
    await cancelToolCallTask(task.id, {
      summary: `Runtime authorization request for ${params.runtimeTarget.deviceDisplayName?.trim() || "the device"} failed before dispatch.`,
      finalResultPayload: {
        content: textBlocks(
          `Runtime authorization request for ${params.runtimeTarget.deviceDisplayName?.trim() || "the device"} failed before dispatch.`
        ),
        isError: true,
      },
      finalErrorPayload: {
        message: error instanceof Error ? error.message : String(error),
      },
      notifyActor: false,
    })
    throw error
  }
}

export async function waitForRuntimeAuthorizationResolution<T>(
  params: WaitForRuntimeAuthorizationResolutionParams<T>
): Promise<RuntimeAuthorizationWaitResult<T>> {
  const startedAt = Date.now()
  const maxWaitMs = params.maxWaitMs ?? 10 * 60 * 1000

  while (Date.now() - startedAt < maxWaitMs) {
    if (
      await hasNewUserFacingConversationMessage(
        params.conversationId,
        params.createdAt
      )
    ) {
      const superseded = await markRuntimeAuthorizationInteractionSuperseded(
        params.interactionId,
        "Superseded by a newer user message."
      )
      return {
        status: "superseded",
        interaction: superseded,
      }
    }

    const interaction = await getTaskSummary(params.interactionId)
    if (!interaction) {
      throw new Error("Authorization interaction could not be reloaded.")
    }
    if (interaction.status === "pending") {
      await sleep(1000)
      continue
    }
    if (interaction.status === "approved") {
      return {
        status: "approved",
        interaction,
        approvedValue: await params.onApproved(interaction),
      }
    }
    if (
      interaction.status === "rejected" ||
      interaction.status === "cancelled"
    ) {
      return {
        status: interaction.status,
        interaction,
      }
    }
    return {
      status: "expired",
      interaction,
    }
  }

  return {
    status: "expired",
    interaction: await getTaskSummary(params.interactionId),
  }
}
