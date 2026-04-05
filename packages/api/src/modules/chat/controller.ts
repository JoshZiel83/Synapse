import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { requireWorkspaceMemberIdentity } from "./workspace-identity.js";
import {
  createChatConversation,
  getConversationParticipant,
  getChatBootstrap,
  getChatConversationMessages,
  getChatSync,
  isChatServiceError,
  registerChatClientInstance,
  sendChatConversationMessage,
  updateChatConversationReadWatermark,
} from "./service.js";
import {
  canUserViewInteraction,
  getInteractionRequestSummary,
  resolveInteractionRequest,
} from "../interactions/service.js";

const CHAT_BASE_PATH = "/api/v1/workspaces/:workspaceId/chat";
const CONVERSATION_BASE_PATH = "/api/v1/workspaces/:workspaceId/conversations";

const jsonRecordSchema = z.record(z.any()).optional();

const createConversationSchema = z.object({
  clientRequestId: z.string().uuid(),
  kind: z.enum(["group", "private", "virtual"]),
  boundary: z.enum(["internal", "external"]).optional(),
  title: z.string().trim().min(1).max(255).optional(),
  workspaceMemberIds: z.array(z.string().uuid()).optional().default([]),
  actorIds: z.array(z.string().uuid()).optional().default([]),
  externalParticipants: z
    .array(
      z.object({
        displayName: z.string().trim().min(1).max(255),
        metadata: jsonRecordSchema,
        transportAddressIds: z.array(z.string().uuid()).optional().default([]),
      }),
    )
    .optional()
    .default([]),
  metadata: jsonRecordSchema,
});

const registerClientInstanceSchema = z.object({
  platform: z.string().trim().min(1).max(64).optional(),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
  metadata: jsonRecordSchema,
});

const conversationMessagesQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).optional(),
    beforeSequence: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    clientInstanceId: z.string().uuid().optional(),
  })
  .refine(
    (value) =>
      !(typeof value.afterSequence === "number" && typeof value.beforeSequence === "number"),
    {
      message: "afterSequence and beforeSequence cannot both be provided",
    },
  );

const syncQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const sendMessageSchema = z
  .object({
    contentBlocks: z.array(z.any()).min(1),
    clientMessageId: z.string().uuid(),
    replyToItemId: z.string().uuid().optional(),
    clientInstanceId: z.string().uuid().optional(),
    metadata: jsonRecordSchema,
  });

const readWatermarkSchema = z.object({
  readUpToSequence: z.number().int().min(0),
  lastVisibleSequence: z.number().int().min(0).optional(),
  clientInstanceId: z.string().uuid().optional(),
});

const interactionAnswerSchema = z.object({
  questionId: z.string().trim().min(1),
  selectedOptionIds: z.array(z.string().trim().min(1)).optional(),
  otherText: z.string().trim().optional(),
  text: z.string().trim().optional(),
});

const resolveInteractionSchema = z.object({
  answers: z.array(interactionAnswerSchema).optional(),
  decision: z.enum(["approve", "reject", "revise"]).optional(),
  preset: z.enum(["once", "actor", "conversation", "workspace"]).optional(),
  selectedOptionIds: z.array(z.string().trim().min(1)).optional(),
  note: z.string().trim().optional(),
});

function getRequestUserId(request: any) {
  return (request as any).user!.userId as string;
}

async function resolveRequestWorkspaceMemberId(request: any, reply: any) {
  try {
    const identity = await requireWorkspaceMemberIdentity(
      request.params.workspaceId,
      getRequestUserId(request),
    );
    return identity.workspaceMemberId;
  } catch {
    reply.status(403).send({
      error: "You are not a member of this workspace",
      code: "workspace_access_denied",
    });
    return null;
  }
}

function replyChatError(reply: any, error: unknown) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: error.issues[0]?.message ?? "Invalid request",
      code: "invalid_request",
      issues: error.issues,
    });
  }

  if (!isChatServiceError(error)) {
    throw error;
  }

  return reply.status(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details || {}),
  });
}

