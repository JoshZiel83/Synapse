import type { FastifyInstance } from 'fastify';
import type { SystemEvent } from '@synapse/shared';
import { WS_AUTH_TIMEOUT, WS_HEARTBEAT_INTERVAL } from '@synapse/shared';
import { onEvent } from '../events/index.js';
import { handleRelayConnection } from '../../modules/mcp-plugins/relay-manager.js';

interface WSClient {
  ws: any;
  userId: string;
  workspaceId?: string;
  authenticated: boolean;
  authTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
}

const clients: Map<string, WSClient> = new Map();

let appRef: FastifyInstance | null = null;

export function setupWebSocket(app: FastifyInstance) {
  appRef = app;

  // Relay agent WebSocket endpoint
  app.get('/ws/relay', { websocket: true }, (socket: any, req: any) => {
    handleRelayConnection(socket, req, app);
  });

  app.get('/ws', { websocket: true }, (socket: any, req: any) => {
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
        try {
          socket.send(JSON.stringify({ type: 'auth_error', message: 'Authentication timeout' }));
        } catch {}
        socket.close();
        clients.delete(clientId);
      }
    }, WS_AUTH_TIMEOUT);

    socket.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'auth') {
          // JWT auth: verify token
          const token = msg.token;
          if (!token) {
            socket.send(JSON.stringify({ type: 'auth_error', message: 'No token provided' }));
            socket.close();
            clients.delete(clientId);
            return;
          }

          try {
            const decoded = app.jwt.verify<{ userId: string; email: string }>(token);
            client.userId = decoded.userId;
            client.workspaceId = msg.workspaceId;
            client.authenticated = true;

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
            socket.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            socket.close();
            clients.delete(clientId);
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
