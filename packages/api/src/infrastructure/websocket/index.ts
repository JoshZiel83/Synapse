import type { FastifyInstance } from "fastify"
import {
  AUTH_SESSION_COOKIE_NAME,
  WS_AUTH_TIMEOUT,
  WS_HEARTBEAT_INTERVAL,
} from "@synapse/shared"
import type {
  ChatSocketEvent,
  ConversationFeedEventPayloadMap,
  ChatSyncEventPayloadMap,
  ChatSocketEventPayloadMap,
  SystemEvent,
} from "@synapse/shared"
import { onEvent } from "../events/index.js"
import { handleRelayConnection } from "../../modules/mcp-plugins/relay-manager.js"
import { handleRemoteAgentDaemonConnection } from "../../modules/remote-agents/service.js"
import { isShuttingDown } from "../shutdown/state.js"
import { authenticateSessionToken } from "../../modules/auth/service.js"
import { getConversationParticipant } from "../../modules/chat/service.js"
import { getWorkspaceMemberIdentity } from "../../modules/chat/workspace-identity.js"
import { enrichInteractionForUser } from "../../modules/interactions/service.js"
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from "./auth-session-registry.js"
import { setupAsrWebSocket, shutdownAsrWebSockets } from "./asr.js"

type InboxSubscription = {
  key: string
  topic: "inbox"
}

type ConversationSubscription = {
  key: string
  topic: "conversation"
  conversationId: string
}

type WSSubscription = InboxSubscription | ConversationSubscription

interface WSClient {
  ws: any
  userId: string
  workspaceId: string
  workspaceMemberId: string
  sessionId?: string
  authenticated: boolean
  subscriptions: Map<string, WSSubscription>
  authTimer?: ReturnType<typeof setTimeout>
  heartbeatTimer?: ReturnType<typeof setInterval>
  pongTimer?: ReturnType<typeof setTimeout>
}

const clients: Map<string, WSClient> = new Map()

let appRef: FastifyInstance | null = null

function parseCookieHeader(cookieHeader: string | string[] | undefined) {
  const source = Array.isArray(cookieHeader)
    ? cookieHeader.join(";")
    : cookieHeader || ""
  return source.split(";").reduce<Record<string, string>>((acc, part) => {
    const [key, ...rest] = part.split("=")
    const trimmedKey = key?.trim()
    if (!trimmedKey) return acc
    acc[trimmedKey] = decodeURIComponent(rest.join("=").trim())
    return acc
  }, {})
}

async function canWorkspaceMemberAccessConversation(
  conversationId: string,
  workspaceMemberId: string
) {
  const participant = await getConversationParticipant({
    conversationId,
    workspaceMemberId,
  })
  return Boolean(participant && participant.state === "active")
}

function mapInternalEventToSocketEvent(
  event: SystemEvent
): ChatSocketEvent | SystemEvent | null {
  switch (event.type) {
    case "chat.sync.event":
      return {
        type: "chat.sync.event",
        payload:
          event.payload as unknown as ChatSocketEventPayloadMap["chat.sync.event"],
      }
    case "runtime.updated":
      return {
        type: "runtime.updated",
        payload: event.payload as ChatSocketEventPayloadMap["runtime.updated"],
      }
    case "session.message.new":
    case "session.status.changed":
    case "session.thinking":
    case "actor.version_changed":
    case "feed.item.created":
      return null
    default:
      return event
  }
}

