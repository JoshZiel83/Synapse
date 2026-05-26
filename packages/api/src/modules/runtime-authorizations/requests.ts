import type {
  ConversationBoundary,
  InteractionRequestSummary,
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
} from "@synapse/shared/types"
import { textBlocks } from "@synapse/shared"
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import { authorizeAction } from "../access/service.js"
import { buildUserInteractionCandidatesFromRows } from "../ai/session-tool-user-interactions.js"
import { listConversationParticipants } from "../chat/service.js"
import {
  createRuntimeAuthorizationInteractionRequest,
  findOpenRuntimeAuthorizationInteraction,
  getInteractionRequestSummary,
  markRuntimeAuthorizationInteractionSuperseded,
} from "../interactions/service.js"
import {
  cancelToolCallTask,
  createToolCallTask,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js"

export interface RuntimeAuthorizationRequestSource {
  workspaceId: string
  conversationId: string
  sessionId: string
  actorId: string
  sourceToolName: string
  conversationKind?: "private" | "group" | "virtual"
  conversationBoundary?: ConversationBoundary
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

export interface RuntimeAuthorizationRequestResult {
  interaction: InteractionRequestSummary
  task: ToolCallTaskRecord | null
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
  onApproved: (interaction: InteractionRequestSummary) => Promise<T>
  maxWaitMs?: number
}

export type RuntimeAuthorizationWaitResult<T> =
  | {
      status: "approved"
      interaction: InteractionRequestSummary
      approvedValue: T
    }
  | {
      status: "superseded" | "rejected" | "cancelled" | "expired"
      interaction: InteractionRequestSummary | null
    }

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildWaitingSummary(deviceDisplayName?: string) {
  return `Waiting for a user to authorize ${deviceDisplayName?.trim() || "the device"}.`
}

async function loadConversationKindAndBoundary(
  conversationId: string,
  fallback?: Pick<
    RuntimeAuthorizationRequestSource,
    "conversationKind" | "conversationBoundary"
  >
) {
  if (fallback?.conversationKind && fallback?.conversationBoundary) {
    return {
      kind: fallback.conversationKind,
      boundary: fallback.conversationBoundary,
    }
  }

  return db
    .selectFrom("conversations")
    .select(["kind", "boundary"])
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
    .select("ci.id")
    .where("ci.conversation_id", "=", conversationId)
    .where("ci.item_type", "=", "message")
    .where("ci.created_at", ">", new Date(afterIso))
    .where((eb) =>
      eb.or([
        eb("ci.role", "=", "user"),
        eb("cp.participant_type", "in", ["workspace_member", "external"]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export function buildRuntimeAuthorizationRetryNonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export async function createRuntimeAuthorizationRequest(
  params: CreateRuntimeAuthorizationRequestParams
): Promise<RuntimeAuthorizationRequestResult> {
  const allMembers = await listConversationParticipants(
    params.source.conversationId
  )
  const requesterMember = allMembers.find(
    (member) =>
      member.actor_id === params.source.actorId && member.state === "active"
  )
  if (!requesterMember) {
    throw new Error(
      "Current actor is not an active participant of this conversation"
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
    })

    if (existing) {
      return {
        interaction: existing,
        task: null,
        availableAuthorizerCount: availableAuthorizers.length,
        availableAuthorizers,
        requesterParticipantId: requesterMember.id,
        reused: true,
        retryNonce,
      }
    }
  }

  const task = await createToolCallTask({
    workspaceId: params.source.workspaceId,
    conversationId: params.source.conversationId,
    sessionId: params.source.sessionId,
    actorId: params.source.actorId,
    turnId: params.source.turnId,
    sourceToolCallId: params.source.sourceToolCallId,
    sourceToolName: params.source.sourceToolName,
    executorKind: "runtime_authorization",
    deliveryPolicy: "human_interaction",
    status: "input_required",
    statusMessage: buildWaitingSummary(params.runtimeTarget.deviceDisplayName),
    dispatchStatus: "input_requested",
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
  })

  try {
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
    })

    return {
      interaction,
      task,
      availableAuthorizerCount: availableAuthorizers.length,
      availableAuthorizers,
      requesterParticipantId: requesterMember.id,
      reused: false,
      retryNonce,
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

    const interaction = await getInteractionRequestSummary(params.interactionId)
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
    interaction: await getInteractionRequestSummary(params.interactionId),
  }
}
