import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { ToolDefinition } from '@synapse/shared';
import { RELAY_AUTH_TIMEOUT, RELAY_HEARTBEAT_INTERVAL, RELAY_TOOL_CALL_TIMEOUT } from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import { incrementMcpVersion } from './instance-manager.js';
import { logEvent } from './audit.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { createOrganization, createPlugin } from './service.js';

// ============ Types ============

interface ConnectedRelay {
  relayId: string;
  workspaceId: string | null;
  userId: string | null;
  ws: any; // WebSocket
  servers: Map<string, { tools: ToolDefinition[]; transport: string }>;
  pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  heartbeatTimer: NodeJS.Timeout | null;
  pongTimer: NodeJS.Timeout | null;
}

// ============ State ============

const connectedRelays = new Map<string, ConnectedRelay>();

// ============ Public API ============

/**
 * Main WebSocket handler for /ws/relay endpoint
 */
export function handleRelayConnection(socket: any, req: any, app: FastifyInstance) {
  let relayId: string | null = null;
  let authenticated = false;
  let authInProgress = false; // guard against concurrent auth attempts

  // Auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      try { socket.send(JSON.stringify({ type: 'auth_error', message: 'Authentication timeout' })); } catch {}
      socket.close();
    }
  }, RELAY_AUTH_TIMEOUT);

  socket.on('message', async (raw: any) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      // Unparseable message — ignore
      return;
    }

    // ---- Auth ----
    if (msg.type === 'auth') {
      // Guard: reject if already authenticated or auth in progress
      if (authenticated) {
        socket.send(JSON.stringify({ type: 'auth_error', message: 'Already authenticated' }));
        return;
      }
      if (authInProgress) {
        socket.send(JSON.stringify({ type: 'auth_error', message: 'Authentication in progress' }));
        return;
      }
      authInProgress = true;
      clearTimeout(authTimer);

      try {
        const relay = await authenticateRelay(msg.token);
        if (!relay) {
          socket.send(JSON.stringify({ type: 'auth_error', message: 'Invalid or unknown token' }));
          socket.close();
          return;
        }

        // Check duplicate connection
        const existing = connectedRelays.get(relay.id);
        if (existing) {
          // Check if old WS is still alive
          if (existing.ws.readyState === 1) {
            socket.send(JSON.stringify({ type: 'auth_error', message: 'Relay already connected' }));
            socket.close();
            return;
          }
          // Old connection is dead, clean up
          cleanupRelay(relay.id);
        }

        relayId = relay.id;
        authenticated = true;

        const connected: ConnectedRelay = {
          relayId: relay.id,
          workspaceId: relay.workspace_id,
          userId: relay.user_id,
          ws: socket,
          servers: new Map(),
          pendingRequests: new Map(),
          heartbeatTimer: null,
          pongTimer: null,
        };
        connectedRelays.set(relay.id, connected);

        await onRelayAuthenticated(relay.id);

        socket.send(JSON.stringify({ type: 'auth_ok', relayId: relay.id }));

        // Start heartbeat
        connected.heartbeatTimer = setInterval(() => {
          if (socket.readyState === 1) {
            // Clear any lingering pongTimer before sending a new ping
            if (connected.pongTimer) {
              clearTimeout(connected.pongTimer);
              connected.pongTimer = null;
            }
            socket.send(JSON.stringify({ type: 'ping' }));
            connected.pongTimer = setTimeout(() => {
              // No pong received — connection dead
              console.warn(`[Relay Manager] Pong timeout for relay ${relay.id}`);
              try { socket.close(); } catch {}
              cleanupRelay(relay.id);
            }, 10000);
          }
        }, RELAY_HEARTBEAT_INTERVAL);
      } catch (err: any) {
        console.error('[Relay Manager] Auth error:', err.message);
        try { socket.send(JSON.stringify({ type: 'auth_error', message: 'Internal error during authentication' })); } catch {}
        socket.close();
      } finally {
        authInProgress = false;
      }
      return;
    }

    if (!authenticated || !relayId) {
      socket.send(JSON.stringify({ type: 'auth_error', message: 'Not authenticated' }));
      return;
    }

    // ---- Pong ----
    if (msg.type === 'pong') {
      const connected = connectedRelays.get(relayId);
      if (connected?.pongTimer) {
        clearTimeout(connected.pongTimer);
        connected.pongTimer = null;
      }
      return;
    }

    // ---- Servers Register ----
    if (msg.type === 'servers_register') {
      try {
        const error = await onServersRegister(relayId, msg.servers || []);
        if (error) {
          socket.send(JSON.stringify({ type: 'servers_register_error', message: error }));
        } else {
          socket.send(JSON.stringify({ type: 'servers_registered' }));
        }
      } catch (err: any) {
        console.error('[Relay Manager] servers_register error:', err.message);
        socket.send(JSON.stringify({ type: 'servers_register_error', message: 'Internal error during registration' }));
      }
      return;
    }

    // ---- JSON-RPC Response (tool call result from agent) ----
    if (msg.jsonrpc === '2.0' && msg.id && (msg.result !== undefined || msg.error)) {
      const connected = connectedRelays.get(relayId);
      if (!connected) return;

      const pending = connected.pendingRequests.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      connected.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'Relay tool call failed'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (relayId) {
      cleanupRelay(relayId);
    }
  });

  socket.on('error', () => {
    clearTimeout(authTimer);
    if (relayId) {
      cleanupRelay(relayId);
    }
  });
}

