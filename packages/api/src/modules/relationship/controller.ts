import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js";
import { requireRequestAction } from "../access/guards.js";
import {
  CONTACT_HUB_KINDS,
  getActorRelationshipProfile,
  getContactHub,
  getContactHubDetail,
  getUserFriendSearchProfile,
  getUserRelationshipProfile,
  listActorAccessRequests,
  listFriendRequests,
  listFriends,
  openDirectConversation,
  requestFriendBySearchProfile,
  resolveActorAccessRequest,
  resolveFriendRequest,
  scanRelationshipQr,
  searchUsersByFriendId,
  updateActorRelationshipProfile,
  updateUserFriendSearchProfile,
  updateUserRelationshipProfile,
} from "./service.js";

const approvalModeSchema = z.enum(["auto", "manual"]);
const actorAccessPolicySchema = z.enum([
  "workspace_open",
  "approval_required",
]);
const contactKindSchema = z.enum(CONTACT_HUB_KINDS);

const scanSchema = z.object({
  token: z.string().trim().min(1).max(256),
});

const openDirectSchema = z.object({
  contactKind: contactKindSchema,
  contactId: z.string().trim().min(1).max(255),
});

const updateUserProfileSchema = z.object({
  approvalMode: approvalModeSchema,
});

const updateUserFriendIdSchema = z.object({
  friendId: z.string().trim().min(4).max(32).optional(),
  searchByIdEnabled: z.boolean().optional(),
});

const friendIdSearchQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
});

const requestFriendBySearchSchema = z.object({
  profileId: z.string().uuid(),
});

const updateActorProfileSchema = z.object({
  approvalMode: approvalModeSchema,
  accessPolicy: actorAccessPolicySchema.optional(),
});

function sendServiceError(reply: FastifyReply, error: unknown) {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Request failed";
  if (/not found/i.test(message)) {
    return reply.status(404).send({ error: message });
  }
  if (/not allowed|forbidden/i.test(message)) {
    return reply.status(403).send({ error: message });
  }
  return reply.status(400).send({ error: message });
}

