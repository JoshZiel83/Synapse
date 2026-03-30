import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js";
import { getFileUrl } from "../../infrastructure/storage/index.js";
import { getFileUrlById } from "../files/service.js";
import {
  createWorkspaceContact,
  createWorkspaceUserContact,
  discoverContacts,
  listScopedContacts,
} from "./service.js";

const contactTargetSchema = z
  .object({
    targetType: z.enum(["user", "actor"]),
    targetWorkspaceId: z.string().uuid(),
    targetUserId: z.string().uuid().optional(),
    targetActorId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const validUser =
      value.targetType === "user" &&
      typeof value.targetUserId === "string" &&
      value.targetActorId === undefined;
    const validActor =
      value.targetType === "actor" &&
      typeof value.targetActorId === "string" &&
      value.targetUserId === undefined;
    if (!validUser && !validActor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetType and target id do not match",
      });
    }
  });

function mapContactForResponse(contact: any) {
  return {
    id: contact.id,
    scope: contact.scope,
    targetType: contact.targetType,
    targetWorkspace: contact.targetWorkspace,
    actor: contact.actor
      ? {
          ...contact.actor,
          avatarUrl: contact.actor.avatarStoredName
            ? getFileUrl(contact.actor.avatarStoredName)
            : undefined,
        }
      : null,
    user: contact.user
      ? {
          ...contact.user,
          avatarUrl: contact.user.avatarFileId
            ? getFileUrlById(contact.user.avatarFileId)
            : undefined,
        }
      : null,
    createdAt: contact.createdAt,
  };
}

export default async function contactController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", workspaceMiddleware);

  app.get<{
    Params: { workspaceId: string };
  }>("/api/v1/workspaces/:workspaceId/contacts", async (request, reply) => {
    const userId = (request as any).user!.userId;
    const { workspaceId } = request.params;
    const contacts = await listScopedContacts({ workspaceId, userId });
    return reply.send({
      workspaceContacts: contacts.workspaceContacts.map(mapContactForResponse),
      personalContacts: contacts.personalContacts.map(mapContactForResponse),
    });
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { q?: string; limit?: string };
  }>(
    "/api/v1/workspaces/:workspaceId/contacts/discover",
    async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const result = await discoverContacts({
        workspaceId,
        userId,
        queryText:
          typeof request.query.q === "string" ? request.query.q : undefined,
        limit:
          typeof request.query.limit === "string"
            ? Number.parseInt(request.query.limit, 10)
            : undefined,
      });

      return reply.send({
        actors: result.actors.map((actor) => ({
          ...actor,
          avatarUrl: actor.avatarStoredName
            ? getFileUrl(actor.avatarStoredName)
            : undefined,
        })),
        users: result.users.map((user) => ({
          ...user,
          avatarUrl: user.avatarFileId ? getFileUrlById(user.avatarFileId) : undefined,
        })),
      });
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/contacts/workspace",
    async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const body = contactTargetSchema.parse(request.body);
      const contact = await createWorkspaceContact({
        workspaceId,
        createdBy: userId,
        targetType: body.targetType,
        targetWorkspaceId: body.targetWorkspaceId,
        targetUserId: body.targetUserId,
        targetActorId: body.targetActorId,
      });
      return reply.status(201).send({ contact: mapContactForResponse(contact) });
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/contacts/personal",
    async (request, reply) => {
      const userId = (request as any).user!.userId;
      const { workspaceId } = request.params;
      const body = contactTargetSchema.parse(request.body);
      const contact = await createWorkspaceUserContact({
        workspaceId,
        ownerUserId: userId,
        createdBy: userId,
        targetType: body.targetType,
        targetWorkspaceId: body.targetWorkspaceId,
        targetUserId: body.targetUserId,
        targetActorId: body.targetActorId,
      });
      return reply.status(201).send({ contact: mapContactForResponse(contact) });
    },
  );
}