async function enrichChatSyncSocketEventForViewer(
  payload: ChatSocketEventPayloadMap["chat.sync.event"],
  viewerUserId: string
): Promise<ChatSocketEventPayloadMap["chat.sync.event"]> {
  if (payload.eventType === "conversation.item.created") {
    const eventPayload =
      payload.payload as ChatSyncEventPayloadMap["conversation.item.created"]
    const item = eventPayload.item
    if (item.itemType !== "event" || item.subtype !== "interaction_requested") {
      return payload
    }

    const eventItem = item as Extract<
      ChatSyncEventPayloadMap["conversation.item.created"]["item"],
      { itemType: "event"; subtype: "interaction_requested" }
    >
    const itemPayload =
      eventItem.eventPayload as ConversationFeedEventPayloadMap["interaction_requested"]
    const interaction =
      itemPayload &&
      typeof itemPayload === "object" &&
      "interaction" in itemPayload
        ? (
            itemPayload as ConversationFeedEventPayloadMap["interaction_requested"]
          ).interaction
        : undefined

    if (!interaction) {
      return payload
    }

    return {
      ...payload,
      payload: {
        ...eventPayload,
        item: {
          ...eventItem,
          eventPayload: {
            ...itemPayload,
            interaction: await enrichInteractionForUser(
              interaction,
              viewerUserId
            ),
          },
        },
      },
    }
  }

  if (payload.eventType !== "interaction.updated") {
    return payload
  }

  return {
    ...payload,
    payload: {
      ...(payload.payload as ChatSyncEventPayloadMap["interaction.updated"]),
      interaction: await enrichInteractionForUser(
        (payload.payload as ChatSyncEventPayloadMap["interaction.updated"])
          .interaction,
        viewerUserId
      ),
    },
  }
}

function getConversationIdFromSocketEvent(
  event: ChatSocketEvent | SystemEvent
) {
  switch (event.type) {
    case "chat.sync.event":
      return (event.payload as ChatSocketEventPayloadMap["chat.sync.event"])
        .conversationId
    case "runtime.updated":
      return (event.payload as { conversationId: string }).conversationId
    default:
      return undefined
  }
}

function closeClient(clientId: string, message: string, closeCode = 1008) {
  const client = clients.get(clientId)
  if (!client) return

  if (client.ws.readyState === 1) {
    try {
      client.ws.send(JSON.stringify({ type: "auth.error", message }))
    } catch {}
  }

  try {
    if (client.ws.readyState === 0 || client.ws.readyState === 1) {
      client.ws.close(closeCode, message)
    }
  } catch {}

  cleanup(clientId)
}

function safeSendSocketEvent(
  clientId: string,
  event: ChatSocketEvent | SystemEvent
) {
  const client = clients.get(clientId)
  if (!client || client.ws.readyState !== 1) {
    return false
  }

  try {
    client.ws.send(JSON.stringify(event))
    return true
  } catch (error) {
    appRef?.log.warn(
      { error, clientId, eventType: event.type },
      "Failed to send websocket event"
    )
    cleanup(clientId)
    return false
  }
}

function getInboxSubscriptions(client: WSClient) {
  return [...client.subscriptions.values()].filter(
    (subscription): subscription is InboxSubscription =>
      subscription.topic === "inbox"
  )
}

function hasConversationSubscription(client: WSClient, conversationId: string) {
  return [...client.subscriptions.values()].some(
    (subscription) =>
      subscription.topic === "conversation" &&
      subscription.conversationId === conversationId
  )
}

async function handleSubscribe(clientId: string, msg: Record<string, unknown>) {
  const client = clients.get(clientId)
  if (!client || !client.authenticated) {
    closeClient(clientId, "Authenticate first")
    return
  }

  const key =
    typeof msg.key === "string" && msg.key.trim() ? msg.key.trim() : ""
  const topic =
    typeof msg.topic === "string" && msg.topic.trim() ? msg.topic.trim() : ""
  if (!key || !topic) {
    return
  }

  if (topic === "inbox") {
    client.subscriptions.set(key, {
      key,
      topic: "inbox",
    })
    return
  }

  if (topic === "conversation") {
    const conversationId =
      typeof msg.conversationId === "string" && msg.conversationId.trim()
        ? msg.conversationId.trim()
        : ""
    if (!conversationId) {
      return
    }
    if (
      !(await canWorkspaceMemberAccessConversation(
        conversationId,
        client.workspaceMemberId
      ))
    ) {
      return
    }
    client.subscriptions.set(key, {
      key,
      topic: "conversation",
      conversationId,
    })
  }
}

