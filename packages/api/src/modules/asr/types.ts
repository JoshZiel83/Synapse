// modules/asr/ — the REALTIME streaming ASR (语音识别) provider abstraction.
//
// The api core never imports a concrete realtime ASR vendor. The /ws/asr gateway
// (infrastructure/websocket/asr.ts) selects a provider by env (config.asr.provider)
// via registry.ts and drives it through the interfaces below. Every provider —
// Volcengine 豆包 SAUC today, a self-hosted streaming sidecar or a cloud vendor
// later — is an adapter behind this interface that OWNS its own upstream
// connection + auth + framing + normalization.
//
// DISTINCT from modules/transcription/ (batch/file speech-to-text over an HTTP
// sidecar): realtime ASR is a stateful, bidirectional, long-lived duplex session,
// so the provider is a SESSION FACTORY, not a stateless one-shot transcribe().

import type { RealtimeAsrSocketEvent } from "@synapse/shared"
import type { FastifyBaseLogger } from "fastify"

/** Emits a canonical wire event to the client. Returns false if the socket is
 *  gone (the gateway's safe-send). Unchanged from the pre-abstraction gateway. */
export type AsrSocketSender = (event: RealtimeAsrSocketEvent) => boolean

export type AsrLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">

export interface CreateSessionInput {
  readonly userId: string
  readonly logger: AsrLogger
  readonly sendEvent: AsrSocketSender
}

export interface RealtimeAsrProvider {
  /** stable id incl. the literal "none", e.g. "volcengine" | "sherpa-stream" | "none" */
  readonly key: string
  /** true only when the env needed to reach this vendor is present. */
  isConfigured(): boolean
  /** Session FACTORY — the streaming divergence from batch transcribe()/recognize(). */
  createSession(input: CreateSessionInput): RealtimeAsrSession
}

/**
 * The exact 4-method lifecycle the /ws/asr gateway depends on. The session OWNS
 * its own upstream connection + auth + framing + normalization; the gateway never
 * sees a socket handle, header map, signer, or channel. That is what lets a
 * signed-URL vendor (讯飞/腾讯), a gRPC vendor (Google), an ephemeral-token vendor
 * (阿里 NLS/OpenAI), or a localhost sidecar plug in without changing this interface.
 */
export interface RealtimeAsrSession {
  /**
   * Validate the client audio config, open + auth the upstream, emit asr.started,
   * resolve.
   *
   * FAILURE CONTRACT (LOAD-BEARING — the gateway depends on BOTH signals,
   * infrastructure/websocket/asr.ts start path). On ANY operational failure the
   * session MUST:
   *   (1) emit EXACTLY ONE terminal event via sendEvent — asr.error (or
   *       asr.completed for a salvaged transcript). This is the client's ONLY
   *       source of the failure reason: the gateway catch emits nothing, it only
   *       logs + nulls the handle + closes the socket (1011); AND
   *   (2) REJECT the returned promise — the ONLY trigger for that socket teardown.
   * Emit-without-reject leaves the socket open forever (heartbeat keeps firing);
   * reject-without-emit leaves the client a bare 1011 close with no ASR_* reason.
   * On success: emit asr.started and resolve.
   */
  start(audioConfigInput: unknown): Promise<void>

  /**
   * Forward one audio chunk upstream.
   *
   * RE-ENTRANCY: the gateway does NOT serialize — ws delivers "message" events
   * synchronously and does not await this promise, so sendAudio(B) MAY begin
   * before sendAudio(A) resolves. The Volcengine adapter is safe because it writes
   * to the socket SYNCHRONOUSLY before its only await. Any order-sensitive adapter
   * (per-frame SigV4 chain-signing, pre-write resample, or token refresh) MUST
   * serialize internally via a promise-chain mutex.
   */
  sendAudio(audioChunk: Buffer): Promise<void>

  /** Flush the last segment (provider-specific: Volcengine sends an empty FINAL frame). */
  stop(): Promise<void>

  /**
   * Idempotent teardown + concurrency-slot release. Volcengine returns void
   * (synchronous). The Promise arm lets a gRPC/HTTP2/token-refresh adapter await a
   * graceful upstream half-close/drain on server shutdown (shutdownAsrWebSockets
   * awaits it, bounded by a timeout).
   */
  close(): void | Promise<void>
}
