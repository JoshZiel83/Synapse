import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CanonicalContentBlock } from "@synapse/shared";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import { requireRequestAction } from "../access/guards.js";
import {
  authorizeAction,
  userSubject,
} from "../access/service.js";
import {
  addMembersToConversation,
  cancelConversation,
  createThread,
  getConversation,
  getConversationMembers,
  getConversationMessages,
  getThreadsForUser,
  issueConversationGrant,
  markConversationRead,
  listConversationGrants,
  removeActorFromConversation,
  revokeConversationGrant,
  sendConversationMessage,
  updateConversationProfile,
} from "./chat-service.js";
import {
  enrichFeedItemInteractionsForUser,
  enrichInteractionForUser,
  getInteractionRequestSummary,
  resolveInteractionRequest,
} from "../interactions/service.js";
import { getConversationRuntimeMap } from "../session/runtime.js";
import {
  getConversationMember,
} from "./service.js";
import { enqueueRelayAuthorizationApply } from "../mcp-plugins/relay-manager.js";
import { getConversationTransportBinding } from "../im/service.js";

const CONVERSATIONS_BASE_PATH = "/api/v1/conversations";

const createThreadSchema = z.object({
  domain: z.enum(["workspace", "social"]),
  kind: z.enum(["private", "group"]),
  workspaceId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  actorIds: z.array(z.string().uuid()).optional().default([]),
  userIds: z.array(z.string().uuid()).optional().default([]),
  content: z.string().max(10000).optional(),
  contentBlocks: z.array(z.any()).optional(),
  targetActorIds: z.array(z.string().uuid()).optional(),
});

const sendThreadMessageSchema = z
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

const markReadWatermarkSchema = z.object({
  readUpToSequence: z.number().int().min(0),
});

const updateThreadSchema = z
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

const addThreadMembersSchema = z
  .object({
    actorIds: z.array(z.string().uuid()).optional().default([]),
    userIds: z.array(z.string().uuid()).optional().default([]),
  })
  .refine((body) => body.actorIds.length > 0 || body.userIds.length > 0, {
    message: "At least one actor or user is required",
  });

const threadGrantPermissionEnum = z.enum([
  "send",
  "moderate",
  "manage",
  "manage_members",
  "attach_resources",
]);

const issueThreadGrantSchema = z
  .object({
    permission: threadGrantPermissionEnum,
    userId: z.string().uuid().optional(),
    actorId: z.string().uuid().optional(),
    reason: z.string().max(1000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.userId && value.actorId) || (!value.userId && !value.actorId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of userId or actorId is required",
      });
    }
  });

const resolveThreadInteractionSchema = z
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
      state: row.state,
    };
  }

  if (row.member_type === "external") {
    return {
      memberId: row.id,
      participantId: row.id,
      type: "external",
      id: row.id,
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
    avatarUrl: row.user_avatar_file_id
      ? getFileUrlById(row.user_avatar_file_id)
      : undefined,
    state: row.state,
  };
}

async function mapThreadSummary(row: any, userId: string) {
  const members = (await getConversationMembers(row.id)).filter(
    (member: any) => member.state === "active",
  );
  const mappedMembers = members.map(mapMember);
  const participants = mappedMembers.filter(
    (member: any) => member.type === "actor",
  );
  const hasOpenLane = members.some(
    (member: any) => member.actor_id && member.session_status !== "closed",
  );
  const directPeerNames =
    row.kind === "private"
      ? mappedMembers
          .filter(
            (member: any) =>
              !(member.type === "user" && member.userId === userId) &&
              member.state !== "removed",
          )
          .map((member: any) => member.name)
          .filter(Boolean)
      : [];
  const derivedName =
    row.kind === "private" && directPeerNames.length > 0
      ? directPeerNames.join(", ")
      : row.title ||
        mappedMembers
          .map((member: any) => member.name)
          .filter(Boolean)
          .join(", ") ||
        row.last_message?.substring(0, 100) ||
        "Untitled thread";
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
    domain: row.domain,
    kind: row.kind,
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
}

async function requireThreadPermission(
  request: any,
  reply: any,
  permission: "view" | "send" | "manage" | "manage_members",
  errorMessage: string,
) {
  const threadId =
    typeof request.params.threadId === "string" ? request.params.threadId : "";
  const thread = await getConversation(threadId);

  if (!thread) {
    reply.status(404).send({ error: "Thread not found" });
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
    threadId,
    errorMessage,
  );
  if (!allowed) {
    return null;
  }

  return thread;
}