function handleUnsubscribe(clientId: string, msg: Record<string, unknown>) {
  const client = clients.get(clientId)
  if (!client) return
  const key =
    typeof msg.key === "string" && msg.key.trim() ? msg.key.trim() : ""
  if (!key) return
  client.subscriptions.delete(key)
}

export function setupWebSocket(app: FastifyInstance) {
  appRef = app
  void initAuthSessionRegistry().catch((error) => {
    app.log.error({ error }, "Failed to initialize auth session registry")
  })
  setupAsrWebSocket(app)

  app.addHook("onRequest", async (request, reply) => {
    const isUpgrade = request.headers.upgrade?.toLowerCase() === "websocket"
    if (isUpgrade && isShuttingDown()) {
      return reply.code(503).send({
        error: "Server shutting down",
        message:
          "WebSocket connections are temporarily unavailable while the server is shutting down.",
      })
    }
  })

  app.get("/ws/relay", { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(
          JSON.stringify({
            type: "server.shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          })
        )
      } catch {}
      try {
        socket.close(1012, "service restart")
      } catch {}
      return
    }
    handleRelayConnection(socket, req, app)
  })

  app.get("/ws/remote-agents", { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(
          JSON.stringify({
            type: "server.shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          })
        )
      } catch {}
      try {
        socket.close(1012, "service restart")
      } catch {}
      return
    }

    void handleRemoteAgentDaemonConnection(socket, req, app)
  })

  app.get("/ws", { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(
          JSON.stringify({
            type: "server.shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          })
        )
      } catch {}
      try {
        socket.close(1012, "service restart")
      } catch {}
      return
    }

    const clientId = crypto.randomUUID()
    const client: WSClient = {
      ws: socket,
      userId: "",
      workspaceId: "",
      workspaceMemberId: "",
      authenticated: false,
      subscriptions: new Map(),
    }
    clients.set(clientId, client)

    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        closeClient(clientId, "Authentication timeout")
      }
    }, WS_AUTH_TIMEOUT)

    const cookieToken = parseCookieHeader(req.headers.cookie)[
      AUTH_SESSION_COOKIE_NAME
    ]

    socket.on("message", async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>

        if (msg.type === "auth") {
          const token =
            typeof msg.token === "string" && msg.token.trim().length > 0
              ? msg.token.trim()
              : cookieToken
          const workspaceId =
            typeof msg.workspaceId === "string" && msg.workspaceId.trim()
              ? msg.workspaceId.trim()
              : ""

          if (!token) {
            closeClient(clientId, "No session provided")
            return
          }
          if (!workspaceId) {
            closeClient(clientId, "workspaceId is required")
            return
          }

          const authenticated = await authenticateSessionToken(token)
          if (!authenticated) {
            closeClient(clientId, "Invalid or expired session")
            return
          }

          const workspaceMember = await getWorkspaceMemberIdentity(
            workspaceId,
            authenticated.user.id
          )
          if (!workspaceMember) {
            closeClient(clientId, "Workspace membership not found")
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
            disconnect: (reason) => closeClient(clientId, reason),
          })

          if (client.authTimer) {
            clearTimeout(client.authTimer)
            client.authTimer = undefined
          }

          safeSendSocketEvent(clientId, {
            type: "auth.ok",
            payload: {
              connectionId: clientId,
              heartbeatMs: WS_HEARTBEAT_INTERVAL,
            },
          })

          client.heartbeatTimer = setInterval(() => {
            if (socket.readyState === 1) {
              safeSendSocketEvent(clientId, {
                type: "ping",
                payload: { at: new Date().toISOString() },
              })
              client.pongTimer = setTimeout(() => {
                try {
                  socket.close()
                } catch {}
                cleanup(clientId)
              }, 10000)
            }
          }, WS_HEARTBEAT_INTERVAL)
          return
        }

        if (msg.type === "subscribe") {
          await handleSubscribe(clientId, msg)
          return
        }

        if (msg.type === "unsubscribe") {
          handleUnsubscribe(clientId, msg)
          return
        }

        if (msg.type === "pong") {
          if (client.pongTimer) {
            clearTimeout(client.pongTimer)
            client.pongTimer = undefined
          }
        }
      } catch {
        // Ignore malformed websocket frames.
      }
    })

    socket.on("close", () => {
      cleanup(clientId)
    })

    socket.on("error", () => {
      cleanup(clientId)
    })
  })

  onEvent("*", async (event: SystemEvent) => {
    const outbound = mapInternalEventToSocketEvent(event)
    if (!outbound) return

    const conversationId = getConversationIdFromSocketEvent(outbound)

    for (const [clientId, client] of clients) {
      if (!client.authenticated || client.ws.readyState !== 1) {
        continue
      }

      if (
        event.recipientWorkspaceMemberId &&
        client.workspaceMemberId !== event.recipientWorkspaceMemberId
      ) {
        continue
      }

      if (
        !event.recipientWorkspaceMemberId &&
        event.workspaceId &&
        client.workspaceId !== event.workspaceId
      ) {
        continue
      }

      const inboxSubscriptions = getInboxSubscriptions(client)
      const hasConversationTopic = conversationId
        ? hasConversationSubscription(client, conversationId)
        : false

      if (inboxSubscriptions.length === 0 && !hasConversationTopic) {
        continue
      }

      const isConversationAllowed =
        conversationId && client.workspaceMemberId
          ? await canWorkspaceMemberAccessConversation(
              conversationId,
              client.workspaceMemberId
            )
          : false

      if (outbound.type === "chat.sync.event") {
        const chatSyncPayload =
          outbound.payload as ChatSocketEventPayloadMap["chat.sync.event"]
        const enrichedPayload = await enrichChatSyncSocketEventForViewer(
          chatSyncPayload,
          client.userId
        )
        if (
          inboxSubscriptions.length > 0 ||
          (conversationId && hasConversationTopic && isConversationAllowed)
        ) {
          safeSendSocketEvent(clientId, {
            ...outbound,
            payload: enrichedPayload,
          })
        }
        continue
      }

      if (outbound.type === "runtime.updated") {
        if (conversationId && hasConversationTopic && isConversationAllowed) {
          safeSendSocketEvent(clientId, outbound)
        }
        continue
      }
    }
  })
}