export default async function chatController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);

  app.get<{
    Params: { workspaceId: string };
  }>(`${CHAT_BASE_PATH}/bootstrap`, async (request, reply) => {
    try {
      const response = await getChatBootstrap({
        workspaceId: request.params.workspaceId,
        userId: getRequestUserId(request),
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
  }>(`${CHAT_BASE_PATH}/sync`, async (request, reply) => {
    try {
      const query = syncQuerySchema.parse(request.query);
      const response = await getChatSync({
        workspaceId: request.params.workspaceId,
        userId: getRequestUserId(request),
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.put<{
    Params: { workspaceId: string; clientInstanceId: string };
  }>(`${CHAT_BASE_PATH}/client-instances/:clientInstanceId`, async (request, reply) => {
    try {
      const body = registerClientInstanceSchema.parse(request.body);
      const response = await registerChatClientInstance({
        workspaceId: request.params.workspaceId,
        userId: getRequestUserId(request),
        clientInstanceId: request.params.clientInstanceId,
        platform: body.platform,
        deviceLabel: body.deviceLabel,
        metadata: body.metadata,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
  }>(`${CHAT_BASE_PATH}/conversations`, async (request, reply) => {
    try {
      const body = createConversationSchema.parse(request.body);
      const response = await createChatConversation({
        workspaceId: request.params.workspaceId,
        userId: getRequestUserId(request),
        clientRequestId: body.clientRequestId,
        kind: body.kind,
        boundary: body.boundary,
        title: body.title,
        workspaceMemberIds: body.workspaceMemberIds,
        actorIds: body.actorIds,
        externalParticipants: body.externalParticipants,
        metadata: body.metadata,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; conversationId: string };
  }>(`${CHAT_BASE_PATH}/conversations/:conversationId/messages`, async (request, reply) => {
    try {
      const query = conversationMessagesQuerySchema.parse(request.query);
      const response = await getChatConversationMessages({
        workspaceId: request.params.workspaceId,
        userId: getRequestUserId(request),
        conversationId: request.params.conversationId,
        afterSequence: query.afterSequence,
        beforeSequence: query.beforeSequence,
        limit: query.limit,
        clientInstanceId: query.clientInstanceId,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string; conversationId: string };
  }>(`${CHAT_BASE_PATH}/conversations/:conversationId/messages`, async (request, reply) => {
    try {
      const body = sendMessageSchema.parse(request.body);
      const workspaceMemberId = await resolveRequestWorkspaceMemberId(request, reply);
      if (!workspaceMemberId) return;
      const response = await sendChatConversationMessage({
        workspaceId: request.params.workspaceId,
        workspaceMemberId,
        conversationId: request.params.conversationId,
        clientInstanceId: body.clientInstanceId,
        clientMessageId: body.clientMessageId,
        contentBlocks: body.contentBlocks,
        replyToItemId: body.replyToItemId,
        metadata: body.metadata,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string; conversationId: string };
  }>(`${CHAT_BASE_PATH}/conversations/:conversationId/read-watermark`, async (request, reply) => {
    try {
      const body = readWatermarkSchema.parse(request.body);
      const workspaceMemberId = await resolveRequestWorkspaceMemberId(request, reply);
      if (!workspaceMemberId) return;
      const response = await updateChatConversationReadWatermark({
        workspaceId: request.params.workspaceId,
        workspaceMemberId,
        conversationId: request.params.conversationId,
        clientInstanceId: body.clientInstanceId,
        readUpToSequence: body.readUpToSequence,
        lastVisibleSequence: body.lastVisibleSequence,
      });
      return reply.send(response);
    } catch (error) {
      return replyChatError(reply, error);
    }
  });

  app.post<{
    Params: {
      workspaceId: string;
      conversationId: string;
      interactionId: string;
    };
  }>(`${CONVERSATION_BASE_PATH}/:conversationId/interactions/:interactionId/respond`, async (request, reply) => {
    try {
      const body = resolveInteractionSchema.parse(request.body);
      const workspaceMemberId = await resolveRequestWorkspaceMemberId(request, reply);
      if (!workspaceMemberId) return;

      const interaction = await getInteractionRequestSummary(
        request.params.interactionId,
      );
      if (
        !interaction ||
        interaction.workspaceId !== request.params.workspaceId ||
        interaction.conversationId !== request.params.conversationId
      ) {
        return reply.status(404).send({
          error: "Interaction not found",
          code: "interaction_not_found",
        });
      }

      const canView = await canUserViewInteraction({
        interactionId: interaction.id,
        userId: getRequestUserId(request),
      });
      if (!canView) {
        return reply.status(403).send({
          error: "You cannot access this interaction",
          code: "interaction_access_denied",
        });
      }

      const resolverParticipant = await getConversationParticipant({
        conversationId: request.params.conversationId,
        workspaceMemberId,
      });
      if (!resolverParticipant?.id) {
        return reply.status(403).send({
          error: "You are not an active participant in this conversation",
          code: "interaction_resolver_not_participant",
        });
      }

      try {
        const result = await resolveInteractionRequest({
          interactionId: interaction.id,
          resolverWorkspaceMemberId: workspaceMemberId,
          resolverParticipantId: resolverParticipant.id,
          answers: body.answers,
          decision: body.decision,
          preset: body.preset,
          selectedOptionIds: body.selectedOptionIds,
          note: body.note,
        });
        return reply.send({ interaction: result.interaction });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to resolve interaction";
        return reply.status(400).send({
          error: message,
          code: "interaction_resolution_failed",
        });
      }
    } catch (error) {
      return replyChatError(reply, error);
    }
  });
}
