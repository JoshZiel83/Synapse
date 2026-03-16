import type { FastifyInstance } from "fastify";
import { AUTH_SESSION_COOKIE_NAME } from "@synapse/shared";
import type {
  ChatSocketEvent,
  ChatSocketEventPayloadMap,
  SystemEvent,
  WorkspaceFeedEventRecord,
} from "@synapse/shared";
import { WS_AUTH_TIMEOUT, WS_HEARTBEAT_INTERVAL } from "@synapse/shared";
import { onEvent } from "../events/index.js";
import { query } from "../database/index.js";
import { handleRelayConnection } from "../../modules/mcp-plugins/relay-manager.js";
import { isShuttingDown } from "../shutdown/state.js";
import { authenticateSessionToken } from "../../modules/auth/service.js";
import { listWorkspaceFeedEventsAfter } from "../../modules/conversation/service.js";
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from "./auth-session-registry.js";
import {
  authorizePermission,
  listAuthorizedResourceIds,
  userSubject,
} from "../../modules/access/service.js";

interface WSClient {
  ws: any;
  userId: string;
  sessionId?: string;
  workspaceId?: string;
  authenticated: boolean;
  syncState: "authenticating" | "syncing" | "live";
  bufferedFeedRecords: WorkspaceFeedEventRecord[];
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
}

const clients: Map<string, WSClient> = new Map();

let appRef: FastifyInstance | null = null;

function parseCookieHeader(cookieHeader: string | string[] | undefined) {
  const source = Array.isArray(cookieHeader)
    ? cookieHeader.join(";")
    : cookieHeader || "";
  return source.split(";").reduce<Record<string, string>>((acc, part) => {
    const [key, ...rest] = part.split("=");
    const trimmedKey = key?.trim();
    if (!trimmedKey) return acc;
    acc[trimmedKey] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
}

async function canUserAccessWorkspace(workspaceId: string, userId: string) {
  return authorizePermission({
    subject: userSubject(userId),
    resourceType: "workspace",
    resourceId: workspaceId,
    permission: "view",
  });
}

async function getVisibleConversationIdsForUser(
  workspaceId: string,
  userId: string,
) {
  const conversationIds = await listAuthorizedResourceIds({
    subject: userSubject(userId),
    action: "conversation.view",
  });
  if (conversationIds.length === 0) return [];

  const result = await query(
    `SELECT id
     FROM conversations
     WHERE workspace_id = $1
       AND id = ANY($2)`,
    [workspaceId, conversationIds],
  );
  return result.rows.map((row: any) => row.id as string);
}

async function canUserAccessConversation(
  conversationId: string,
  userId: string,
) {
  return authorizePermission({
    subject: userSubject(userId),
    resourceType: "conversation",
    resourceId: conversationId,
    permission: "view",
  });
}

function mapInternalEventToSocketEvent(
  event: SystemEvent,
): ChatSocketEvent | SystemEvent | null {
  switch (event.type) {
    case "chat.feed.item.created":
      return {
        type: "feed.item.created",
        payload: event.payload as unknown as WorkspaceFeedEventRecord,
      };
    case "chat.runtime.updated":
      return {
        type: "runtime.updated",
        payload: event.payload as ChatSocketEventPayloadMap["runtime.updated"],
      };
    case "chat.conversation.updated":
      return {
        type: "conversation.updated",
        payload:
          event.payload as ChatSocketEventPayloadMap["conversation.updated"],
      };
    case "session.message.new":
    case "session.status.changed":
    case "session.thinking":
    case "group.actor.runtime.updated":
    case "group.updated":
    case "group.member_joined":
    case "group.member_kicked":
    case "actor.version_changed":
      return null;
    default:
      return event;
  }
}

function getConversationIdFromSocketEvent(
  event: ChatSocketEvent | SystemEvent,
) {
  switch (event.type) {
    case "feed.item.created":
      return (event.payload as WorkspaceFeedEventRecord).item.conversationId;
    case "runtime.updated":
    case "conversation.updated":
      return (event.payload as { conversationId: string }).conversationId;
    default:
      return undefined;
  }
}

function closeClient(clientId: string, message: string, closeCode = 1008) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.ws.readyState === 1) {
    try {
      client.ws.send(JSON.stringify({ type: "auth_error", message }));
    } catch {}
  }

  try {
    if (client.ws.readyState === 0 || client.ws.readyState === 1) {
      client.ws.close(closeCode, message);
    }
  } catch {}

  cleanup(clientId);
}