function requireWorkspaceBackedThread(
  reply: any,
  thread: { workspace_id?: string | null } | null,
  errorMessage: string,
) {
  if (!thread?.workspace_id) {
    reply.status(400).send({ error: errorMessage });
    return null;
  }

  return thread.workspace_id;
}

export default async function threadController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);

  app.get<{
    Querystring: {
      workspaceId?: string;
      domain?: "workspace" | "social";
    };
  }>(CONVERSATIONS_BASE_PATH, async (request, reply) => {
    const userId = (request as any).user!.userId;
    const threads = await getThreadsForUser({
      userId,
      workspaceId:
        typeof request.query.workspaceId === "string"
          ? request.query.workspaceId
          : undefined,
      domain:
        request.query.domain === "workspace" || request.query.domain === "social"
          ? request.query.domain
          : undefined,
    });
    const runtimeMap = await getConversationRuntimeMap(
      threads.map((thread) => thread.id as string),
    );

    return reply.send({
      conversations: await Promise.all(
        threads.map((thread) => mapThreadSummary(thread, userId)),
      ),
      runtimeMap,
    });
  });

  app.post<{
    Body: unknown;
  }>(CONVERSATIONS_BASE_PATH, async (request, reply) => {
    const body = createThreadSchema.parse(request.body);
    const userId = (request as any).user!.userId;

    if (body.domain === "workspace") {
      if (!body.workspaceId) {
        return reply.status(400).send({
          error: "workspaceId is required for workspace threads",
        });
      }
      const allowed = await requireRequestAction(
        request,
        reply,
        "workspace.create_conversation",
        body.workspaceId,
        "Not allowed to create threads in this workspace",
      );
      if (!allowed) return;
    }

    const created = await createThread({
      workspaceId: body.domain === "workspace" ? body.workspaceId : undefined,
      domain: body.domain,
      kind: body.kind,
      createdBy: userId,
      title: body.title,
      actorIds: body.actorIds,
      userIds: body.userIds,
      initialMessage:
        typeof body.content === "string" ? body.content : undefined,
      initialContentBlocks: Array.isArray(body.contentBlocks)
        ? (body.contentBlocks as CanonicalContentBlock[])
        : undefined,
      targetActorIds: body.targetActorIds,
    });

    return reply.status(201).send({
      conversationId: created.conversation.id,
    });
  });

  app.get<{
    Params: { threadId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId`, async (request, reply) => {
    const userId = (request as any).user!.userId;
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread",
    );
    if (!thread) return;

    const rows = await getThreadsForUser({ userId });
    const summary = rows.find((row) => row.id === thread.id);
    if (!summary) {
      return reply.status(404).send({ error: "Thread not found" });
    }

    return reply.send({
      conversation: await mapThreadSummary(summary, userId),
    });
  });

  app.get<{
    Params: { threadId: string };
    Querystring: { limit?: string; before?: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/messages`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread",
    );
    if (!thread) return;

    const userId = (request as any).user!.userId;
    const limit = parseInt(request.query.limit || "100", 10);
    const page = await getConversationMessages(
      thread.id,
      { userId },
      limit,
      request.query.before,
    );
    return reply.send({
      ...page,
      items: await Promise.all(
        page.items.map((item) => enrichFeedItemInteractionsForUser(item, userId)),
      ),
    });
  });

  app.get<{
    Params: { threadId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/members`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread",
    );
    if (!thread) return;

    const members = (await getConversationMembers(thread.id))
      .filter((member: any) => member.state === "active")
      .map(mapMember);
    return reply.send({ members });
  });

  app.post<{
    Params: { threadId: string };
    Body: unknown;
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/members`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage_members",
      "Not allowed to manage thread members",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace member management",
    );
    if (!workspaceId) return;

    const body = addThreadMembersSchema.parse(request.body);
    const result = await addMembersToConversation({
      conversationId: thread.id,
      workspaceId,
      actorIds: body.actorIds,
      userIds: body.userIds,
      initiator: {
        memberType: "user",
        userId: (request as any).user!.userId,
      },
    });
    return reply.status(201).send(result);
  });

  app.post<{
    Params: { threadId: string };
    Body: unknown;
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/messages`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "send",
      "Not allowed to send messages to this thread",
    );
    if (!thread) return;

    const body = sendThreadMessageSchema.parse(request.body);
    const userId = (request as any).user!.userId;
    const response = await sendConversationMessage({
      conversationId: thread.id,
      senderType: "user",
      senderUserId: userId,
      clientMessageId: body.clientMessageId,
      targetParticipantIds: body.targetParticipantIds,
      targetActorIds: body.targetActorIds,
      content: body.content,
      contentBlocks: body.contentBlocks as CanonicalContentBlock[] | undefined,
    });

    return reply.status(201).send(response);
  });

  app.post<{
    Params: { threadId: string };
    Body: unknown;
  }>(
    `${CONVERSATIONS_BASE_PATH}/:threadId/read-watermark`,
    async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread",
    );
    if (!thread) return;

      const userId = (request as any).user!.userId;
      const body = markReadWatermarkSchema.parse(request.body);
      await markConversationRead(userId, thread.id, body.readUpToSequence);
      return reply.status(204).send();
    },
  );

  app.put<{
    Params: { threadId: string };
    Body: unknown;
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage",
      "Not allowed to manage this thread",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace-scoped profile updates",
    );
    if (!workspaceId) return;

    const body = updateThreadSchema.parse(request.body);
    const updated = await updateConversationProfile({
      conversationId: thread.id,
      workspaceId,
      updatedBy: (request as any).user!.userId,
      title: body.title,
      avatarFileId: body.avatarFileId,
    });
    return reply.send({ thread: updated });
  });

  app.delete<{
    Params: { threadId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage",
      "Not allowed to manage this thread",
    );
    if (!thread) return;

    await cancelConversation(thread.id);
    return reply.status(204).send();
  });

  app.delete<{
    Params: { threadId: string; actorId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/members/:actorId`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage_members",
      "Not allowed to manage thread members",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace member management",
    );
    if (!workspaceId) return;

    await removeActorFromConversation(thread.id, request.params.actorId);
    return reply.status(204).send();
  });

  app.post<{
    Params: { threadId: string; interactionId: string };
    Body: unknown;
  }>(
    `${CONVERSATIONS_BASE_PATH}/:threadId/interactions/:interactionId/respond`,
    async (request, reply) => {
      const thread = await requireThreadPermission(
        request,
        reply,
        "view",
        "Not allowed to view this thread",
      );
      if (!thread) return;

      const userId = (request as any).user!.userId;
      const interaction = await getInteractionRequestSummary(
        request.params.interactionId,
      );
      if (!interaction || interaction.conversationId !== thread.id) {
        return reply.status(404).send({ error: "Interaction not found" });
      }

      const resolverMember = await getConversationMember({
        conversationId: thread.id,
        userId,
      });
      if (!resolverMember) {
        return reply
          .status(403)
          .send({ error: "You are not an active member of this thread" });
      }

      const body = resolveThreadInteractionSchema.parse(request.body);
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

  app.get<{
    Params: { threadId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/grants`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage",
      "Not allowed to manage thread permissions",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace-scoped grants",
    );
    if (!workspaceId) return;

    const grants = await listConversationGrants(thread.id, workspaceId);
    return reply.send({ grants });
  });

  app.post<{
    Params: { threadId: string };
    Body: unknown;
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/grants`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage",
      "Not allowed to manage thread permissions",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace-scoped grants",
    );
    if (!workspaceId) return;

    const body = issueThreadGrantSchema.parse(request.body);
    const grant = await issueConversationGrant({
      conversationId: thread.id,
      workspaceId,
      permission: body.permission,
      userId: body.userId,
      actorId: body.actorId,
      grantedBy: (request as any).user!.userId,
      reason: body.reason,
      metadata: body.metadata,
    });
    return reply.status(201).send({ grant });
  });

  app.post<{
    Params: { threadId: string; grantId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/grants/:grantId/revoke`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "manage",
      "Not allowed to manage thread permissions",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not support workspace-scoped grants",
    );
    if (!workspaceId) return;

    const revoked = await revokeConversationGrant({
      conversationId: thread.id,
      workspaceId,
      grantId: request.params.grantId,
    });
    if (!revoked) {
      return reply.status(404).send({ error: "Thread grant not found" });
    }
    return reply.send({ grant: revoked });
  });

  app.get<{
    Params: { threadId: string };
  }>(`${CONVERSATIONS_BASE_PATH}/:threadId/transport-binding`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread transport binding",
    );
    if (!thread) return;

    const workspaceId = requireWorkspaceBackedThread(
      reply,
      thread,
      "Social threads do not have transport bindings",
    );
    if (!workspaceId) return;

    const binding = await getConversationTransportBinding({
      workspaceId,
      conversationId: thread.id,
    });
    return reply.send({ binding });
  });
}
