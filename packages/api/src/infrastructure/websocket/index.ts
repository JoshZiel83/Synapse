import type { FastifyInstance } from "fastify"
import { WS_AUTH_TIMEOUT, WS_HEARTBEAT_INTERVAL } from "@synapse/shared"
import { assertIsoInstant, nowIsoInstant } from "@synapse/shared/datetime"
import type {
  ChatSocketEvent,
  ConversationFeedEventPayloadMap,
  ChatSyncEventPayloadMap,
  ChatSocketEventPayloadMap,
  SystemEvent,
} from "@synapse/shared"
import { onEvent } from "../events/index.js"
import { handleRemoteAgentDaemonConnection } from "../../modules/remote-agents/service.js"
import { isShuttingDown } from "../shutdown/state.js"
import {
  authenticateSessionFromHeaders,
  authenticateSessionToken,
} from "../../modules/auth/service.js"
import { getConversationParticipantUseCase as getConversationParticipant } from "../../modules/chat/participant-roster.js"
import { getWorkspaceMemberIdentity } from "../../modules/chat/workspace-identity.js"
import { enrichTaskForUser } from "../../modules/tasks/service.js"
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from "./auth-session-registry.js"
import { setupAsrWebSocket, shutdownAsrWebSockets } from "./asr.js"
import { parseChatSocketClientFrame } from "./client-frame.js"

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
    case "chat.typing": {
      const typingPayload = event.payload as {
        conversationId?: string
        fromWorkspaceMemberId?: string
        state?: "started" | "stopped"
        occurredAt?: import("@synapse/shared").Timestamp
      }
      if (
        !typingPayload.conversationId ||
        !typingPayload.fromWorkspaceMemberId ||
        !typingPayload.state
      ) {
        return null
      }
      return {
        type: "chat.typing",
        payload: {
          conversationId: typingPayload.conversationId,
          fromWorkspaceMemberId: typingPayload.fromWorkspaceMemberId,
          state: typingPayload.state,
          occurredAt: typingPayload.occurredAt
            ? assertIsoInstant(typingPayload.occurredAt)
            : nowIsoInstant(),
        },
      }
    }
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
    if (item.itemType !== "event" || item.subtype !== "task_requested") {
      return payload
    }

    const eventItem = item as Extract<
      ChatSyncEventPayloadMap["conversation.item.created"]["item"],
      { itemType: "event"; subtype: "task_requested" }
    >
    const itemPayload =
      eventItem.eventPayload as ConversationFeedEventPayloadMap["task_requested"]
    const task =
      itemPayload && typeof itemPayload === "object" && "task" in itemPayload
        ? (itemPayload as ConversationFeedEventPayloadMap["task_requested"])
            .task
        : undefined

    if (!task) {
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
            task: await enrichTaskForUser(task, viewerUserId),
          },
        },
      },
    }
  }

  if (payload.eventType !== "task.updated") {
    return payload
  }

  return {
    ...payload,
    payload: {
      ...(payload.payload as ChatSyncEventPayloadMap["task.updated"]),
      task: await enrichTaskForUser(
        (payload.payload as ChatSyncEventPayloadMap["task.updated"]).task,
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
    case "chat.typing":
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

async function handleInboundTyping(
  client: { workspaceId: string; workspaceMemberId: string; userId: string },
  msg: Record<string, unknown>
) {
  const conversationId =
    typeof msg.conversationId === "string" && msg.conversationId.trim()
      ? msg.conversationId.trim()
      : ""
  const state =
    msg.state === "started" || msg.state === "stopped" ? msg.state : null
  if (!conversationId || !state) return

  try {
    const { broadcastTypingState } =
      await import("../../modules/chat/typing.js")
    await broadcastTypingState({
      workspaceId: client.workspaceId,
      userId: client.userId,
      conversationId,
      state,
    })
  } catch {
    // Inbound typing is best-effort.
  }
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

    socket.on("message", async (raw: any) => {
      try {
        const msg = parseChatSocketClientFrame(raw.toString())

        if (msg.type === "auth") {
          const frameToken =
            typeof msg.token === "string" && msg.token.trim().length > 0
              ? msg.token.trim()
              : ""
          const workspaceId =
            typeof msg.workspaceId === "string" && msg.workspaceId.trim()
              ? msg.workspaceId.trim()
              : ""

          if (!workspaceId) {
            closeClient(clientId, "workspaceId is required")
            return
          }

          // Two auth paths (the session cookie name is unknowable here because
          // of Better Auth's production __Secure- prefix, so we never parse it):
          //  - native clients carry the BA session token in the auth frame ->
          //    validate it as a bearer token;
          //  - web / Expo web rely on the signed session cookie carried on the
          //    upgrade request -> validate from the handshake headers.
          const authenticated = frameToken
            ? await authenticateSessionToken(frameToken)
            : await authenticateSessionFromHeaders(req.headers)
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
                payload: { at: nowIsoInstant() },
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

        if (msg.type === "typing") {
          await handleInboundTyping(client, msg)
          return
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

      // Defense-in-depth: even on a recipient-id match, require the event's
      // workspace to match the socket's workspace. workspaceMemberId is a
      // per-workspace surrogate today (so this is belt-and-suspenders), but it
      // guards against any future id reuse / mis-stamped recipient leaking a
      // chat.sync.event across a tenant boundary.
      if (
        event.recipientWorkspaceMemberId &&
        event.workspaceId &&
        client.workspaceId !== event.workspaceId
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

      // Lazily resolve conversation access only when a conversation-topic
      // delivery path actually needs it. chat.sync.event delivered via the
      // inbox subscription does NOT consult this — authorization for those is
      // asserted at WRITE time (the producer computes recipients from the
      // active participant set and stamps recipient_workspace_member_id, which
      // the recipient gate above already enforces). This avoids running a heavy
      // 11-join roster query per event per socket on the hot inbox path. Only
      // the conversation-topic branches (runtime.updated, chat.typing, and the
      // conversation-topic disjunct of chat.sync.event for a member with NO
      // inbox subscription) pay for it, and the result is memoized.
      let conversationAllowedCache: boolean | undefined
      const isConversationAllowed = async () => {
        if (conversationAllowedCache !== undefined) {
          return conversationAllowedCache
        }
        conversationAllowedCache =
          conversationId && client.workspaceMemberId
            ? await canWorkspaceMemberAccessConversation(
                conversationId,
                client.workspaceMemberId
              )
            : false
        return conversationAllowedCache
      }

      if (outbound.type === "chat.sync.event") {
        // Fast path: inbox subscribers get it on the recipient match alone (no
        // roster query). A conversation-topic-only subscriber (no inbox) still
        // requires the access recheck.
        const allowed =
          inboxSubscriptions.length > 0
            ? true
            : conversationId && hasConversationTopic
              ? await isConversationAllowed()
              : false
        if (!allowed) {
          continue
        }
        const chatSyncPayload =
          outbound.payload as ChatSocketEventPayloadMap["chat.sync.event"]
        const enrichedPayload = await enrichChatSyncSocketEventForViewer(
          chatSyncPayload,
          client.userId
        )
        safeSendSocketEvent(clientId, {
          ...outbound,
          payload: enrichedPayload,
        })
        continue
      }

      if (outbound.type === "runtime.updated") {
        if (
          conversationId &&
          hasConversationTopic &&
          (await isConversationAllowed())
        ) {
          safeSendSocketEvent(clientId, outbound)
        }
        continue
      }

      if (outbound.type === "chat.typing") {
        const typingPayload =
          outbound.payload as ChatSocketEventPayloadMap["chat.typing"]
        // Don't echo the typer's own event back to themselves.
        if (client.workspaceMemberId === typingPayload.fromWorkspaceMemberId) {
          continue
        }
        if (
          conversationId &&
          hasConversationTopic &&
          (await isConversationAllowed())
        ) {
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
