import type {
  InteractionRequestSummary,
  RelayAuthorizationGrantOption,
  RelayAuthorizationPreset,
  RelayAuthorizationRequestMode,
  RelayAuthorizationRequestedAction,
} from "@synapse/shared/types";
import { textBlocks } from "@synapse/shared";
import { db } from "../../infrastructure/database/kysely.js";
import { actorSubject, authorizeAction } from "../access/service.js";
import { buildUserInteractionCandidatesFromRows } from "../ai/session-tool-user-interactions.js";
import { listConversationParticipants } from "../chat/service.js";
import {
  createRelayAuthorizationInteractionRequest,
  findOpenRelayAuthorizationInteraction,
  getInteractionRequestSummary,
  markRelayAuthorizationInteractionSuperseded,
} from "../interactions/service.js";
import {
  cancelToolCallTask,
  createToolCallTask,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js";

export interface RelayAuthorizationRequestSource {
  workspaceId: string;
  conversationId: string;
  sessionId: string;
  actorId: string;
  sourceToolName: string;
  workspaceMemberId?: string;
  turnId?: string;
  sourceToolCallId?: string;
}

export interface RelayAuthorizationRequestTarget {
  relayCapabilityId: string;
  relayDeviceId: string;
  relayExposureId: string;
  requestedToolName: string;
  relayToolStableKey: string;
  runtimeSessionId: string;
  relayDeviceDisplayName?: string;
  relayExposureDisplayName?: string;
}

export interface RelayAuthorizationRequestPlanSnapshot {
  requestedAction: RelayAuthorizationRequestedAction;
  grantOptions: RelayAuthorizationGrantOption[];
}

export interface CreateRelayAuthorizationRequestParams {
  source: RelayAuthorizationRequestSource;
  relayTarget: RelayAuthorizationRequestTarget;
  authorizationPlan: RelayAuthorizationRequestPlanSnapshot;
  requestMode: RelayAuthorizationRequestMode;
  availablePresets: RelayAuthorizationPreset[];
  reason: string;
  sourceRequestArgs: Record<string, unknown>;
  retryNonce?: string;
}

export interface RelayAuthorizationRequestResult {
  interaction: InteractionRequestSummary;
  task: ToolCallTaskRecord | null;
  availableAuthorizerCount: number;
  availableAuthorizers: Array<{
    participantId: string;
    workspaceMemberId: string;
    name: string;
    label: string;
  }>;
  requesterParticipantId: string;
  reused: boolean;
  retryNonce: string;
}

export interface WaitForRelayAuthorizationResolutionParams<T> {
  interactionId: string;
  conversationId: string;
  createdAt: string;
  onApproved: (interaction: InteractionRequestSummary) => Promise<T>;
  maxWaitMs?: number;
}

export type RelayAuthorizationWaitResult<T> =
  | {
      status: "approved";
      interaction: InteractionRequestSummary;
      approvedValue: T;
    }
  | {
      status: "superseded" | "rejected" | "cancelled" | "expired";
      interaction: InteractionRequestSummary | null;
    };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWaitingSummary(deviceDisplayName?: string) {
  return `Waiting for a user to authorize ${deviceDisplayName?.trim() || "the relay device"}.`;
}

async function hasNewUserFacingConversationMessage(
  conversationId: string,
  afterIso: string,
) {
  const row = await db
    .selectFrom("conversation_items as ci")
    .leftJoin("conversation_participants as cp", "cp.id", "ci.author_participant_id")
    .select("ci.id")
    .where("ci.conversation_id", "=", conversationId)
    .where("ci.item_type", "=", "message")
    .where("ci.created_at", ">", new Date(afterIso))
    .where((eb) =>
      eb.or([
        eb("ci.role", "=", "user"),
        eb("cp.participant_kind", "in", ["workspace_member", "external"]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export function buildRelayAuthorizationRetryNonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function createRelayAuthorizationRequest(
  params: CreateRelayAuthorizationRequestParams,
): Promise<RelayAuthorizationRequestResult> {
  const requesterAllowed = await authorizeAction({
    subject: actorSubject(params.source.actorId),
    action: "relay_capability.request_relay_authorization",
    resourceId: params.relayTarget.relayCapabilityId,
  });
  if (!requesterAllowed) {
    throw new Error(
      "Current actor is not allowed to request authorization for this relay capability",
    );
  }

  const allMembers = await listConversationParticipants(params.source.conversationId);
  const requesterMember = allMembers.find(
    (member) =>
      member.actor_id === params.source.actorId && member.state === "active",
  );
  if (!requesterMember) {
    throw new Error(
      "Current actor is not an active participant of this conversation",
    );
  }

  const candidates = buildUserInteractionCandidatesFromRows(allMembers);
  if (candidates.length === 0) {
    throw new Error(
      "This conversation has no active user who could receive a relay authorization request",
    );
  }

  const authorizerCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      allowed: await authorizeAction({
        subject: { type: "workspace_member", id: candidate.workspaceMemberId },
        action: "relay_device.authorize_relay_authorization",
        resourceId: params.relayTarget.relayDeviceId,
      }),
    })),
  );
  const availableAuthorizers = authorizerCandidates
    .filter((entry) => entry.allowed)
    .map((entry) => entry.candidate);
  if (availableAuthorizers.length === 0) {
    throw new Error(
      "No active user in this conversation is currently allowed to approve relay authorization for this relay device",
    );
  }

  const retryNonce =
    params.retryNonce?.trim() || buildRelayAuthorizationRetryNonce();

  if (params.requestMode === "background") {
    const existing = await findOpenRelayAuthorizationInteraction({
      workspaceId: params.source.workspaceId,
      conversationId: params.source.conversationId,
      requesterParticipantId: requesterMember.id,
      relayCapabilityId: params.relayTarget.relayCapabilityId,
      relayDeviceId: params.relayTarget.relayDeviceId,
      relayExposureId: params.relayTarget.relayExposureId,
      requestedToolName: params.relayTarget.requestedToolName,
      relayToolStableKey: params.relayTarget.relayToolStableKey,
      requestedAction: params.authorizationPlan.requestedAction,
      grantOptions: params.authorizationPlan.grantOptions,
      availablePresets: params.availablePresets,
      requestMode: params.requestMode,
    });

    if (existing) {
      return {
        interaction: existing,
        task: null,
        availableAuthorizerCount: availableAuthorizers.length,
        availableAuthorizers,
        requesterParticipantId: requesterMember.id,
        reused: true,
        retryNonce,
      };
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
    executorKind: "relay_authorization",
    deliveryPolicy: "human_interaction",
    status: "input_required",
    statusMessage: buildWaitingSummary(
      params.relayTarget.relayDeviceDisplayName,
    ),
    dispatchStatus: "input_requested",
    supportsCancel: true,
    requestPayload: {
      relayCapabilityId: params.relayTarget.relayCapabilityId,
      relayDeviceId: params.relayTarget.relayDeviceId,
      relayExposureId: params.relayTarget.relayExposureId,
      runtimeSessionId: params.relayTarget.runtimeSessionId,
      requestedToolName: params.relayTarget.requestedToolName,
      relayToolStableKey: params.relayTarget.relayToolStableKey,
      reason: params.reason,
      requestMode: params.requestMode,
      requestedAction: params.authorizationPlan.requestedAction,
      grantOptions: params.authorizationPlan.grantOptions,
      availablePresets: params.availablePresets,
      sourceRetryNonce: retryNonce,
      sourceRequestArgs: params.sourceRequestArgs,
    },
  });

  try {
    const interaction = await createRelayAuthorizationInteractionRequest({
      workspaceId: params.source.workspaceId,
      conversationId: params.source.conversationId,
      taskId: task.id,
      requesterParticipantId: requesterMember.id,
      relayCapabilityId: params.relayTarget.relayCapabilityId,
      relayDeviceId: params.relayTarget.relayDeviceId,
      relayExposureId: params.relayTarget.relayExposureId,
      requestedToolName: params.relayTarget.requestedToolName,
      runtimeSessionId: params.relayTarget.runtimeSessionId,
      relayToolStableKey: params.relayTarget.relayToolStableKey,
      reason: params.reason,
      requestedAction: params.authorizationPlan.requestedAction,
      grantOptions: params.authorizationPlan.grantOptions,
      availablePresets: params.availablePresets,
      requestMode: params.requestMode,
      sourceRetryNonce: retryNonce,
      sourceRequestArgs: params.sourceRequestArgs,
    });

    return {
      interaction,
      task,
      availableAuthorizerCount: availableAuthorizers.length,
      availableAuthorizers,
      requesterParticipantId: requesterMember.id,
      reused: false,
      retryNonce,
    };
  } catch (error) {
    await cancelToolCallTask(task.id, {
      summary: `Relay authorization request for ${params.relayTarget.relayDeviceDisplayName?.trim() || "the relay device"} failed before dispatch.`,
      finalResultPayload: {
        content: textBlocks(
          `Relay authorization request for ${params.relayTarget.relayDeviceDisplayName?.trim() || "the relay device"} failed before dispatch.`,
        ),
        isError: true,
      },
      finalErrorPayload: {
        message: error instanceof Error ? error.message : String(error),
      },
      notifyActor: false,
    });
    throw error;
  }
}

export async function waitForRelayAuthorizationResolution<T>(
  params: WaitForRelayAuthorizationResolutionParams<T>,
): Promise<RelayAuthorizationWaitResult<T>> {
  const startedAt = Date.now();
  const maxWaitMs = params.maxWaitMs ?? 10 * 60 * 1000;

  while (Date.now() - startedAt < maxWaitMs) {
    if (
      await hasNewUserFacingConversationMessage(
        params.conversationId,
        params.createdAt,
      )
    ) {
      const superseded =
        await markRelayAuthorizationInteractionSuperseded(
          params.interactionId,
          "Superseded by a newer user message.",
        );
      return {
        status: "superseded",
        interaction: superseded,
      };
    }

    const interaction = await getInteractionRequestSummary(params.interactionId);
    if (!interaction) {
      throw new Error("Authorization interaction could not be reloaded.");
    }
    if (interaction.status === "pending") {
      await sleep(1000);
      continue;
    }
    if (interaction.status === "approved") {
      return {
        status: "approved",
        interaction,
        approvedValue: await params.onApproved(interaction),
      };
    }
    if (interaction.status === "rejected" || interaction.status === "cancelled") {
      return {
        status: interaction.status,
        interaction,
      };
    }
    return {
      status: "expired",
      interaction,
    };
  }

  return {
    status: "expired",
    interaction: await getInteractionRequestSummary(params.interactionId),
  };
}