function safeSendSocketEvent(
  clientId: string,
  event: ChatSocketEvent | SystemEvent,
) {
  const client = clients.get(clientId);
  if (!client || client.ws.readyState !== 1) {
    return false;
  }

  try {
    client.ws.send(JSON.stringify(event));
    return true;
  } catch (error) {
    appRef?.log.warn(
      { error, clientId, eventType: event.type },
      "Failed to send websocket event",
    );
    cleanup(clientId);
    return false;
  }
}

function bufferFeedRecord(client: WSClient, record: WorkspaceFeedEventRecord) {
  if (
    client.bufferedFeedRecords.some(
      (entry) => entry.workspaceSequence === record.workspaceSequence,
    )
  ) {
    return;
  }
  client.bufferedFeedRecords.push(record);
}

function drainBufferedFeedRecords(client: WSClient, afterSequence: number) {
  const nextRecords = client.bufferedFeedRecords
    .filter((record) => record.workspaceSequence > afterSequence)
    .sort((left, right) => left.workspaceSequence - right.workspaceSequence);

  client.bufferedFeedRecords = [];
  return nextRecords;
}

async function replayWorkspaceFeed(clientId: string, afterSequence: number) {
  const client = clients.get(clientId);
  if (!client?.workspaceId || !client.userId || client.ws.readyState !== 1) {
    return;
  }

  const visibleConversationIds = await getVisibleConversationIdsForUser(
    client.workspaceId,
    client.userId,
  );
  let cursor = afterSequence;
  const pageSize = 200;

  while (true) {
    const page = await listWorkspaceFeedEventsAfter({
      workspaceId: client.workspaceId,
      conversationIds: visibleConversationIds,
      afterSequence: cursor,
      limit: pageSize,
    });
    if (page.length === 0) {
      break;
    }

    for (const record of page) {
      if (
        !safeSendSocketEvent(clientId, {
          type: "feed.item.created",
          payload: record,
        })
      ) {
        return;
      }
      cursor = record.workspaceSequence;
    }
  }

  while (true) {
    const current = clients.get(clientId);
    if (!current || current.ws.readyState !== 1) {
      return;
    }

    const buffered = drainBufferedFeedRecords(current, cursor);
    if (buffered.length === 0) {
      current.syncState = "live";
      return;
    }

    for (const record of buffered) {
      if (
        !safeSendSocketEvent(clientId, {
          type: "feed.item.created",
          payload: record,
        })
      ) {
        return;
      }
      cursor = record.workspaceSequence;
    }
  }
}

