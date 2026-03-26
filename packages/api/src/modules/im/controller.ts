import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js";
import { requireRequestAction } from "../access/guards.js";
import { getGroup } from "../group/service.js";
import {
  createTransportAccount,
  getConversationTransportBinding,
  listTransportExternalUsers,
  listTransportSessions,
  listTransportAccounts,
  setTransportAddressLinkedUser,
  updateTransportSessionSettings,
  updateTransportAccount,
} from "./service.js";
import { listTransportConnectorCapabilities } from "./connectors/index.js";
import {
  getWeixinQrLoginSession,
  startWeixinQrLoginSession,
} from "./weixin-qr.js";

const accountSchema = z.object({
  transportKind: z.enum(["feishu", "weixin"]),
  accountKey: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(255),
  connectionMode: z.enum(["webhook", "long_connection"]),
  status: z.enum(["active", "disabled", "error"]).optional(),
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(255).optional(),
  connectionMode: z.enum(["webhook", "long_connection"]).optional(),
  status: z.enum(["active", "disabled", "error"]).optional(),
  credentials: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const feishuAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  accountKey: z.string().trim().min(1).max(120).optional(),
  connectionMode: z.enum(["webhook", "long_connection"]),
  appId: z.string().trim().min(1).max(255),
  appSecret: z.string().trim().min(1).max(255),
  verificationToken: z.string().trim().max(255).optional(),
  encryptKey: z.string().trim().max(255).optional(),
  status: z.enum(["active", "disabled", "error"]).optional(),
});

const updateFeishuAccountSchema = feishuAccountSchema.partial().extend({
  displayName: z.string().trim().min(1).max(255).optional(),
});

