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
 *
 * ─────────────────────────────────────────────────────────────────────
 * Module top-level contract — IMPORTANT
 * ─────────────────────────────────────────────────────────────────────
 * Each connector's `index.ts` is allowed to do ONLY two things at
 * module top level:
 *
 *   1. Construct a `TransportConnector` object (pure data + closures
 *      over imported helpers).
 *   2. Call `registerConnector(...)` from `./registry.js`.
 *
 * It MUST NOT, at top level, start network connections, schedule
 * timers/intervals, spin up BullMQ workers, instantiate Redis clients,
 * open long-lived HTTP connections, subscribe to pub/sub, or perform
 * any file I/O. All such side effects belong inside
 * `startAccount(ctx)` (per-account lifecycle) or behind lazy helpers
 * called from there.
 *
 * Reason: `connectors/capability-assertions.test.ts` imports
 * `./register-all.js`, which side-effect-imports every connector. Any
 * top-level IO would drag real platform dependencies into unit tests
 * (slow, flaky, and impossible to run offline). All current connectors
 * comply (Redis is already lazy); preserve this invariant for new
 * connectors via PR review.
 */

import type {
  Timestamp,
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
  receivedAt: Timestamp
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
   * `transport_message_links.id` for this delivery attempt. Connectors
   * that persist per-link state across retries (e.g. QQ msg_seq, anchor
   * reservation) read/write under this key via `patchLinkMetadata`.
   * Connectors that don't need it may ignore.
   */
  transportMessageLinkId: string
  /**
   * Snapshot of `transport_message_links.metadata` JSONB at load time.
   * Mutating this object has no DB effect; use `patchLinkMetadata` to
   * persist.
   *
   * Namespace convention:
   *  - `metadata.delivery.*` — neutral worker/sweeper state shared by
   *    every connector (ambiguity, sweeper retry counters, etc).
   *    Helpers in `service/delivery-links.ts` and `workers/*` only
   *    touch this namespace.
   *  - `metadata.<transportKind>.*` — protocol-specific state owned by
   *    one connector (e.g. `metadata.qq.msg_seq`, anchor reservation,
   *    in-flight attempt outcomes).
   *  - Top-level `metadata.skippedReason` — legacy worker field for
   *    why a link was skipped, kept as-is to stay compatible with
   *    existing sweeper/recovery scans.
   */
  linkMetadata: Record<string, unknown>
  /**
   * BullMQ `job.attemptsMade` for this delivery. 0 on the first try,
   * ≥1 on retries triggered by retryable errors. Connectors use this
   * to scope per-attempt outcome records and drive crash-recovery
   * (mark stale `in_flight` entries from prior attempts as
   * `unknown_assumed` before running the current attempt).
   */
  attemptNumber: number
  /**
   * Deep-merge a JSON patch into `transport_message_links.metadata`.
   * Awaitable; the worker performs `SELECT … FOR UPDATE` +
   * application-level deep merge + UPDATE atomically, so multiple
   * parallel attempts on the same link serialize cleanly. Connectors
   * should patch BEFORE the HTTP POST to make state visible to
   * recovery paths if the process crashes mid-flight.
   */
  patchLinkMetadata: (patch: Record<string, unknown>) => Promise<void>
}

