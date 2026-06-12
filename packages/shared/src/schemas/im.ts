import { z } from "zod"
import {
  TRANSPORT_KINDS,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_ENDPOINT_TYPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

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
 * round-6 P1-4: the interior summary shapes (TransportAccountSummary,
 * TransportSessionSummary, WeixinQrLoginSessionSummary,
 * DingtalkDeviceFlowSessionSummary …) are now modeled as real Zod schemas
 * here, matching exactly what the service-layer normalizers emit
 * (im/service/repo.ts normalize*Row, weixin qr-login, dingtalk persist). This
 * is the single source for these views; the hand-written interfaces in
 * types/index.ts are derived from these schemas (z.infer). Open JSON columns
 * (credentials / config / metadata) stay `z.record(...)` passthrough; instants
 * are canonical ISO strings (IsoInstantStringSchema catches a raw-Date leak).
 */

// ─────────────────────────── interior summary shapes ─────────────────────────

const transportKindSchema = z.enum(TRANSPORT_KINDS)
const jsonRecordSchema = z.record(z.string(), z.unknown())

/** Connector capability descriptor (connectors registry → metadata API). */
export const TransportConnectorCapabilitySchema = z.object({
  transportKind: transportKindSchema,
  supportedConnectionModes: z.array(z.enum(TRANSPORT_CONNECTION_MODES)),
  supportedEndpointTypes: z.array(z.enum(TRANSPORT_ENDPOINT_TYPES)),
  supportsDirectMessages: z.boolean(),
  supportsGroupMessages: z.boolean(),
  displayName: z.string(),
  iconAssetPath: z.string(),
  showsBaseUrlConfig: z.boolean().optional(),
})
export type TransportConnectorCapabilitySchemaType = z.infer<
  typeof TransportConnectorCapabilitySchema
>

/** A transport account row, normalized (im/service/repo normalizeAccountRow). */
export const TransportAccountSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  transportKind: transportKindSchema,
  accountKey: z.string(),
  displayName: z.string(),
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES),
  ownerWorkspaceMemberId: z.string().optional(),
  inboundActorMode: z.enum(TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES),
  inboundActorId: z.string().optional(),
  connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
  status: z.enum(TRANSPORT_ACCOUNT_STATUSES),
  credentials: jsonRecordSchema.optional(),
  config: jsonRecordSchema,
  metadata: jsonRecordSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type TransportAccountSummarySchemaType = z.infer<
  typeof TransportAccountSummarySchema
>

/** A transport endpoint row, normalized (normalizeEndpointRow). */
export const TransportEndpointSummarySchema = z.object({
  id: z.string(),
  transportAccountId: z.string(),
  transportKind: transportKindSchema,
  endpointType: z.enum(TRANSPORT_ENDPOINT_TYPES),
  externalId: z.string(),
  parentExternalId: z.string().optional(),
  displayName: z.string().optional(),
  metadata: jsonRecordSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type TransportEndpointSummarySchemaType = z.infer<
  typeof TransportEndpointSummarySchema
>

/** A transport session row, normalized (normalizeTransportSessionRow). */
export const TransportSessionSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  transportKind: transportKindSchema,
  outboundEnabled: z.boolean(),
  inboundActorMode: z.enum(TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES),
  inboundActorId: z.string().optional(),
  metadata: jsonRecordSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  conversationId: z.string().optional(),
  conversationTitle: z.string().optional(),
  lastInboundAt: IsoInstantStringSchema.optional(),
  lastOutboundAt: IsoInstantStringSchema.optional(),
  account: TransportAccountSummarySchema,
  endpoint: TransportEndpointSummarySchema,
})
export type TransportSessionSummarySchemaType = z.infer<
  typeof TransportSessionSummarySchema
>

/** A reference to a conversation/endpoint an external user appears in. */
export const TransportExternalUserSessionRefSchema = z.object({
  conversationId: z.string().optional(),
  conversationTitle: z.string().optional(),
  endpointId: z.string().optional(),
  endpointType: z.enum(TRANSPORT_ENDPOINT_TYPES).optional(),
  endpointExternalId: z.string().optional(),
  endpointDisplayName: z.string().optional(),
})

/** An external (platform) user row, normalized (normalizeExternalUserRow). */
export const TransportExternalUserSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  transportAccountId: z.string(),
  transportKind: transportKindSchema,
  accountDisplayName: z.string(),
  externalId: z.string(),
  displayName: z.string().optional(),
  linkedWorkspaceMemberId: z.string().optional(),
  linkedWorkspaceMemberName: z.string().optional(),
  metadata: jsonRecordSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  lastSeenAt: IsoInstantStringSchema.optional(),
  sessions: z.array(TransportExternalUserSessionRefSchema),
})
export type TransportExternalUserSummarySchemaType = z.infer<
  typeof TransportExternalUserSummarySchema
>

