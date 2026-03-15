import type { FastifyInstance } from 'fastify';
import { AUTH_SESSION_COOKIE_NAME } from '@synapse/shared';
import type { SystemEvent } from '@synapse/shared';
import { WS_AUTH_TIMEOUT, WS_HEARTBEAT_INTERVAL } from '@synapse/shared';
import { onEvent } from '../events/index.js';
import { authzEnabled, checkPermission } from '../authz/index.js';
import { query } from '../database/index.js';
import { handleRelayConnection } from '../../modules/mcp-plugins/relay-manager.js';
import { isShuttingDown } from '../shutdown/state.js';
import { authenticateSessionToken } from '../../modules/auth/service.js';
import {
  initAuthSessionRegistry,
  registerAuthenticatedSocket,
  unregisterAuthenticatedSocket,
} from './auth-session-registry.js';

interface WSClient {
  ws: any;
  userId: string;
  sessionId?: string;
  workspaceId?: string;
  authenticated: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
}

const clients: Map<string, WSClient> = new Map();

let appRef: FastifyInstance | null = null;

function parseCookieHeader(cookieHeader: string | string[] | undefined) {
  const source = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader || '';
  return source.split(';').reduce<Record<string, string>>((acc, part) => {
    const [key, ...rest] = part.split('=');
    const trimmedKey = key?.trim();
    if (!trimmedKey) return acc;
    acc[trimmedKey] = decodeURIComponent(rest.join('=').trim());
    return acc;
  }, {});
}

async function canUserAccessWorkspace(workspaceId: string, userId: string) {
  if (authzEnabled()) {
    return checkPermission({
      resourceType: 'workspace',
      resourceId: workspaceId,
      permission: 'view',
      subject: { type: 'user', id: userId },
    });
  }

  const result = await query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, userId],
  );

  return (result.rowCount ?? 0) > 0;
}

function closeClient(clientId: string, message: string, closeCode = 1008) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.ws.readyState === 1) {
    try {
      client.ws.send(JSON.stringify({ type: 'auth_error', message }));
    } catch {}
  }

  try {
    if (client.ws.readyState === 0 || client.ws.readyState === 1) {
      client.ws.close(closeCode, message);
    }
  } catch {}

  cleanup(clientId);
}

export function setupWebSocket(app: FastifyInstance) {
  appRef = app;
  void initAuthSessionRegistry().catch((error) => {
    app.log.error({ error }, 'Failed to initialize auth session registry');
  });

  app.addHook('onRequest', async (request, reply) => {
    const isUpgrade = request.headers.upgrade?.toLowerCase() === 'websocket';
    if (isUpgrade && isShuttingDown()) {
      return reply.code(503).send({
        error: 'Server shutting down',
        message: 'WebSocket connections are temporarily unavailable while the server is shutting down.',
      });
    }
  });

  // Relay agent WebSocket endpoint
  app.get('/ws/relay', { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(JSON.stringify({
          type: 'server_shutdown',
          message: 'Synapse API server is shutting down',
          retryable: true,
        }));
      } catch {}
      try { socket.close(1012, 'service restart'); } catch {}
      return;
    }
    handleRelayConnection(socket, req, app);
  });

  app.get('/ws', { websocket: true }, (socket: any, req: any) => {
    if (isShuttingDown()) {
      try {
        socket.send(JSON.stringify({
          type: 'server_shutdown',
          message: 'Synapse API server is shutting down',
          retryable: true,
        }));
      } catch {}
      try { socket.close(1012, 'service restart'); } catch {}
      return;
    }

    const clientId = crypto.randomUUID();

    const client: WSClient = {
      ws: socket,
      userId: '',
      authenticated: false,
    };
    clients.set(clientId, client);

    // Auth timeout - must authenticate within WS_AUTH_TIMEOUT
    client.authTimer = setTimeout(() => {
      if (!client.authenticated) {
        closeClient(clientId, 'Authentication timeout');
      }
    }, WS_AUTH_TIMEOUT);

    const cookieToken = parseCookieHeader(req.headers.cookie)[AUTH_SESSION_COOKIE_NAME];

    socket.on('message', async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'auth') {
          const workspaceId = typeof msg.workspaceId === 'string' ? msg.workspaceId : '';
          const token = typeof msg.token === 'string' && msg.token.trim().length > 0
            ? msg.token.trim()
            : cookieToken;

          if (!token) {
            closeClient(clientId, 'No session provided');
            return;
          }

          if (!workspaceId) {
            closeClient(clientId, 'No workspace selected');
            return;
          }

          const authenticated = await authenticateSessionToken(token);
          if (!authenticated) {
            closeClient(clientId, 'Invalid or expired session');
            return;
          }

          const canAccessWorkspace = await canUserAccessWorkspace(workspaceId, authenticated.user.id);
          if (!canAccessWorkspace) {
            closeClient(clientId, 'Not allowed to access this workspace');
            return;
          }

          try {
            client.userId = authenticated.user.id;
            client.sessionId = authenticated.session.id;
            client.workspaceId = workspaceId;
            client.authenticated = true;

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

            socket.send(JSON.stringify({ type: 'auth_ok' }));

            // Start heartbeat
            client.heartbeatTimer = setInterval(() => {
              if (socket.readyState === 1) {
                socket.send(JSON.stringify({ type: 'ping' }));
                // Expect pong within 10s
                client.pongTimer = setTimeout(() => {
                  // No pong received, close dead connection
                  try { socket.close(); } catch {}
                  cleanup(clientId);
                }, 10000);
              }
            }, WS_HEARTBEAT_INTERVAL);
          } catch (err: any) {
            closeClient(clientId, 'Session authentication failed');
          }
          return;
        }

        if (msg.type === 'pong') {
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

    socket.on('close', () => {
      cleanup(clientId);
    });

    socket.on('error', () => {
      cleanup(clientId);
    });
  });

  // Forward events to relevant WebSocket clients
  onEvent('*', (event: SystemEvent) => {
    for (const [, client] of clients) {
      if (client.authenticated && client.workspaceId === event.workspaceId && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(event));
      }
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
    if (client.authenticated && client.workspaceId === workspaceId && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}

export async function shutdownWebSockets(reason = 'Synapse API server is shutting down') {
  for (const [clientId, client] of clients) {
    if (client.authTimer) clearTimeout(client.authTimer);
    if (client.heartbeatTimer) clearInterval(client.heartbeatTimer);
    if (client.pongTimer) clearTimeout(client.pongTimer);

    if (client.ws.readyState === 1) {
      try {
        client.ws.send(JSON.stringify({
          type: 'server_shutdown',
          message: reason,
          retryable: true,
        }));
      } catch {}
      try { client.ws.close(1012, 'service restart'); } catch {}
    }

    cleanup(clientId);
  }
}
