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
import type { TypingConfig } from "../typing/state.js"

/**
 * Return shape for `TransportConnector.createTypingAdapter`.
 * A bare adapter works for platforms whose timing fits the
 * `DEFAULT_TYPING_CONFIG` (3s heartbeat, 60s TTL — fine for Weixin's
 * sendtyping). Connectors with different platform constraints (e.g. QQ
 * single-chat input_notify expires every 60s and needs ~50s heartbeat)
 * return `{ adapter, config }` to override the controller defaults.
 */
export type TypingAdapterResult =
  | TypingAdapter
  | { adapter: TypingAdapter; config?: Partial<TypingConfig> }

/**
 * Caller helper: normalize either shape to `{ adapter, config? }`.
 * Returns null when the input is null (no typing on this platform).
 *
 * Discriminator is the presence of an `adapter` property on the result.
 * A bare `TypingAdapter` exposes `start`/`stop` directly on the object,
 * never an `adapter` field.
 */
export function unwrapTypingAdapterResult(
  result: TypingAdapterResult | null
): { adapter: TypingAdapter; config?: Partial<TypingConfig> } | null {
  if (!result) return null
  if (
    "adapter" in (result as object) &&
    (result as { adapter?: TypingAdapter }).adapter
  ) {
    return result as { adapter: TypingAdapter; config?: Partial<TypingConfig> }
  }
  return { adapter: result as TypingAdapter }
}

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
  /**
   * Identity of the `transport_message_links` row this send is fulfilling.
   * Always provided; required by connectors that persist per-link state
   * across retries (e.g. QQ msg_seq, anchor reservation). Connectors that
   * don't need it may ignore.
   */
  transportMessageLinkId: string
  /**
   * Snapshot of `transport_message_links.metadata` JSONB at load time.
   * Connectors read state written by previous attempts (msg_seq, anchor,
   * in-flight markers) from here. Mutating this object has no DB effect;
   * use `patchLinkMetadata` instead.
   */
  linkMetadata: Record<string, unknown>
  /**
   * BullMQ `job.attemptsMade` for this delivery. 0 on the first try, ≥1
   * on retries triggered by RetryableTransportError. Connectors use this
   * to scope per-attempt outcome records under `metadata.qq.attempts.<n>`
   * and to drive crash-recovery logic (mark stale `in_flight` entries
   * from prior attempts as `unknown_assumed` before running the current
   * attempt).
   */
  attemptNumber: number
  /**
   * Deep-merge patch into `transport_message_links.metadata`. Awaitable;
   * the worker performs `SELECT … FOR UPDATE` + application-level deep
   * merge + UPDATE atomically, so multiple parallel attempts on the same
   * link serialize cleanly. Connectors should patch BEFORE the HTTP POST
   * to make state visible to recovery paths if the process crashes
   * mid-flight.
   */
  patchLinkMetadata: (patch: Record<string, unknown>) => Promise<void>
}

export interface OutboundSendResult {
  /**
   * Platform message id. Optional because the duplicate-ambiguous path
   * (QQ returns "msg_seq already used" → connector classifies as
   * `success_likely` based on a prior `unknown` attempt) cannot recover
   * the original id. When omitted, the worker marks the link `sent` with
   * `external_message_id` NULL and the deliveryAmbiguous flag in metadata.
   */
  externalMessageId?: string
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
  /**
   * Raw, unparsed HTTP body string captured by the JSON content-type parser
   * in `packages/api/src/index.ts` (stashed as `(request as any).rawBody`).
   * Required for connectors that must verify a signature over the original
   * bytes (e.g. QQ Ed25519: `timestamp + raw body`). Undefined for legacy
   * paths that didn't plumb it; connectors should fall back to re-encoding
   * `body` only if their signature scheme tolerates that (most don't).
   */
  rawBody?: string
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
   *
   * `lastInboundMessageRef` is the inbound message that triggered the current
   * turn (e.g. QQ requires `msg_id` in the `input_notify` POST body; without
   * it the connector cannot construct a valid request and should return
   * `null`). Pass undefined for non-turn-bound callers (idle proactive).
   *
   * Return shape:
   *   - `TypingAdapter` — plain adapter; controller uses DEFAULT_TYPING_CONFIG
   *   - `{ adapter, config }` — adapter plus per-connector controller config
   *     overrides (e.g. QQ needs `heartbeatMs: 50_000` instead of Weixin's 3s)
   *   - `null` — no typing on this platform
   */
  createTypingAdapter(input: {
    account: TransportAccountSummary
    endpointRef: EndpointRef
    lastInboundMessageRef?: MessageRef
  }): TypingAdapterResult | null

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

/**
 * Connectors throw this from `sendMessage` / `startAccount` / `handleWebhook`
 * to signal that the failure is transient (network timeout, 5xx, expired
 * access token, platform-specific "please retry" codes). The IM delivery
 * worker treats this as a BullMQ-retryable error: the job re-enters the
 * queue with exponential backoff up to `attempts:5` (G7).
 */
export class RetryableTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RetryableTransportError"
  }
}

/**
 * Connectors throw this when the failure is terminal: a 4xx business code
 * with no retry semantics, quota exhausted, bot banned (QQ 4914/4915),
 * group-file-not-supported, etc. The IM delivery worker wraps it in
 * BullMQ's `UnrecoverableError` so the job stops retrying immediately.
 *
 * Bare `Error` thrown from a connector defaults to retryable behavior
 * (BullMQ retries up to `attempts`). Use this class explicitly for known
 * terminal cases to avoid wasted retries.
 */
export class PermanentTransportError extends Error {
  /**
   * Optional short code (e.g. `"qq_group_file_not_supported"`) persisted
   * to `transport_message_links.metadata.lastError` so the dashboard /
   * sweeper can introspect without parsing free-form messages.
   */
  readonly code?: string
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = "PermanentTransportError"
    if (options?.code) this.code = options.code
  }
}
