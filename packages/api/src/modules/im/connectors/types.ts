/**
 * TransportConnector: the contract every IM platform implementation fulfills.
 *
 * Replaces the per-platform `if (transportKind === "feishu") ...` branches
 * that used to live in runtime.ts, service.ts, and im-transport-delivery.ts.
 *
 * Adding a new IM = implementing this interface + registering it. No edits
 * to the shared layers.
 *
 * Stays minimal for V1: account lifecycle, inbound emit, outbound send,
 * status/typing factory, mention parse/render, credentials validation,
 * optional webhook handler.
 */

import type {
  TransportAccountSummary,
  TransportConnectionMode,
  TransportConnectorCapability,
  TransportEndpointType,
  TransportKind,
} from "@synapse/shared/types"
import type { CanonicalMessage } from "../messaging/canonical-message.js"
import type { MessageCapabilities } from "../messaging/degradation.js"
import type { StatusReactionAdapter } from "../status-reaction/controller.js"
import type { TypingAdapter } from "../typing/controller.js"

// ───────────────────────── Envelope types ─────────────────────────

export interface InboundEnvelope {
  endpointType: TransportEndpointType
  endpointExternalId: string
  endpointDisplayName?: string
  externalMessageId: string
  externalReplyToId?: string
  externalThreadId?: string
  sender: {
    externalId: string
    displayName?: string
    metadata?: Record<string, unknown>
  }
  receivedAt: string
  message: CanonicalMessage
  endpointMetadata?: Record<string, unknown>
  /** Free-form per-connector payload (e.g. weixin contextToken, feishu chat_type). */
  raw?: Record<string, unknown>
}

export interface OutboundEndpointRef {
  endpointType: TransportEndpointType
  externalId: string
  metadata: Record<string, unknown>
}

export interface OutboundSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
  /**
   * Metadata of the transport_address row whose external_id matches the
   * recipient endpoint. Pre-loaded by the worker only when the connector
   * declares `requiresRecipientAddressMetadata = true`. Undefined when no
   * address row exists, or when the connector did not request it.
   */
  recipientAddressMetadata?: Record<string, unknown>
}

export interface OutboundSendResult {
  externalMessageId: string
  raw?: unknown
}

export interface MessageRef {
  externalMessageId: string
  endpointExternalId: string
}

export interface EndpointRef {
  endpointType: TransportEndpointType
  externalId: string
  metadata: Record<string, unknown>
}

// ───────────────────────── Lifecycle ─────────────────────────

export interface ConnectorLogger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, err?: unknown, fields?: Record<string, unknown>): void
}

export interface AccountStartContext {
  account: TransportAccountSummary
  signal: AbortSignal
  emitInbound: (envelope: InboundEnvelope) => Promise<void>
  logger: ConnectorLogger
}

export interface RunningAccount {
  stop(): Promise<void>
}

// ───────────────────────── Credentials ─────────────────────────

export interface CredentialValidationInput {
  connectionMode: TransportConnectionMode
  credentials: Record<string, unknown>
}

export interface CredentialValidationResult {
  ok: boolean
  errors?: string[]
  /** Server-side regularized form, e.g. {appId, appSecret} after alias merging. */
  normalized?: Record<string, unknown>
}

// ───────────────────────── Config ─────────────────────────

export interface ConfigValidationInput {
  connectionMode: TransportConnectionMode
  config: Record<string, unknown>
}

export interface ConfigValidationResult {
  ok: boolean
  errors?: string[]
  /** Server-side regularized form (e.g. wecom's `{baseWsUrl}` after alias merging). */
  normalized?: Record<string, unknown>
}

// ───────────────────────── Mentions ─────────────────────────

export interface ParsedInboundMention {
  externalId: string
  displayName?: string
  /** Original placeholder key in the raw message (e.g. "@_user_1" for Feishu). */
  key: string
}

export interface OutboundMentionInput {
  externalId: string
  displayName: string
}

// ───────────────────────── Webhook ─────────────────────────

export interface WebhookHandlerInput {
  account: TransportAccountSummary
  headers: Record<string, unknown>
  body: unknown
  /**
   * Where the connector should push normalized inbound events. Supplied by
   * the HTTP layer (public-controller.ts) — typically a thin wrapper around
   * `ingestInboundEnvelope`. Webhook accounts don't go through the runtime
   * reconcile loop (which is long_connection-only), so the connector cannot
   * assume there's a per-account context already registered for it.
   */
  emitInbound: (envelope: InboundEnvelope) => Promise<void>
  logger?: ConnectorLogger
}