/**
 * Send a tool call to a connected relay agent and wait for response
 */
export async function callRelayTool(
  relayId: string,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | unknown[]> {
  const connected = connectedRelays.get(relayId);
  if (!connected || connected.ws.readyState !== 1) {
    throw new Error(`Relay ${relayId} is not connected`);
  }

  const requestId = crypto.randomUUID();

  return new Promise<string | unknown[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      connected.pendingRequests.delete(requestId);
      reject(new Error(`Relay tool call timed out after ${RELAY_TOOL_CALL_TIMEOUT}ms`));
    }, RELAY_TOOL_CALL_TIMEOUT);

    connected.pendingRequests.set(requestId, {
      resolve: (result: any) => {
        // Pass through raw MCP content array (text, image, resource, etc.)
        if (typeof result === 'string') {
          resolve(result);
        } else if (result?.content) {
          if (typeof result.content === 'string') {
            resolve(result.content);
          } else if (Array.isArray(result.content)) {
            resolve(result.content);
          } else {
            resolve(JSON.stringify(result.content));
          }
        } else {
          resolve(JSON.stringify(result));
        }
      },
      reject,
      timer,
    });

    const rpcMessage = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { server: serverName, tool: toolName, arguments: args },
    };

    try {
      connected.ws.send(JSON.stringify(rpcMessage));
    } catch (err: any) {
      clearTimeout(timer);
      connected.pendingRequests.delete(requestId);
      reject(new Error(`Failed to send to relay: ${err.message}`));
    }
  });
}

/**
 * Get tools from all connected relay servers for a given workspace/user
 */
export function getConnectedRelayServers(workspaceId: string, userId?: string): Array<{
  relayId: string;
  relayName: string;
  serverName: string;
  tools: ToolDefinition[];
  transport: string;
}> {
  const results: Array<{
    relayId: string;
    relayName: string;
    serverName: string;
    tools: ToolDefinition[];
    transport: string;
  }> = [];

  for (const [, relay] of connectedRelays) {
    if (relay.workspaceId !== workspaceId) continue;

    for (const [serverName, serverInfo] of relay.servers) {
      results.push({
        relayId: relay.relayId,
        relayName: relay.relayId.slice(0, 8),
        serverName,
        tools: serverInfo.tools,
        transport: serverInfo.transport,
      });
    }
  }

  return results;
}

/**
 * Force-disconnect a relay by ID
 */
export function disconnectRelay(relayId: string) {
  const connected = connectedRelays.get(relayId);
  if (connected) {
    try { connected.ws.close(); } catch {}
    cleanupRelay(relayId);
  }
}

/**
 * Check if a relay is connected in-memory
 */
export function isRelayConnected(relayId: string): boolean {
  const connected = connectedRelays.get(relayId);
  return !!connected && connected.ws.readyState === 1;
}

