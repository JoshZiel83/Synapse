/**
 * Shared schemas + helpers used by the IM controller files.
 *
 * Split out of the monolithic controller.ts so per-transport controller
 * modules (feishu.ts, weixin.ts) can register against the same Fastify
 * instance without duplicating the validation rules.
 */

import {
  TransportAccountCreateInputSchema,
  TransportFeishuAccountCreateInputSchema,
  TransportFeishuAccountUpdateInputSchema,
  TransportAccountInboundActorCreateShape,
  TransportAccountInboundActorUpdateShape,
  TransportAccountOwnerCreateShape,
  TransportAccountOwnerUpdateShape,
  TransportAccountUpdateInputSchema,
  TransportConversationInboundActorUpdateShape,
  TransportExternalUserLinkedMemberInputSchema,
  TransportQqAccountCreateInputSchema,
  TransportQqAccountUpdateInputSchema,
  TransportSessionSettingsInputSchema,
  TransportWecomAccountCreateInputSchema,
  TransportWecomAccountUpdateInputSchema,
  WeixinBindingAutoLinkInputSchema,
  WeixinQrSessionCreateInputSchema,
  WeixinQrVerifyCodeInputSchema,
  validateTransportAccountInboundActorCreateInput,
  validateTransportAccountInboundActorUpdateInput,
  validateTransportAccountOwnerCreateInput,
  validateTransportAccountOwnerUpdateInput,
} from "@synapse/shared/schemas"
import { requireRequestAction } from "../../access/guards.js"
import { refreshTransportRuntimeManager } from "../runtime.js"
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("im.controller")

export const transportAccountOwnerCreateShape = TransportAccountOwnerCreateShape
export const transportAccountOwnerUpdateShape = TransportAccountOwnerUpdateShape
export const transportAccountInboundActorCreateShape =
  TransportAccountInboundActorCreateShape
export const transportAccountInboundActorUpdateShape =
  TransportAccountInboundActorUpdateShape
export const transportConversationInboundActorUpdateShape =
  TransportConversationInboundActorUpdateShape
export const validateTransportAccountOwnerCreate =
  validateTransportAccountOwnerCreateInput
export const validateTransportAccountOwnerUpdate =
  validateTransportAccountOwnerUpdateInput
export const validateTransportAccountInboundActorCreate =
  validateTransportAccountInboundActorCreateInput
export const validateTransportAccountInboundActorUpdate =
  validateTransportAccountInboundActorUpdateInput
export const accountSchema = TransportAccountCreateInputSchema
export const updateAccountSchema = TransportAccountUpdateInputSchema
export const feishuAccountSchema = TransportFeishuAccountCreateInputSchema
export const updateFeishuAccountSchema = TransportFeishuAccountUpdateInputSchema

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
export const wecomAccountSchema = TransportWecomAccountCreateInputSchema
export const updateWecomAccountSchema = TransportWecomAccountUpdateInputSchema

/**
 * QQ Bot account schemas. `configuredUrlDomains` is server-side normalized
 * by the connector (readQqAccountConfig). We accept any string list here
 * — the connector lowercases, strips scheme/path/port, and rejects
 * wildcards / IP literals. UI hint should mirror that contract.
 */
export const qqAccountSchema = TransportQqAccountCreateInputSchema
export const updateQqAccountSchema = TransportQqAccountUpdateInputSchema

export const transportSessionSettingsSchema =
  TransportSessionSettingsInputSchema

export const weixinQrSessionSchema = WeixinQrSessionCreateInputSchema

export const weixinQrVerifyCodeSchema = WeixinQrVerifyCodeInputSchema

export const linkedUserSchema = TransportExternalUserLinkedMemberInputSchema

export const bindingAutoLinkSchema = WeixinBindingAutoLinkInputSchema

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
    log.error(
      { err: error },
      "[im] Failed to refresh transport runtime manager"
    )
  })
}