export interface OutboundSendResult {
  /**
   * Platform message id. Optional because the duplicate-ambiguous path
   * (connector knows the send succeeded but the platform never
   * returned an id — e.g. QQ msg_seq replay after a prior `unknown`
   * attempt) cannot recover the original id. When omitted *and*
   * `deliveryAmbiguous` is true, the worker marks the link `sent`
   * with `external_message_id` NULL and writes
   * `metadata.delivery.ambiguous = true`. When omitted without
   * `deliveryAmbiguous`, the worker treats it as a connector bug and
   * raises (do not silently swallow).
   */
  externalMessageId?: string
  /**
   * Explicit signal that the connector reached the send-likely-OK
   * branch (e.g. duplicate msg_seq + prior unknown attempt) and the
   * worker should treat the missing id as success rather than a bug.
   * Defaults to undefined / false.
   */
  deliveryAmbiguous?: boolean
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
  /** Server-side regularized form, e.g. {appId, appSecret}. */
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
  /**
   * Server-side regularized form persisted to DB
   * (trimmed, defaults filled).
   */
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
   * Raw, unparsed HTTP body string captured by the JSON content-type
   * parser in `packages/api/src/index.ts` (stashed as
   * `(request as any).rawBody`). Required for connectors that must
   * verify a signature over the original bytes (e.g. QQ Ed25519:
   * `timestamp + raw body`). Undefined for legacy paths that didn't
   * plumb it; connectors should fall back to re-encoding `body` only
   * if their signature scheme tolerates that (most don't).
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

/**
 * Input for `handleWebhookVerification` — the HTTP **GET** subscription
 * handshake some platforms require before they will POST events. The
 * canonical case is WhatsApp Cloud, whose webhook is registered by Meta
 * issuing a one-time
 * `GET …?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; the
 * server must echo `hub.challenge` verbatim (status 200) when the token
 * matches, else reply 403. Telegram does NOT need this (its webhook is
 * registered via the `setWebhook` Bot API call, not an inbound GET ping).
 */
export interface WebhookVerificationInput {
  account: TransportAccountSummary
  /** Parsed query string of the GET request (e.g. `hub.*` params). */
  query: Record<string, unknown>
  headers: Record<string, unknown>
  logger?: ConnectorLogger
}

export interface WebhookVerificationResult {
  statusCode: number
  /**
   * Bare response body the platform expects. For WhatsApp Cloud this is
   * the raw `hub.challenge` string echoed back on success — never wrapped
   * in `{ data }` (the WIRE route sends it verbatim).
   */
  body: unknown
}

// ───────────────────────── Typing adapter result ─────────────────────────

/**
 * Return shape for `TransportConnector.createTypingAdapter`. A bare
 * `TypingAdapter` works for platforms whose timing fits
 * `DEFAULT_TYPING_CONFIG` (3s heartbeat, 60s TTL — fine for Weixin's
 * sendtyping). Connectors whose platform indicator expires on a
 * different cadence return `{ adapter, config }` to override the
 * controller defaults.
 */
export type TypingAdapterResult =
  | TypingAdapter
  | { adapter: TypingAdapter; config?: Partial<TypingConfig> }

/**
 * Caller helper: normalize either shape to `{ adapter, config? }`.
 * Returns null when the input is null (no typing on this platform).
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

// ───────────────────────── Account recovery actions ─────────────────────────

/**
 * Closed-enum of side effects an account update may need to run after
 * a state transition (status flip, connection_mode change,
 * config field accepted, etc.). Connector-side
 * `planAccountRecoveryActions?()` hook returns these; generic
 * `service/accounts.ts` dispatches them.
 *
 * Adding a new action type requires updating both `accounts.ts`
 * (executor) and every connector that wants to emit it — by design,
 * so the executor stays a single closed switch.
 *
 * Execution order contract (`service/accounts.ts` executor must
 * preserve): for any single transition, the executor first runs all
 * `reEnableAutoDisabledBindings` actions, then all
 * `recoverSkippedTaskProjections` actions. Re-enabling a
 * binding first is required because projection recovery would
 * otherwise immediately skip again on `outbound_disabled`.
 */
export type AccountRecoveryAction =
  | {
      type: "reEnableAutoDisabledBindings"
      /**
       * Match value compared against `transport_conversation_bindings.metadata
       * ->> 'autoDisabledReason'` in the marker-based UPDATE. Pair with
       * `getBindingDefaults?()` which writes the same string.
       */
      reason: string
    }
  | {
      type: "recoverSkippedTaskProjections"
      /**
       * Account-level event kind that triggered recovery. Worker /
       * recovery helper looks at `tool_call_task_transport_projections`
       * rows where `error` matches a fixed set of reasons keyed off
       * this event.
       *
       * Only account-level events go through this hook — binding-level
       * events (`binding_created_or_replaced`, `outbound_re_enabled`)
       * are fired directly by `service/bindings.ts` because the
       * connector hook input is account-scoped and lacks the
       * conversationId/transportEndpointId those need.
       */
      eventKind:
        | "account_status_activated"
        | "connection_mode_changed_to_long_connection"
        | "config_webhook_confirmed"
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
   * `accountSchema.config: z.record(z.string(), z.unknown())` cannot constrain.
   * Example: WeCom rejects a `baseWsUrl` that isn't `ws(s)://`.
   * Connectors that don't care about config can omit this entirely;
   * the service helper treats absence as "any config is acceptable".
   * When provided, the optional `normalized` field is the shape
   * persisted to DB (trimmed, defaults filled).
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
   *
   * `lastInboundMessageRef` is the inbound message that triggered the
   * current turn. Some platforms cannot construct a valid typing
   * request without the originating message id and should return
   * `null`. Pass undefined for non-turn-bound callers (idle proactive).
   *
   * Return shape:
   *   - `TypingAdapter` — plain adapter; controller uses
   *     `DEFAULT_TYPING_CONFIG`
   *   - `{ adapter, config }` — adapter plus per-connector controller
   *     config overrides (e.g. `heartbeatMs: 50_000`)
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

  /**
   * Optional: respond to the platform's HTTP **GET** webhook-verification
   * handshake (WhatsApp Cloud `hub.challenge`). Connectors that register
   * their webhook out-of-band (Telegram `setWebhook`) or run no webhook
   * at all omit this; the public GET route then replies 501.
   */
  handleWebhookVerification?(
    input: WebhookVerificationInput
  ): Promise<WebhookVerificationResult>

  // ─────────── Optional service-layer hooks (anti-dispatch-drift) ───────────
  //
  // These hooks let connectors plug platform-specific recovery rules
  // into generic service helpers without those helpers regrowing
  // `if (transportKind === "qq")` branches. Each is optional; absence
  // means "use the neutral default".

  /**
   * Called by `service/bindings.ts` when constructing a new binding,
   * only if the caller did not explicitly supply `outboundEnabled`.
   * Lets a connector default a binding to `outbound_enabled = false`
   * (and tag a stable `metadata.autoDisabledReason`) so a later
   * `reEnableAutoDisabledBindings` action can find and lift the gate.
   *
   * Generic helper merges `defaults.metadata` into binding metadata
   * only when `defaults.outboundEnabled === false`; otherwise the
   * metadata override is silently ignored to avoid leaking
   * platform-specific keys onto enabled bindings.
   *
   * `inboundEnabled` is intentionally omitted from this contract —
   * the binding row does not currently carry such a field, and adding
   * it here would be a false abstraction.
   */
  getBindingDefaults?(input: {
    account: TransportAccountSummary
    endpoint: { endpointType: TransportEndpointType; externalId: string }
  }): { outboundEnabled: boolean; metadata?: Record<string, unknown> }

  /**
   * Called by `service/accounts.ts` after a `transport_accounts`
   * row update (status / connection_mode / credentials / config).
   * Connector returns a list of generic recovery actions for the
   * generic executor to run in-transaction.
   *
   * `incomingConfig` is the literal `config` argument passed to the
   * update API call (undefined when the caller did not touch
   * config). Connectors should use the `undefined` check —
   * NOT a previous-vs-next config diff — to detect "the user
   * accepted/confirmed config in this very request"; otherwise an
   * unrelated status update can spuriously re-fire confirm-based
   * recovery.
   *
   * Executor preserves the §AccountRecoveryAction execution-order
   * contract.
   */
  planAccountRecoveryActions?(input: {
    previous: TransportAccountSummary
    next: TransportAccountSummary
    incomingConfig?: Record<string, unknown>
  }): AccountRecoveryAction[]

  /**
   * Called by the generic task-projection worker to gate
   * whether an account is ready to receive interaction-prompt
   * projections right now. Capability eligibility
   * (`messageCapabilities.supportsInteractionPrompt`) is checked
   * separately; this hook covers per-account runtime preconditions
   * (e.g. QQ requires `webhookInboundConfirmed`).
   *
   * Return `{ ok: false, reason }` to skip the projection AND have
   * the worker stamp `reason` on `tool_call_task_transport_projections.error`,
   * so recovery code that matches on the stable reason string can
   * later re-arm the projection when the precondition flips.
   */
  getTaskProjectionReadiness?(
    account: TransportAccountSummary
  ): { ok: true } | { ok: false; reason: string }
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
 * Connectors throw this from `sendMessage` / `startAccount` /
 * `handleWebhook` to signal a transient failure (network timeout,
 * 5xx, expired access token, platform "please retry" code). The IM
 * delivery worker treats this as BullMQ-retryable: the job re-enters
 * the queue with exponential backoff up to the configured attempts.
 */
export class RetryableTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RetryableTransportError"
  }
}

/**
 * Connectors throw this when the failure is terminal: a 4xx business
 * code with no retry semantics, quota exhausted, bot banned,
 * group-file-not-supported, etc. The IM delivery worker wraps it in
 * BullMQ's `UnrecoverableError` so the job stops retrying
 * immediately. Bare `Error` thrown from a connector defaults to
 * retryable; use this class explicitly for known terminal cases to
 * avoid wasted retries.
 */
export class PermanentTransportError extends Error {
  /**
   * Optional short code (e.g. `"qq_group_file_not_supported"`)
   * persisted to `transport_message_links.metadata.lastError` so the
   * dashboard / sweeper can introspect without parsing free-form
   * messages.
   */
  readonly code?: string
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = "PermanentTransportError"
    if (options?.code) this.code = options.code
  }
}
