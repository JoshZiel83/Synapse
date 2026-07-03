// sherpa-stream adapter — a realtime ASR provider backed by a SELF-HOSTED
// streaming sherpa-onnx sidecar over WebSocket (sidecars/sherpa-asr-streaming).
// The realtime analogue of the committed batch sherpa sidecar
// (modules/transcription/providers/sherpa.ts). No auth: the upstream is an
// operator-set localhost / compose-network URL. Accepts raw 16 kHz PCM only —
// streaming opus decode is deferred to the sidecar (rejected up front here).
//
// Wire protocol (we own BOTH ends):
//   adapter → sidecar: text {"type":"start","sampleRate":16000}; then binary PCM
//     s16le frames; then text {"type":"stop"} to flush.
//   sidecar → adapter: text JSON — partial / final / completed / error (schema
//     below), mapped to the canonical RealtimeAsr* wire events.

import type {
  RealtimeAsrAudioConfig,
  RealtimeAsrFinalSegment,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import WebSocket, { type RawData } from "ws"
import { z } from "zod"
import { config } from "../../../../config/index.js"
import { validateRealtimeAsrAudioConfig } from "../../audio.js"
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from "../../concurrency.js"
import {
  AsrConcurrencyLimitError,
  AsrNotConfiguredError,
  AsrUnsupportedAudioError,
  startErrorCode,
  startErrorMessage,
  startRetryable,
} from "../../preflight.js"
import type {
  AsrLogger,
  AsrSocketSender,
  CreateSessionInput,
  RealtimeAsrSession,
} from "../../types.js"

type AsrErrorPayload = RealtimeAsrSocketEventPayloadMap["asr.error"]
type AsrCompletedPayload = RealtimeAsrSocketEventPayloadMap["asr.completed"]

const SidecarMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("partial"),
    displayText: z.string(),
    unstableText: z.string(),
  }),
  z.object({
    type: z.literal("final"),
    text: z.string(),
    startTimeMs: z.number().optional(),
    endTimeMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("completed"),
    text: z.string(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
])

/** true only when the sidecar URL env is set. */
export function isSherpaStreamConfigured() {
  return Boolean(config.asr.sherpaStream.url)
}

export class SherpaStreamRealtimeAsrSession implements RealtimeAsrSession {
  readonly sessionId = crypto.randomUUID()

  private readonly sendEvent: AsrSocketSender

  private readonly logger: AsrLogger

  private upstreamSocket: WebSocket | null = null

  private readonly pendingAudioChunks: Buffer[] = []

  private readonly finalizedSegments: RealtimeAsrFinalSegment[] = []

  private lastDisplayText = ""

  private lastDurationMs = 0

  private started = false

  private startInFlight = false

  private stopRequested = false

  private completed = false

  private closed = false

  private idleTimer?: NodeJS.Timeout

  constructor(input: CreateSessionInput) {
    // userId is intentionally unused: the local sidecar has no per-user auth.
    this.logger = input.logger
    this.sendEvent = input.sendEvent
  }

  async start(audioConfigInput: unknown) {
    if (this.closed) {
      throw new Error("ASR session is already closed")
    }

    if (this.started || this.startInFlight) {
      throw new Error("ASR session is already active")
    }

    // Operational preflight — each failure emits exactly one terminal asr.error
    // THEN rejects (the RealtimeAsrSession start() contract).
    let audioConfig: RealtimeAsrAudioConfig
    try {
      if (!isSherpaStreamConfigured()) {
        throw new AsrNotConfiguredError(
          "the sherpa-stream ASR sidecar URL is not configured"
        )
      }
      audioConfig = validateRealtimeAsrAudioConfig(audioConfigInput)
      if (audioConfig.format !== "pcm" || audioConfig.codec !== "raw") {
        throw new AsrUnsupportedAudioError(
          "the sherpa-stream ASR sidecar accepts raw 16 kHz PCM only (format=pcm, codec=raw)"
        )
      }
      if (
        !acquireConcurrencySlot(
          this.sessionId,
          config.asr.sherpaStream.maxConcurrency
        )
      ) {
        throw new AsrConcurrencyLimitError()
      }
    } catch (error) {
      this.emitErrorAndClose({
        code: startErrorCode(error),
        message: startErrorMessage(error),
        retryable: startRetryable(error),
      })
      throw error
    }

    this.startInFlight = true

    try {
      const socket = await this.openSidecarSocket()

      if (this.closed) {
        socket.close()
        return
      }

      this.upstreamSocket = socket
      this.attachSidecarListeners(socket)
      await this.sendText(
        socket,
        JSON.stringify({ type: "start", sampleRate: audioConfig.rate })
      )

      // A terminal error/close delivered by the sidecar DURING the handshake await
      // (the listeners are already attached) tears this session down. Abort so we
      // never emit asr.started after a terminal event or arm an idle timer on a
      // closed session.
      if (this.closed) {
        return
      }

      this.started = true
      this.startInFlight = false
      this.bumpIdleTimer()

      this.sendEvent({
        type: "asr.started",
        payload: {
          sessionId: this.sessionId,
          // api-side session correlation id (no vendor connection id exists).
          providerConnectId: this.sessionId,
          heartbeatMs: 30000,
        },
      })

      // Flush the pre-start queue as ONE ordered batch: enqueue every buffered
      // chunk to the socket synchronously (ws.send buffers in call order) before
      // awaiting, so a live chunk arriving mid-flush can't interleave ahead of a
      // still-queued one (streaming ASR is order-sensitive; cf. the sendAudio
      // re-entrancy note in types.ts).
      const queued = this.pendingAudioChunks.splice(0)
      if (queued.length > 0) {
        this.bumpIdleTimer()
        await Promise.all(queued.map((chunk) => this.sendBinary(socket, chunk)))
      }

      if (this.stopRequested) {
        await this.stop()
      }
    } catch (error) {
      this.startInFlight = false
      this.emitErrorAndClose({
        code: startErrorCode(error),
        message: startErrorMessage(error),
        retryable: startRetryable(error),
      })
      throw error
    }
  }

  async sendAudio(audioChunk: Buffer) {
    if (this.closed) {
      return
    }

    if (!this.started) {
      if (!this.startInFlight) {
        throw new Error("ASR session has not been started")
      }

      if (this.pendingAudioChunks.length >= 32) {
        throw new Error("Too many queued ASR audio packets before startup")
      }

      this.pendingAudioChunks.push(Buffer.from(audioChunk))
      return
    }

    if (
      !this.upstreamSocket ||
      this.upstreamSocket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("ASR provider connection is not open")
    }

    this.bumpIdleTimer()
    await this.sendBinary(this.upstreamSocket, audioChunk)
  }

  async stop() {
    this.stopRequested = true
    this.clearIdleTimer()

    if (
      !this.upstreamSocket ||
      this.upstreamSocket.readyState !== WebSocket.OPEN
    ) {
      return
    }

    await this.sendText(this.upstreamSocket, JSON.stringify({ type: "stop" }))
  }

  close() {
    if (this.closed) {
      return
    }

    this.closed = true
    this.clearIdleTimer()
    releaseConcurrencySlot(this.sessionId)

    if (this.upstreamSocket) {
      this.upstreamSocket.removeAllListeners()
      if (
        this.upstreamSocket.readyState === WebSocket.OPEN ||
        this.upstreamSocket.readyState === WebSocket.CONNECTING
      ) {
        this.upstreamSocket.close()
      }
      this.upstreamSocket = null
    }
  }

  private openSidecarSocket() {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(config.asr.sherpaStream.url, {
        handshakeTimeout: config.asr.sherpaStream.connectTimeoutMs,
      })

      let settled = false

      socket.once("open", () => {
        if (settled) {
          return
        }
        settled = true
        this.logger.info(
          { sessionId: this.sessionId },
          "Connected to sherpa-stream ASR sidecar"
        )
        resolve(socket)
      })

      socket.once(
        "unexpected-response",
        (_request, response: { statusCode?: number }) => {
          if (settled) {
            return
          }
          settled = true
          reject(
            new Error(
              `sherpa-stream sidecar handshake failed with status ${response.statusCode ?? 502}`
            )
          )
        }
      )

      socket.once("error", (error: Error) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      })
    })
  }

  private sendBinary(socket: WebSocket, payload: Buffer) {
    return new Promise<void>((resolve, reject) => {
      socket.send(payload, { binary: true }, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private sendText(socket: WebSocket, payload: string) {
    return new Promise<void>((resolve, reject) => {
      socket.send(payload, { binary: false }, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private attachSidecarListeners(socket: WebSocket) {
    socket.on("message", (rawData: RawData, isBinary: boolean) => {
      // The sidecar speaks JSON text only; ignore any unexpected binary frame.
      if (isBinary) {
        return
      }
      this.handleSidecarMessage(rawData.toString())
    })

    socket.on("close", (code: number, reasonBuffer: Buffer) => {
      if (this.closed) {
        return
      }

      const reason = reasonBuffer.toString("utf8").trim()
      const alreadyCompleted = this.completed
      // Snapshot recognized text before close() tears down state (the sidecar can
      // drop the connection after partials without a terminal "completed").
      const fallback = this.buildCompletedPayload()
      this.close()

      if (alreadyCompleted) {
        return
      }

      if (fallback.text.trim() || fallback.segments.length > 0) {
        this.completed = true
        this.sendEvent({ type: "asr.completed", payload: fallback })
        return
      }

      this.sendEvent({
        type: "asr.error",
        payload: {
          code: "ASR_UPSTREAM_CLOSED",
          message:
            reason ||
            `ASR provider connection closed unexpectedly (code ${code})`,
          retryable: true,
        },
      })
    })

    socket.on("error", (error: Error) => {
      if (this.closed) {
        return
      }

      this.logger.warn(
        { error, sessionId: this.sessionId },
        "sherpa-stream ASR sidecar socket error"
      )
    })
  }

  private handleSidecarMessage(text: string) {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch {
      this.logger.warn(
        { sessionId: this.sessionId },
        "sherpa-stream sidecar sent a non-JSON message"
      )
      return
    }

    const parsed = SidecarMessageSchema.safeParse(parsedJson)
    if (!parsed.success) {
      this.logger.warn(
        {
          sessionId: this.sessionId,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        },
        "sherpa-stream sidecar message failed schema validation"
      )
      return
    }

    const message = parsed.data
    const receivedAt = nowIsoInstant()

    if (message.type === "partial") {
      this.lastDisplayText = message.displayText
      this.sendEvent({
        type: "asr.partial",
        payload: {
          displayText: message.displayText,
          unstableText: message.unstableText,
          receivedAt,
        },
      })
      return
    }

    if (message.type === "final") {
      const segment: RealtimeAsrFinalSegment = {
        text: message.text.trim(),
        segmentIndex: this.finalizedSegments.length,
        startTimeMs: message.startTimeMs ?? 0,
        endTimeMs: message.endTimeMs ?? 0,
        receivedAt,
      }
      this.finalizedSegments.push(segment)
      this.sendEvent({ type: "asr.segment.final", payload: segment })
      return
    }

    if (message.type === "completed") {
      if (typeof message.durationMs === "number") {
        this.lastDurationMs = message.durationMs
      }
      this.completed = true
      this.sendEvent({
        type: "asr.completed",
        payload: {
          text: message.text.trim() || this.lastDisplayText,
          segments: [...this.finalizedSegments],
          durationMs: this.lastDurationMs,
        },
      })
      this.close()
      return
    }

    // message.type === "error"
    this.emitErrorAndClose({
      code: "ASR_PROVIDER_ERROR",
      message: message.message,
      // The sidecar flags transient conditions (model warming up, at capacity) as
      // retryable; genuine decode failures default to non-retryable.
      retryable: message.retryable ?? false,
    })
  }

  private buildCompletedPayload(): AsrCompletedPayload {
    return {
      text: this.lastDisplayText,
      segments: [...this.finalizedSegments],
      durationMs: this.lastDurationMs,
    }
  }

  private emitErrorAndClose(payload: AsrErrorPayload) {
    // Idempotent: a session torn down by an upstream error/close during the start()
    // handshake await must not emit a second asr.error when the pending send rejects.
    if (this.closed) {
      return
    }
    this.sendEvent({ type: "asr.error", payload })
    this.close()
  }

  private bumpIdleTimer() {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(
      () => {
        this.emitErrorAndClose({
          code: "ASR_IDLE_TIMEOUT",
          message: "No ASR audio packet was received before the idle timeout",
          retryable: true,
        })
      },
      Math.max(1_000, config.asr.sherpaStream.idleTimeoutMs)
    )
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}
