import type { FastifyInstance } from "fastify"
import {
  WS_AUTH_TIMEOUT,
  WS_HEARTBEAT_INTERVAL,
  type RealtimeAsrClientMessage,
  type RealtimeAsrSocketEvent,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import {
  authenticateSessionFromHeaders,
  authenticateSessionToken,
} from "../../modules/auth/service.js"
import { getWorkspaceMemberIdentity } from "../../modules/chat/workspace-identity.js"
import { VolcengineRealtimeAsrSession } from "../../modules/asr/service.js"
import { isShuttingDown } from "../shutdown/state.js"
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from "./auth-session-registry.js"

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
  asrSession?: VolcengineRealtimeAsrSession
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

  app.get("/ws/asr", { websocket: true }, (socket: any, req: any) => {
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
    }
    asrClients.set(clientId, client)

    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        closeAsrClient(clientId, "Authentication timeout")
      }
    }, WS_AUTH_TIMEOUT)

    socket.on("message", async (raw: any, isBinary: boolean) => {
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

        try {
          await client.asrSession.sendAudio(toAudioBuffer(raw))
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
        message = JSON.parse(raw.toString()) as RealtimeAsrClientMessage
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

        const asrSession = new VolcengineRealtimeAsrSession({
          userId: client.userId,
          logger: app.log,
          sendEvent: (event) => {
            const sent = safeSendAsrEvent(clientId, event)
            if (event.type === "asr.completed" || event.type === "asr.error") {
              client.asrSession = undefined
            }
            return sent
          },
        })
        client.asrSession = asrSession

        try {
          await asrSession.start(message.audio)
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
          await client.asrSession.stop()
        } catch (error) {
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

    socket.on("close", () => {
      cleanupAsrClient(clientId)
    })

    socket.on("error", () => {
      cleanupAsrClient(clientId)
    })
  })
}

export async function shutdownAsrWebSockets(
  reason = "Synapse API server is shutting down"
) {
  for (const [clientId, client] of asrClients) {
    if (client.authTimer) clearTimeout(client.authTimer)
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
    if (client.pongTimer) clearTimeout(client.pongTimer)
    client.asrSession?.close()

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
}
