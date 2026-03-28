import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CanonicalContentBlock } from "@synapse/shared";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js";
import {
  createConversation,
  getConversation,
  getConversationsByWorkspace,
  getConversationMessages,
  sendConversationMessage,
  markConversationRead,
  cancelConversation,
  getConversationMembers,
  addMembersToConversation,
  issueConversationGrant,
  listConversationGrants,
  removeActorFromConversation,
  updateConversationProfile,
  revokeConversationGrant,
} from "./chat-service.js";
import { getConversationRuntimeMap } from "../session/runtime.js";
import { requireRequestAction } from "../access/guards.js";
import {
  authorizeAction,
  listAuthorizedResourceIds,
  userSubject,
} from "../access/service.js";
import {
  isFeedItemVisibleToUser,
  listWorkspaceFeedEventsPage,
} from "./service.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import { getConversationMember } from "./service.js";
import {
  enrichFeedItemInteractionsForUser,
  enrichInteractionForUser,
  getInteractionRequestSummary,
  resolveInteractionRequest,
} from "../interactions/service.js";
import { enqueueRelayAuthorizationApply } from "../mcp-plugins/relay-manager.js";

const CONVERSATIONS_BASE_PATH =
  "/api/v1/workspaces/:workspaceId/conversations";
const CONVERSATIONS_FEED_PATH =
  "/api/v1/workspaces/:workspaceId/conversations/feed";

const sendConversationMessageSchema = z
  .object({
    content: z.string().max(10000).optional().default(""),
    contentBlocks: z.array(z.any()).optional(),
    clientMessageId: z.string().min(1).max(128),
    targetParticipantIds: z.array(z.string().uuid()).optional(),
    targetActorIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (body) =>
      body.content.trim().length > 0 ||
      (Array.isArray(body.contentBlocks) && body.contentBlocks.length > 0),
    { message: "content or contentBlocks is required" },
  );

const updateConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    avatarFileId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (body) => body.title !== undefined || body.avatarFileId !== undefined,
    {
      message: "At least one of title or avatarFileId is required",
    },
  );

const addConversationMembersSchema = z
  .object({
    actorIds: z.array(z.string().uuid()).optional().default([]),
    userIds: z.array(z.string().uuid()).optional().default([]),
  })
  .refine((body) => body.actorIds.length > 0 || body.userIds.length > 0, {
    message: "At least one actor or user is required",
  });

const conversationGrantPermissionEnum = z.enum([
  "send",
  "moderate",
  "manage",
  "manage_members",
  "attach_resources",
]);

