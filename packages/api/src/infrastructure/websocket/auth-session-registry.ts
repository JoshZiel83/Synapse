import { redisPub, redisSub } from "../redis/index.js"
import { createLogger } from "../logger/index.js"
import {
  AUTH_SESSION_CONTROL_CHANNEL,
  parseAuthSessionControlMessage,
  serializeAuthSessionControlMessage,
  type AuthSessionControlMessage,
  type DisconnectReason,
} from "./auth-session-control.js"

const log = createLogger("auth-session-registry")

interface LiveAuthSocket {
  clientId: string
  sessionId: string
  userId: string
  disconnect: (reason: string) => void
}

const socketsByClientId = new Map<string, LiveAuthSocket>()
const clientIdsBySessionId = new Map<string, Set<string>>()
const clientIdsByUserId = new Map<string, Set<string>>()

let subscriptionStarted = false

function addIndex(
  map: Map<string, Set<string>>,
  key: string,
  clientId: string
) {
  if (!map.has(key)) {
    map.set(key, new Set())
  }
  map.get(key)!.add(clientId)
}

function removeIndex(
  map: Map<string, Set<string>>,
  key: string,
  clientId: string
) {
  const clientIds = map.get(key)
  if (!clientIds) return
  clientIds.delete(clientId)
  if (clientIds.size === 0) {
    map.delete(key)
  }
}

function disconnectClientIds(
  clientIds: Iterable<string>,
  reason: string,
  matcher?: (socket: LiveAuthSocket) => boolean
) {
  for (const clientId of [...clientIds]) {
    const socket = socketsByClientId.get(clientId)
    if (!socket) continue
    if (matcher && !matcher(socket)) continue
    socket.disconnect(reason)
  }
}

function applyControlMessage(message: AuthSessionControlMessage) {
  if (message.type === "session.disconnect") {
    const clientIds = clientIdsBySessionId.get(message.sessionId)
    if (!clientIds) return
    disconnectClientIds(clientIds, message.reason)
    return
  }

  const clientIds = clientIdsByUserId.get(message.userId)
  if (!clientIds) return
  disconnectClientIds(
    clientIds,
    message.reason,
    message.exceptSessionId
      ? (socket) => socket.sessionId !== message.exceptSessionId
      : undefined
  )
}

export async function initAuthSessionRegistry() {
  if (subscriptionStarted) return
  subscriptionStarted = true

  redisSub.on("message", (channel: string, rawMessage: string) => {
    if (channel !== AUTH_SESSION_CONTROL_CHANNEL) return

    try {
      const message = parseAuthSessionControlMessage(rawMessage)
      applyControlMessage(message)
    } catch (error) {
      log.error(
        { err: error },
        "[auth-session-registry] Failed to parse control message"
      )
    }
  })

  await redisSub.subscribe(AUTH_SESSION_CONTROL_CHANNEL)
}

export function registerAuthenticatedSocket(input: LiveAuthSocket) {
  unregisterAuthenticatedSocket(input.clientId)

  socketsByClientId.set(input.clientId, input)
  addIndex(clientIdsBySessionId, input.sessionId, input.clientId)
  addIndex(clientIdsByUserId, input.userId, input.clientId)
}

export function unregisterAuthenticatedSocket(clientId: string) {
  const socket = socketsByClientId.get(clientId)
  if (!socket) return

  socketsByClientId.delete(clientId)
  removeIndex(clientIdsBySessionId, socket.sessionId, clientId)
  removeIndex(clientIdsByUserId, socket.userId, clientId)
}

export async function disconnectSocketsForSession(
  sessionId: string,
  reason: DisconnectReason
) {
  applyControlMessage({ type: "session.disconnect", sessionId, reason })
  await redisPub.publish(
    AUTH_SESSION_CONTROL_CHANNEL,
    serializeAuthSessionControlMessage({
      type: "session.disconnect",
      sessionId,
      reason,
    })
  )
}

export async function disconnectSocketsForUser(
  userId: string,
  reason: DisconnectReason,
  exceptSessionId?: string
) {
  applyControlMessage({
    type: "user.disconnect",
    userId,
    exceptSessionId,
    reason,
  })
  await redisPub.publish(
    AUTH_SESSION_CONTROL_CHANNEL,
    serializeAuthSessionControlMessage({
      type: "user.disconnect",
      userId,
      exceptSessionId,
      reason,
    })
  )
}