export interface WebhookHandlerResult {
  statusCode: number
  body: unknown
}

// ───────────────────────── Connector contract ─────────────────────────

export interface TransportConnector {
  readonly transportKind: TransportKind

  /** Static capability descriptor (modes/endpoint types) — already used by UI. */
  readonly capability: TransportConnectorCapability

  /** Per-message capabilities used by `degradation.ts` and by feature toggles. */
  readonly messageCapabilities: MessageCapabilities

  /**
   * When true, the worker pre-loads the recipient transport_address row's
   * metadata (matched by `endpoint.externalId` + `addressType: "user"`)
   * and passes it to `sendMessage` as `recipientAddressMetadata`. Used by
   * Weixin (the ilink contextToken is on the address row). Default
   * false; Feishu / WeCom leave it undefined so the worker skips the DB
   * lookup for capabilities they don't use.
   *
   * Lives on the connector rather than `MessageCapabilities` because it
   * describes a worker-side orchestration need (whether to pre-fetch a
   * row), not a message-shape degradation rule.
   */
  readonly requiresRecipientAddressMetadata?: boolean

  validateCredentials(
    input: CredentialValidationInput
  ): CredentialValidationResult

  /**
   * Optional: validate the `transport_accounts.config` JSONB shape.
   * Used for connector-specific config fields the generic
   * `accountSchema.config: z.record(z.unknown())` can't constrain on
   * its own. Example: WeCom rejects a `baseWsUrl` that isn't
   * `ws(s)://`. Connectors that don't care about config can omit this
   * entirely — the service helper treats absence as "any config is
   * acceptable". When provided, the optional `normalized` field is the
   * shape persisted to DB (alias-merged, trimmed, etc).
   */
  validateConfig?(input: ConfigValidationInput): ConfigValidationResult

  startAccount(ctx: AccountStartContext): Promise<RunningAccount>

  sendMessage(input: OutboundSendInput): Promise<OutboundSendResult>

  /**
   * Build a per-message StatusReactionAdapter. Returns null on platforms with
   * no reaction capability (the controller becomes a no-op).
   *
   * `onPersist` is invoked whenever the platform's reaction state changes,
   * so the caller can persist {glyph → reaction_id} into durable storage
   * for cross-restart cleanup. Connectors that can't track reaction ids
   * may pass an empty map.
   *
   * `initialReactionIdsByEmoji` seeds the adapter's internal id map on
   * construction. Used by the orphan-recovery path on restart: the caller
   * loads the persisted map from durable storage and passes it in so that
   * subsequent `removeReaction(glyph)` calls actually have the platform
   * reaction_id to delete.
   */
  createStatusReactionAdapter(input: {
    account: TransportAccountSummary
    messageRef: MessageRef
    initialReactionIdsByEmoji?: Record<string, string>
    onPersist?: (state: { reactionIdsByEmoji: Record<string, string> }) => void
  }): StatusReactionAdapter | null

  /**
   * Build a per-endpoint TypingAdapter. Returns null on platforms with no
   * typing indicator.
   */
  createTypingAdapter(input: {
    account: TransportAccountSummary
    endpointRef: EndpointRef
  }): TypingAdapter | null

  /**
   * Pure: take the raw inbound payload and produce a clean mention list +
   * cleaned text. Used by the inbound normalizer to feed CanonicalMessage.
   */
  parseInboundMentions(input: { rawText: string; rawMentions: unknown }): {
    text: string
    mentions: ParsedInboundMention[]
  }

  /**
   * Pure: render a mention for outbound text (e.g. <at user_id="ou_x">Bob</at>).
   * Connectors that don't support mentions in text return "" or "@name".
   */
  renderOutboundMention(input: OutboundMentionInput): string

  /** Optional: handle a raw webhook HTTP body (Feishu signature etc.). */
  handleWebhook?(input: WebhookHandlerInput): Promise<WebhookHandlerResult>
}

// ───────────────────────── Errors ─────────────────────────

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Not implemented: ${method}`)
    this.name = "NotImplementedError"
  }
}

export class TransportCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransportCredentialError"
  }
}
