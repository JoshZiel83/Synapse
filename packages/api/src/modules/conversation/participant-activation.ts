import { transaction } from "../../infrastructure/database/index.js";
import { db } from "../../infrastructure/database/kysely.js";
import {
  buildWorkspaceUserContextId,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchActorConversationContext,
  touchRelation,
} from "../../infrastructure/authz/index.js";
import { v4 as uuidv4 } from "uuid";
import {
  createConversationEvent,
  ensureConversationMemberActivation,
  getConversationMember,
} from "./service.js";

type ParticipantInitiator = {
  memberType: "actor" | "user";
  participantId?: string;
  memberId?: string;
  workspaceMemberId?: string;
  actorId?: string;
  userId?: string;
  name?: string;
};

async function loadParticipantDisplay(params: {
  memberType: "actor" | "user" | "external" | "remote_agent" | "system";
  actorId?: string;
  userId?: string;
  displayName?: string;
}) {
  if (params.displayName?.trim()) {
    return {
      name: params.displayName.trim(),
      title: undefined as string | undefined,
    };
  }

  if (params.memberType === "actor" && params.actorId) {
    const result = await db
      .selectFrom('actors')
      .select(['name', 'title'])
      .where('id', '=', params.actorId)
      .limit(1)
      .executeTakeFirst();
    return {
      name: result?.name || "Actor",
      title: result?.title || undefined,
    };
  }

  if (params.memberType === "user" && params.userId) {
    const result = await db
      .selectFrom('users')
      .select('name')
      .where('id', '=', params.userId)
      .limit(1)
      .executeTakeFirst();
    return {
      name: result?.name || "User",
      title: undefined as string | undefined,
    };
  }

  return {
    name:
      params.displayName?.trim() ||
      (params.memberType === "actor"
        ? "Actor"
        : params.memberType === "user"
          ? "User"
          : "External participant"),
    title: undefined as string | undefined,
  };
}

async function hydrateMembershipInitiator(params: {
  conversationId: string;
  initiator?: ParticipantInitiator;
}) {
  if (!params.initiator) return undefined;

  let memberId = params.initiator.memberId;
  if (!memberId) {
    const member = await getConversationMember({
      conversationId: params.conversationId,
      workspaceMemberId: params.initiator.workspaceMemberId,
      actorId: params.initiator.actorId,
      userId: params.initiator.userId,
    });
    memberId = member?.id;
  }

  return {
    ...params.initiator,
    participantId: memberId,
    memberId,
  };
}

async function recordMembershipEvent(params: {
  workspaceId?: string;
  conversationId: string;
  subtype: "member_joined";
  authorMemberId?: string;
  initiator?: ParticipantInitiator;
  members: Array<{
    participantId: string;
    memberId: string;
    memberType: "actor" | "user" | "external";
    actorId?: string;
    userId?: string;
    name: string;
    title?: string;
  }>;
}) {
  const initiator = await hydrateMembershipInitiator({
    conversationId: params.conversationId,
    initiator: params.initiator,
  });
  const batchId = uuidv4();
  await createConversationEvent({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    eventType: params.subtype,
    timelinePolicy: "all_members",
    contextPolicy: "shared",
    authorMemberId: params.authorMemberId || initiator?.memberId,
    metadata: { batchId },
    eventPayload: {
      batchId,
      members: params.members,
      initiator: initiator
        ? {
            participantId: initiator.participantId || initiator.memberId,
            memberId: initiator.memberId,
            memberType: initiator.memberType,
            actorId: initiator.actorId,
            userId: initiator.userId,
            name: initiator.name,
          }
        : undefined,
    },
  });
}

export async function activateConversationParticipant(params: {
  workspaceId?: string;
  conversationId: string;
  memberType: "actor" | "user" | "external" | "remote_agent" | "system";
  workspaceMemberId?: string;
  actorId?: string;
  userId?: string;
  displayName?: string;
  actorJoinVersionId?: string;
  metadata?: Record<string, unknown>;
  initiator?: ParticipantInitiator;
  recordJoinEvent?: boolean;
}) {
  const activation = await ensureConversationMemberActivation({
    conversationId: params.conversationId,
    memberType: params.memberType,
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    userId: params.userId,
    displayName: params.displayName,
    actorJoinVersionId: params.actorJoinVersionId,
    metadata: params.metadata,
  });

  if (!activation.activated) {
    return activation;
  }

  const relations =
    params.memberType === "actor" && params.actorId
      ? [
          touchRelation(
            "conversation",
            params.conversationId,
            "participant",
            "actor",
            params.actorId,
          ),
          ...touchActorConversationContext(params.actorId, params.conversationId),
        ]
      : params.memberType === "user" && params.userId && params.workspaceId
        ? [
            touchRelation(
              "conversation",
              params.conversationId,
              "participant",
              "workspace_user",
              buildWorkspaceUserContextId(
                params.workspaceId,
                params.userId,
              ),
            ),
          ]
        : [];

  if (relations.length > 0) {
    const { authzEntryIds } = await transaction(async (client) => ({
      authzEntryIds: await queueAuthzRelationships(client, relations, {
        source: "conversation.activate_participant",
        conversationId: params.conversationId,
        memberType: params.memberType,
        actorId: params.actorId,
        userId: params.userId,
      }),
    }));
    if (authzEntryIds.length > 0) {
      await flushAuthzOutboxEntries(authzEntryIds);
    }
  }

  if (params.recordJoinEvent !== false) {
    const { name, title } = await loadParticipantDisplay({
      memberType: params.memberType,
      actorId: params.actorId,
      userId: params.userId,
      displayName: params.displayName,
    });
    await recordMembershipEvent({
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      subtype: "member_joined",
      authorMemberId:
        params.initiator?.memberType === params.memberType
          ? activation.member.id
          : undefined,
      initiator: params.initiator,
      members: [
        {
          participantId: activation.member.id,
          memberId: activation.member.id,
          memberType:
            params.memberType === "actor" || params.memberType === "user"
              ? params.memberType
              : "external",
          actorId: params.actorId,
          userId: params.userId,
          name,
          title,
        },
      ],
    });
  }

  return activation;
}
