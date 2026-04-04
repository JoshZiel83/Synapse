import crypto from "node:crypto";
import { createConversationEvent, ensureConversationParticipant, getConversationParticipant } from "./service.js";

type ParticipantInitiator = {
  participantKind: "actor" | "workspace_member";
  participantId?: string;
  workspaceMemberId?: string;
  actorId?: string;
  name?: string;
};

async function resolveInitiator(params: {
  conversationId: string;
  initiator?: ParticipantInitiator;
}) {
  if (!params.initiator) {
    return undefined;
  }
  if (params.initiator.participantId) {
    return params.initiator;
  }
  const participant = await getConversationParticipant({
    conversationId: params.conversationId,
    workspaceMemberId: params.initiator.workspaceMemberId,
    actorId: params.initiator.actorId,
  });
  if (!participant) {
    return params.initiator;
  }
  return {
    ...params.initiator,
    participantId: participant.id,
  };
}

async function loadParticipantDisplay(params: {
  participantKind: "actor" | "workspace_member" | "external" | "system";
  actorId?: string;
  workspaceMemberId?: string;
  displayName?: string;
}) {
  if (params.displayName?.trim()) {
    return {
      name: params.displayName.trim(),
      title: undefined as string | undefined,
    };
  }
  return {
    name:
      params.participantKind === "actor"
        ? "Actor"
        : params.participantKind === "workspace_member"
          ? "User"
          : params.participantKind === "system"
            ? "System"
            : "External participant",
    title: undefined as string | undefined,
  };
}

export async function activateConversationParticipant(params: {
  workspaceId?: string;
  conversationId: string;
  participantKind: "actor" | "workspace_member" | "external" | "system";
  workspaceMemberId?: string;
  actorId?: string;
  displayName?: string;
  actorJoinVersionId?: string;
  metadata?: Record<string, unknown>;
  initiator?: ParticipantInitiator;
  recordJoinEvent?: boolean;
}) {
  const existing = await getConversationParticipant({
    conversationId: params.conversationId,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
  });
  const activated = !existing || existing.state !== "active";
  const created = !existing;
  const revived = Boolean(existing && existing.state !== "active");

  const member = await ensureConversationParticipant({
    conversationId: params.conversationId,
    participantKind: params.participantKind,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    displayName: params.displayName,
    actorJoinVersionId: params.actorJoinVersionId,
    metadata: params.metadata,
  });

  if (!member) {
    throw new Error("Failed to activate conversation participant");
  }

  if (activated && params.recordJoinEvent !== false) {
    const initiator = await resolveInitiator({
      conversationId: params.conversationId,
      initiator: params.initiator,
    });
    const { name, title } = await loadParticipantDisplay({
      participantKind: params.participantKind,
      actorId: params.actorId,
      workspaceMemberId: params.workspaceMemberId,
      displayName: params.displayName,
    });

    await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      eventType: "participant_joined",
      timelinePolicy: "all_members",
      contextPolicy: "shared",
      authorParticipantId:
        initiator?.participantKind === params.participantKind
          ? member.id
          : initiator?.participantId,
      eventPayload: {
        batchId: crypto.randomUUID(),
        participants: [
          {
            participantId: member.id,
            participantType: params.participantKind === "system" ? "external" : params.participantKind,
            actorId: params.actorId,
            workspaceMemberId: params.workspaceMemberId,
            name,
            title,
          },
        ],
        initiator: initiator
          ? {
              participantId: initiator.participantId,
              participantType: initiator.participantKind,
              actorId: initiator.actorId,
              workspaceMemberId: initiator.workspaceMemberId,
              name: initiator.name,
            }
          : undefined,
      },
    });
  }

  return {
    member,
    activated,
    created,
    revived,
  };
}