const transportSessionSettingsSchema = z.object({
  outboundEnabled: z.boolean().optional(),
  defaultTargetParticipantId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

const weixinQrSessionSchema = z.object({
  displayName: z.string().trim().max(255).optional(),
  baseUrl: z.string().trim().url().optional(),
  botType: z.string().trim().max(32).optional(),
});

const linkedUserSchema = z.object({
  userId: z.string().uuid().nullable(),
});

async function requireWorkspaceAction(
  request: any,
  reply: any,
  action: "workspace.view" | "workspace.manage",
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  return requireRequestAction(request, reply, action, workspaceId, errorMessage);
}

async function requireConversationAction(
  request: any,
  reply: any,
  action: "conversation.view" | "conversation.manage",
  errorMessage: string,
) {
  const { workspaceId, groupId } = request.params as {
    workspaceId: string;
    groupId: string;
  };
  const group = await getGroup(groupId);
  if (!group || group.workspace_id !== workspaceId) {
    reply.status(404).send({ error: "Group not found" });
    return null;
  }

  const allowed = await requireRequestAction(
    request,
    reply,
    action,
    groupId,
    errorMessage,
  );
  if (!allowed) return null;
  return group;
}

export default async function imController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware);
  app.addHook("onRequest", workspaceMiddleware);

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/connectors",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM connectors in this workspace",
      );
      if (!allowed) return;
      return reply.send({
        connectors: listTransportConnectorCapabilities(),
      });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/accounts",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const accounts = await listTransportAccounts(workspaceId);
      return reply.send({ accounts });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/sessions",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM sessions in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const sessions = await listTransportSessions(workspaceId);
      return reply.send({ sessions });
    },
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: { transportAccountId?: string };
  }>(
    "/api/v1/workspaces/:workspaceId/im/external-users",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to view IM external users in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const externalUsers = await listTransportExternalUsers({
        workspaceId,
        transportAccountId: request.query.transportAccountId,
      });
      return reply.send({ externalUsers });
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/feishu",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const body = feishuAccountSchema.parse(request.body);
      const credentials: Record<string, unknown> = {
        appId: body.appId,
        appSecret: body.appSecret,
      };
      if (body.connectionMode === "webhook") {
        if (body.verificationToken) {
          credentials.verificationToken = body.verificationToken;
        }
        if (body.encryptKey) {
          credentials.encryptKey = body.encryptKey;
        }
      }

      const account = await createTransportAccount({
        workspaceId,
        transportKind: "feishu",
        accountKey: body.accountKey || body.appId,
        displayName: body.displayName,
        connectionMode: body.connectionMode,
        status: body.status,
        credentials,
      });
      return reply.status(201).send({ account });
    },
  );

  app.put<{
    Params: { workspaceId: string; sessionId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/im/sessions/:sessionId/settings",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM sessions in this workspace",
      );
      if (!allowed) return;

      const { workspaceId, sessionId } = request.params;
      const body = transportSessionSettingsSchema.parse(request.body);
      const session = await updateTransportSessionSettings({
        workspaceId,
        transportEndpointId: sessionId,
        outboundEnabled: body.outboundEnabled,
        defaultTargetParticipantId:
          body.defaultTargetParticipantId === null
            ? null
            : body.defaultTargetParticipantId,
        metadata: body.metadata,
      });
      return reply.send({ session });
    },
  );

  app.put<{
    Params: { workspaceId: string; addressId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/im/external-users/:addressId/workspace-user",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM external users in this workspace",
      );
      if (!allowed) return;

      const { workspaceId, addressId } = request.params;
      const body = linkedUserSchema.parse(request.body);
      await setTransportAddressLinkedUser({
        workspaceId,
        transportAddressId: addressId,
        userId: body.userId,
      });

      const externalUsers = await listTransportExternalUsers({ workspaceId });
      const externalUser = externalUsers.find((entry) => entry.id === addressId);
      if (!externalUser) {
        return reply.status(404).send({ error: "Transport external user not found" });
      }
      return reply.send({ externalUser });
    },
  );

  app.put<{
    Params: { workspaceId: string; accountId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/feishu/:accountId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId, accountId } = request.params;
      const body = updateFeishuAccountSchema.parse(request.body);
      const credentials =
        body.appId || body.appSecret || body.verificationToken || body.encryptKey
          ? {
              ...(body.appId ? { appId: body.appId } : {}),
              ...(body.appSecret ? { appSecret: body.appSecret } : {}),
              ...(body.verificationToken
                ? { verificationToken: body.verificationToken }
                : {}),
              ...(body.encryptKey ? { encryptKey: body.encryptKey } : {}),
            }
          : undefined;

      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        displayName: body.displayName,
        connectionMode: body.connectionMode,
        status: body.status,
        credentials,
      });
      return reply.send({ account });
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const body = weixinQrSessionSchema.parse(request.body);
      const session = await startWeixinQrLoginSession({
        workspaceId,
        displayName: body.displayName,
        baseUrl: body.baseUrl,
        botType: body.botType,
      });
      return reply.status(201).send({ session });
    },
  );

  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/weixin/qr/:sessionId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const session = await getWeixinQrLoginSession({
        workspaceId: request.params.workspaceId,
        sessionId: request.params.sessionId,
      });
      if (!session) {
        return reply.status(404).send({ error: "Weixin QR session not found" });
      }
      return reply.send({ session });
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/accounts",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const body = accountSchema.parse(request.body);
      const account = await createTransportAccount({
        workspaceId,
        transportKind: body.transportKind,
        accountKey: body.accountKey,
        displayName: body.displayName,
        connectionMode: body.connectionMode,
        status: body.status,
        credentials: body.credentials,
        config: body.config,
        metadata: body.metadata,
      });
      return reply.status(201).send({ account });
    },
  );

  app.put<{
    Params: { workspaceId: string; accountId: string };
    Body: unknown;
  }>(
    "/api/v1/workspaces/:workspaceId/im/accounts/:accountId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.manage",
        "Not allowed to manage IM accounts in this workspace",
      );
      if (!allowed) return;

      const { workspaceId, accountId } = request.params;
      const body = updateAccountSchema.parse(request.body);
      const account = await updateTransportAccount({
        workspaceId,
        accountId,
        displayName: body.displayName,
        connectionMode: body.connectionMode,
        status: body.status,
        credentials: body.credentials,
        config: body.config,
        metadata: body.metadata,
      });
      return reply.send({ account });
    },
  );

  app.get<{ Params: { workspaceId: string; groupId: string } }>(
    "/api/v1/workspaces/:workspaceId/chat/groups/:groupId/transport-binding",
    async (request, reply) => {
      const group = await requireConversationAction(
        request,
        reply,
        "conversation.view",
        "Not allowed to view this conversation transport binding",
      );
      if (!group) return;

      const binding = await getConversationTransportBinding({
        workspaceId: group.workspace_id,
        conversationId: group.id,
      });
      return reply.send({ binding });
    },
  );
}
