import type { FastifyInstance } from "fastify"
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api"
import {
  WS_AUTH_TIMEOUT,
  WS_HEARTBEAT_INTERVAL,
  type RealtimeAsrClientMessage,
  type RealtimeAsrSocketEvent,
  type RealtimeAsrSocketEventPayloadMap,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import {
  authenticateSessionFromHeaders,
  authenticateSessionToken,
} from "../../modules/auth/service.js"
import { getWorkspaceMemberIdentity } from "../../modules/chat/workspace-identity.js"
import { resolveRealtimeAsrProvider } from "../../modules/asr/registry.js"
import type { RealtimeAsrSession } from "../../modules/asr/types.js"
import { isShuttingDown } from "../shutdown/state.js"
import {
  extractEnvelopeTraceContext,
  logWsConnectionClosed,
} from "../observability/envelope-trace.js"
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from "./auth-session-registry.js"
import { parseRealtimeAsrClientFrame } from "./asr-client-frame.js"

// ONE SERVER span per provider session (`asr.session {provider.key}`), opened
// at the `start` frame inside the frame's extracted trace context — NEVER a
// span (or context switch) per audio frame: audio is counters-only on the hot
// path, final segments become span events (capped), and the span is ended
// exactly once by endAsrSessionSpan (§4.D change 9).
const tracer = trace.getTracer("synapse-ws")

/** Terminal label for the session span; 'aborted' is the cleanup fallback that
 *  guarantees the span always ends (socket kill, shutdown, contract breach). */
type AsrSessionOutcome = "completed" | "error" | "cancelled" | "aborted"

interface AsrWsClient {
  ws: any
  userId: string
  workspaceId: string
  workspaceMemberId: string
  sessionId?: string
  authenticated: boolean
  authTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  pongTimer?: ReturnType<typeof setTimeout>
  asrSession?: RealtimeAsrSession
  /** The per-provider-session SERVER span; present ⟺ not yet ended. */
  sessionSpan?: Span
  audioFrames: number
  audioBytes: number
  segmentEvents: number
}

const MAX_SEGMENT_SPAN_EVENTS = 64

/**
 * Idempotent single-end of the session span: outcome + audio counters land as
 * attributes, 'error' also sets ERROR status. Callers race benignly (e.g. a
 * terminal asr.error immediately followed by socket teardown) — the first
 * outcome wins, later calls are no-ops.
 */
function endAsrSessionSpan(
  client: AsrWsClient,
  outcome: AsrSessionOutcome,
  errorCode?: string
): void {
  const span = client.sessionSpan
  if (!span) return
  client.sessionSpan = undefined
  span.setAttribute("synapse.asr.outcome", outcome)
  span.setAttribute("synapse.asr.audio_frames", client.audioFrames)
  span.setAttribute("synapse.asr.audio_bytes", client.audioBytes)
  if (errorCode !== undefined) {
    span.setAttribute("synapse.asr.error_code", errorCode)
  }
  if (outcome === "error") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode })
  }
  span.end()
}

const asrClients = new Map<string, AsrWsClient>()

function toAudioBuffer(raw: unknown) {
  if (Buffer.isBuffer(raw)) {
    return raw
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((part) => Buffer.from(part)))
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw)
  }

  return Buffer.from(raw as Uint8Array)
}

function safeSendAsrEvent(clientId: string, event: RealtimeAsrSocketEvent) {
  const client = asrClients.get(clientId)
  if (!client || client.ws.readyState !== 1) {
    return false
  }

  try {
    client.ws.send(JSON.stringify(event))
    return true
  } catch {
    cleanupAsrClient(clientId)
    return false
  }
}

function closeAsrClient(clientId: string, message: string, closeCode = 1008) {
  const client = asrClients.get(clientId)
  if (!client) return

  if (client.ws.readyState === 1 && !client.authenticated) {
    try {
      client.ws.send(
        JSON.stringify({
          type: "auth.error",
          payload: { message },
        } satisfies RealtimeAsrSocketEvent<"auth.error">)
      )
    } catch {}
  }

  try {
    if (client.ws.readyState === 0 || client.ws.readyState === 1) {
      client.ws.close(closeCode, message)
    }
  } catch {}

  cleanupAsrClient(clientId)
}

