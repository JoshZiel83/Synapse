import { z } from "zod"

/**
 * App-facing contracts for the IM module's APP routes (master plan §5.3).
 *
 * Every IM REST route here is workspace-scoped + authenticated, so its
 * response value is wrapped through `appRoute` → `sendData` → `{ data: ... }`.
 * To keep the public method shapes of the web client stable, each handler
 * keeps returning its existing named-key object (`{ account }`, `{ accounts }`,
 * `{ session }`, `{ binding }`, …); the consumer then unwraps `res.data` to
 * recover that same object.
 *
 * The interior summary shapes (TransportAccountSummary, TransportSessionSummary,
 * WeixinQrLoginSessionSummary, DingtalkDeviceFlow* …) are already strongly typed
 * interfaces the service/connector layers own. The boundary only needs to
 * round-trip them unchanged, not re-validate their interior, so they are modeled
 * here as `z.unknown()` / open records — matching the relationship/remote-agents
 * schema convention in this package.
 */

/** GET /im/connectors → `{ connectors: TransportConnectorCapability[] }`. */
export const TransportConnectorsResponseSchema = z.object({
  connectors: z.array(z.unknown()),
})
export type TransportConnectorsResponseSchemaType = z.infer<
  typeof TransportConnectorsResponseSchema
>

/** GET /im/accounts → `{ accounts: TransportAccountSummary[] }`. */
export const TransportAccountsResponseSchema = z.object({
  accounts: z.array(z.unknown()),
})
export type TransportAccountsResponseSchemaType = z.infer<
  typeof TransportAccountsResponseSchema
>

/** GET /im/sessions → `{ sessions: TransportSessionSummary[] }`. */
export const TransportSessionsResponseSchema = z.object({
  sessions: z.array(z.unknown()),
})
export type TransportSessionsResponseSchemaType = z.infer<
  typeof TransportSessionsResponseSchema
>

/** GET /im/external-users → `{ externalUsers: TransportExternalUserSummary[] }`. */
export const TransportExternalUsersResponseSchema = z.object({
  externalUsers: z.array(z.unknown()),
})
export type TransportExternalUsersResponseSchemaType = z.infer<
  typeof TransportExternalUsersResponseSchema
>

/**
 * POST/PUT account create/update across every transport kind (generic +
 * feishu/wecom/qq/dingtalk-manual) → `{ account: TransportAccountSummary }`.
 */
export const TransportAccountResponseSchema = z.object({
  account: z.unknown(),
})
export type TransportAccountResponseSchemaType = z.infer<
  typeof TransportAccountResponseSchema
>

/**
 * PUT /im/sessions/:sessionId/settings → `{ session: TransportSessionSummary }`.
 * The service may return null when the session no longer exists; the boundary
 * just round-trips it.
 */
export const TransportSessionResponseSchema = z.object({
  session: z.unknown(),
})
export type TransportSessionResponseSchemaType = z.infer<
  typeof TransportSessionResponseSchema
>

/**
 * PUT /im/external-users/:addressId/workspace-member →
 * `{ address: TransportExternalUserSummary }`.
 */
export const TransportAddressResponseSchema = z.object({
  address: z.unknown(),
})
export type TransportAddressResponseSchemaType = z.infer<
  typeof TransportAddressResponseSchema
>

/**
 * GET /im/me/weixin-binding/candidates. The handler returns the workspace
 * member list directly under `{ members }`; the web client preserves its
 * existing `{ data: [...] }` public shape by re-wrapping after the unwrap.
 */
export const WeixinBindingCandidatesResponseSchema = z.object({
  members: z.array(z.unknown()),
})
export type WeixinBindingCandidatesResponseSchemaType = z.infer<
  typeof WeixinBindingCandidatesResponseSchema
>

/**
 * POST/GET weixin QR session (workspace-managed bot + current-user binding)
 * → `{ session: WeixinQrLoginSessionSummary }`.
 */
export const WeixinQrSessionResponseSchema = z.object({
  session: z.unknown(),
})
export type WeixinQrSessionResponseSchemaType = z.infer<
  typeof WeixinQrSessionResponseSchema
>

/**
 * GET /im/me/weixin-binding → `{ binding: CurrentUserWeixinBindingSummary | null }`
 * and POST link / PUT auto-link → `{ binding: CurrentUserWeixinBindingSummary }`.
 */
export const WeixinBindingResponseSchema = z.object({
  binding: z.unknown(),
})
export type WeixinBindingResponseSchemaType = z.infer<
  typeof WeixinBindingResponseSchema
>

/**
 * POST /im/accounts/dingtalk/device-registration/start →
 * `DingtalkDeviceFlowStartResponse` (a discriminated union on
 * `providerStartFailed`). The route never returns a 5xx for provider
 * failures — both success and provider-failure variants are 200 bodies, so
 * the whole union is the returned value (no named-key wrapper).
 */
export const DingtalkDeviceFlowStartResponseSchema = z.union([
  z.object({
    providerStartFailed: z.literal(false),
    session: z.unknown(),
  }),
  z.object({
    providerStartFailed: z.literal(true),
    error: z.string(),
  }),
])
export type DingtalkDeviceFlowStartResponseSchemaType = z.infer<
  typeof DingtalkDeviceFlowStartResponseSchema
>

/**
 * GET /im/accounts/dingtalk/device-registration/:sessionId (success body) →
 * `{ session: DingtalkDeviceFlowSessionSummary }`. Non-200 outcomes (404/502)
 * are sent by the handler directly as bare error bodies before returning, so
 * `appRoute` no-ops on them; this schema only covers the wrapped 200 body.
 */
export const DingtalkDeviceFlowPollResponseSchema = z.object({
  session: z.unknown(),
})
export type DingtalkDeviceFlowPollResponseSchemaType = z.infer<
  typeof DingtalkDeviceFlowPollResponseSchema
>