/** Weixin QR login session summary (weixin/qr-login.ts). */
export const WeixinQrLoginSessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["waiting", "scanned", "confirmed", "expired", "error"]),
  message: z.string(),
  qrCodeUrl: z.string().optional(),
  baseUrl: z.string().optional(),
  botId: z.string().optional(),
  scannerUserId: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  expiresAt: IsoInstantStringSchema,
  transportAccount: TransportAccountSummarySchema.optional(),
})
export type WeixinQrLoginSessionSummarySchemaType = z.infer<
  typeof WeixinQrLoginSessionSummarySchema
>

/** Current-user weixin binding summary (GET /im/me/weixin-binding). */
export const CurrentUserWeixinBindingSummarySchema = z.object({
  account: TransportAccountSummarySchema,
  scannerUserId: z.string().optional(),
  externalUser: TransportExternalUserSummarySchema.optional(),
  pendingAutoLinkWorkspaceMemberId: z.string().optional(),
  pendingAutoLinkWorkspaceMemberName: z.string().optional(),
})
export type CurrentUserWeixinBindingSummarySchemaType = z.infer<
  typeof CurrentUserWeixinBindingSummarySchema
>

/** DingTalk device-flow registration session summary (dingtalk/persist.ts). */
export const DingtalkDeviceFlowSessionSummarySchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  status: z.enum(["waiting", "success", "fail", "expired"]),
  message: z.string().optional(),
  verificationUriComplete: z.string(),
  verificationUri: z.string().optional(),
  userCode: z.string().optional(),
  expiresInSeconds: z.number(),
  intervalSeconds: z.number(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  expiresAt: IsoInstantStringSchema,
  transportAccount: TransportAccountSummarySchema.optional(),
})
export type DingtalkDeviceFlowSessionSummarySchemaType = z.infer<
  typeof DingtalkDeviceFlowSessionSummarySchema
>

// ─────────────────────────── response envelopes ──────────────────────────────

/** GET /im/connectors → `{ connectors: TransportConnectorCapability[] }`. */
export const TransportConnectorsResponseSchema = z.object({
  connectors: z.array(TransportConnectorCapabilitySchema),
})
export type TransportConnectorsResponseSchemaType = z.infer<
  typeof TransportConnectorsResponseSchema
>

/** GET /im/accounts → `{ accounts: TransportAccountSummary[] }`. */
export const TransportAccountsResponseSchema = z.object({
  accounts: z.array(TransportAccountSummarySchema),
})
export type TransportAccountsResponseSchemaType = z.infer<
  typeof TransportAccountsResponseSchema
>

/** GET /im/sessions → `{ sessions: TransportSessionSummary[] }`. */
export const TransportSessionsResponseSchema = z.object({
  sessions: z.array(TransportSessionSummarySchema),
})
export type TransportSessionsResponseSchemaType = z.infer<
  typeof TransportSessionsResponseSchema
>

/** GET /im/external-users → `{ externalUsers: TransportExternalUserSummary[] }`. */
export const TransportExternalUsersResponseSchema = z.object({
  externalUsers: z.array(TransportExternalUserSummarySchema),
})
export type TransportExternalUsersResponseSchemaType = z.infer<
  typeof TransportExternalUsersResponseSchema
>

/**
 * POST/PUT account create/update across every transport kind (generic +
 * feishu/wecom/qq/dingtalk-manual) → `{ account: TransportAccountSummary }`.
 */
export const TransportAccountResponseSchema = z.object({
  account: TransportAccountSummarySchema,
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
  session: TransportSessionSummarySchema.nullable(),
})
export type TransportSessionResponseSchemaType = z.infer<
  typeof TransportSessionResponseSchema
>

/**
 * PUT /im/external-users/:addressId/workspace-member →
 * `{ address: <transport_addresses row> }`. NOTE: unlike the GET
 * /im/external-users list (which goes through normalizeTransportExternalUserRow
 * → TransportExternalUserSummary), this write path returns the raw
 * transport_addresses row (returningAll) with Date instants and the addressType
 * discriminator — a different, repo-shaped value. Modeling it as the summary
 * schema would be wrong, so it stays an open passthrough here; tightening this
 * route to emit a normalized summary is tracked under P1-7 (repo→domain) /
 * P1-9 (Date serialization).
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
 * Each member is the workspace module's presented member row (presentMemberRow
 * + user fields) — a cross-module presentation shape owned by the workspace
 * presenter, so it stays an open record the boundary round-trips unchanged.
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
  session: WeixinQrLoginSessionSummarySchema,
})
export type WeixinQrSessionResponseSchemaType = z.infer<
  typeof WeixinQrSessionResponseSchema
>

/**
 * GET /im/me/weixin-binding → `{ binding: CurrentUserWeixinBindingSummary | null }`
 * and POST link / PUT auto-link → `{ binding: CurrentUserWeixinBindingSummary }`.
 */
export const WeixinBindingResponseSchema = z.object({
  binding: CurrentUserWeixinBindingSummarySchema.nullable(),
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
    session: DingtalkDeviceFlowSessionSummarySchema,
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
  session: DingtalkDeviceFlowSessionSummarySchema,
})
export type DingtalkDeviceFlowPollResponseSchemaType = z.infer<
  typeof DingtalkDeviceFlowPollResponseSchema
>
