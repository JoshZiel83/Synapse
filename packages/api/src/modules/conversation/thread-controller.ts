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
  createConversation,
  getConversation,
  getConversationMembers,
  getConversationMessages,
  getThreadsForUser,
  markConversationRead,
  sendConversationMessage,
} from "./chat-service.js";
import {
  enrichFeedItemInteractionsForUser,
} from "../interactions/service.js";

const THREADS_BASE_PATH = "/api/v1/threads";

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

export default async function threadController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);

  app.get<{
    Querystring: { workspaceId?: string };
  }>(THREADS_BASE_PATH, async (request, reply) => {
    const userId = (request as any).user!.userId;
    const threads = await getThreadsForUser({
      userId,
      workspaceId:
        typeof request.query.workspaceId === "string"
          ? request.query.workspaceId
          : undefined,
    });

    return reply.send({
      threads: await Promise.all(
        threads.map((thread) => mapThreadSummary(thread, userId)),
      ),
    });
  });

  app.post<{
    Body: unknown;
  }>(THREADS_BASE_PATH, async (request, reply) => {
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

    const created = await createConversation({
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
      id: created.conversation.id,
      threadId: created.conversation.id,
    });
  });

  app.get<{
    Params: { threadId: string };
  }>(`${THREADS_BASE_PATH}/:threadId`, async (request, reply) => {
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
      thread: await mapThreadSummary(summary, userId),
    });
  });

  app.get<{
    Params: { threadId: string };
    Querystring: { limit?: string; before?: string };
  }>(`${THREADS_BASE_PATH}/:threadId/messages`, async (request, reply) => {
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
  }>(`${THREADS_BASE_PATH}/:threadId/members`, async (request, reply) => {
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
  }>(`${THREADS_BASE_PATH}/:threadId/messages`, async (request, reply) => {
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
  }>(`${THREADS_BASE_PATH}/:threadId/read`, async (request, reply) => {
    const thread = await requireThreadPermission(
      request,
      reply,
      "view",
      "Not allowed to view this thread",
    );
    if (!thread) return;

    const userId = (request as any).user!.userId;
    await markConversationRead(userId, thread.id);
    return reply.status(204).send();
  });
}
