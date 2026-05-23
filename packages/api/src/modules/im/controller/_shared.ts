/**
 * Shared schemas + helpers used by the IM controller files.
 *
 * Split out of the monolithic controller.ts so per-transport controller
 * modules (feishu.ts, weixin.ts) can register against the same Fastify
 * instance without duplicating the validation rules.
 */

import { z } from "zod"
import {
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  TRANSPORT_KINDS,
} from "@synapse/shared/constants"
import { requireRequestAction } from "../../access/guards.js"
import { refreshTransportRuntimeManager } from "../runtime.js"

export const transportAccountOwnerCreateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).default("workspace"),
  ownerWorkspaceMemberId: z.string().uuid().nullable().optional(),
}

export const transportAccountOwnerUpdateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).optional(),
  ownerWorkspaceMemberId: z.string().uuid().nullable().optional(),
}

const transportAccountInboundActorModeSchema = z.enum(
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES
)

const transportConversationInboundActorModeSchema = z.enum(
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES
)

export const transportAccountInboundActorCreateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
}

export const transportAccountInboundActorUpdateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
}

export const transportConversationInboundActorUpdateShape = {
  inboundActorMode: transportConversationInboundActorModeSchema.optional(),
  inboundActorId: z.string().uuid().nullable().optional(),
}

export function validateTransportAccountOwnerCreate(
  value: {
    ownerScope: (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number]
    ownerWorkspaceMemberId?: string | null
  },
  ctx: z.RefinementCtx
) {
  if (value.ownerScope === "workspace" && value.ownerWorkspaceMemberId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Workspace-owned transport accounts cannot include ownerWorkspaceMemberId",
      path: ["ownerWorkspaceMemberId"],
    })
  }
  if (
    value.ownerScope === "workspace_member" &&
    !value.ownerWorkspaceMemberId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Workspace-member transport accounts require ownerWorkspaceMemberId",
      path: ["ownerWorkspaceMemberId"],
    })
  }
}

export function validateTransportAccountOwnerUpdate(
  value: {
    ownerScope?: (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number]
    ownerWorkspaceMemberId?: string | null
  },
  ctx: z.RefinementCtx
) {
  if (value.ownerScope === "workspace" && value.ownerWorkspaceMemberId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Workspace-owned transport accounts cannot include ownerWorkspaceMemberId",
      path: ["ownerWorkspaceMemberId"],
    })
  }
}

export function validateTransportAccountInboundActorCreate(
  value: {
    ownerScope: (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number]
    inboundActorMode?: (typeof TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES)[number]
    inboundActorId?: string | null
  },
  ctx: z.RefinementCtx
) {
  if (!value.inboundActorMode && value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inboundActorId requires inboundActorMode=specified_actor",
      path: ["inboundActorId"],
    })
  }
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    })
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
    })
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope !== "workspace_member"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "follow_owner_chief_actor requires a workspace_member-owned account",
      path: ["inboundActorMode"],
    })
  }
}

export function validateTransportAccountInboundActorUpdate(
  value: {
    ownerScope?: (typeof TRANSPORT_ACCOUNT_OWNER_SCOPES)[number]
    inboundActorMode?: (typeof TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES)[number]
    inboundActorId?: string | null
  },
  ctx: z.RefinementCtx
) {
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    })
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
    })
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope === "workspace"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "follow_owner_chief_actor requires a workspace_member-owned account",
      path: ["inboundActorMode"],
    })
  }
}

export function validateTransportConversationInboundActorUpdate(
  value: {
    inboundActorMode?: (typeof TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES)[number]
    inboundActorId?: string | null
  },
  ctx: z.RefinementCtx
) {
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "specified_actor requires inboundActorId",
      path: ["inboundActorId"],
    })
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
    })
  }
}

export const accountSchema = z
  .object({
    transportKind: z.enum(TRANSPORT_KINDS),
    accountKey: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(255),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

export const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    credentials: z.record(z.unknown()).optional(),
    config: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate)

export const feishuAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    appId: z.string().trim().min(1).max(255),
    appSecret: z.string().trim().min(1).max(255),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

export const updateFeishuAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    appId: z.string().trim().min(1).max(255).optional(),
    appSecret: z.string().trim().min(1).max(255).optional(),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate)

export const transportSessionSettingsSchema = z
  .object({
    outboundEnabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    ...transportConversationInboundActorUpdateShape,
  })
  .superRefine(validateTransportConversationInboundActorUpdate)

export const weixinQrSessionSchema = z
  .object({
    displayName: z.string().trim().max(255).optional(),
    baseUrl: z.string().trim().url().optional(),
    botType: z.string().trim().max(32).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

export const linkedUserSchema = z.object({
  workspaceMemberId: z.string().uuid().nullable(),
})

export const bindingAutoLinkSchema = z.object({
  workspaceMemberId: z.string().uuid().nullable(),
})

export async function requireWorkspaceAction(
  request: any,
  reply: any,
  action: "workspace.view" | "workspace.manage",
  errorMessage: string
): Promise<boolean> {
  const { workspaceId } = request.params as { workspaceId: string }
  return requireRequestAction(request, reply, action, workspaceId, errorMessage)
}

export async function refreshTransportRuntimeState(): Promise<void> {
  await refreshTransportRuntimeManager().catch((error) => {
    console.error("[im] Failed to refresh transport runtime manager:", error)
  })
}
