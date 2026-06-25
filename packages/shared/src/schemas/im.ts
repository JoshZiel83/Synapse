import { z } from "zod"
import {
  TRANSPORT_KINDS,
  TRANSPORT_CONNECTION_MODES,
  TRANSPORT_ENDPOINT_TYPES,
  TRANSPORT_ACCOUNT_STATUSES,
  TRANSPORT_ACCOUNT_OWNER_SCOPES,
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES,
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES,
  WEIXIN_QR_LOGIN_STATUSES,
  DINGTALK_DEVICE_FLOW_STATUSES,
  WECOM_BASE_WS_URL_MAX_BYTES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"
import { WorkspaceMemberViewSchema } from "./workspace.js"

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
  status: z.enum(WEIXIN_QR_LOGIN_STATUSES),
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
  status: z.enum(DINGTALK_DEVICE_FLOW_STATUSES),
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

/** PUT /im/external-users/:addressId/workspace-member → `{ externalUser }`. */
export const TransportExternalUserResponseSchema = z.object({
  externalUser: TransportExternalUserSummarySchema,
})
export type TransportExternalUserResponseSchemaType = z.infer<
  typeof TransportExternalUserResponseSchema
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

export const TransportAddressResponseSchema =
  TransportExternalUserResponseSchema
export type TransportAddressResponseSchemaType =
  TransportExternalUserResponseSchemaType

/**
 * GET /im/me/weixin-binding/candidates. The handler returns the workspace
 * member list directly under `{ members }`. Each member is the workspace
 * module's presented member row (presentMemberRow + user fields).
 */
export const WeixinBindingCandidatesResponseSchema = z.object({
  members: z.array(WorkspaceMemberViewSchema),
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

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// Generic IM app route request bodies. Per-transport credential bodies are
// intentionally migrated in separate slices because some compose connector-
// specific validation.

export const TransportAccountOwnerCreateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).default("workspace"),
  ownerWorkspaceMemberId: z.uuid().nullable().optional(),
}

export const TransportAccountOwnerUpdateShape = {
  ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).optional(),
  ownerWorkspaceMemberId: z.uuid().nullable().optional(),
}

const transportAccountInboundActorModeSchema = z.enum(
  TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES
)

const transportConversationInboundActorModeSchema = z.enum(
  TRANSPORT_CONVERSATION_INBOUND_ACTOR_MODES
)

export const TransportAccountInboundActorCreateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
}

export const TransportAccountInboundActorUpdateShape = {
  inboundActorMode: transportAccountInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
}

export const TransportConversationInboundActorUpdateShape = {
  inboundActorMode: transportConversationInboundActorModeSchema.optional(),
  inboundActorId: z.uuid().nullable().optional(),
}

