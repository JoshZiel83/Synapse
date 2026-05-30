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
import { WECOM_BASE_WS_URL_MAX_BYTES } from "../connectors/wecom/credentials.js"
import { refreshTransportRuntimeManager } from "../runtime.js"

export const transportAccountOwnerCreateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).default("workspace"),
  ownerWorkspaceMemberId: z.uuid().nullable().optional(),
}

export const transportAccountOwnerUpdateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).optional(),
  ownerWorkspaceMemberId: z.uuid().nullable().optional(),
}

const transportAccountInboundActorModeSchema = z.enum(
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES
)

const transportConversationInboundActorModeSchema = z.enum(
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES
)

export const transportAccountInboundActorCreateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
}

export const transportAccountInboundActorUpdateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
}

export const transportConversationInboundActorUpdateShape = {
  inboundActorMode: transportConversationInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
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
      code: "custom",
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
      code: "custom",
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
      code: "custom",
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
      code: "custom",
      message: "inboundActorId requires inboundActorMode=specified_actor",
      path: ["inboundActorId"],
    })
  }
  if (value.inboundActorMode === "specified_actor" && !value.inboundActorId) {
    ctx.addIssue({
      code: "custom",
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
      code: "custom",
      message: "Only specified_actor can include inboundActorId",
      path: ["inboundActorId"],
    })
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope !== "workspace_member"
  ) {
    ctx.addIssue({
      code: "custom",
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
      code: "custom",
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
      code: "custom",
      message: "Only specified_actor can include inboundActorId",
      path: ["inboundActorId"],
    })
  }
  if (
    value.inboundActorMode === "follow_owner_chief_actor" &&
    value.ownerScope === "workspace"
  ) {
    ctx.addIssue({
      code: "custom",
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
      code: "custom",
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
      code: "custom",
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
    credentials: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
    credentials: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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

// WeCom (Enterprise WeChat) v1 — smart-bot long-connection only. baseWsUrl
// is a deployment-level override that lands in transport_accounts.config,
// kept separate from credentials so it doesn't go through validateCredentials
// (which only sees credentials, per TransportConnector contract).
//
// Both schemas are `.strict()`: Zod's default `strip` would silently drop
// unknown keys (e.g. `accountKey` on update — `updateTransportAccount`
// doesn't accept it), returning a 200 that misled clients into thinking
// the value persisted. Strict mode rejects unknown keys at the API
// boundary so callers get a clear 400 instead of a silent no-op.
//
// `baseWsUrl` is refined to `wss://` (preferred) or `ws://` (for private
// dev gateways) — bare `.url()` would let `http://` / `ftp://` etc.
// through to the SDK, which would fail in a confusing way at connect time.
const WECOM_WS_URL_PATTERN = /^wss?:\/\//i
const wecomBaseWsUrlSchema = z
  .string()
  .trim()
  .url()
  // Use UTF-8 byte length, not `.max(N)`'s code-unit count, so the
  // route-level and connector-level checks accept exactly the same set
  // of inputs. Otherwise a 118-char URL with non-ASCII path segments
  // (~318 bytes) would pass the route schema and then be rejected by
  // the service-level connector validator — inconsistent error surfaces.
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= WECOM_BASE_WS_URL_MAX_BYTES,
    {
      message: `baseWsUrl must be at most ${WECOM_BASE_WS_URL_MAX_BYTES} bytes (UTF-8)`,
    }
  )
  .refine((value) => WECOM_WS_URL_PATTERN.test(value), {
    message: "baseWsUrl must use the wss:// (or ws:// for dev) scheme",
  })

export const wecomAccountSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.literal("long_connection").default("long_connection"),
    botId: z.string().trim().min(1).max(255),
    secret: z.string().trim().min(1).max(255),
    baseWsUrl: wecomBaseWsUrlSchema.optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

export const updateWecomAccountSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(255).optional(),
    // `accountKey` intentionally omitted from the update shape: the
    // shared `updateTransportAccount` service does not currently update
    // `account_key`, so accepting it here would silently no-op. With
    // `z.strictObject` (below), sending `accountKey` now returns a 400
    // instead of a misleading 200.
    connectionMode: z.literal("long_connection").optional(),
    botId: z.string().trim().min(1).max(255).optional(),
    secret: z.string().trim().min(1).max(255).optional(),
    // `null` explicitly clears a previously-saved baseWsUrl (the
    // controller translates that to a `config: {}` write so service
    // doesn't keep the old value). An absent field leaves the existing
    // config untouched. A string value is validated by the same
    // wecomBaseWsUrlSchema as the create path.
    baseWsUrl: wecomBaseWsUrlSchema.nullable().optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate)

/**
 * QQ Bot account schemas. `configuredUrlDomains` is server-side normalized
 * by the connector (readQqAccountConfig). We accept any string list here
 * — the connector lowercases, strips scheme/path/port, and rejects
 * wildcards / IP literals. UI hint should mirror that contract.
 */
export const qqAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    appId: z.string().trim().min(1).max(255),
    clientSecret: z.string().trim().min(1).max(255),
    /**
     * Optional botSecret — used for Ed25519 webhook signing if QQ console
     * exposes it separately from clientSecret. Falls back to clientSecret
     * when absent (see getEd25519Seed in credentials.ts).
     */
    botSecret: z.string().trim().max(255).optional(),
    webhookInboundConfirmed: z.boolean().optional(),
    allowProactiveBestEffort: z.boolean().optional(),
    configuredUrlDomains: z.array(z.string().min(1)).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerCreateShape,
    ...transportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreate)
  .superRefine(validateTransportAccountInboundActorCreate)

export const updateQqAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    appId: z.string().trim().min(1).max(255).optional(),
    clientSecret: z.string().trim().min(1).max(255).optional(),
    botSecret: z.string().trim().max(255).optional(),
    webhookInboundConfirmed: z.boolean().optional(),
    allowProactiveBestEffort: z.boolean().optional(),
    configuredUrlDomains: z.array(z.string().min(1)).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...transportAccountOwnerUpdateShape,
    ...transportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdate)
  .superRefine(validateTransportAccountInboundActorUpdate)

export const transportSessionSettingsSchema = z
  .object({
    outboundEnabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
  workspaceMemberId: z.uuid().nullable(),
})

export const bindingAutoLinkSchema = z.object({
  workspaceMemberId: z.uuid().nullable(),
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