export function setupWebSocket(app: FastifyInstance) {
  appRef = app;
  void initAuthSessionRegistry().catch((error) => {
    app.log.error({ error }, "Failed to initialize auth session registry");
  });

  app.addHook("onRequest", async (request, reply) => {
    const isUpgrade = request.headers.upgrade?.toLowerCase() === "websocket";
    if (isUpgrade && isShuttingDown()) {
      return reply.code(503).send({
        error: "Server shutting down",
        message:
          "WebSocket connections are temporarily unavailable while the server is shutting down.",
      });
    }
  });

  // Relay agent WebSocket endpoint
  app.get("/ws/relay", { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(
          JSON.stringify({
            type: "server_shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          }),
        );
      } catch {}
      try {
        socket.close(1012, "service restart");
      } catch {}
      return;
    }
    handleRelayConnection(socket, req, app);
  });

  app.get("/ws", { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(
          JSON.stringify({
            type: "server_shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          }),
        );
      } catch {}
      try {
        socket.close(1012, "service restart");
      } catch {}
      return;
    }

    const clientId = crypto.randomUUID();

    const client: WSClient = {
      ws: socket,
      userId: "",
      authenticated: false,
      syncState: "authenticating",
      bufferedFeedRecords: [],
    };
    clients.set(clientId, client);

    // Auth timeout - must authenticate within WS_AUTH_TIMEOUT
    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        closeClient(clientId, "Authentication timeout");
      }
    }, WS_AUTH_TIMEOUT);

    const cookieToken = parseCookieHeader(req.headers.cookie)[
      AUTH_SESSION_COOKIE_NAME
    ];

    socket.on("message", async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "auth") {
          const workspaceId =
            typeof msg.workspaceId === "string" ? msg.workspaceId : "";
          const lastWorkspaceSequence =
            typeof msg.lastWorkspaceSequence === "number"
              ? Math.max(0, Math.floor(msg.lastWorkspaceSequence))
              : 0;
          const token =
            typeof msg.token === "string" && msg.token.trim().length > 0
              ? msg.token.trim()
              : cookieToken;

          if (!token) {
            closeClient(clientId, "No session provided");
            return;
          }

          if (!workspaceId) {
            closeClient(clientId, "No workspace selected");
            return;
          }

          const authenticated = await authenticateSessionToken(token);
          if (!authenticated) {
            closeClient(clientId, "Invalid or expired session");
            return;
          }

          const canAccessWorkspace = await canUserAccessWorkspace(
            workspaceId,
            authenticated.user.id,
          );
          if (!canAccessWorkspace) {
            closeClient(clientId, "Not allowed to access this workspace");
            return;
          }

          try {
            client.userId = authenticated.user.id;
            client.sessionId = authenticated.session.id;
            client.workspaceId = workspaceId;
            client.authenticated = true;
            client.syncState = "syncing";
            client.bufferedFeedRecords = [];

            registerAuthenticatedSocket({
              clientId,
              sessionId: authenticated.session.id,
              userId: authenticated.user.id,
              disconnect: (reason) => closeClient(clientId, reason),
            });

            // Clear auth timeout
            if (client.authTimer) {
              clearTimeout(client.authTimer);
              client.authTimer = undefined;
            }

            safeSendSocketEvent(clientId, {
              type: "auth.ok",
              payload: {
                connectionId: clientId,
                heartbeatMs: WS_HEARTBEAT_INTERVAL,
                workspaceId,
                lastWorkspaceSequence,
              },
            });

            await replayWorkspaceFeed(clientId, lastWorkspaceSequence);

            // Start heartbeat
            client.heartbeatTimer = setInterval(() => {
              if (socket.readyState === 1) {
                safeSendSocketEvent(clientId, {
                  type: "ping",
                  payload: { at: new Date().toISOString() },
                });
                // Expect pong within 10s
                client.pongTimer = setTimeout(() => {
                  // No pong received, close dead connection
                  try {
                    socket.close();
                  } catch {}
                  cleanup(clientId);
                }, 10000);
              }
            }, WS_HEARTBEAT_INTERVAL);
          } catch (err: any) {
            closeClient(clientId, "Session authentication failed");
          }
          return;
        }

        if (msg.type === "pong") {
          // Clear pong timeout
          if (client.pongTimer) {
            clearTimeout(client.pongTimer);
            client.pongTimer = undefined;
          }
          return;
        }
      } catch {
        // ignore parse errors
      }
    });

    socket.on("close", () => {
      cleanup(clientId);
    });

    socket.on("error", () => {
      cleanup(clientId);
    });
  });

  // Forward events to relevant WebSocket clients
  onEvent("*", async (event: SystemEvent) => {
    const outbound = mapInternalEventToSocketEvent(event);
    if (!outbound) return;

    const conversationId = getConversationIdFromSocketEvent(outbound);
    const isFeedItem = outbound.type === "feed.item.created";

    for (const [clientId, client] of clients) {
      if (
        !client.authenticated ||
        client.workspaceId !== event.workspaceId ||
        client.ws.readyState !== 1
      ) {
        continue;
      }

      if (conversationId) {
        const allowed = await canUserAccessConversation(
          conversationId,
          client.userId,
        );
        if (!allowed) {
          continue;
        }
      }

      if (isFeedItem && client.syncState !== "live") {
        bufferFeedRecord(
          client,
          (outbound as ChatSocketEvent<"feed.item.created">).payload,
        );
        continue;
      }

      if (!isFeedItem && client.syncState !== "live") {
        continue;
      }

      safeSendSocketEvent(clientId, outbound);
    }
  });
}

function cleanup(clientId: string) {
  const client = clients.get(clientId);
  if (client) {
    unregisterAuthenticatedSocket(clientId);
    if (client.authTimer) clearTimeout(client.authTimer);
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
    if (client.pongTimer) clearTimeout(client.pongTimer);
    clients.delete(clientId);
  }
}

export function broadcastToWorkspace(workspaceId: string, data: unknown) {
  const msg = JSON.stringify(data);
  for (const [, client] of clients) {
    if (
      client.authenticated &&
      client.workspaceId === workspaceId &&
      client.ws.readyState === 1
    ) {
      client.ws.send(msg);
    }
  }
}

export async function shutdownWebSockets(
  reason = "Synapse API server is shutting down",
) {
  for (const [clientId, client] of clients) {
    if (client.authTimer) clearTimeout(client.authTimer);
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
    if (client.pongTimer) clearTimeout(client.pongTimer);

    if (client.ws.readyState === 1) {
      try {
        client.ws.send(
          JSON.stringify({
            type: "server_shutdown",
            message: reason,
            retryable: true,
          }),
        );
      } catch {}
      try {
        client.ws.close(1012, "service restart");
      } catch {}
    }

    cleanup(clientId);
  }
}
