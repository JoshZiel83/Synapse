import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware } from "../../infrastructure/middleware/auth.js";
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js";
import { requireRequestAction } from "../access/guards.js";
import { listMembers } from "../workspace/service.js";
import {
  createTransportAccount,
  getCurrentUserWeixinBinding,
  listTransportExternalUsers,
  listTransportSessions,
  listTransportAccounts,
  setCurrentUserWeixinBindingAutoLink,
  linkCurrentUserWeixinBinding,
  setTransportAddressLinkedUser,
  updateTransportSessionSettings,
  updateTransportAccount,
} from "./service.js";
import { listTransportConnectorCapabilities } from "./connectors/index.js";
import {
  getWeixinQrLoginSession,
  getWeixinQrLoginSessionOwner,
  startWeixinQrLoginSession,
} from "./weixin-qr.js";
import { refreshTransportRuntimeManager } from "./runtime.js";

const transportAccountOwnerCreateShape = {
  ownerScope: z.enum(["workspace", "workspace_user"]).default("workspace"),
  ownerUserId: z.string().uuid().nullable().optional(),
};

const transportAccountOwnerUpdateShape = {
  ownerScope: z.enum(["workspace", "workspace_user"]).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
};

const transportAccountInboundActorModeSchema = z.enum([
  "none",
  "specified_actor",
  "follow_owner_chief_actor",
]);

const transportConversationInboundActorModeSchema = z.enum([
  "inherit_account",
  "none",
  "specified_actor",
]);

const transportAccountInboundActorCreateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
};

const transportAccountInboundActorUpdateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
};

const transportConversationInboundActorUpdateShape = {
  inboundActorMode: transportConversationInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
};

function validateTransportAccountOwnerCreate(
  value: {
    ownerScope: "workspace" | "workspace_user";
    ownerUserId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.ownerScope === "workspace" && value.ownerUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace-owned transport accounts cannot include ownerUserId",
      path: ["ownerUserId"],
    });
  }
  if (value.ownerScope === "workspace_user" && !value.ownerUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace-user transport accounts require ownerUserId",
      path: ["ownerUserId"],
    });
  }
}

function validateTransportAccountOwnerUpdate(
  value: {
    ownerScope?: "workspace" | "workspace_user";
    ownerUserId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.ownerScope === "workspace" && value.ownerUserId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace-owned transport accounts cannot include ownerUserId",
      path: ["ownerUserId"],
    });
  }
}

function validateTransportAccountInboundActorCreate(
  value: {
    ownerScope: "workspace" | "workspace_user";
    inboundActorMode?: "none" | "specified_actor" | "follow_owner_chief_actor";
    inboundActorId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (!value.inboundActorMode && value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inboundActorId requires inboundActorMode=specified_actor",
      path: ["inboundActorId"],
    });
  }
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    });
  }
  if (
    value.inboundActorMode &&
    value.inboundActorMode !== "specified_actor" &&
    value.inboundActorId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only specified_actor can include inboundActorId",
      path: ["inboundActorId"],
    });
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope !== "workspace_user"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "follow_owner_chief_actor requires a workspace_user-owned account",
      path: ["inboundActorMode"],
    });
  }
}

function validateTransportAccountInboundActorUpdate(
  value: {
    ownerScope?: "workspace" | "workspace_user";
    inboundActorMode?: "none" | "specified_actor" | "follow_owner_chief_actor";
    inboundActorId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    });
  }
  if (
    value.inboundActorMode &&
    value.inboundActorMode !== "specified_actor" &&
    value.inboundActorId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only specified_actor can include inboundActorId",
      path: ["inboundActorId"],
    });
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope === "workspace"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "follow_owner_chief_actor requires a workspace_user-owned account",
      path: ["inboundActorMode"],
    });
  }
}

function validateTransportConversationInboundActorUpdate(
  value: {
    inboundActorMode?: "inherit_account" | "none" | "specified_actor";
    inboundActorId?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    });
  }
  if (
    value.inboundActorMode &&
    value.inboundActorMode !== "specified_actor" &&
    value.inboundActorId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Only specified_actor can include inboundActorId",
      path: ["inboundActorId"],
    });
  }
}

const accountSchema = z
  .object({
    transportKind: z.enum(["feishu", "weixin"]),
    accountKey: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(255),
    connectionMode: z.enum(["webhook", "long_connection"]),
    status: z.enum(["active", "disabled", "error"]).optional(),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate);

const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    connectionMode: z.enum(["webhook", "long_connection"]).optional(),
    status: z.enum(["active", "disabled", "error"]).optional(),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate);

const feishuAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(["webhook", "long_connection"]),
    appId: z.string().trim().min(1).max(255),
    appSecret: z.string().trim().min(1).max(255),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    status: z.enum(["active", "disabled", "error"]).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate);

const updateFeishuAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(["webhook", "long_connection"]).optional(),
    appId: z.string().trim().min(1).max(255).optional(),
    appSecret: z.string().trim().min(1).max(255).optional(),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    status: z.enum(["active", "disabled", "error"]).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate);

const transportSessionSettingsSchema = z
  .object({
    outboundEnabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportConversationInboundActorUpdateShape,
  })
  .superRefine(validateTransportConversationInboundActorUpdate);