function cleanupAsrClient(clientId: string) {
  const client = asrClients.get(clientId)
  if (!client) return

  // The always-ended guarantee: whatever teardown path got here first ends a
  // still-open session span as 'aborted' (no-op when a terminal event already
  // ended it with a real outcome).
  endAsrSessionSpan(client, "aborted")
  unregisterAuthenticatedSocket(clientId)
  if (client.authTimer) clearTimeout(client.authTimer)
  if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
  if (client.pongTimer) clearTimeout(client.pongTimer)
  client.asrSession?.close()
  asrClients.delete(clientId)
}

export function setupAsrWebSocket(app: FastifyInstance) {
  void initAuthSessionRegistry().catch((error) => {
    app.log.error({ error }, "Failed to initialize ASR auth session registry")
  })

  // config:{otel:false} — the WS upgrade never completes as a normal reply, so
  // @fastify/otel's request span would start and never end; the traced unit on
  // this surface is the provider SESSION, not the connection.
  app.get(
    "/ws/asr",
    { websocket: true, config: { otel: false } },
    (socket: any, req: any) => {
      if (isShuttingDown()) {
        try {
          socket.send(
            JSON.stringify({
              type: "server.shutdown",
              payload: {
                message: "Synapse API server is shutting down",
                retryable: true,
              },
            } satisfies RealtimeAsrSocketEvent<"server.shutdown">)
          )
        } catch {}
        try {
          socket.close(1012, "service restart")
        } catch {}
        return
      }

      const clientId = crypto.randomUUID()
      const client: AsrWsClient = {
        ws: socket,
        userId: "",
        workspaceId: "",
        workspaceMemberId: "",
        authenticated: false,
        audioFrames: 0,
        audioBytes: 0,
        segmentEvents: 0,
      }
      asrClients.set(clientId, client)

      // Connection telemetry: one structured close line per connection
      // (logWsConnectionClosed), mirroring /ws — the session span covers the
      // provider SESSION, not the connection.
      const openedAt = Date.now()
      let messagesIn = 0

      client.authTimer = setTimeout(() => {
        if (!client.authenticated) {
          closeAsrClient(clientId, "Authentication timeout")
        }
      }, WS_AUTH_TIMEOUT)

      socket.on("message", async (raw: any, isBinary: boolean) => {
        messagesIn += 1
        if (isBinary) {
          if (!client.authenticated) {
            closeAsrClient(clientId, "Authenticate first")
            return
          }

          if (!client.asrSession) {
            safeSendAsrEvent(clientId, {
              type: "asr.error",
              payload: {
                code: "ASR_NOT_STARTED",
                message: "Send a start message before streaming audio",
                retryable: false,
              },
            })
            closeAsrClient(clientId, "ASR session not started")
            return
          }

          // Counters only on the audio hot path — never a span or context
          // switch; they land on the session span at end time.
          const audio = toAudioBuffer(raw)
          client.audioFrames += 1
          client.audioBytes += audio.length

          try {
            await client.asrSession.sendAudio(audio)
          } catch (error) {
            safeSendAsrEvent(clientId, {
              type: "asr.error",
              payload: {
                code: "ASR_AUDIO_SEND_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to forward audio to the ASR provider",
                retryable: true,
              },
            })
            closeAsrClient(clientId, "ASR audio send failed", 1011)
          }
          return
        }

        let message: RealtimeAsrClientMessage
        try {
          message = parseRealtimeAsrClientFrame(raw.toString())
        } catch {
          return
        }

        if (message.type === "auth") {
          const frameToken =
            typeof message.token === "string" && message.token.trim().length > 0
              ? message.token.trim()
              : ""
          const workspaceId =
            typeof message.workspaceId === "string"
              ? message.workspaceId.trim()
              : ""

          if (!workspaceId) {
            closeAsrClient(clientId, "workspaceId is required")
            return
          }

          // Two auth paths (see websocket/index.ts): native bearer token in the
          // auth frame, or the signed session cookie on the upgrade headers.
          const authenticated = frameToken
            ? await authenticateSessionToken(frameToken)
            : await authenticateSessionFromHeaders(req.headers)
          if (!authenticated) {
            closeAsrClient(clientId, "Invalid or expired session")
            return
          }

          const workspaceMember = await getWorkspaceMemberIdentity(
            workspaceId,
            authenticated.user.id
          )
          if (!workspaceMember) {
            closeAsrClient(clientId, "Workspace membership not found")
            return
          }

          client.userId = authenticated.user.id
          client.workspaceId = workspaceMember.workspaceId
          client.workspaceMemberId = workspaceMember.workspaceMemberId
          client.sessionId = authenticated.session.id
          client.authenticated = true

          registerAuthenticatedSocket({
            clientId,
            sessionId: authenticated.session.id,
            userId: authenticated.user.id,
            disconnect: (reason) => closeAsrClient(clientId, reason),
          })

          if (client.authTimer) {
            clearTimeout(client.authTimer)
            client.authTimer = undefined
          }

          safeSendAsrEvent(clientId, {
            type: "auth.ok",
            payload: {
              connectionId: clientId,
              heartbeatMs: WS_HEARTBEAT_INTERVAL,
            },
          })

          client.heartbeatTimer = setInterval(() => {
            if (socket.readyState === 1) {
              safeSendAsrEvent(clientId, {
                type: "ping",
                payload: { at: nowIsoInstant() },
              })
              client.pongTimer = setTimeout(() => {
                try {
                  socket.close()
                } catch {}
                cleanupAsrClient(clientId)
              }, 10_000)
            }
          }, WS_HEARTBEAT_INTERVAL)
          return
        }

        if (!client.authenticated) {
          closeAsrClient(clientId, "Authenticate first")
          return
        }

        if (message.type === "start") {
          if (client.asrSession) {
            safeSendAsrEvent(clientId, {
              type: "asr.error",
              payload: {
                code: "ASR_ALREADY_STARTED",
                message: "This connection already has an active ASR session",
                retryable: false,
              },
            })
            closeAsrClient(clientId, "ASR session already started")
            return
          }

          const provider = resolveRealtimeAsrProvider()
          // The session span: remote-parented on the start frame's envelope
          // trace fields (extract-or-ROOT), one per provider session.
          client.audioFrames = 0
          client.audioBytes = 0
          client.segmentEvents = 0
          const sessionSpan = tracer.startSpan(
            `asr.session ${provider.key}`,
            {
              kind: SpanKind.SERVER,
              attributes: { "synapse.asr.provider": provider.key },
            },
            extractEnvelopeTraceContext(message)
          )
          client.sessionSpan = sessionSpan

          const asrSession = provider.createSession({
            userId: client.userId,
            logger: app.log,
            sendEvent: (event) => {
              // The connection legally accepts another `start` after a
              // terminal event, so a contract-breaching provider raising a
              // LATE event from THIS (finished) session must never end or
              // annotate a SUCCESSOR session's span/state: every mutation
              // below is scoped to this closure's own sessionSpan.
              const spanIsCurrent = client.sessionSpan === sessionSpan
              // Final segments become span EVENTS (capped) — never child spans;
              // the event carries the index only, not the transcript text.
              // (RealtimeAsrSocketEvent's payload is keyed by a generic, so a
              // `type` check does not narrow it — hence the payload casts.)
              if (
                event.type === "asr.segment.final" &&
                spanIsCurrent &&
                client.segmentEvents < MAX_SEGMENT_SPAN_EVENTS
              ) {
                client.segmentEvents += 1
                const segment =
                  event.payload as RealtimeAsrSocketEventPayloadMap["asr.segment.final"]
                sessionSpan.addEvent("asr.segment.final", {
                  "synapse.asr.segment_index": segment.segmentIndex,
                })
              }
              // End with the real outcome BEFORE sending: a dead socket makes
              // safeSendAsrEvent tear the client down ('aborted'), which must
              // not beat the truthful terminal label.
              if (event.type === "asr.completed") {
                if (spanIsCurrent) endAsrSessionSpan(client, "completed")
              } else if (event.type === "asr.error") {
                if (spanIsCurrent) {
                  endAsrSessionSpan(
                    client,
                    "error",
                    (
                      event.payload as RealtimeAsrSocketEventPayloadMap["asr.error"]
                    ).code
                  )
                }
              }
              const sent = safeSendAsrEvent(clientId, event)
              if (
                spanIsCurrent &&
                (event.type === "asr.completed" || event.type === "asr.error")
              ) {
                client.asrSession = undefined
              }
              return sent
            },
          })
          client.asrSession = asrSession

          try {
            // Inside the session-span context (ROOT-based, per the extract-or-
            // ROOT invariant), so the provider's own upstream egress (e.g. the
            // sherpa-stream WS handshake) carries the injected trace context.
            await context.with(trace.setSpan(ROOT_CONTEXT, sessionSpan), () =>
              asrSession.start(message.audio)
            )
          } catch (error) {
            app.log.warn(
              {
                error,
                clientId,
                userId: client.userId,
              },
              "Failed to start realtime ASR session"
            )
            client.asrSession = undefined
            // The session's failure contract already emitted a terminal
            // asr.error (ending the span); the close below covers a
            // contract-breaching provider via the 'aborted' fallback.
            closeAsrClient(clientId, "Failed to start ASR session", 1011)
          }
          return
        }

        if (message.type === "stop") {
          if (!client.asrSession) {
            safeSendAsrEvent(clientId, {
              type: "asr.error",
              payload: {
                code: "ASR_NOT_STARTED",
                message: "No active ASR session to stop",
                retryable: false,
              },
            })
            return
          }

          try {
            // stop() runs inside the session-span context too (upstream flush
            // egress stays correlated); success ends the span via the provider's
            // terminal asr.completed.
            const session = client.asrSession
            await (client.sessionSpan
              ? context.with(
                  trace.setSpan(ROOT_CONTEXT, client.sessionSpan),
                  () => session.stop()
                )
              : session.stop())
          } catch (error) {
            endAsrSessionSpan(client, "error", "ASR_STOP_FAILED")
            safeSendAsrEvent(clientId, {
              type: "asr.error",
              payload: {
                code: "ASR_STOP_FAILED",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to finalize the ASR session",
                retryable: true,
              },
            })
            closeAsrClient(clientId, "ASR stop failed", 1011)
          }
          return
        }

        if (message.type === "cancel") {
          endAsrSessionSpan(client, "cancelled")
          client.asrSession?.close()
          client.asrSession = undefined
          try {
            socket.close(1000, "client canceled")
          } catch {}
          cleanupAsrClient(clientId)
          return
        }

        if (message.type === "pong") {
          if (client.pongTimer) {
            clearTimeout(client.pongTimer)
            client.pongTimer = undefined
          }
        }
      })

      socket.on("close", (code?: number) => {
        logWsConnectionClosed("asr", Date.now() - openedAt, messagesIn, code)
        cleanupAsrClient(clientId)
      })

      socket.on("error", () => {
        cleanupAsrClient(clientId)
      })
    }
  )
}

