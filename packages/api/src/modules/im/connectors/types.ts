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

  validateCredentials(
    input: CredentialValidationInput
  ): CredentialValidationResult

  startAccount(ctx: AccountStartContext): Promise<RunningAccount>

  sendMessage(input: OutboundSendInput): Promise<OutboundSendResult>

  /**
   * Build a per-message StatusReactionAdapter. Returns null on platforms with
   * no reaction capability (the controller becomes a no-op).
   */
  createStatusReactionAdapter(input: {
    account: TransportAccountSummary
    messageRef: MessageRef
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
