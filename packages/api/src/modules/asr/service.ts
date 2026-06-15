import type {
  RealtimeAsrAudioConfig,
  RealtimeAsrSocketEvent,
  RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { RealtimeAsrAudioConfigSchema } from "@synapse/shared/schemas"
import type { IncomingMessage } from "node:http"
import type { FastifyBaseLogger } from "fastify"
import { z } from "zod"
import WebSocket, { type RawData } from "ws"
import { config } from "../../config/index.js"
import { AsrResultAccumulator } from "./normalizer.js"
import {
  decodeProviderFrame,
  encodeAudioOnlyRequest,
  encodeFullClientRequest,
  type VolcengineAsrFullClientRequest,
} from "./protocol.js"

type AsrSocketSender = (event: RealtimeAsrSocketEvent) => boolean

type AsrErrorPayload = RealtimeAsrSocketEventPayloadMap["asr.error"]

type AsrLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">

const activeProviderSessionIds = new Set<string>()

function acquireProviderConcurrencySlot(sessionId: string) {
  if (activeProviderSessionIds.has(sessionId)) {
    return true
  }

  if (
    activeProviderSessionIds.size >=
    Math.max(1, config.asr.volcengine.maxConcurrency)
  ) {
    return false
  }

  activeProviderSessionIds.add(sessionId)
  return true
}

function releaseProviderConcurrencySlot(sessionId: string) {
  activeProviderSessionIds.delete(sessionId)
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw)
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw)
  }

  return Buffer.from(raw)
}

function isConfigured() {
  return Boolean(
    config.asr.volcengine.appId &&
    config.asr.volcengine.accessToken &&
    config.asr.volcengine.resourceId &&
    config.asr.volcengine.wsUrl
  )
}

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => issue.message).join("; ")
}

function providerErrorMessage(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim()
  }

  if (!payload || typeof payload !== "object") {
    return "ASR provider error"
  }

  const record = payload as Record<string, unknown>
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim()
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim()
  }

  return "ASR provider error"
}

export function validateRealtimeAsrAudioConfig(input: unknown) {
  return RealtimeAsrAudioConfigSchema.parse(input) as RealtimeAsrAudioConfig
}