const weixinQrSessionSchema = z
  .object({
    displayName: z.string().trim().max(255).optional(),
    baseUrl: z.string().trim().url().optional(),
    botType: z.string().trim().max(32).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate);

const linkedUserSchema = z.object({
  userId: z.string().uuid().nullable(),
});

const bindingAutoLinkSchema = z.object({
  userId: z.string().uuid().nullable(),
});

async function requireWorkspaceAction(
  request: any,
  reply: any,
  action: "workspace.view" | "workspace.manage",
  errorMessage: string,
) {
  const { workspaceId } = request.params as { workspaceId: string };
  return requireRequestAction(
    request,
    reply,
    action,
    workspaceId,
    errorMessage,
  );
}

async function refreshTransportRuntimeState() {
  await refreshTransportRuntimeManager().catch((error) => {
    console.error("[im] Failed to refresh transport runtime manager:", error);
  });
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

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace",
      );
      if (!allowed) return;

      const binding = await getCurrentUserWeixinBinding({
        workspaceId: request.params.workspaceId,
        userId: (request as any).user!.userId,
      });
      return reply.send({ binding });
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/candidates",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace",
      );
      if (!allowed) return;

      const members = await listMembers(request.params.workspaceId);
      return reply.send({ data: members });
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to bind WeChat in this workspace",
      );
      if (!allowed) return;

      const { workspaceId } = request.params;
      const userId = (request as any).user!.userId as string;
      const existing = await getCurrentUserWeixinBinding({
        workspaceId,
        userId,
      });
      if (existing) {
        return reply.status(409).send({ error: "WeChat already bound" });
      }

      const session = await startWeixinQrLoginSession({
        workspaceId,
        ownerScope: "workspace_user",
        ownerUserId: userId,
        inboundActorMode: "follow_owner_chief_actor",
      });
      return reply.status(201).send({ session });
    },
  );

  app.get<{
    Params: { workspaceId: string; sessionId: string };
  }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/qr/:sessionId",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to access WeChat binding in this workspace",
      );
      if (!allowed) return;

      const { workspaceId, sessionId } = request.params;
      const userId = (request as any).user!.userId as string;
      const owner = getWeixinQrLoginSessionOwner({ workspaceId, sessionId });
      if (
        !owner ||
        owner.ownerScope !== "workspace_user" ||
        owner.ownerUserId !== userId
      ) {
        return reply.status(404).send({ error: "Weixin QR session not found" });
      }

      const session = await getWeixinQrLoginSession({
        workspaceId,
        sessionId,
      });
      if (!session) {
        return reply.status(404).send({ error: "Weixin QR session not found" });
      }
      return reply.send({ session });
    },
  );

  app.post<{ Params: { workspaceId: string } }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/link",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to link WeChat in this workspace",
      );
      if (!allowed) return;

      try {
        const binding = await linkCurrentUserWeixinBinding({
          workspaceId: request.params.workspaceId,
          userId: (request as any).user!.userId,
        });
        return reply.send({ binding });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to link WeChat";
        if (message === "WeChat binding not found") {
          return reply.status(404).send({ error: message });
        }
        if (message === "WeChat user is already linked to another workspace member") {
          return reply.status(409).send({ error: message });
        }
        return reply.status(400).send({ error: message });
      }
    },
  );

  app.put<{ Params: { workspaceId: string }; Body: unknown }>(
    "/api/v1/workspaces/:workspaceId/im/me/weixin-binding/auto-link",
    async (request, reply) => {
      const allowed = await requireWorkspaceAction(
        request,
        reply,
        "workspace.view",
        "Not allowed to configure WeChat binding in this workspace",
      );
      if (!allowed) return;

      try {
        const body = bindingAutoLinkSchema.parse(request.body);
        const binding = await setCurrentUserWeixinBindingAutoLink({
          workspaceId: request.params.workspaceId,
          userId: (request as any).user!.userId,
          targetUserId: body.userId,
        });
        return reply.send({ binding });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to configure WeChat binding";
        if (message === "WeChat binding not found") {
          return reply.status(404).send({ error: message });
        }
        if (message === "Workspace user not found") {
          return reply.status(404).send({ error: message });
        }
        return reply.status(400).send({ error: message });
      }
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
        ownerScope: body.ownerScope,
        ownerUserId: body.ownerUserId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
      });
      await refreshTransportRuntimeState();
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
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
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
      const externalUser = externalUsers.find(
        (entry) => entry.id === addressId,
      );
      if (!externalUser) {
        return reply
          .status(404)
          .send({ error: "Transport external user not found" });
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
        body.appId ||
        body.appSecret ||
        body.verificationToken ||
        body.encryptKey
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
        ownerScope: body.ownerScope,
        ownerUserId: body.ownerUserId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
        credentials,
      });
      await refreshTransportRuntimeState();
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
        ownerScope: body.ownerScope,
        ownerUserId: body.ownerUserId ?? null,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
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
        ownerScope: body.ownerScope,
        ownerUserId: body.ownerUserId ?? null,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
        credentials: body.credentials,
        config: body.config,
        metadata: body.metadata,
      });
      await refreshTransportRuntimeState();
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
        ownerScope: body.ownerScope,
        ownerUserId: body.ownerUserId,
        connectionMode: body.connectionMode,
        status: body.status,
        inboundActorMode: body.inboundActorMode,
        inboundActorId: body.inboundActorId === null ? null : body.inboundActorId,
        credentials: body.credentials,
        config: body.config,
        metadata: body.metadata,
      });
      await refreshTransportRuntimeState();
      return reply.send({ account });
    },
  );
}
