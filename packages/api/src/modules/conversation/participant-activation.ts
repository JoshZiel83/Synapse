import { transaction } from "../../infrastructure/database/index.js";
import { db } from "../../infrastructure/database/kysely.js";
import {
  buildWorkspaceMemberContextId,
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
  memberType: "actor" | "workspace_member";
  participantId?: string;
  memberId?: string;
  workspaceMemberId?: string;
  actorId?: string;
  name?: string;
};

async function loadParticipantDisplay(params: {
  memberType: "actor" | "workspace_member" | "external" | "remote_agent" | "system";
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

  if (params.memberType === "workspace_member" && params.workspaceMemberId) {
    const result = await db
      .selectFrom('workspace_members as wm')
      .innerJoin('users as u', 'u.id', 'wm.user_id')
      .select('u.name')
      .where('wm.id', '=', params.workspaceMemberId)
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
        : params.memberType === "workspace_member"
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
    memberType: "actor" | "workspace_member" | "external";
    actorId?: string;
    workspaceMemberId?: string;
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
            workspaceMemberId: initiator.workspaceMemberId,
            name: initiator.name,
          }
        : undefined,
    },
  });
}

export async function activateConversationParticipant(params: {
  workspaceId?: string;
  conversationId: string;
  memberType: "actor" | "workspace_member" | "external" | "remote_agent" | "system";
  workspaceMemberId?: string;
  actorId?: string;
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
      : params.memberType === "workspace_member" && params.workspaceMemberId
        ? [
            touchRelation(
              "conversation",
              params.conversationId,
              "participant",
              "workspace_member",
              buildWorkspaceMemberContextId(params.workspaceMemberId),
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
        workspaceMemberId: params.workspaceMemberId,
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
      workspaceMemberId: params.workspaceMemberId,
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
            params.memberType === "actor" ||
            params.memberType === "workspace_member"
              ? params.memberType
              : "external",
          actorId: params.actorId,
          workspaceMemberId: params.workspaceMemberId,
          name,
          title,
        },
      ],
    });
  }

  return activation;
}