const issueConversationGrantSchema = z
  .object({
    permission: conversationGrantPermissionEnum,
    userId: z.string().uuid().optional(),
    actorId: z.string().uuid().optional(),
    reason: z.string().max(1000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if ((value.userId && value.actorId) || (!value.userId && !value.actorId)) {
      invalid("Exactly one of userId or actorId is required");
    }
  });

const resolveInteractionSchema = z
  .object({
    answers: z
      .array(
        z.object({
          fieldId: z.string().min(1),
          selectedOptionIds: z.array(z.string().min(1)).optional(),
          otherText: z.string().trim().max(4000).optional(),
          text: z.string().trim().max(4000).optional(),
        }),
      )
      .max(50)
      .optional(),
    selectedOptionId: z.string().min(1).optional(),
    decision: z.enum(["approve", "reject"]).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(
    (body) =>
      (Array.isArray(body.answers) && body.answers.length > 0) ||
      typeof body.selectedOptionId === "string" ||
      typeof body.decision === "string",
    { message: "answers, selectedOptionId, or decision is required" },
  );

async function requireWorkspacePermission(
  request: any,
  reply: any,
  permission: string,
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  return requireRequestAction(
    request,
    reply,
    permission === "create_conversation"
      ? "workspace.create_conversation"
      : "workspace.view",
    workspaceId,
    errorMessage,
  );
}

async function requireConversationPermission(
  request: any,
  reply: any,
  permission: "view" | "send" | "manage" | "manage_members",
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  const conversationId = readConversationId(request.params);
  const conversation = await getConversation(conversationId);

  if (!conversation || conversation.workspace_id !== workspaceId) {
    reply.status(404).send({ error: "Conversation not found" });
    return null;
  }

  const action =
    permission === "view"
      ? "conversation.view"
      : permission === "send"
        ? "conversation.send"
        : permission === "manage"
          ? "conversation.manage"
          : "conversation.manage_members";
  const allowed = await requireRequestAction(
    request,
    reply,
    action,
    conversationId,
    errorMessage,
  );
  if (!allowed) {
    return null;
  }

  return conversation;
}

function readConversationId(params: Record<string, unknown>) {
  return typeof params.conversationId === "string" ? params.conversationId : "";
}

function collectionPaths() {
  return [CONVERSATIONS_BASE_PATH] as const;
}

function feedPaths() {
  return [CONVERSATIONS_FEED_PATH] as const;
}

function conversationPaths(suffix = "") {
  return [`${CONVERSATIONS_BASE_PATH}/:conversationId${suffix}`] as const;
}

type ConversationRouteParams = {
  workspaceId: string;
  conversationId: string;
};

type ConversationInteractionRouteParams = ConversationRouteParams & {
  interactionId: string;
};

type ConversationActorRouteParams = ConversationRouteParams & {
  actorId: string;
};

type ConversationGrantRouteParams = ConversationRouteParams & {
  grantId: string;
};

function mapMember(row: any) {
  if (row.actor_id) {
    return {
      memberId: row.id,
      participantId: row.id,
      type: "actor",
      actorId: row.actor_id,
      id: row.actor_id,
      name: row.actor_name || "Unknown",
      title: row.actor_title || undefined,
      role: row.actor_role || "specialist",
      emoji: row.actor_avatar_emoji || undefined,
      avatarUrl: row.actor_avatar_stored_name
        ? getFileUrl(row.actor_avatar_stored_name)
        : undefined,
      sessionStatus: row.session_status || undefined,
      state: row.state,
    };
  }

  if (row.member_type === "external") {
    return {
      memberId: row.id,
      participantId: row.id,
      type: "external",
      id: row.id,
      externalUserKey: row.transport_external_id || undefined,
      transportKind: row.transport_kind || undefined,
      transportAddressId: row.transport_address_id || undefined,
      linkedUserId: row.linked_user_id || undefined,
      linkedUserName: row.linked_user_name || undefined,
      linkedUserAvatarUrl: row.linked_user_avatar_file_id
        ? getFileUrlById(row.linked_user_avatar_file_id)
        : undefined,
      name:
        row.transport_display_name ||
        row.display_name ||
        "External participant",
      state: row.state,
    };
  }

  return {
    memberId: row.id,
    participantId: row.id,
    type: "user",
    userId: row.user_id,
    id: row.user_id,
    name: row.user_name || "User",
    transportKind: row.transport_kind || undefined,
    transportAddressId: row.transport_address_id || undefined,
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    state: row.state,
  };
}

export default async function conversationController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", workspaceMiddleware);

  // List conversations for current user
  for (const path of collectionPaths()) {
    app.get<{ Params: { workspaceId: string } }>(path, async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        "view",
        "Not allowed to access this workspace",
      );
      if (!allowed) return;

      const conversationIds = await listAuthorizedResourceIds({
        subject: userSubject(userId),
        action: "conversation.view",
      });
      const rawConversations = await getConversationsByWorkspace(
        workspaceId,
        userId,
        conversationIds,
      );

      // Transform to frontend format
      const conversations = await Promise.all(
        rawConversations.map(async (row: any) => {
          const members = (await getConversationMembers(row.id)).filter(
            (member: any) => member.state === "active",
          );
          const mappedMembers = members.map(mapMember);
          const participants = mappedMembers.filter(
            (member: any) => member.type === "actor",
          );

          const hasOpenLane = members.some(
            (m: any) => m.actor_id && m.session_status !== "closed",
          );
          const derivedName =
            row.title ||
            mappedMembers
              .map((member: any) => member.name)
              .filter(Boolean)
              .join(", ") ||
            row.last_message?.substring(0, 100) ||
            "Untitled conversation";
          const [canManage, canManageMembers] = await Promise.all([
            authorizeAction({
              subject: userSubject(userId),
              action: "conversation.manage",
              resourceId: row.id,
            }),
            authorizeAction({
              subject: userSubject(userId),
              action: "conversation.manage_members",
              resourceId: row.id,
            }),
          ]);

          return {
            id: row.id,
            status: hasOpenLane ? "active" : "completed",
            transportKind: row.transport_kind || undefined,
            participants,
            members: mappedMembers,
            lastMessage: row.last_message
              ? {
                  content: row.last_message,
                  role:
                    row.last_message_sender_type === "user"
                      ? "user"
                      : "assistant",
                  actorName: row.last_message_sender_name,
                  createdAt: row.last_message_at,
                }
              : undefined,
            unreadCount: row.unread_count || 0,
            createdAt: row.created_at,
            title: derivedName,
            name: derivedName,
            avatarUrl: row.avatar_url || undefined,
            permissions: {
              canManage,
              canManageMembers,
            },
          };
        }),
      );

      const runtimeMap = await getConversationRuntimeMap(
        conversations.map((conversation: any) => conversation.id),
      );
      return reply.send({
        conversations,
        runtimeMap,
      });
    });
  }

  for (const path of feedPaths()) {
    app.get<{
      Params: { workspaceId: string };
      Querystring: { after?: string; limit?: string };
    }>(path, async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const allowed = await requireWorkspacePermission(
        request,
        reply,
      "view",
      "Not allowed to access this workspace",
    );
    if (!allowed) return;

    const authorizedConversationIds = await listAuthorizedResourceIds({
      subject: userSubject(userId),
      action: "conversation.view",
    });
    const afterSequence = Number.parseInt(request.query.after || "0", 10);
    const limit = Number.parseInt(request.query.limit || "200", 10);
    const page = await listWorkspaceFeedEventsPage({
      workspaceId,
      conversationIds: authorizedConversationIds,
      afterSequence: Number.isFinite(afterSequence)
        ? Math.max(0, afterSequence)
        : 0,
      limit: Number.isFinite(limit) ? limit : 200,
    });
    const visibleRecords = page.records.filter((record) =>
      isFeedItemVisibleToUser(record.item, userId),
    );
    return reply.send({
      ...page,
        records: await Promise.all(
          visibleRecords.map(async (record) => ({
            ...record,
            item: await enrichFeedItemInteractionsForUser(record.item, userId),
          })),
        ),
      });
    });
  }

  // Create conversation — accepts { actorId } or { actorIds }, content is optional
  for (const path of collectionPaths()) {
    app.post<{ Params: { workspaceId: string }; Body: any }>(
      path,
      async (request, reply) => {
      const allowed = await requireWorkspacePermission(
        request,
        reply,
        "create_conversation",
        "Not allowed to create conversations in this workspace",
      );
      if (!allowed) return;

      const body = request.body as any;
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;

      // Support both single-actor and multi-actor formats
      let actorIds: string[];
      let targetActorIds: string[] | undefined;

      if (body.actorIds) {
        actorIds = body.actorIds;
        targetActorIds = Array.isArray(body.targetActorIds)
          ? body.targetActorIds
          : body.targetActorId
            ? [body.targetActorId]
            : actorIds[0]
              ? [actorIds[0]]
              : undefined;
      } else if (body.actorId) {
        actorIds = [body.actorId];
        targetActorIds = Array.isArray(body.targetActorIds)
          ? body.targetActorIds
          : body.targetActorId
            ? [body.targetActorId]
            : [body.actorId];
      } else {
        return reply
          .status(400)
          .send({ error: "actorId or actorIds required" });
      }

      const content =
        body.content && typeof body.content === "string"
          ? body.content
          : undefined;
      const contentBlocks = Array.isArray(body.contentBlocks)
        ? (body.contentBlocks as CanonicalContentBlock[])
        : undefined;

      const result = await createConversation({
        workspaceId,
        createdBy: userId,
        actorIds,
        initialMessage: content,
        initialContentBlocks: contentBlocks,
        targetActorIds:
          content || (contentBlocks && contentBlocks.length > 0)
            ? targetActorIds
            : undefined,
      });

      const members = await getConversationMembers(result.conversation.id);

      return reply.status(201).send({
        id: result.conversation.id,
        conversationId: result.conversation.id,
        conversation: result.conversation,
        members,
        status: "active",
      });
      },
    );
  }

  // Get conversation messages — transformed to frontend format
  for (const path of conversationPaths("/messages")) {
    app.get<{
      Params: ConversationRouteParams;
      Querystring: { limit?: string; before?: string };
    }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "view",
        "Not allowed to view this conversation",
      );
      if (!conversation) return;

      const userId = (request as any).user!.userId;
      const limit = parseInt(request.query.limit || "100", 10);
      const before = request.query.before;
      const page = await getConversationMessages(
        conversation.id,
        { userId },
        limit,
        before,
      );
      return reply.send({
        ...page,
        items: await Promise.all(
          page.items.map((item) =>
            enrichFeedItemInteractionsForUser(item, userId),
          ),
        ),
      });
      },
    );
  }

  // Send message to conversation — explicit targets are optional.
  for (const path of conversationPaths("/messages")) {
    app.post<{ Params: ConversationRouteParams; Body: any }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "send",
        "Not allowed to send messages to this conversation",
      );
      if (!conversation) return;

      const body = sendConversationMessageSchema.parse(request.body) as {
        content: string;
        contentBlocks?: CanonicalContentBlock[];
        clientMessageId: string;
        targetParticipantIds?: string[];
        targetActorIds?: string[];
      };
      const userId = (request as any).user!.userId;

      const msg = await sendConversationMessage({
        conversationId: conversation.id,
        senderType: "user",
        senderUserId: userId,
        clientMessageId: body.clientMessageId,
        targetParticipantIds: body.targetParticipantIds,
        targetActorIds: body.targetActorIds,
        content: body.content,
        contentBlocks: body.contentBlocks,
      });

      return reply.status(201).send(msg);
      },
    );
  }

  for (const path of conversationPaths("/interactions/:interactionId/respond")) {
    app.post<{
      Params: ConversationInteractionRouteParams;
      Body: unknown;
    }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "view",
        "Not allowed to view this conversation",
      );
      if (!conversation) return;

      const userId = (request as any).user!.userId;
      const interaction = await getInteractionRequestSummary(
        request.params.interactionId,
      );
      if (
        !interaction ||
        interaction.workspaceId !== request.params.workspaceId ||
        interaction.conversationId !== conversation.id
      ) {
        return reply.status(404).send({ error: "Interaction not found" });
      }

      if (
        interaction.kind === "relay_authorization" &&
        interaction.relayAuthorization?.deviceId
      ) {
        const allowed = await authorizeAction({
          subject: userSubject(userId),
          action: "relay_device.authorize_runtime_access",
          resourceId: interaction.relayAuthorization.deviceId,
        });
        if (!allowed) {
          return reply
            .status(403)
            .send({ error: "Not allowed to authorize this relay device" });
        }
      }

      const resolverMember = await getConversationMember({
        conversationId: conversation.id,
        userId,
      });
      if (!resolverMember) {
        return reply
          .status(403)
          .send({ error: "You are not an active member of this conversation" });
      }

      const body = resolveInteractionSchema.parse(request.body);
      const result = await resolveInteractionRequest({
        interactionId: interaction.id,
        resolverUserId: userId,
        resolverMemberId: resolverMember.id,
        answers: body.answers,
        selectedOptionId: body.selectedOptionId,
        decision: body.decision,
        note: body.note,
      });

      if (result.relayApplyNeeded) {
        await enqueueRelayAuthorizationApply(result.interaction.id);
      }

      return reply.send({
        interaction: await enrichInteractionForUser(result.interaction, userId),
      });
      },
    );
  }

  // Mark conversation as read
  for (const path of conversationPaths("/read")) {
    app.post<{ Params: ConversationRouteParams }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "view",
        "Not allowed to view this conversation",
      );
      if (!conversation) return;

      const userId = (request as any).user!.userId;
      await markConversationRead(userId, conversation.id);
      return reply.status(204).send();
      },
    );
  }

  // Cancel conversation (stop all actors)
  for (const path of conversationPaths()) {
    app.delete<{ Params: ConversationRouteParams }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage",
        "Not allowed to manage this conversation",
      );
      if (!conversation) return;

      await cancelConversation(conversation.id);
      return reply.status(204).send();
      },
    );
  }

  for (const path of conversationPaths()) {
    app.put<{ Params: ConversationRouteParams; Body: unknown }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage",
        "Not allowed to manage this conversation",
      );
      if (!conversation) return;

      try {
        const body = updateConversationSchema.parse(request.body);
        const updated = await updateConversationProfile({
          conversationId: conversation.id,
          workspaceId: conversation.workspace_id,
          updatedBy: (request as any).user!.userId,
          title: body.title,
          avatarFileId: body.avatarFileId,
        });
        return reply.send({ conversation: updated });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: "Validation failed",
            details: error.errors.map((item) => ({
              field: item.path.join("."),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to update conversation",
        });
      }
      },
    );
  }

  // Get conversation members
  for (const path of conversationPaths("/members")) {
    app.get<{ Params: ConversationRouteParams }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "view",
        "Not allowed to view this conversation",
      );
      if (!conversation) return;

      const members = (await getConversationMembers(conversation.id))
        .filter((member: any) => member.state === "active")
        .map(mapMember);
      return reply.send({ members });
      },
    );
  }

  for (const path of conversationPaths("/members")) {
    app.post<{ Params: ConversationRouteParams; Body: unknown }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage_members",
        "Not allowed to manage conversation members",
      );
      if (!conversation) return;

      try {
        const body = addConversationMembersSchema.parse(request.body);
        const result = await addMembersToConversation({
          conversationId: conversation.id,
          workspaceId: conversation.workspace_id,
          actorIds: body.actorIds,
          userIds: body.userIds,
          initiator: {
            memberType: "user",
            userId: (request as any).user!.userId,
          },
        });
        return reply.status(201).send(result);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: "Validation failed",
            details: error.errors.map((item) => ({
              field: item.path.join("."),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({
          error:
            error instanceof Error ? error.message : "Failed to add members",
        });
      }
      },
    );
  }

  // Remove actor from conversation (kick)
  for (const path of conversationPaths("/members/:actorId")) {
    app.delete<{
      Params: ConversationActorRouteParams;
    }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage_members",
        "Not allowed to manage conversation members",
      );
      if (!conversation) return;

      const actorId = request.params.actorId;
      await removeActorFromConversation(conversation.id, actorId);
      return reply.status(204).send();
      },
    );
  }

  for (const path of conversationPaths("/grants")) {
    app.get<{ Params: ConversationRouteParams }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage",
        "Not allowed to manage conversation permissions",
      );
      if (!conversation) return;

      const { workspaceId } = request.params;
      const conversationId = readConversationId(request.params);
      const grants = await listConversationGrants(conversationId, workspaceId);
      return reply.send({ grants });
      },
    );
  }

  for (const path of conversationPaths("/grants")) {
    app.post<{ Params: ConversationRouteParams; Body: unknown }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage",
        "Not allowed to manage conversation permissions",
      );
      if (!conversation) return;

      try {
        const body = issueConversationGrantSchema.parse(request.body);
        const grant = await issueConversationGrant({
          conversationId: conversation.id,
          workspaceId: conversation.workspace_id,
          permission: body.permission,
          userId: body.userId,
          actorId: body.actorId,
          grantedBy: (request as any).user!.userId,
          reason: body.reason,
          metadata: body.metadata,
        });
        return reply.status(201).send({ grant });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({
            error: "Validation failed",
            details: error.errors.map((item) => ({
              field: item.path.join("."),
              message: item.message,
            })),
          });
        }
        return reply.status(400).send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to issue conversation grant",
        });
      }
      },
    );
  }

  for (const path of conversationPaths("/grants/:grantId/revoke")) {
    app.post<{
      Params: ConversationGrantRouteParams;
    }>(
      path,
      async (request, reply) => {
      const conversation = await requireConversationPermission(
        request,
        reply,
        "manage",
        "Not allowed to manage conversation permissions",
      );
      if (!conversation) return;

      const conversationId = readConversationId(request.params);
      const { grantId } = request.params;
      const revoked = await revokeConversationGrant({
        conversationId,
        workspaceId: conversation.workspace_id,
        grantId,
      });
      if (!revoked) {
        return reply
          .status(404)
          .send({ error: "Conversation grant not found" });
      }
      return reply.send({ grant: revoked });
      },
    );
  }
}