export function validateTransportAccountOwnerCreateInput(
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

export function validateTransportAccountOwnerUpdateInput(
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

export function validateTransportAccountInboundActorCreateInput(
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

export function validateTransportAccountInboundActorUpdateInput(
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

export function validateTransportConversationInboundActorUpdateInput(
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

export const TransportAccountCreateInputSchema = z
  .strictObject({
    transportKind: z.enum(TRANSPORT_KINDS),
    accountKey: z.string().trim().min(1).max(120),
    displayName: z.string().trim().min(1).max(255),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    credentials: jsonRecordSchema.optional(),
    config: jsonRecordSchema.optional(),
    metadata: jsonRecordSchema.optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type TransportAccountCreateInput = z.input<
  typeof TransportAccountCreateInputSchema
>

export const TransportAccountUpdateInputSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(255).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    credentials: jsonRecordSchema.optional(),
    config: jsonRecordSchema.optional(),
    metadata: jsonRecordSchema.optional(),
    ...TransportAccountOwnerUpdateShape,
    ...TransportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdateInput)
  .superRefine(validateTransportAccountInboundActorUpdateInput)
export type TransportAccountUpdateInput = z.input<
  typeof TransportAccountUpdateInputSchema
>

export const TransportSessionSettingsInputSchema = z
  .strictObject({
    outboundEnabled: z.boolean().optional(),
    metadata: jsonRecordSchema.optional(),
    ...TransportConversationInboundActorUpdateShape,
  })
  .superRefine(validateTransportConversationInboundActorUpdateInput)
export type TransportSessionSettingsInput = z.input<
  typeof TransportSessionSettingsInputSchema
>

export const TransportExternalUserLinkedMemberInputSchema = z.strictObject({
  workspaceMemberId: z.uuid().nullable(),
})
export type TransportExternalUserLinkedMemberInput = z.input<
  typeof TransportExternalUserLinkedMemberInputSchema
>

export const TransportExternalUsersListQuerySchema = z.strictObject({
  transportAccountId: z.uuid().optional(),
})
export type TransportExternalUsersListQuery = z.input<
  typeof TransportExternalUsersListQuerySchema
>

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length

export const TransportFeishuAccountCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    appId: z.string().trim().min(1).max(255),
    appSecret: z.string().trim().min(1).max(255),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    // Which Open Platform the app lives on: "feishu" => open.feishu.cn (China,
    // default when omitted), "lark" => open.larksuite.com (international).
    domain: z.enum(["feishu", "lark"]).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type TransportFeishuAccountCreateInput = z.input<
  typeof TransportFeishuAccountCreateInputSchema
>

export const TransportFeishuAccountUpdateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    appId: z.string().trim().min(1).max(255).optional(),
    appSecret: z.string().trim().min(1).max(255).optional(),
    verificationToken: z.string().trim().max(255).optional(),
    encryptKey: z.string().trim().max(255).optional(),
    domain: z.enum(["feishu", "lark"]).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerUpdateShape,
    ...TransportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdateInput)
  .superRefine(validateTransportAccountInboundActorUpdateInput)
export type TransportFeishuAccountUpdateInput = z.input<
  typeof TransportFeishuAccountUpdateInputSchema
>

const WECOM_WS_URL_PATTERN = /^wss?:\/\//i

export const WecomBaseWsUrlInputSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => utf8ByteLength(value) <= WECOM_BASE_WS_URL_MAX_BYTES, {
    message: `baseWsUrl must be at most ${WECOM_BASE_WS_URL_MAX_BYTES} bytes (UTF-8)`,
  })
  .refine((value) => WECOM_WS_URL_PATTERN.test(value), {
    message: "baseWsUrl must use the wss:// (or ws:// for dev) scheme",
  })

export const TransportWecomAccountCreateInputSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.literal("long_connection").default("long_connection"),
    botId: z.string().trim().min(1).max(255),
    secret: z.string().trim().min(1).max(255),
    baseWsUrl: WecomBaseWsUrlInputSchema.optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type TransportWecomAccountCreateInput = z.input<
  typeof TransportWecomAccountCreateInputSchema
>

export const TransportWecomAccountUpdateInputSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(255).optional(),
    connectionMode: z.literal("long_connection").optional(),
    botId: z.string().trim().min(1).max(255).optional(),
    secret: z.string().trim().min(1).max(255).optional(),
    baseWsUrl: WecomBaseWsUrlInputSchema.nullable().optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerUpdateShape,
    ...TransportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdateInput)
  .superRefine(validateTransportAccountInboundActorUpdateInput)
export type TransportWecomAccountUpdateInput = z.input<
  typeof TransportWecomAccountUpdateInputSchema
>

export const TransportQqAccountCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    appId: z.string().trim().min(1).max(255),
    clientSecret: z.string().trim().min(1).max(255),
    botSecret: z.string().trim().max(255).optional(),
    webhookInboundConfirmed: z.boolean().optional(),
    allowProactiveBestEffort: z.boolean().optional(),
    configuredUrlDomains: z.array(z.string().min(1)).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type TransportQqAccountCreateInput = z.input<
  typeof TransportQqAccountCreateInputSchema
>

export const TransportQqAccountUpdateInputSchema = z
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
    ...TransportAccountOwnerUpdateShape,
    ...TransportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdateInput)
  .superRefine(validateTransportAccountInboundActorUpdateInput)
export type TransportQqAccountUpdateInput = z.input<
  typeof TransportQqAccountUpdateInputSchema
>

// ── Telegram (Bot API) typed-credentials create/update. Owner + inbound-actor
// use the shared shapes + validators — byte-identical to the schema the
// telegram controller defined locally before this was single-sourced. ──
export const TransportTelegramAccountCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES),
    botToken: z.string().trim().min(1).max(255),
    webhookSecretToken: z.string().trim().min(1).max(255).optional(),
    apiRoot: z.string().trim().url().max(255).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type TransportTelegramAccountCreateInput = z.input<
  typeof TransportTelegramAccountCreateInputSchema
>

export const TransportTelegramAccountUpdateInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    accountKey: z.string().trim().min(1).max(120).optional(),
    connectionMode: z.enum(TRANSPORT_CONNECTION_MODES).optional(),
    botToken: z.string().trim().min(1).max(255).optional(),
    webhookSecretToken: z.string().trim().min(1).max(255).optional(),
    apiRoot: z.string().trim().url().max(255).optional(),
    status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
    ...TransportAccountOwnerUpdateShape,
    ...TransportAccountInboundActorUpdateShape,
  })
  .superRefine(validateTransportAccountOwnerUpdateInput)
  .superRefine(validateTransportAccountInboundActorUpdateInput)
export type TransportTelegramAccountUpdateInput = z.input<
  typeof TransportTelegramAccountUpdateInputSchema
>

// ── WhatsApp Cloud API (webhook-only). Owner fields are INTENTIONALLY inline
// (plain non-empty string, optional, no default, no owner superRefine) to
// preserve the controller's exact prior validation — they deliberately differ
// from TransportAccountOwnerCreateShape (uuid + default + refine). ──
const whatsappAccountOwnerScopeSchema = z
  .enum(TRANSPORT_ACCOUNT_OWNER_SCOPES)
  .optional()

export const TransportWhatsappAccountCreateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  accountKey: z.string().trim().min(1).max(120).optional(),
  // Cloud API is webhook-only.
  connectionMode: z.literal("webhook").default("webhook"),
  phoneNumberId: z.string().trim().min(1).max(255),
  wabaId: z.string().trim().min(1).max(255),
  accessToken: z.string().trim().min(1).max(4096),
  appSecret: z.string().trim().min(1).max(512),
  appId: z.string().trim().min(1).max(255),
  webhookVerifyToken: z.string().trim().min(1).max(512),
  graphApiVersion: z.string().trim().min(2).max(16).optional(),
  status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
  ownerScope: whatsappAccountOwnerScopeSchema,
  ownerWorkspaceMemberId: z.string().trim().min(1).nullable().optional(),
})
export type TransportWhatsappAccountCreateInput = z.input<
  typeof TransportWhatsappAccountCreateInputSchema
>

export const TransportWhatsappAccountUpdateInputSchema = z.object({
  displayName: z.string().trim().min(1).max(255).optional(),
  phoneNumberId: z.string().trim().min(1).max(255).optional(),
  wabaId: z.string().trim().min(1).max(255).optional(),
  accessToken: z.string().trim().min(1).max(4096).optional(),
  appSecret: z.string().trim().min(1).max(512).optional(),
  appId: z.string().trim().min(1).max(255).optional(),
  webhookVerifyToken: z.string().trim().min(1).max(512).optional(),
  graphApiVersion: z.string().trim().min(2).max(16).optional(),
  status: z.enum(TRANSPORT_ACCOUNT_STATUSES).optional(),
  ownerScope: whatsappAccountOwnerScopeSchema,
  ownerWorkspaceMemberId: z.string().trim().min(1).nullable().optional(),
})
export type TransportWhatsappAccountUpdateInput = z.input<
  typeof TransportWhatsappAccountUpdateInputSchema
>

// ── WhatsApp (unofficial / Baileys) QR / pairing-code login START input.
// Kept verbatim from the controller (inline owner/inbound enums via the shared
// constants, z.string().uuid(), .strict()). The login-session + session-guard
// RESPONSES stay controller-local: they carry epoch-ms expiresAt / runtime
// kill-switch state, which would clash with this module's ISO datetime convention. ──
export const WhatsappUnofficialLoginStartInputSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    /** When set, use pairing-code login (else QR). E.164, with or without +. */
    phoneNumberE164: z
      .string()
      .regex(/^\+?[0-9]{6,15}$/)
      .optional(),
    ownerScope: z.enum(TRANSPORT_ACCOUNT_OWNER_SCOPES).optional(),
    ownerWorkspaceMemberId: z.string().uuid().nullable().optional(),
    inboundActorMode: z.enum(TRANSPORT_ACCOUNT_INBOUND_ACTOR_MODES).optional(),
    inboundActorId: z.string().uuid().nullable().optional(),
  })
  .strict()
export type WhatsappUnofficialLoginStartInput = z.input<
  typeof WhatsappUnofficialLoginStartInputSchema
>

export const WeixinQrSessionCreateInputSchema = z
  .object({
    displayName: z.string().trim().max(255).optional(),
    baseUrl: z.string().trim().url().optional(),
    botType: z.string().trim().max(32).optional(),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type WeixinQrSessionCreateInput = z.input<
  typeof WeixinQrSessionCreateInputSchema
>

/** POST weixin QR verify-code (need_verifycode pairing step) → `{ code }`. */
export const WeixinQrVerifyCodeInputSchema = z
  .object({ code: z.string().trim().min(1).max(32) })
  .strict()
export type WeixinQrVerifyCodeInput = z.input<
  typeof WeixinQrVerifyCodeInputSchema
>

export const WeixinBindingAutoLinkInputSchema = z.object({
  workspaceMemberId: z.uuid().nullable(),
})
export type WeixinBindingAutoLinkInput = z.input<
  typeof WeixinBindingAutoLinkInputSchema
>

export const DingtalkDeviceFlowStartInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(255),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type DingtalkDeviceFlowStartInput = z.input<
  typeof DingtalkDeviceFlowStartInputSchema
>
export type DingtalkDeviceFlowStartParsedInput = z.output<
  typeof DingtalkDeviceFlowStartInputSchema
>

export const DingtalkManualAccountCreateInputSchema = z
  .object({
    clientId: z.string().trim().min(8).max(255),
    clientSecret: z.string().trim().min(8).max(255),
    displayName: z.string().trim().min(1).max(255),
    ...TransportAccountOwnerCreateShape,
    ...TransportAccountInboundActorCreateShape,
  })
  .superRefine(validateTransportAccountOwnerCreateInput)
  .superRefine(validateTransportAccountInboundActorCreateInput)
export type DingtalkManualAccountCreateInput = z.input<
  typeof DingtalkManualAccountCreateInputSchema
>
