import type { FastifyInstance } from 'fastify';
import type { SystemEvent } from '@synapse/shared';
import { onEvent } from '../events/index.js';

interface WSClient {
  ws: any;
  userId: string;
  workspaceId?: string;
}

const clients: Map<string, WSClient> = new Map();

export function setupWebSocket(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket: any, req: any) => {
    const clientId = crypto.randomUUID();

    const client: WSClient = {
      ws: socket,
      userId: '',
    };
    clients.set(clientId, client);

    socket.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth') {
          client.userId = msg.userId;
          client.workspaceId = msg.workspaceId;
          socket.send(JSON.stringify({ type: 'auth_ok' }));
        }
      } catch {
        // ignore parse errors
      }
    });

    socket.on('close', () => {
      clients.delete(clientId);
    });
  });

  // Forward events to relevant WebSocket clients
  onEvent('*', (event: SystemEvent) => {
    for (const [, client] of clients) {
      if (client.workspaceId === event.workspaceId && client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(event));
      }
    }
  });
}

export function broadcastToWorkspace(workspaceId: string, data: unknown) {
  const msg = JSON.stringify(data);
  for (const [, client] of clients) {
    if (client.workspaceId === workspaceId && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  }
}