export function mapProviderError(
  code: number,
  payload: unknown,
  providerLogId?: string
): AsrErrorPayload {
  const message = providerErrorMessage(payload)

  if (code === 45000001) {
    return {
      code: "ASR_PROVIDER_INVALID_REQUEST",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000002) {
    return {
      code: "ASR_PROVIDER_EMPTY_AUDIO",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000081) {
    return {
      code: "ASR_PROVIDER_AUDIO_TIMEOUT",
      message,
      retryable: true,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 45000151) {
    return {
      code: "ASR_PROVIDER_AUDIO_FORMAT_INVALID",
      message,
      retryable: false,
      providerCode: code,
      providerLogId,
    }
  }

  if (code === 55000031) {
    return {
      code: "ASR_PROVIDER_BUSY",
      message,
      retryable: true,
      providerCode: code,
      providerLogId,
    }
  }

  return {
    code:
      code >= 55000000 ? "ASR_PROVIDER_INTERNAL_ERROR" : "ASR_PROVIDER_ERROR",
    message,
    retryable: code >= 55000000,
    providerCode: code,
    providerLogId,
  }
}

function buildFullClientRequest(
  input: RealtimeAsrAudioConfig,
  userId: string,
  sessionId: string
): VolcengineAsrFullClientRequest {
  return {
    user: {
      uid: userId,
      did: sessionId,
      platform: "Synapse",
      sdk_version: "synapse-api",
      app_version: "0.1.0",
    },
    audio: {
      format: input.format,
      codec: input.codec,
      rate: input.rate,
      bits: input.bits,
      channel: input.channel,
    },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
      end_window_size: 800,
      force_to_speech_time: 1000,
    },
  }
}

async function openProviderSocket(
  providerConnectId: string,
  logger: AsrLogger
) {
  return await new Promise<{
    socket: WebSocket
    providerLogId?: string
  }>((resolve, reject) => {
    const socket = new WebSocket(config.asr.volcengine.wsUrl, {
      headers: {
        "X-Api-App-Key": config.asr.volcengine.appId,
        "X-Api-Access-Key": config.asr.volcengine.accessToken,
        "X-Api-Resource-Id": config.asr.volcengine.resourceId,
        "X-Api-Connect-Id": providerConnectId,
      },
      handshakeTimeout: config.asr.volcengine.connectTimeoutMs,
    })

    let settled = false
    let providerLogId: string | undefined

    socket.once("upgrade", (response: IncomingMessage) => {
      const logId = response.headers["x-tt-logid"]
      if (typeof logId === "string" && logId.trim()) {
        providerLogId = logId.trim()
      }
    })

    socket.once(
      "unexpected-response",
      (_request: IncomingMessage, response: IncomingMessage) => {
        if (settled) {
          return
        }
        settled = true
        const statusCode = response.statusCode ?? 502
        reject(
          new Error(`ASR provider handshake failed with status ${statusCode}`)
        )
      }
    )

    socket.once("open", () => {
      if (settled) {
        return
      }
      settled = true
      logger.info(
        {
          providerConnectId,
          providerLogId,
        },
        "Connected to Volcengine ASR provider"
      )
      resolve({ socket, providerLogId })
    })

    socket.once("error", (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(error)
    })
  })
}

function sendProviderFrame(socket: WebSocket, payload: Buffer) {
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

export class VolcengineRealtimeAsrSession {
  readonly sessionId = crypto.randomUUID()

  private readonly providerConnectId = crypto.randomUUID()

  private readonly sendEvent: AsrSocketSender

  private readonly logger: AsrLogger

  private readonly userId: string

  private upstreamSocket: WebSocket | null = null

  private readonly accumulator = new AsrResultAccumulator()

  private readonly pendingAudioChunks: Buffer[] = []

  private providerLogId?: string

  private started = false

  private startInFlight = false

  private stopRequested = false

  private completed = false

  private closed = false

  private concurrencySlotHeld = false

  private idleTimer?: NodeJS.Timeout

  constructor(input: {
    userId: string
    logger: AsrLogger
    sendEvent: AsrSocketSender
  }) {
    this.userId = input.userId
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

    if (!isConfigured()) {
      throw new Error("Volcengine ASR is not configured on the server")
    }

    const audioConfig = validateRealtimeAsrAudioConfig(audioConfigInput)
    if (!acquireProviderConcurrencySlot(this.sessionId)) {
      throw new Error("ASR concurrency limit reached")
    }

    this.concurrencySlotHeld = true
    this.startInFlight = true

    try {
      const { socket, providerLogId } = await openProviderSocket(
        this.providerConnectId,
        this.logger
      )

      if (this.closed) {
        socket.close()
        return
      }

      this.providerLogId = providerLogId
      this.upstreamSocket = socket
      this.attachProviderListeners(socket)
      await sendProviderFrame(
        socket,
        encodeFullClientRequest(
          buildFullClientRequest(audioConfig, this.userId, this.sessionId)
        )
      )

      this.started = true
      this.startInFlight = false
      this.bumpIdleTimer()

      this.sendEvent({
        type: "asr.started",
        payload: {
          sessionId: this.sessionId,
          providerConnectId: this.providerConnectId,
          heartbeatMs: 30000,
        },
      })

      if (this.pendingAudioChunks.length > 0) {
        for (const chunk of this.pendingAudioChunks.splice(0)) {
          await this.sendAudio(chunk)
        }
      }

      if (this.stopRequested) {
        await this.stop()
      }
    } catch (error) {
      this.startInFlight = false
      this.emitErrorAndClose({
        code:
          error instanceof z.ZodError
            ? "ASR_INVALID_AUDIO_CONFIG"
            : error instanceof Error &&
                error.message === "ASR concurrency limit reached"
              ? "ASR_CONCURRENCY_LIMIT_REACHED"
              : "ASR_UPSTREAM_CONNECT_FAILED",
        message:
          error instanceof z.ZodError
            ? formatZodError(error)
            : error instanceof Error
              ? error.message
              : "Failed to connect to the ASR provider",
        retryable:
          !(error instanceof z.ZodError) &&
          !(
            error instanceof Error &&
            error.message === "Volcengine ASR is not configured on the server"
          ),
        providerLogId: this.providerLogId,
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
    await sendProviderFrame(
      this.upstreamSocket,
      encodeAudioOnlyRequest(audioChunk)
    )
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

    await sendProviderFrame(
      this.upstreamSocket,
      encodeAudioOnlyRequest(Buffer.alloc(0), true)
    )
  }

  close() {
    if (this.closed) {
      return
    }

    this.closed = true
    this.clearIdleTimer()
    releaseProviderConcurrencySlot(this.sessionId)
    this.concurrencySlotHeld = false

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

  private attachProviderListeners(socket: WebSocket) {
    socket.on("message", (rawData: RawData) => {
      void this.handleProviderMessage(rawData).catch((error: unknown) => {
        this.logger.error(
          {
            error,
            providerConnectId: this.providerConnectId,
            providerLogId: this.providerLogId,
          },
          "Failed to process ASR provider message"
        )
        this.emitErrorAndClose({
          code: "ASR_PROVIDER_PROTOCOL_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to decode ASR provider response",
          retryable: false,
          providerLogId: this.providerLogId,
        })
      })
    })

    socket.on("close", (code: number, reasonBuffer: Buffer) => {
      if (this.closed) {
        return
      }

      const reason = reasonBuffer.toString("utf8").trim()
      const shouldReportError = !this.completed
      this.close()

      if (!shouldReportError) {
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
          providerLogId: this.providerLogId,
        },
      })
    })

    socket.on("error", (error: Error) => {
      if (this.closed) {
        return
      }

      this.logger.warn(
        {
          error,
          providerConnectId: this.providerConnectId,
          providerLogId: this.providerLogId,
        },
        "ASR provider socket error"
      )
    })
  }

  private async handleProviderMessage(rawData: RawData) {
    const decodedFrame = decodeProviderFrame(toBuffer(rawData))
    if (decodedFrame.kind === "error") {
      this.emitErrorAndClose(
        mapProviderError(
          decodedFrame.code,
          decodedFrame.payload,
          this.providerLogId
        )
      )
      return
    }

    const receivedAt = nowIsoInstant()
    const normalized = this.accumulator.ingest(
      decodedFrame.payload,
      receivedAt,
      decodedFrame.isFinal
    )

    if (normalized.partial) {
      this.sendEvent({
        type: "asr.partial",
        payload: normalized.partial,
      })
    }

    for (const segment of normalized.segmentFinals) {
      this.sendEvent({
        type: "asr.segment.final",
        payload: segment,
      })
    }

    if (!normalized.completed) {
      return
    }

    this.completed = true
    this.sendEvent({
      type: "asr.completed",
      payload: normalized.completed,
    })
    this.close()
  }

  private emitErrorAndClose(payload: AsrErrorPayload) {
    this.sendEvent({
      type: "asr.error",
      payload,
    })
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
          providerLogId: this.providerLogId,
        })
      },
      Math.max(1_000, config.asr.volcengine.idleTimeoutMs)
    )
  }

  private clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}