/**
 * Initialize relay manager — reset stale is_connected flags on startup
 */
export async function initRelayManager() {
  await query(`UPDATE mcp_relays SET is_connected = FALSE WHERE is_connected = TRUE`);
  console.log('[Relay Manager] Initialized, stale connections cleared');
}

/**
 * Shutdown all relay connections (for process exit)
 */
export async function shutdownAllRelays() {
  for (const [, connected] of connectedRelays) {
    if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer);
    if (connected.pongTimer) clearTimeout(connected.pongTimer);
    for (const [, pending] of connected.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
    }
    try { connected.ws.close(); } catch {}
  }
  connectedRelays.clear();
  await query(`UPDATE mcp_relays SET is_connected = FALSE WHERE is_connected = TRUE`).catch(() => {});
  console.log('[Relay Manager] All relay connections closed');
}

// ============ Internal helpers ============

async function authenticateRelay(token: string): Promise<any> {
  if (!token) return null;
  const result = await query(
    `SELECT id, user_id, workspace_id, name, is_connected FROM mcp_relays WHERE auth_token = $1`,
    [token]
  );
  return result.rows[0] || null;
}

async function onRelayAuthenticated(relayId: string) {
  await query(
    `UPDATE mcp_relays SET is_connected = TRUE, last_connected_at = NOW() WHERE id = $1`,
    [relayId]
  );

  const connected = connectedRelays.get(relayId);

  logEvent({
    workspaceId: connected?.workspaceId || undefined,
    relayId,
    eventType: 'relay.connected',
    eventData: {},
  });

  if (connected?.workspaceId) {
    emitEvent({
      type: 'relay.connected',
      workspaceId: connected.workspaceId,
      payload: { relayId },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Process servers_register. Returns error string if validation fails, null on success.
 * Creates/updates mcp_plugins records for each server so relay tools go through
 * the unified mcp_installations authorization system.
 */
async function onServersRegister(
  relayId: string,
  servers: Array<{ name: string; tools: ToolDefinition[]; transport?: string }>,
): Promise<string | null> {
  const connected = connectedRelays.get(relayId);
  if (!connected) return 'Relay not found in connection map';

  // Validate names (no __ separator allowed)
  for (const server of servers) {
    if (server.name.includes('__')) {
      return `Server name "${server.name}" must not contain "__"`;
    }
    if (!server.name || server.name.length > 255) {
      return `Server name must be 1-255 characters`;
    }
  }

  // Update in-memory state
  connected.servers.clear();
  for (const server of servers) {
    connected.servers.set(server.name, {
      tools: server.tools || [],
      transport: server.transport || 'stdio',
    });
  }

  // Upsert into DB (relay_servers as raw metadata)
  await query(`DELETE FROM mcp_relay_servers WHERE relay_id = $1`, [relayId]);
  for (const server of servers) {
    await query(
      `INSERT INTO mcp_relay_servers (relay_id, name, transport, tools_manifest, is_enabled)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [relayId, server.name, server.transport || 'stdio', JSON.stringify(server.tools || [])]
    );
  }

  // Create/update mcp_plugins records for unified authorization
  if (connected.workspaceId) {
    try {
      const org = await findOrCreateRelayOrg(relayId, connected);
      const activeSlugs: string[] = [];

      for (const server of servers) {
        const slug = sanitizeServerName(server.name);
        activeSlugs.push(slug);

        // Get relay name for display
        const relayResult = await query('SELECT name FROM mcp_relays WHERE id = $1', [relayId]);
        const relayName = relayResult.rows[0]?.name || relayId.slice(0, 8);

        const plugin = await createPlugin({
          orgId: org.id,
          slug,
          displayName: `${relayName} / ${server.name}`,
          description: `Relay server: ${server.name}`,
          transport: 'relay',
          entryPoint: JSON.stringify({ relayId, serverName: server.name }),
          lifecycleScope: 'session',
          toolsManifest: server.tools || [],
        });

        // Ensure is_active = true (may have been set to false on disconnect)
        await query('UPDATE mcp_plugins SET is_active = TRUE WHERE id = $1', [plugin.id]);

        // Ensure default workspace-scope installation exists
        await ensureDefaultInstallation(connected.workspaceId, plugin.id);
      }

      // Deactivate stale plugins (servers no longer in the list)
      await deactivateStaleRelayPlugins(org.id, activeSlugs);
    } catch (err: any) {
      console.error('[Relay Manager] Failed to create plugin records:', err.message);
    }

    await incrementMcpVersion(connected.workspaceId);

    emitEvent({
      type: 'relay.servers_updated',
      workspaceId: connected.workspaceId,
      payload: { relayId, serverCount: servers.length },
      timestamp: new Date().toISOString(),
    });
  }

  logEvent({
    workspaceId: connected.workspaceId || undefined,
    relayId,
    eventType: 'relay.servers_registered',
    eventData: { serverCount: servers.length, serverNames: servers.map(s => s.name) },
  });

  return null; // success
}

function cleanupRelay(relayId: string) {
  const connected = connectedRelays.get(relayId);
  if (!connected) return;

  // Clear timers
  if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer);
  if (connected.pongTimer) clearTimeout(connected.pongTimer);

  // Fail all pending requests
  for (const [, pending] of connected.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Relay disconnected'));
  }

  connectedRelays.delete(relayId);

  // Update DB
  query(`UPDATE mcp_relays SET is_connected = FALSE WHERE id = $1`, [relayId]).catch(() => {});

  // Mark relay's plugins as inactive — resolveTools query filters on p.is_active = TRUE
  findRelayOrg(relayId).then(org => {
    if (org) {
      query('UPDATE mcp_plugins SET is_active = FALSE WHERE org_id = $1 AND transport = $2', [org.id, 'relay']).catch(() => {});
    }
  }).catch(() => {});

  // Bump MCP version so tools disappear from active sessions
  if (connected.workspaceId) {
    incrementMcpVersion(connected.workspaceId).catch(() => {});

    emitEvent({
      type: 'relay.disconnected',
      workspaceId: connected.workspaceId,
      payload: { relayId },
      timestamp: new Date().toISOString(),
    });
  }

  logEvent({
    workspaceId: connected.workspaceId || undefined,
    relayId,
    eventType: 'relay.disconnected',
    eventData: {},
  });
}

// ============ Relay Plugin Helpers ============

function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

async function findOrCreateRelayOrg(relayId: string, connected: ConnectedRelay) {
  const slug = `relay_${relayId.slice(0, 8)}`;
  const relayResult = await query('SELECT name FROM mcp_relays WHERE id = $1', [relayId]);
  const relayName = relayResult.rows[0]?.name || relayId.slice(0, 8);

  return createOrganization({
    slug,
    displayName: `Relay: ${relayName}`,
    description: `Auto-created organization for relay agent ${relayName}`,
    isBuiltin: false,
    isVerified: false,
  });
}

async function findRelayOrg(relayId: string) {
  const slug = `relay_${relayId.slice(0, 8)}`;
  const result = await query('SELECT * FROM mcp_organizations WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

async function ensureDefaultInstallation(workspaceId: string, pluginId: string) {
  const existing = await query(
    'SELECT id FROM mcp_installations WHERE plugin_id = $1 AND workspace_id = $2',
    [pluginId, workspaceId]
  );
  if (existing.rows.length > 0) return; // already has installation(s)

  await query(
    `INSERT INTO mcp_installations (workspace_id, plugin_id, scope_type, scope_id, lifecycle_scope, is_enabled)
     VALUES ($1, $2, 'workspace', $1, 'session', TRUE)
     ON CONFLICT (plugin_id, scope_type, scope_id) DO NOTHING`,
    [workspaceId, pluginId]
  );
}

async function deactivateStaleRelayPlugins(orgId: string, activeSlugs: string[]) {
  if (activeSlugs.length === 0) {
    await query('UPDATE mcp_plugins SET is_active = FALSE WHERE org_id = $1 AND transport = $2', [orgId, 'relay']);
    return;
  }
  await query(
    `UPDATE mcp_plugins SET is_active = FALSE
     WHERE org_id = $1 AND transport = 'relay' AND slug != ALL($2)`,
    [orgId, activeSlugs]
  );
}