function cleanup(clientId: string) {
  const client = clients.get(clientId)
  if (client) {
    unregisterAuthenticatedSocket(clientId)
    if (client.authTimer) clearTimeout(client.authTimer)
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
    if (client.pongTimer) clearTimeout(client.pongTimer)
    clients.delete(clientId)
  }
}

export function broadcastToWorkspace(workspaceId: string, data: unknown) {
  const msg = JSON.stringify(data)
  for (const [, client] of clients) {
    const inboxSubscriptions = getInboxSubscriptions(client)
    if (
      client.authenticated &&
      client.workspaceId === workspaceId &&
      client.ws.readyState === 1 &&
      inboxSubscriptions.length > 0
    ) {
      client.ws.send(msg)
    }
  }
}

export async function shutdownWebSockets(
  reason = "Synapse API server is shutting down"
) {
  await shutdownAsrWebSockets(reason)

  for (const [clientId, client] of clients) {
    if (client.authTimer) clearTimeout(client.authTimer)
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer)
    if (client.pongTimer) clearTimeout(client.pongTimer)

    if (client.ws.readyState === 1) {
      try {
        client.ws.send(
          JSON.stringify({
            type: "server.shutdown",
            message: reason,
            retryable: true,
          })
        )
      } catch {}
      try {
        client.ws.close(1012, "service restart")
      } catch {}
    }

    cleanup(clientId)
  }
}
