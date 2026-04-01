import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  INTERACTION_DECISIONS,
  type CanonicalContentBlock,
} from "@synapse/shared";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import {
  addMembersToConversation,
  cancelConversation,
  createThread,
  getConversation,
  getConversationMembers,
  getConversationMessages,
  getThreadsForWorkspaceMember,
  isConversationServiceError,
  markConversationRead,
  sendConversationMessage,
  updateConversationProfile,
} from "./chat-service.js";
import {
  enrichFeedItemInteractionsForUser,
  enrichInteractionForUser,
  getInteractionRequestSummary,
  resolveInteractionRequest,
} from "../interactions/service.js";
import {
  enqueueSessionWakeup,
  getConversationRuntimeMap,
} from "../session/runtime.js";
import { getSession } from "../session/service.js";
import {
  getConversationFeedItemById,
  getConversationMember,
  isFeedItemVisibleToWorkspaceMember,
} from "./service.js";
import { getConversationTransportBinding } from "../im/service.js";
import {
  mapConversationMember,
  mapConversationSummaryView,
} from "./summary-view.js";
import {
  requireWorkspaceMemberIdentity,
} from "./workspace-identity.js";

const WORKSPACE_CONVERSATIONS_BASE_PATH =
  "/api/v1/workspaces/:workspaceId/conversations";

const createConversationSchema = z.object({
  kind: z.enum(["private", "group"]),
  title: z.string().trim().min(1).max(255).optional(),
  actorIds: z.array(z.string().uuid()).optional().default([]),
  workspaceMemberIds: z.array(z.string().uuid()).optional().default([]),
  content: z.string().max(10000).optional(),
  contentBlocks: z.array(z.any()).optional(),
  targetActorIds: z.array(z.string().uuid()).optional(),
});

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

const markReadSchema = z.object({
  readUpToSequence: z.number().int().min(0),
});

const retryConversationMessageSchema = z.object({
  itemId: z.string().uuid(),
});

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

const addParticipantsSchema = z
  .object({
    actorIds: z.array(z.string().uuid()).optional().default([]),
    workspaceMemberIds: z.array(z.string().uuid()).optional().default([]),
  })
  .refine(
    (body) => body.actorIds.length > 0 || body.workspaceMemberIds.length > 0,
    {
      message: "At least one actor or workspace member is required",
    },
  );

const resolveConversationInteractionSchema = z
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
    decision: z.enum(INTERACTION_DECISIONS).optional(),
    preset: z
      .enum(["once", "actor", "conversation", "workspace"])
      .optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(
    (body) =>
      (Array.isArray(body.answers) && body.answers.length > 0) ||
      typeof body.selectedOptionId === "string" ||
      typeof body.decision === "string",
    { message: "answers, selectedOptionId, or decision is required" },
  );

async function resolveRequestWorkspaceMember(request: any, reply: any) {
  try {
    return await requireWorkspaceMemberIdentity(
      request.params.workspaceId,
      (request as any).user!.userId,
    );
  } catch {
    reply.status(403).send({ error: "You are not a member of this workspace" });
    return null;
  }
}

function getRequestUserId(request: any) {
  return (request as any).user!.userId as string;
}

function canManageConversation(
  conversation: { kind?: string | null },
  viewerMember: { role?: string | null } | null,
) {
  if (!viewerMember || conversation.kind === "private") {
    return false;
  }

  return viewerMember.role === "owner" || viewerMember.role === "admin";
}

async function requireConversationAccess(
  request: any,
  reply: any,
  permission: "view" | "send" | "manage" | "manage_members",
) {
  const workspaceMember = await resolveRequestWorkspaceMember(request, reply);
  if (!workspaceMember) {
    return null;
  }

  const conversationId =
    typeof request.params.conversationId === "string"
      ? request.params.conversationId
      : "";
  if (!conversationId) {
    reply.status(400).send({ error: "conversationId is required" });
    return null;
  }

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    reply.status(404).send({ error: "Conversation not found" });
    return null;
  }

  const viewerMember = await getConversationMember({
    conversationId,
    workspaceMemberId: workspaceMember.workspaceMemberId,
  });
  if (!viewerMember || viewerMember.state !== "active") {
    reply.status(403).send({ error: "You are not a participant in this conversation" });
    return null;
  }

  if (
    (permission === "manage" || permission === "manage_members") &&
    !canManageConversation(conversation, viewerMember)
  ) {
    reply.status(403).send({ error: "You are not allowed to manage this conversation" });
    return null;
  }

  return {
    conversation,
    workspaceMember,
    viewerMember,
  };
}

async function loadConversationSummary(params: {
  conversationId: string;
  workspaceId: string;
  workspaceMemberId: string;
}) {
  const rows = await getThreadsForWorkspaceMember({
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
  });
  return rows.find((row) => row.id === params.conversationId) || null;
}

function replyConversationServiceError(reply: any, error: unknown) {
  if (!isConversationServiceError(error)) {
    throw error;
  }

  return reply.status(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details || {}),
  });
}