export default async function relationshipController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", workspaceMiddleware);

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/me/friend-profile", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(
      await getUserRelationshipProfile({
        workspaceId: request.params.workspaceId,
        userId,
      }),
    );
  });

  app.put<{
    Params: { workspaceId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/me/friend-profile", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const body = updateUserProfileSchema.parse(request.body);
    return reply.send(
      await updateUserRelationshipProfile({
        workspaceId: request.params.workspaceId,
        userId,
        approvalMode: body.approvalMode,
      }),
    );
  });

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/me/friend-id", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(await getUserFriendSearchProfile({ userId }));
  });

  app.put<{
    Params: { workspaceId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/me/friend-id", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const body = updateUserFriendIdSchema.parse(request.body);
    try {
      return reply.send(
        await updateUserFriendSearchProfile({
          userId,
          friendId: body.friendId,
          searchByIdEnabled: body.searchByIdEnabled,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string; actorId: string };
  }>("/api/v1/workspaces/:workspaceId/actors/:actorId/friend-profile", async (request, reply) => {
    const allowed = await requireRequestAction(
      request,
      reply,
      "actor.grant",
      request.params.actorId,
      "Not allowed to manage this actor relationship profile",
    );
    if (!allowed) return;
    const userId = (request as any).user!.userId;
    try {
      return reply.send(
        await getActorRelationshipProfile({
          workspaceId: request.params.workspaceId,
          actorId: request.params.actorId,
          userId,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.put<{
    Params: { workspaceId: string; actorId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/actors/:actorId/friend-profile", async (request, reply) => {
    const allowed = await requireRequestAction(
      request,
      reply,
      "actor.grant",
      request.params.actorId,
      "Not allowed to manage this actor relationship profile",
    );
    if (!allowed) return;
    const userId = (request as any).user!.userId;
    const body = updateActorProfileSchema.parse(request.body);
    try {
      return reply.send(
        await updateActorRelationshipProfile({
          workspaceId: request.params.workspaceId,
          actorId: request.params.actorId,
          userId,
          approvalMode: body.approvalMode,
          accessPolicy: body.accessPolicy,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/relationship-qr/scan", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const body = scanSchema.parse(request.body);
    try {
      return reply.send(
        await scanRelationshipQr({
          workspaceId: request.params.workspaceId,
          userId,
          token: body.token,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { q?: string };
  }>("/api/v1/workspaces/:workspaceId/friend-id-search", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const query = friendIdSearchQuerySchema.parse(request.query);
    return reply.send(
      await searchUsersByFriendId({
        workspaceId: request.params.workspaceId,
        userId,
        query: query.q || "",
      }),
    );
  });

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/friend-id-search/request", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const body = requestFriendBySearchSchema.parse(request.body);
    try {
      return reply.send(
        await requestFriendBySearchProfile({
          workspaceId: request.params.workspaceId,
          userId,
          profileId: body.profileId,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/friends", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(
      await listFriends({
        workspaceId: request.params.workspaceId,
        userId,
      }),
    );
  });

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/friend-requests", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(
      await listFriendRequests({
        workspaceId: request.params.workspaceId,
        userId,
      }),
    );
  });

  app.post<{
    Params: { workspaceId: string; requestId: string };
  }>("/api/v1/workspaces/:workspaceId/friend-requests/:requestId/approve", async (request, reply) => {
    const userId = (request as any).user!.userId;
    try {
      return reply.send({
        request: await resolveFriendRequest({
          workspaceId: request.params.workspaceId,
          userId,
          requestId: request.params.requestId,
          decision: "approve",
        }),
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string; requestId: string };
  }>("/api/v1/workspaces/:workspaceId/friend-requests/:requestId/reject", async (request, reply) => {
    const userId = (request as any).user!.userId;
    try {
      return reply.send({
        request: await resolveFriendRequest({
          workspaceId: request.params.workspaceId,
          userId,
          requestId: request.params.requestId,
          decision: "reject",
        }),
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/actor-access-requests", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(
      await listActorAccessRequests({
        workspaceId: request.params.workspaceId,
        userId,
      }),
    );
  });

  app.post<{
    Params: { workspaceId: string; requestId: string };
  }>("/api/v1/workspaces/:workspaceId/actor-access-requests/:requestId/approve", async (request, reply) => {
    const userId = (request as any).user!.userId;
    try {
      return reply.send({
        request: await resolveActorAccessRequest({
          workspaceId: request.params.workspaceId,
          userId,
          requestId: request.params.requestId,
          decision: "approve",
        }),
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string; requestId: string };
  }>("/api/v1/workspaces/:workspaceId/actor-access-requests/:requestId/reject", async (request, reply) => {
    const userId = (request as any).user!.userId;
    try {
      return reply.send({
        request: await resolveActorAccessRequest({
          workspaceId: request.params.workspaceId,
          userId,
          requestId: request.params.requestId,
          decision: "reject",
        }),
      });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/contact-hub", async (request, reply) => {
    const userId = (request as any).user!.userId;
    return reply.send(
      await getContactHub({
        workspaceId: request.params.workspaceId,
        userId,
      }),
    );
  });

  app.get<{
    Params: { workspaceId: string; kind: string; contactId: string };
  }>("/api/v1/workspaces/:workspaceId/contact-hub/:kind/:contactId", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const kind = contactKindSchema.parse(request.params.kind);
    try {
      return reply.send(
        await getContactHubDetail({
          workspaceId: request.params.workspaceId,
          userId,
          contactKind: kind,
          contactId: request.params.contactId,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>("/api/v1/workspaces/:workspaceId/direct-conversations/open", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const body = openDirectSchema.parse(request.body);
    try {
      return reply.send(
        await openDirectConversation({
          workspaceId: request.params.workspaceId,
          userId,
          contactKind: body.contactKind,
          contactId: body.contactId,
        }),
      );
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });
}