export async function shutdownAsrWebSockets(
  reason = "Synapse API server is shutting down"
) {
  const draining: Promise<void>[] = []
  for (const [clientId, client] of asrClients) {
    if (client.authTimer) clearTimeout(client.authTimer)
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
    if (client.pongTimer) clearTimeout(client.pongTimer)
    // close() is synchronous void for Volcengine, but the RealtimeAsrSession
    // contract allows a Promise so a future gRPC/HTTP2/token-refresh adapter can
    // drain its upstream. Collect any promise to await graceful teardown (bounded
    // below) before the process exits. The redundant close() inside
    // cleanupAsrClient is a no-op (idempotent).
    const closing = client.asrSession?.close()
    if (closing) draining.push(Promise.resolve(closing))

    if (client.ws.readyState === 1) {
      try {
        client.ws.send(
          JSON.stringify({
            type: "server.shutdown",
            payload: {
              message: reason,
              retryable: true,
            },
          } satisfies RealtimeAsrSocketEvent<"server.shutdown">)
        )
      } catch {}
      try {
        client.ws.close(1012, "service restart")
      } catch {}
    }

    cleanupAsrClient(clientId)
  }

  // Bounded wait so a misbehaving async adapter's close() can't hang shutdown.
  if (draining.length > 0) {
    await Promise.race([
      Promise.allSettled(draining),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2000)
      }),
    ])
  }
}