export default async function threadController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);

  app.get<{
    Params: { workspaceId: string };
  }>(WORKSPACE_CONVERSATIONS_BASE_PATH, async (request, reply) => {
    const workspaceMember = await resolveRequestWorkspaceMember(request, reply);
    if (!workspaceMember) return;

    const threads = await getThreadsForWorkspaceMember({
      workspaceId: request.params.workspaceId,
      workspaceMemberId: workspaceMember.workspaceMemberId,
    });
    const runtimeMap = await getConversationRuntimeMap(
      threads.map((thread) => thread.id as string),
    );

    return reply.send({
      conversations: await Promise.all(
        threads.map((thread) =>
          mapConversationSummaryView(thread, {
            workspaceMemberId: workspaceMember.workspaceMemberId,
          }),
        ),
      ),
      runtimeMap,
    });
  });

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>(WORKSPACE_CONVERSATIONS_BASE_PATH, async (request, reply) => {
    const workspaceMember = await resolveRequestWorkspaceMember(request, reply);
    if (!workspaceMember) return;

    try {
      const body = createConversationSchema.parse(request.body);
      const created = await createThread({
        workspaceId: request.params.workspaceId,
        kind: body.kind,
        createdByWorkspaceMemberId: workspaceMember.workspaceMemberId,
        title: body.title,
        actorIds: body.actorIds,
        workspaceMemberIds: body.workspaceMemberIds,
        initialMessage:
          typeof body.content === "string" ? body.content : undefined,
        initialContentBlocks: Array.isArray(body.contentBlocks)
          ? (body.contentBlocks as CanonicalContentBlock[])
          : undefined,
        targetActorIds: body.targetActorIds,
        includeCreatorMember: true,
      });

      const summary = await loadConversationSummary({
        conversationId: created.conversation.id,
        workspaceId: request.params.workspaceId,
        workspaceMemberId: workspaceMember.workspaceMemberId,
      });

      return reply.status(201).send({
        conversationId: created.conversation.id,
        conversation: summary
          ? await mapConversationSummaryView(summary, {
              workspaceMemberId: workspaceMember.workspaceMemberId,
            })
          : undefined,
      });
    } catch (error) {
      return replyConversationServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; conversationId: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const summary = await loadConversationSummary({
        conversationId: request.params.conversationId,
        workspaceId: request.params.workspaceId,
        workspaceMemberId: access.workspaceMember.workspaceMemberId,
      });
      if (!summary) {
        return reply.status(404).send({ error: "Conversation not found" });
      }

      return reply.send({
        conversation: await mapConversationSummaryView(summary, {
          workspaceMemberId: access.workspaceMember.workspaceMemberId,
        }),
      });
    },
  );

  app.get<{
    Params: { workspaceId: string; conversationId: string };
    Querystring: { limit?: string; before?: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/messages`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const limit = parseInt(request.query.limit || "100", 10);
      const page = await getConversationMessages(
        request.params.conversationId,
        {
          workspaceMemberId: access.workspaceMember.workspaceMemberId,
        },
        limit,
        request.query.before,
      );
      return reply.send({
        ...page,
        items: await Promise.all(
          page.items.map((item) =>
            enrichFeedItemInteractionsForUser(item, getRequestUserId(request)),
          ),
        ),
      });
    },
  );

  app.get<{
    Params: { workspaceId: string; conversationId: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/members`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const members = (await getConversationMembers(request.params.conversationId))
        .filter((member: any) => member.state === "active")
        .map(mapConversationMember);
      return reply.send({ members });
    },
  );

  app.post<{
    Params: { workspaceId: string; conversationId: string };
    Body: unknown;
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/members`,
    async (request, reply) => {
      const access = await requireConversationAccess(
        request,
        reply,
        "manage_members",
      );
      if (!access) return;
      if (access.conversation.kind === "private") {
        return reply.status(400).send({
          error: "Direct conversations do not support member management",
        });
      }

      const body = addParticipantsSchema.parse(request.body);
      const result = await addMembersToConversation({
        conversationId: request.params.conversationId,
        workspaceId: request.params.workspaceId,
        actorIds: body.actorIds,
        workspaceMemberIds: body.workspaceMemberIds,
        initiator: {
          memberType: "workspace_member",
          memberId: access.viewerMember.id,
          workspaceMemberId: access.workspaceMember.workspaceMemberId,
          name: access.workspaceMember.userName,
        },
      });
      return reply.status(201).send(result);
    },
  );

  app.post<{
    Params: { workspaceId: string; conversationId: string };
    Body: unknown;
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/messages`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "send");
      if (!access) return;

      try {
        const body = sendConversationMessageSchema.parse(request.body);
        const response = await sendConversationMessage({
          conversationId: request.params.conversationId,
          senderType: "workspace_member",
          senderWorkspaceId: request.params.workspaceId,
          senderWorkspaceMemberId: access.workspaceMember.workspaceMemberId,
          clientMessageId: body.clientMessageId,
          targetParticipantIds: body.targetParticipantIds,
          targetActorIds: body.targetActorIds,
          content: body.content,
          contentBlocks: body.contentBlocks as CanonicalContentBlock[] | undefined,
        });

        return reply.status(201).send(response);
      } catch (error) {
        return replyConversationServiceError(reply, error);
      }
    },
  );

  app.post<{
    Params: { workspaceId: string; conversationId: string };
    Body: unknown;
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/read`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const body = markReadSchema.parse(request.body);
      await markConversationRead(
        access.workspaceMember.workspaceMemberId,
        request.params.conversationId,
        body.readUpToSequence,
        request.params.workspaceId,
      );
      return reply.status(204).send();
    },
  );

  app.post<{
    Params: { workspaceId: string; conversationId: string; itemId: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/messages/:itemId/retry`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "send");
      if (!access) return;

      const { itemId } = retryConversationMessageSchema.parse(request.params);
      const item = await getConversationFeedItemById(itemId);

      if (
        !item ||
        item.kind !== "message" ||
        item.conversationId !== request.params.conversationId ||
        item.messageType !== "model_error_notice" ||
        !isFeedItemVisibleToWorkspaceMember(
          item,
          access.workspaceMember.workspaceMemberId,
        )
      ) {
        return reply.status(404).send({ error: "Retry target not found" });
      }

      const metadata =
        item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const retrySessionId =
        typeof metadata.retrySessionId === "string" && metadata.retrySessionId
          ? metadata.retrySessionId
          : item.sessionId;

      if (!retrySessionId) {
        return reply
          .status(400)
          .send({ error: "Retry target is missing its session binding" });
      }

      const session = await getSession(retrySessionId);
      if (
        !session ||
        session.conversation_id !== request.params.conversationId
      ) {
        return reply.status(404).send({ error: "Retry session not found" });
      }

      if (session.status === "closed") {
        return reply
          .status(400)
          .send({ error: "Cannot retry a closed session" });
      }

      const wakeup = await enqueueSessionWakeup({
        sessionId: session.id,
        actorId: session.actor_id,
        workspaceId: session.workspace_id,
        sourceType: "retry",
        sourceItemId: itemId,
        sourceMemberType: "workspace_member",
        sourceMemberId: access.workspaceMember.workspaceMemberId,
        summary: "Retry requested",
        reasonText: "User requested a retry after a model error.",
        trigger: "retry",
        metadata: {
          requestedByUserId: getRequestUserId(request),
          requestedByWorkspaceMemberId: access.workspaceMember.workspaceMemberId,
          retryFromItemId: itemId,
          source: "model_error_notice",
        },
      });

      return reply.status(201).send({
        wakeupId: wakeup.id,
        status: "queued",
        sessionId: session.id,
      });
    },
  );

  app.patch<{
    Params: { workspaceId: string; conversationId: string };
    Body: unknown;
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "manage");
      if (!access) return;
      if (access.conversation.kind === "private") {
        return reply.status(400).send({
          error: "Direct conversations do not support profile updates",
        });
      }

      const body = updateConversationSchema.parse(request.body);
      const updated = await updateConversationProfile({
        conversationId: request.params.conversationId,
        workspaceId: request.params.workspaceId,
        updatedByWorkspaceMemberId: access.workspaceMember.workspaceMemberId,
        title: body.title,
        avatarFileId: body.avatarFileId,
      });
      return reply.send({ conversation: updated });
    },
  );

  app.delete<{
    Params: { workspaceId: string; conversationId: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "manage");
      if (!access) return;

      await cancelConversation(request.params.conversationId);
      return reply.status(204).send();
    },
  );

  app.post<{
    Params: { workspaceId: string; conversationId: string; interactionId: string };
    Body: unknown;
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/interactions/:interactionId/respond`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const interaction = await getInteractionRequestSummary(
        request.params.interactionId,
      );
      if (
        !interaction ||
        interaction.conversationId !== request.params.conversationId
      ) {
        return reply.status(404).send({ error: "Interaction not found" });
      }

      const resolverMember = await getConversationMember({
        conversationId: request.params.conversationId,
        workspaceMemberId: access.workspaceMember.workspaceMemberId,
      });
      if (!resolverMember) {
        return reply
          .status(403)
          .send({ error: "You are not an active participant in this conversation" });
      }

      const body = resolveConversationInteractionSchema.parse(request.body);
      const result = await resolveInteractionRequest({
        interactionId: interaction.id,
        resolverWorkspaceMemberId: access.workspaceMember.workspaceMemberId,
        resolverMemberId: resolverMember.id,
        answers: body.answers,
        selectedOptionId: body.selectedOptionId,
        decision: body.decision,
        preset: body.preset,
        note: body.note,
      });

      return reply.send({
        interaction: await enrichInteractionForUser(
          result.interaction,
          getRequestUserId(request),
        ),
      });
    },
  );

  app.get<{
    Params: { workspaceId: string; conversationId: string };
  }>(
    `${WORKSPACE_CONVERSATIONS_BASE_PATH}/:conversationId/transport-binding`,
    async (request, reply) => {
      const access = await requireConversationAccess(request, reply, "view");
      if (!access) return;

      const binding = await getConversationTransportBinding({
        workspaceId: request.params.workspaceId,
        conversationId: request.params.conversationId,
      });
      return reply.send({ binding });
    },
  );
}
