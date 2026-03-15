import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type {
  RelayCatalogToolSnapshot,
  RelayHiddenToolBinding,
  RelayOperationError,
  RelayVisibleToolDefinition,
} from '@synapse/shared';
import {
  RELAY_AUTH_TIMEOUT,
  RELAY_DELIVERY_ACK_TIMEOUT_MS,
  RELAY_HEARTBEAT_INTERVAL,
  RELAY_OPERATION_TTL_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOOL_CALL_TIMEOUT,
} from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import { incrementMcpVersion } from './instance-manager.js';
import { logEvent } from './audit.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { createOrganization, createPlugin } from './service.js';

interface RelayToolRegistration {
  stableKey: string;
  visible: RelayVisibleToolDefinition;
  annotations: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface RelayExposureRegistration {
  stableKey: string;
  syncSourceKey: string | null;
  displayName: string;
  transport: 'stdio' | 'http' | 'sse' | 'custom';
  runtimeStatus: 'discovered' | 'starting' | 'healthy' | 'degraded' | 'failed' | 'quarantined' | 'offline';
  managementMode: 'manual' | 'imported' | 'mirrored' | 'managed';
  metadata: Record<string, unknown>;
  tools: RelayToolRegistration[];
}

interface RelaySyncSourceRegistration {
  sourceKind: 'manual' | 'claude_code' | 'claude_desktop' | 'codex' | 'gemini' | 'opencode' | 'custom';
  sourceKey: string;
  configPath: string | null;
  syncMode: 'import_only' | 'observe' | 'mirror' | 'managed' | 'detached';
  status: 'unknown' | 'idle' | 'syncing' | 'error' | 'disabled';
  lastSyncedAt: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
}

interface ConnectedRelayExposure {
  exposureId: string;
  stableKey: string;
  displayName: string;
  transport: string;
  runtimeStatus: string;
  tools: RelayCatalogToolSnapshot[];
}

interface PendingRelayOperation {
  operationId: string;
  deviceId: string;
  workspaceId: string;
  exposureId: string;
  exposureStableKey: string;
  visibleToolName: string;
  toolId: string;
  toolRevisionId: string;
  catalogRevisionId: string;
  args: Record<string, unknown>;
  inputHash: string;
  timeoutTimer: NodeJS.Timeout;
  ackTimer: NodeJS.Timeout | null;
  relaySessionRowId: string | null;
  deliverySeq: number | null;
  deliveryId: string | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ConnectedRelay {
  deviceId: string;
  workspaceId: string;
  ownerUserId: string | null;
  displayName: string;
  sessionRowId: string;
  sessionId: string;
  ws: any;
  exposures: Map<string, ConnectedRelayExposure>;
  heartbeatTimer: NodeJS.Timeout | null;
  pongTimer: NodeJS.Timeout | null;
  nextDeliverySeq: number;
}

interface RelayExposureCatalog {
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureDisplayName: string;
  transport: string;
  tools: RelayCatalogToolSnapshot[];
}

interface RelayCallParams {
  deviceId: string;
  exposureId: string;
  visibleToolName: string;
  binding: RelayHiddenToolBinding;
  args: Record<string, unknown>;
}

type RelayAuthRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string | null;
  display_name: string;
  public_key: string;
  public_key_fingerprint: string;
  trust_status: 'pending' | 'active' | 'revoked' | 'blocked';
};

const connectedRelays = new Map<string, ConnectedRelay>();
const pendingRelayOperations = new Map<string, PendingRelayOperation>();

export function handleRelayConnection(socket: any, _req: any, _app: FastifyInstance) {
  let deviceId: string | null = null;
  let authenticated = false;
  let authInProgress = false;
  let pendingChallenge: {
    device: RelayAuthRow;
    challenge: string;
    nonce: string;
    protocolVersion: number;
    clientVersion: string | null;
  } | null = null;

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      try {
        sendAuthError(socket, 'auth_timeout', 'Authentication timeout', true);
      } catch {}
      socket.close();
    }
  }, RELAY_AUTH_TIMEOUT);

  socket.on('message', async (raw: any) => {
    const msg = parseMessage(raw);
    if (!msg) return;

    if (msg.type === 'auth.begin') {
      if (authenticated) {
        sendAuthError(socket, 'already_authenticated', 'Already authenticated', false);
        return;
      }
      if (authInProgress) {
        sendAuthError(socket, 'auth_in_progress', 'Authentication in progress', true);
        return;
      }
      authInProgress = true;
      clearTimeout(authTimer);

      try {
        const device = await authenticateRelayDevice(msg.deviceId);
        if (!device) {
          sendAuthError(socket, 'unknown_device', 'Unknown device', false);
          socket.close();
          return;
        }

        if (device.trust_status !== 'active') {
          sendAuthError(socket, `device_${device.trust_status}`, `Device trust status is ${device.trust_status}`, false);
          socket.close();
          return;
        }

        if (typeof msg.publicKeyFingerprint === 'string' && msg.publicKeyFingerprint !== device.public_key_fingerprint) {
          sendAuthError(socket, 'public_key_fingerprint_mismatch', 'Public key fingerprint mismatch', false);
          socket.close();
          return;
        }

        pendingChallenge = {
          device,
          challenge: crypto.randomUUID(),
          nonce: crypto.randomBytes(32).toString('base64url'),
          protocolVersion: Number.isFinite(msg.protocolVersion) ? Number(msg.protocolVersion) : RELAY_PROTOCOL_VERSION,
          clientVersion: typeof msg.clientVersion === 'string' ? msg.clientVersion : null,
        };
        socket.send(JSON.stringify({
          type: 'auth.challenge',
          deviceId: device.id,
          challenge: pendingChallenge.challenge,
          nonce: pendingChallenge.nonce,
        }));
      } catch (error: any) {
        console.error('[Relay Manager] Auth error:', error.message);
        try {
          sendAuthError(socket, 'auth_internal_error', 'Internal error during authentication', true);
        } catch {}
        socket.close();
      } finally {
        authInProgress = false;
      }
      return;
    }

    if (msg.type === 'auth.finish') {
      if (authenticated) {
        sendAuthError(socket, 'already_authenticated', 'Already authenticated', false);
        return;
      }
      if (!pendingChallenge) {
        sendAuthError(socket, 'auth_challenge_missing', 'No auth challenge in progress', true);
        socket.close();
        return;
      }
      if (msg.deviceId !== pendingChallenge.device.id || msg.challenge !== pendingChallenge.challenge) {
        sendAuthError(socket, 'auth_challenge_mismatch', 'Auth challenge mismatch', false);
        socket.close();
        return;
      }

      try {
        const verified = verifyRelayAuthSignature(
          pendingChallenge.device.public_key,
          pendingChallenge.device.id,
          pendingChallenge.challenge,
          pendingChallenge.nonce,
          typeof msg.signature === 'string' ? msg.signature : '',
        );
        if (!verified) {
          sendAuthError(socket, 'invalid_auth_signature', 'Invalid auth signature', false);
          socket.close();
          return;
        }

        const existing = connectedRelays.get(pendingChallenge.device.id);
        if (existing) {
          if (existing.ws.readyState === 1) {
            sendAuthError(socket, 'device_already_connected', 'Device already connected', true);
            socket.close();
            return;
          }
          cleanupRelay(pendingChallenge.device.id);
        }

        const sessionId = crypto.randomUUID();
        const sessionResult = await query(
          `INSERT INTO relay_device_sessions (
             device_id, protocol_version, client_version, status, transport, remote_addr, last_heartbeat_at, metadata
           )
           VALUES ($1, $2, $3, 'active', 'websocket', $4, NOW(), $5)
           RETURNING id`,
          [
            pendingChallenge.device.id,
            pendingChallenge.protocolVersion,
            pendingChallenge.clientVersion,
            typeof _req?.socket?.remoteAddress === 'string' ? _req.socket.remoteAddress : null,
            JSON.stringify({ sessionId }),
          ],
        );

        deviceId = pendingChallenge.device.id;
        authenticated = true;

        const connected: ConnectedRelay = {
          deviceId: pendingChallenge.device.id,
          workspaceId: pendingChallenge.device.workspace_id,
          ownerUserId: pendingChallenge.device.owner_user_id,
          displayName: pendingChallenge.device.display_name,
          sessionRowId: sessionResult.rows[0].id,
          sessionId,
          ws: socket,
          exposures: new Map(),
          heartbeatTimer: null,
          pongTimer: null,
          nextDeliverySeq: 1,
        };
        connectedRelays.set(connected.deviceId, connected);

        await onRelayAuthenticated(connected);

        socket.send(JSON.stringify({
          type: 'auth_ok',
          protocolVersion: RELAY_PROTOCOL_VERSION,
          deviceId: connected.deviceId,
          sessionId: connected.sessionId,
        }));

        connected.heartbeatTimer = setInterval(() => {
          if (socket.readyState !== 1) return;
          if (connected.pongTimer) {
            clearTimeout(connected.pongTimer);
            connected.pongTimer = null;
          }
          socket.send(JSON.stringify({
            type: 'ping',
            sessionId: connected.sessionId,
            protocolVersion: RELAY_PROTOCOL_VERSION,
          }));
          connected.pongTimer = setTimeout(() => {
            try {
              socket.close();
            } catch {}
            cleanupRelay(connected.deviceId);
          }, 10_000);
        }, RELAY_HEARTBEAT_INTERVAL);
      } catch (error: any) {
        console.error('[Relay Manager] Auth finish error:', error.message);
        try {
          sendAuthError(socket, 'auth_internal_error', 'Internal error during authentication', true);
        } catch {}
        socket.close();
      } finally {
        pendingChallenge = null;
      }
      return;
    }

    if (!authenticated || !deviceId) {
      sendAuthError(socket, 'not_authenticated', 'Not authenticated', false);
      return;
    }

    const connected = connectedRelays.get(deviceId);
    if (!connected) return;

    if (msg.type === 'pong') {
      if (connected.pongTimer) {
        clearTimeout(connected.pongTimer);
        connected.pongTimer = null;
      }
      void query(
        `UPDATE relay_device_sessions SET last_heartbeat_at = NOW() WHERE id = $1`,
        [connected.sessionRowId],
      ).catch(() => {});
      return;
    }

    if (msg.type === 'catalog.sync') {
      try {
        const syncSources = normalizeSyncSourceRegistrations(msg);
        const exposures = normalizeExposureRegistrations(msg);
        const error = await syncDeviceCatalog(connected, syncSources, exposures);
        if (error) {
          socket.send(JSON.stringify({ type: 'catalog.sync_error', code: 'catalog_sync_rejected', message: error, retryable: true }));
        } else {
          void redrivePendingRelayOperations(connected);
          socket.send(JSON.stringify({ type: 'catalog.synced', exposureCount: exposures.length }));
        }
      } catch (error: any) {
        console.error('[Relay Manager] catalog sync error:', error.message);
        socket.send(JSON.stringify({ type: 'catalog.sync_error', code: 'catalog_sync_internal_error', message: 'Internal error during catalog sync', retryable: true }));
      }
      return;
    }

    if (msg.type === 'operation.received' && typeof msg.operationId === 'string') {
      await markOperationStatus(msg.operationId, 'received');
      await markDeliveryAcknowledged(msg.operationId, typeof msg.deliveryId === 'string' ? msg.deliveryId : undefined);
      return;
    }

    if (msg.type === 'operation.started' && typeof msg.operationId === 'string') {
      await markOperationStatus(msg.operationId, 'started');
      await markDeliveryAcknowledged(msg.operationId, typeof msg.deliveryId === 'string' ? msg.deliveryId : undefined);
      return;
    }

    if (msg.type === 'operation.result' && typeof msg.operationId === 'string') {
      await resolveOperationResult(connected, msg);
      return;
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (deviceId) cleanupRelay(deviceId);
  });

  socket.on('error', () => {
    clearTimeout(authTimer);
    if (deviceId) cleanupRelay(deviceId);
  });
}

export async function callRelayTool(params: RelayCallParams): Promise<unknown> {
  const connected = connectedRelays.get(params.deviceId);
  if (!connected || connected.ws.readyState !== 1) {
    throw buildRelayExecutionError({
      code: 'mcp_unavailable',
      message: `Relay device ${params.deviceId} is not connected`,
      retryable: true,
    });
  }

  const exposure = connected.exposures.get(params.exposureId);
  if (!exposure) {
    throw buildRelayExecutionError({
      code: 'mcp_unavailable',
      message: `Relay exposure ${params.exposureId} is not available`,
      retryable: true,
    });
  }

  const currentTool = exposure.tools.find((tool) => tool.binding.toolId === params.binding.toolId);
  if (!currentTool || currentTool.visible.name !== params.visibleToolName) {
    throw buildRelayExecutionError({
      code: 'tool_removed',
      message: `Tool "${params.visibleToolName}" is no longer available`,
      retryable: true,
      requiresReplan: true,
    });
  }

  if (
    currentTool.binding.catalogRevisionId !== params.binding.catalogRevisionId ||
    currentTool.binding.toolRevisionId !== params.binding.toolRevisionId
  ) {
    throw buildRelayExecutionError({
      code: 'tool_definition_changed',
      message: `Tool "${params.visibleToolName}" changed after planning. Re-read the latest tool definition before retrying.`,
      retryable: true,
      requiresReplan: true,
      currentToolRevisionId: currentTool.binding.toolRevisionId,
    });
  }

  const operationId = crypto.randomUUID();
  const inputHash = hashValue(params.args);

  await query(
    `INSERT INTO relay_operations (
       id, workspace_id, device_id, exposure_id, catalog_revision_id, tool_id, tool_revision_id,
       visible_tool_name, status, input_payload, input_hash, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'created', $9, $10, NOW(), NOW())`,
    [
      operationId,
      connected.workspaceId,
      params.deviceId,
      params.exposureId,
      params.binding.catalogRevisionId,
      params.binding.toolId,
      params.binding.toolRevisionId,
      params.visibleToolName,
      JSON.stringify(params.args),
      inputHash,
    ],
  );

  return new Promise<unknown>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      const pending = pendingRelayOperations.get(operationId);
      if (!pending) return;

      clearPendingRelayOperation(pending);
      pendingRelayOperations.delete(operationId);
      void failOperation(operationId, 'delivery_timed_out', `Relay operation timed out after ${RELAY_TOOL_CALL_TIMEOUT}ms`, true, false);
      reject(buildRelayExecutionError({
        code: 'delivery_timed_out',
        message: `Relay operation timed out after ${RELAY_TOOL_CALL_TIMEOUT}ms`,
        retryable: true,
      }));
    }, Math.min(RELAY_TOOL_CALL_TIMEOUT, RELAY_OPERATION_TTL_MS));

    const pending: PendingRelayOperation = {
      operationId,
      deviceId: connected.deviceId,
      workspaceId: connected.workspaceId,
      exposureId: params.exposureId,
      exposureStableKey: exposure.stableKey,
      visibleToolName: currentTool.visible.name,
      toolId: params.binding.toolId,
      toolRevisionId: params.binding.toolRevisionId,
      catalogRevisionId: params.binding.catalogRevisionId,
      args: params.args,
      inputHash,
      timeoutTimer,
      ackTimer: null,
      relaySessionRowId: null,
      deliverySeq: null,
      deliveryId: null,
      resolve,
      reject,
    };
    pendingRelayOperations.set(operationId, pending);

    void dispatchPendingRelayOperation(connected, pending);
  });
}

async function dispatchPendingRelayOperation(connected: ConnectedRelay, pending: PendingRelayOperation) {
  try {
    if (pendingRelayOperations.get(pending.operationId) !== pending) {
      return;
    }
    if (connected.ws.readyState !== 1) {
      return;
    }

    const exposure = connected.exposures.get(pending.exposureId);
    if (!exposure) {
      await rejectPendingRelayOperation(pending, {
        code: 'mcp_unavailable',
        message: `Relay exposure ${pending.exposureId} is not available`,
        retryable: true,
      });
      return;
    }

    const currentTool = exposure.tools.find((tool) => tool.binding.toolId === pending.toolId);
    if (!currentTool || currentTool.visible.name !== pending.visibleToolName) {
      await rejectPendingRelayOperation(pending, {
        code: 'tool_removed',
        message: `Tool "${pending.visibleToolName}" is no longer available`,
        retryable: true,
        requiresReplan: true,
      });
      return;
    }

    if (
      currentTool.binding.catalogRevisionId !== pending.catalogRevisionId ||
      currentTool.binding.toolRevisionId !== pending.toolRevisionId
    ) {
      await rejectPendingRelayOperation(pending, {
        code: 'tool_definition_changed',
        message: `Tool "${pending.visibleToolName}" changed after planning. Re-read the latest tool definition before retrying.`,
        retryable: true,
        requiresReplan: true,
        currentToolRevisionId: currentTool.binding.toolRevisionId,
      });
      return;
    }

    const deliveryId = crypto.randomUUID();
    const deliverySeq = connected.nextDeliverySeq++;
    pending.deliveryId = deliveryId;
    pending.deliverySeq = deliverySeq;
    pending.relaySessionRowId = connected.sessionRowId;

    await query(
      `INSERT INTO relay_operation_deliveries (
         operation_id, relay_session_id, delivery_seq, status, metadata
       )
       VALUES ($1, $2, $3, 'queued', $4)`,
      [
        pending.operationId,
        connected.sessionRowId,
        deliverySeq,
        JSON.stringify({ deliveryId }),
      ],
    );

    const payload = {
      exposureId: pending.exposureId,
      exposureStableKey: pending.exposureStableKey,
      toolId: pending.toolId,
      toolRevisionId: pending.toolRevisionId,
      toolName: pending.visibleToolName,
      inputHash: pending.inputHash,
      arguments: pending.args,
      expiresInMs: RELAY_OPERATION_TTL_MS,
    };

    try {
      connected.ws.send(JSON.stringify({
        type: 'relay.operation.dispatch',
        protocolVersion: RELAY_PROTOCOL_VERSION,
        sessionId: connected.sessionId,
        operationId: pending.operationId,
        deliveryId,
        payload,
      }));
    } catch {
      await markDeliveryStatus(pending.operationId, deliverySeq, 'nacked');
      return;
    }

    void query(
      `UPDATE relay_operations SET status = 'dispatched', updated_at = NOW() WHERE id = $1`,
      [pending.operationId],
    ).catch(() => {});
    await query(
      `UPDATE relay_operation_deliveries
       SET status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE operation_id = $1 AND delivery_seq = $2`,
      [pending.operationId, deliverySeq],
    );

    resetPendingAckTimer(pending);
  } catch (error: any) {
    console.error('[Relay Manager] dispatch pending operation error:', error?.message || error);
  }
}

function resetPendingAckTimer(pending: PendingRelayOperation) {
  if (pending.ackTimer) {
    clearTimeout(pending.ackTimer);
    pending.ackTimer = null;
  }
  const deliverySeq = pending.deliverySeq;
  if (deliverySeq === null) {
    return;
  }

  pending.ackTimer = setTimeout(() => {
    const current = pendingRelayOperations.get(pending.operationId);
    if (!current || current !== pending || current.deliverySeq !== deliverySeq) {
      return;
    }

    current.ackTimer = null;
    void markDeliveryStatus(current.operationId, deliverySeq, 'timed_out');

    const connected = connectedRelays.get(current.deviceId);
    if (!connected || connected.ws.readyState !== 1) {
      return;
    }

    void dispatchPendingRelayOperation(connected, current);
  }, RELAY_DELIVERY_ACK_TIMEOUT_MS);
}

async function rejectPendingRelayOperation(pending: PendingRelayOperation, error: RelayOperationError) {
  if (pendingRelayOperations.get(pending.operationId) !== pending) {
    return;
  }

  clearPendingRelayOperation(pending);
  pendingRelayOperations.delete(pending.operationId);
  await failOperation(
    pending.operationId,
    error.code,
    error.message,
    error.retryable,
    Boolean(error.requiresReplan),
    error.currentToolRevisionId,
  );
  pending.reject(buildRelayExecutionError(error));
}

function clearPendingRelayOperation(pending: PendingRelayOperation) {
  clearTimeout(pending.timeoutTimer);
  if (pending.ackTimer) {
    clearTimeout(pending.ackTimer);
    pending.ackTimer = null;
  }
}

export function getRelayExposureCatalog(deviceId: string, exposureId: string): RelayExposureCatalog | null {
  const connected = connectedRelays.get(deviceId);
  if (!connected) return null;

  const exposure = connected.exposures.get(exposureId);
  if (!exposure) return null;

  return {
    deviceId: connected.deviceId,
    deviceDisplayName: connected.displayName,
    exposureId: exposure.exposureId,
    exposureDisplayName: exposure.displayName,
    transport: exposure.transport,
    tools: exposure.tools.map((tool) => ({
      binding: { ...tool.binding },
      visible: {
        name: tool.visible.name,
        description: tool.visible.description,
        inputSchema: tool.visible.inputSchema,
      },
      definitionHash: tool.definitionHash,
    })),
  };
}

export function disconnectRelay(relayId: string) {
  const connected = connectedRelays.get(relayId);
  if (!connected) return;

  try {
    connected.ws.close();
  } catch {}
  cleanupRelay(relayId);
}

export function isRelayConnected(relayId: string): boolean {
  const connected = connectedRelays.get(relayId);
  return Boolean(connected && connected.ws.readyState === 1);
}

export async function initRelayManager() {
  await query(
    `UPDATE relay_device_sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         close_reason = COALESCE(close_reason, 'server_restart'),
         updated_at = NOW()
     WHERE status IN ('connecting', 'active', 'closing')`,
  );
  await query(
    `UPDATE relay_exposures
     SET runtime_status = 'offline',
         updated_at = NOW()
     WHERE runtime_status IN ('starting', 'healthy', 'degraded')`,
  );
  console.log('[Relay Manager] Initialized relay v2 runtime');
}

export async function shutdownAllRelays() {
  for (const connected of connectedRelays.values()) {
    if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer);
    if (connected.pongTimer) clearTimeout(connected.pongTimer);
    if (connected.ws.readyState === 1) {
      try {
        connected.ws.send(JSON.stringify({
          type: 'server_shutdown',
          message: 'Synapse API server is shutting down',
          retryable: true,
        }));
      } catch {}
      try {
        connected.ws.close(1012, 'service restart');
      } catch {}
    } else {
      try {
        connected.ws.close();
      } catch {}
    }
  }

  for (const pending of pendingRelayOperations.values()) {
    clearPendingRelayOperation(pending);
    pending.reject(new Error('Server shutting down'));
    void failOperation(pending.operationId, 'delivery_rejected', 'Server shutting down', true, false);
  }

  const deviceIds = [...connectedRelays.keys()];
  connectedRelays.clear();
  pendingRelayOperations.clear();

  if (deviceIds.length > 0) {
    await query(
      `UPDATE relay_devices
       SET last_seen_at = NOW(), updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [deviceIds],
    ).catch(() => {});
    await query(
      `UPDATE relay_exposures
       SET runtime_status = 'offline', updated_at = NOW()
       WHERE device_id = ANY($1::uuid[])`,
      [deviceIds],
    ).catch(() => {});
  }
}

async function authenticateRelayDevice(deviceId: unknown): Promise<RelayAuthRow | null> {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) return null;

  const result = await query<RelayAuthRow>(
    `SELECT id, workspace_id, owner_user_id, display_name, public_key, public_key_fingerprint, trust_status
     FROM relay_devices
     WHERE id = $1
     LIMIT 1`,
    [deviceId],
  );
  return result.rows[0] || null;
}

async function onRelayAuthenticated(connected: ConnectedRelay) {
  await query(
    `UPDATE relay_devices
     SET last_seen_at = NOW(),
         last_connected_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [connected.deviceId],
  );

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: connected.deviceId,
    eventType: 'relay.connected',
    eventData: { deviceId: connected.deviceId },
  });

  emitEvent({
    type: 'relay.connected',
    workspaceId: connected.workspaceId,
    payload: { deviceId: connected.deviceId },
    timestamp: new Date().toISOString(),
  });
}

function normalizeExposureRegistrations(msg: Record<string, unknown>): RelayExposureRegistration[] {
  const rawExposures = Array.isArray(msg.exposures) ? msg.exposures : [];

  return rawExposures
    .map((raw, index) => normalizeExposureRegistration(raw, index))
    .filter((item): item is RelayExposureRegistration => Boolean(item));
}

function normalizeExposureRegistration(raw: unknown, index: number): RelayExposureRegistration | null {
  if (!isObject(raw)) return null;

  const displayName = typeof raw.displayName === 'string'
    ? raw.displayName.trim()
    : typeof raw.name === 'string'
      ? raw.name.trim()
      : '';
  if (!displayName) return null;

  const stableKey = typeof raw.stableKey === 'string' && raw.stableKey.trim().length > 0
    ? raw.stableKey.trim()
    : `legacy:${displayName}`;

  const toolsRaw = Array.isArray(raw.tools) ? raw.tools : [];
  return {
    stableKey,
    syncSourceKey: typeof raw.syncSourceKey === 'string' && raw.syncSourceKey.trim().length > 0
      ? raw.syncSourceKey.trim()
      : null,
    displayName,
    transport: normalizeTransport(raw.transport),
    runtimeStatus: normalizeRuntimeStatus(raw.runtimeStatus),
    managementMode: normalizeManagementMode(raw.managementMode),
    metadata: asObject(raw.metadata),
    tools: toolsRaw
      .map((tool, toolIndex) => normalizeToolRegistration(tool, toolIndex))
      .filter((tool): tool is RelayToolRegistration => Boolean(tool)),
  };
}

function normalizeSyncSourceRegistrations(msg: Record<string, unknown>): RelaySyncSourceRegistration[] {
  const rawSyncSources = Array.isArray(msg.syncSources) ? msg.syncSources : [];

  return rawSyncSources
    .map((raw) => normalizeSyncSourceRegistration(raw))
    .filter((item): item is RelaySyncSourceRegistration => Boolean(item));
}

function normalizeSyncSourceRegistration(raw: unknown): RelaySyncSourceRegistration | null {
  if (!isObject(raw)) return null;

  const sourceKey = typeof raw.sourceKey === 'string' ? raw.sourceKey.trim() : '';
  if (!sourceKey) return null;

  return {
    sourceKind: normalizeSyncSourceKind(raw.sourceKind),
    sourceKey,
    configPath: typeof raw.configPath === 'string' && raw.configPath.trim().length > 0 ? raw.configPath.trim() : null,
    syncMode: normalizeSyncMode(raw.syncMode),
    status: normalizeSyncSourceStatus(raw.status),
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' && raw.lastSyncedAt.trim().length > 0 ? raw.lastSyncedAt : null,
    lastError: typeof raw.lastError === 'string' && raw.lastError.trim().length > 0 ? raw.lastError : null,
    metadata: asObject(raw.metadata),
  };
}

function normalizeToolRegistration(raw: unknown, index: number): RelayToolRegistration | null {
  if (!isObject(raw)) return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return null;

  const inputSchema = isObject(raw.inputSchema)
    ? raw.inputSchema
    : isObject(raw.parameters)
      ? {
          type: 'object',
          properties: asObject(raw.parameters.properties),
          required: Array.isArray(raw.parameters.required) ? raw.parameters.required : [],
        }
      : { type: 'object', properties: {}, required: [] };

  return {
    stableKey: typeof raw.stableKey === 'string' && raw.stableKey.trim().length > 0
      ? raw.stableKey.trim()
      : `legacy:${name}:${index}`,
    visible: {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      inputSchema,
    },
    annotations: asObject(raw.annotations),
    metadata: asObject(raw.metadata),
  };
}

function normalizeTransport(value: unknown): RelayExposureRegistration['transport'] {
  if (value === 'http' || value === 'sse' || value === 'custom') return value;
  return 'stdio';
}

function normalizeRuntimeStatus(value: unknown): RelayExposureRegistration['runtimeStatus'] {
  switch (value) {
    case 'starting':
    case 'healthy':
    case 'degraded':
    case 'failed':
    case 'quarantined':
    case 'offline':
      return value;
    default:
      return 'healthy';
  }
}

function normalizeManagementMode(value: unknown): RelayExposureRegistration['managementMode'] {
  switch (value) {
    case 'imported':
    case 'mirrored':
    case 'managed':
      return value;
    default:
      return 'manual';
  }
}

function normalizeSyncSourceKind(value: unknown): RelaySyncSourceRegistration['sourceKind'] {
  switch (value) {
    case 'claude_code':
    case 'claude_desktop':
    case 'codex':
    case 'gemini':
    case 'opencode':
    case 'custom':
      return value;
    default:
      return 'manual';
  }
}

function normalizeSyncMode(value: unknown): RelaySyncSourceRegistration['syncMode'] {
  switch (value) {
    case 'import_only':
    case 'mirror':
    case 'managed':
    case 'detached':
      return value;
    default:
      return 'observe';
  }
}

function normalizeSyncSourceStatus(value: unknown): RelaySyncSourceRegistration['status'] {
  switch (value) {
    case 'idle':
    case 'syncing':
    case 'error':
    case 'disabled':
      return value;
    default:
      return 'unknown';
  }
}

async function syncDeviceCatalog(
  connected: ConnectedRelay,
  syncSources: RelaySyncSourceRegistration[],
  exposures: RelayExposureRegistration[],
): Promise<string | null> {
  for (const exposure of exposures) {
    if (exposure.displayName.includes('__')) {
      return `Exposure name "${exposure.displayName}" must not contain "__"`;
    }
    for (const tool of exposure.tools) {
      if (tool.visible.name.includes('__')) {
        return `Tool name "${tool.visible.name}" must not contain "__"`;
      }
    }
  }

  const relayOrg = await findOrCreateRelayOrg(connected);
  const activeExposureIds = new Set<string>();
  const activePluginSlugs: string[] = [];
  const syncSourceIds = await syncRelaySyncSources(connected.deviceId, syncSources);

  for (const registration of exposures) {
    const exposureRow = await upsertExposure(
      connected.deviceId,
      registration,
      registration.syncSourceKey ? (syncSourceIds.get(registration.syncSourceKey) || null) : null,
    );
    activeExposureIds.add(exposureRow.id);

    const catalog = await syncExposureCatalog(exposureRow.id, connected.deviceId, registration);
    const runtimeCatalog = await loadExposureCatalog(exposureRow.id);
    if (runtimeCatalog && isRuntimeAvailable(registration.runtimeStatus)) {
      connected.exposures.set(exposureRow.id, runtimeCatalog);
    } else {
      connected.exposures.delete(exposureRow.id);
    }

    if (runtimeCatalog && isRuntimeAvailable(registration.runtimeStatus)) {
      const pluginSlug = exposurePluginSlug(runtimeCatalog.exposureId, runtimeCatalog.stableKey);
      activePluginSlugs.push(pluginSlug);
      await syncExposurePlugin(connected, relayOrg.id, runtimeCatalog, catalog.revisionSeq, pluginSlug);
    }
  }

  await markMissingExposuresOffline(connected.deviceId, activeExposureIds);
  for (const exposureId of [...connected.exposures.keys()]) {
    if (!activeExposureIds.has(exposureId)) {
      connected.exposures.delete(exposureId);
    }
  }

  await deactivateStaleRelayPlugins(relayOrg.id, activePluginSlugs);
  await incrementMcpVersion(connected.workspaceId);

  emitEvent({
    type: 'relay.servers_updated',
    workspaceId: connected.workspaceId,
    payload: { deviceId: connected.deviceId, exposureCount: exposures.length },
    timestamp: new Date().toISOString(),
  });

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: connected.deviceId,
    eventType: 'relay.catalog_synced',
    eventData: {
      deviceId: connected.deviceId,
      syncSourceCount: syncSources.length,
      exposureCount: exposures.length,
      exposureNames: exposures.map((exposure) => exposure.displayName),
    },
  });

  return null;
}

async function upsertExposure(deviceId: string, exposure: RelayExposureRegistration, syncSourceId: string | null) {
  const result = await query(
     `INSERT INTO relay_exposures (
       device_id, sync_source_id, stable_key, display_name, transport, runtime_status, management_mode,
       last_seen_at, last_healthy_at, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), CASE WHEN $8 IN ('healthy', 'degraded') THEN NOW() ELSE NULL END, $9)
     ON CONFLICT (device_id, stable_key) DO UPDATE SET
       sync_source_id = EXCLUDED.sync_source_id,
       display_name = EXCLUDED.display_name,
       transport = EXCLUDED.transport,
       runtime_status = EXCLUDED.runtime_status,
       management_mode = EXCLUDED.management_mode,
       last_seen_at = NOW(),
       last_healthy_at = CASE
         WHEN EXCLUDED.runtime_status IN ('healthy', 'degraded') THEN NOW()
         ELSE relay_exposures.last_healthy_at
       END,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      deviceId,
      syncSourceId,
      exposure.stableKey,
      exposure.displayName,
      exposure.transport,
      exposure.runtimeStatus,
      exposure.managementMode,
      exposure.runtimeStatus,
      JSON.stringify(exposure.metadata),
    ],
  );
  return result.rows[0];
}

async function syncRelaySyncSources(deviceId: string, syncSources: RelaySyncSourceRegistration[]) {
  const bySourceKey = new Map<string, string>();

  for (const source of syncSources) {
    const result = await query(
      `INSERT INTO relay_sync_sources (
         device_id, source_kind, source_key, config_path, sync_mode, status,
         last_synced_at, last_error, metadata
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         COALESCE(CASE WHEN $7 IS NULL OR $7 = '' THEN NULL ELSE $7::timestamptz END, NOW()),
         $8,
         $9
       )
       ON CONFLICT (device_id, source_key) DO UPDATE SET
         source_kind = EXCLUDED.source_kind,
         config_path = EXCLUDED.config_path,
         sync_mode = EXCLUDED.sync_mode,
         status = EXCLUDED.status,
         last_synced_at = EXCLUDED.last_synced_at,
         last_error = EXCLUDED.last_error,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        deviceId,
        source.sourceKind,
        source.sourceKey,
        source.configPath,
        source.syncMode,
        source.status,
        source.lastSyncedAt,
        source.lastError,
        JSON.stringify(source.metadata),
      ],
    );
    bySourceKey.set(source.sourceKey, result.rows[0].id as string);
  }

  const activeKeys = syncSources.map((source) => source.sourceKey);
  if (activeKeys.length > 0) {
    await query(
      `DELETE FROM relay_sync_sources
       WHERE device_id = $1
         AND source_key != ALL($2)`,
      [deviceId, activeKeys],
    );
  } else {
    await query(
      `DELETE FROM relay_sync_sources
       WHERE device_id = $1`,
      [deviceId],
    );
  }

  return bySourceKey;
}

async function syncExposureCatalog(exposureId: string, deviceId: string, exposure: RelayExposureRegistration) {
  const normalizedTools = [...exposure.tools].sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  const schemaHash = hashValue(normalizedTools.map((tool) => ({
    stableKey: tool.stableKey,
    visible: tool.visible,
    annotations: tool.annotations,
  })));

  const activeCatalogResult = await query(
    `SELECT id, revision_seq, schema_hash
     FROM relay_catalog_revisions
     WHERE exposure_id = $1 AND status = 'active'
     ORDER BY revision_seq DESC
     LIMIT 1`,
    [exposureId],
  );
  const activeCatalog = activeCatalogResult.rows[0] || null;

  let revisionSeq = activeCatalog ? Number(activeCatalog.revision_seq) : 0;
  let catalogRevisionId = activeCatalog?.id as string | undefined;

  if (!activeCatalog || activeCatalog.schema_hash !== schemaHash) {
    const nextSeq = revisionSeq + 1;
    if (activeCatalog) {
      await query(
        `UPDATE relay_catalog_revisions
         SET status = 'superseded', invalidated_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [activeCatalog.id],
      );
    }

    const catalogInsert = await query(
      `INSERT INTO relay_catalog_revisions (exposure_id, revision_seq, schema_hash, status, metadata)
       VALUES ($1, $2, $3, 'active', $4)
       RETURNING id`,
      [
        exposureId,
        nextSeq,
        schemaHash,
        JSON.stringify({ toolCount: normalizedTools.length }),
      ],
    );

    revisionSeq = nextSeq;
    catalogRevisionId = catalogInsert.rows[0].id;

    const existingTools = await query(
      `SELECT id, stable_key
       FROM relay_tools
       WHERE exposure_id = $1`,
      [exposureId],
    );
    const existingToolIds = new Map(existingTools.rows.map((row) => [row.stable_key as string, row.id as string]));

    for (const tool of normalizedTools) {
      const toolResult = await query(
        `INSERT INTO relay_tools (
           exposure_id, stable_key, current_name, status, first_seen_at, last_seen_at, metadata
         )
         VALUES ($1, $2, $3, 'active', NOW(), NOW(), $4)
         ON CONFLICT (exposure_id, stable_key) DO UPDATE SET
           current_name = EXCLUDED.current_name,
           status = 'active',
           last_seen_at = NOW(),
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        [
          exposureId,
          tool.stableKey,
          tool.visible.name,
          JSON.stringify(tool.metadata),
        ],
      );
      const toolId = toolResult.rows[0]?.id || existingToolIds.get(tool.stableKey);
      const toolRevisionResult = await query(
        `INSERT INTO relay_tool_revisions (
           tool_id, catalog_revision_id, tool_name, description, input_schema, annotations, definition_hash
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          toolId,
          catalogRevisionId,
          tool.visible.name,
          tool.visible.description,
          JSON.stringify(tool.visible.inputSchema),
          JSON.stringify(tool.annotations),
          hashValue({
            visible: tool.visible,
            annotations: tool.annotations,
          }),
        ],
      );
      await query(
        `UPDATE relay_tools
         SET latest_revision_id = $2,
             current_name = $3,
             status = 'active',
             last_seen_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [toolId, toolRevisionResult.rows[0].id, tool.visible.name],
      );
    }

    const activeStableKeys = normalizedTools.map((tool) => tool.stableKey);
    if (activeStableKeys.length > 0) {
      await query(
        `UPDATE relay_tools
         SET status = 'removed', updated_at = NOW()
         WHERE exposure_id = $1
           AND stable_key != ALL($2)`,
        [exposureId, activeStableKeys],
      );
    } else {
      await query(
        `UPDATE relay_tools
         SET status = 'removed', updated_at = NOW()
         WHERE exposure_id = $1`,
        [exposureId],
      );
    }

    await query(
      `UPDATE relay_devices
       SET last_catalog_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deviceId],
    );
  }

  return { catalogRevisionId, revisionSeq };
}

async function loadExposureCatalog(exposureId: string): Promise<ConnectedRelayExposure | null> {
  const result = await query(
    `SELECT
        e.id AS exposure_id,
        e.stable_key AS exposure_stable_key,
        e.display_name AS exposure_display_name,
        e.transport AS exposure_transport,
        e.runtime_status AS exposure_runtime_status,
        t.id AS tool_id,
        tr.id AS tool_revision_id,
        tr.catalog_revision_id,
        tr.tool_name,
        tr.description,
        tr.input_schema,
        tr.annotations,
        tr.definition_hash
     FROM relay_exposures e
     LEFT JOIN relay_tools t
       ON t.exposure_id = e.id
      AND t.status = 'active'
     LEFT JOIN relay_tool_revisions tr
       ON tr.id = t.latest_revision_id
     WHERE e.id = $1
     ORDER BY tr.tool_name ASC NULLS LAST`,
    [exposureId],
  );

  if (result.rows.length === 0) return null;

  const first = result.rows[0];
  const tools: RelayCatalogToolSnapshot[] = result.rows
    .filter((row) => row.tool_id && row.tool_revision_id)
    .map((row) => ({
      binding: {
        exposureId: row.exposure_id,
        catalogRevisionId: row.catalog_revision_id,
        toolId: row.tool_id,
        toolRevisionId: row.tool_revision_id,
      },
      visible: {
        name: row.tool_name,
        description: row.description || '',
        inputSchema: asObject(row.input_schema),
      },
      definitionHash: row.definition_hash,
    }));

  return {
    exposureId: first.exposure_id,
    stableKey: first.exposure_stable_key,
    displayName: first.exposure_display_name,
    transport: first.exposure_transport,
    runtimeStatus: first.exposure_runtime_status,
    tools,
  };
}

async function markMissingExposuresOffline(deviceId: string, activeExposureIds: Set<string>) {
  const ids = [...activeExposureIds];
  if (ids.length > 0) {
    await query(
      `UPDATE relay_exposures
       SET runtime_status = 'offline',
           updated_at = NOW()
       WHERE device_id = $1
         AND id != ALL($2)`,
      [deviceId, ids],
    );
    return;
  }

  await query(
    `UPDATE relay_exposures
     SET runtime_status = 'offline',
         updated_at = NOW()
     WHERE device_id = $1`,
    [deviceId],
  );
}

async function syncExposurePlugin(
  connected: ConnectedRelay,
  orgId: string,
  exposure: ConnectedRelayExposure,
  revisionSeq: number,
  pluginSlug: string,
) {
  const toolsManifest = exposure.tools.map((tool) => ({
    name: tool.visible.name,
    description: tool.visible.description,
    inputSchema: tool.visible.inputSchema,
  }));

  const plugin = await createPlugin({
    orgId,
    workspaceId: connected.workspaceId,
    slug: pluginSlug,
    displayName: `${connected.displayName} / ${exposure.displayName}`,
    description: `Relay exposure: ${exposure.displayName}`,
    transport: 'relay',
    entryPoint: JSON.stringify({
      deviceId: connected.deviceId,
      exposureId: exposure.exposureId,
      exposureStableKey: exposure.stableKey,
    }),
    lifecycleScope: 'conversation',
    defaultInstanceScope: 'workspace',
    requiresHandshake: true,
    toolsManifest,
    version: `catalog-${revisionSeq}`,
    tags: ['relay', exposure.transport],
    authorization: {
      requiredPermissions: ['relay:use'],
      defaultGrantScope: 'workspace',
      reason: 'Relay-derived tools require explicit workspace authorization.',
    },
  });

  await query(
    `UPDATE capability_packages SET is_active = TRUE WHERE id = $1`,
    [plugin.id],
  );
  await ensureDefaultInstallation(connected.workspaceId, plugin.id);
}

async function resolveOperationResult(connected: ConnectedRelay, msg: Record<string, unknown>) {
  const operationId = msg.operationId as string;
  const pending = pendingRelayOperations.get(operationId);
  if (!pending || pending.deviceId !== connected.deviceId) return;

  clearPendingRelayOperation(pending);
  pendingRelayOperations.delete(operationId);

  const isError = msg.success === false || Boolean(msg.error);
  if (isError) {
    const error = normalizeOperationError(msg.error);
    await failOperation(operationId, error.code, error.message, error.retryable, Boolean(error.requiresReplan), error.currentToolRevisionId);
    pending.reject(buildRelayExecutionError(error));
    return;
  }

  await query(
    `UPDATE relay_operations
     SET status = 'completed',
         completed_at = NOW(),
         result_hash = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [
      operationId,
      hashValue(msg.result),
    ],
  );

  await query(
    `INSERT INTO relay_operation_results (operation_id, output_payload, output_preview, result_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation_id) DO UPDATE SET
       output_payload = EXCLUDED.output_payload,
       output_preview = EXCLUDED.output_preview,
       result_hash = EXCLUDED.result_hash,
       updated_at = NOW()`,
    [
      operationId,
      JSON.stringify(msg.result ?? {}),
      previewValue(msg.result),
      hashValue(msg.result),
    ],
  );

  await query(
    `UPDATE relay_operation_deliveries
     SET status = 'acked', acknowledged_at = NOW(), updated_at = NOW()
     WHERE operation_id = $1
       AND ($2::text IS NULL OR metadata->>'deliveryId' = $2)`,
    [operationId, typeof msg.deliveryId === 'string' ? msg.deliveryId : null],
  );

  pending.resolve(msg.result);
}

async function markOperationStatus(operationId: string, status: 'received' | 'started') {
  await query(
    `UPDATE relay_operations
     SET status = $2, updated_at = NOW()
     WHERE id = $1
       AND status NOT IN ('completed', 'failed', 'aborted', 'expired')`,
    [operationId, status],
  );
}

async function markDeliveryAcknowledged(operationId: string, deliveryId?: string) {
  await query(
    `UPDATE relay_operation_deliveries
     SET status = 'acked', acknowledged_at = NOW(), updated_at = NOW()
     WHERE operation_id = $1
       AND ($2::text IS NULL OR metadata->>'deliveryId' = $2)`,
    [operationId, deliveryId || null],
  );

  const pending = pendingRelayOperations.get(operationId);
  if (pending && (!deliveryId || pending.deliveryId === deliveryId)) {
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    pending.deliverySeq = null;
    pending.deliveryId = null;
    pending.relaySessionRowId = null;
  }
}

async function markDeliveryStatus(
  operationId: string,
  deliverySeq: number,
  status: 'queued' | 'sent' | 'acked' | 'nacked' | 'timed_out' | 'cancelled',
) {
  await query(
    `UPDATE relay_operation_deliveries
     SET status = $3,
         updated_at = NOW(),
         acknowledged_at = CASE WHEN $3 = 'acked' THEN NOW() ELSE acknowledged_at END
     WHERE operation_id = $1
       AND delivery_seq = $2`,
    [operationId, deliverySeq, status],
  ).catch(() => {});
}

async function redrivePendingRelayOperations(connected: ConnectedRelay) {
  const pendingForDevice = [...pendingRelayOperations.values()].filter((pending) => pending.deviceId === connected.deviceId);

  for (const pending of pendingForDevice) {
    if (pending.deliverySeq !== null) {
      await markDeliveryStatus(pending.operationId, pending.deliverySeq, 'nacked');
      pending.deliverySeq = null;
      pending.deliveryId = null;
      pending.relaySessionRowId = null;
    }
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    await dispatchPendingRelayOperation(connected, pending);
  }
}

async function failOperation(
  operationId: string,
  code: string,
  message: string,
  retryable: boolean,
  requiresReplan: boolean,
  currentToolRevisionId?: string,
) {
  await query(
    `UPDATE relay_operations
     SET status = 'failed',
         error_code = $2,
         error_message = $3,
         requires_replan = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [operationId, code, message, requiresReplan],
  ).catch(() => {});

  await query(
    `UPDATE relay_operation_deliveries
     SET status = CASE
         WHEN status = 'queued' THEN 'cancelled'
         WHEN status = 'sent' THEN 'timed_out'
         ELSE status
       END,
       updated_at = NOW()
     WHERE operation_id = $1`,
    [operationId],
  ).catch(() => {});

  await query(
    `INSERT INTO relay_operation_results (operation_id, output_payload, output_preview, result_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation_id) DO UPDATE SET
       output_payload = EXCLUDED.output_payload,
       output_preview = EXCLUDED.output_preview,
       result_hash = EXCLUDED.result_hash,
       updated_at = NOW()`,
    [
      operationId,
      JSON.stringify({
        error: {
          code,
          message,
          retryable,
          requiresReplan,
          currentToolRevisionId,
        },
      }),
      message,
      hashValue({ code, message, retryable, requiresReplan, currentToolRevisionId }),
    ],
  ).catch(() => {});
}

function cleanupRelay(deviceId: string) {
  const connected = connectedRelays.get(deviceId);
  if (!connected) return;

  if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer);
  if (connected.pongTimer) clearTimeout(connected.pongTimer);

  connectedRelays.delete(deviceId);

  for (const pending of pendingRelayOperations.values()) {
    if (pending.deviceId !== deviceId) continue;
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }
    if (pending.relaySessionRowId === connected.sessionRowId && pending.deliverySeq !== null) {
      void markDeliveryStatus(pending.operationId, pending.deliverySeq, 'nacked');
      pending.deliverySeq = null;
      pending.deliveryId = null;
      pending.relaySessionRowId = null;
    }
  }

  void query(
    `UPDATE relay_device_sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         close_reason = COALESCE(close_reason, 'socket_closed'),
         updated_at = NOW()
     WHERE id = $1`,
    [connected.sessionRowId],
  ).catch(() => {});

  void query(
    `UPDATE relay_devices
     SET last_seen_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [deviceId],
  ).catch(() => {});

  void query(
    `UPDATE relay_exposures
     SET runtime_status = 'offline', updated_at = NOW()
     WHERE device_id = $1`,
    [deviceId],
  ).catch(() => {});

  void findRelayOrg(deviceId)
    .then((org) => {
      if (!org) return;
      return query(
        `UPDATE capability_packages
         SET is_active = FALSE
         WHERE publisher_id = $1
           AND kind = 'plugin'`,
        [org.id],
      );
    })
    .catch(() => {});

  void incrementMcpVersion(connected.workspaceId).catch(() => {});

  emitEvent({
    type: 'relay.disconnected',
    workspaceId: connected.workspaceId,
    payload: { deviceId },
    timestamp: new Date().toISOString(),
  });

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: deviceId,
    eventType: 'relay.disconnected',
    eventData: { deviceId },
  });
}

async function findOrCreateRelayOrg(connected: ConnectedRelay) {
  const slug = `relay_device_${connected.deviceId.slice(0, 8)}`;
  return createOrganization({
    slug,
    displayName: `Relay Device: ${connected.displayName}`,
    description: `Auto-created publisher for relay device ${connected.displayName}`,
    isBuiltin: false,
    isVerified: false,
    ownerUserId: connected.ownerUserId || undefined,
  });
}

async function findRelayOrg(deviceId: string) {
  const slug = `relay_device_${deviceId.slice(0, 8)}`;
  const result = await query(
    `SELECT * FROM capability_publishers WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  return result.rows[0] || null;
}

async function ensureDefaultInstallation(workspaceId: string, pluginId: string) {
  const existing = await query(
    `SELECT id
     FROM capability_instances
     WHERE package_id = $1
       AND workspace_id = $2
       AND attachment_type = 'workspace'
     LIMIT 1`,
    [pluginId, workspaceId],
  );
  if (existing.rows.length > 0) return;

  await query(
    `INSERT INTO capability_instances (
       workspace_id, package_id, revision_id, attachment_type, install_mode, is_enabled, config_data,
       reuse_scope, requires_handshake, metadata
     )
     SELECT $1, p.id, p.latest_revision_id, 'workspace', 'relay_derived', TRUE, '{}'::jsonb,
            COALESCE(p.default_reuse_scope, 'conversation'), p.requires_handshake, '{}'::jsonb
     FROM capability_packages p
     WHERE p.id = $2
     ON CONFLICT DO NOTHING`,
    [workspaceId, pluginId],
  );
}

async function deactivateStaleRelayPlugins(orgId: string, activeSlugs: string[]) {
  if (activeSlugs.length === 0) {
    await query(
      `UPDATE capability_packages
       SET is_active = FALSE
       WHERE publisher_id = $1
         AND kind = 'plugin'`,
      [orgId],
    );
    return;
  }

  await query(
    `UPDATE capability_packages
     SET is_active = FALSE
     WHERE publisher_id = $1
       AND kind = 'plugin'
       AND slug != ALL($2)`,
    [orgId, activeSlugs],
  );
}

function exposurePluginSlug(exposureId: string, stableKey: string) {
  const sanitized = stableKey
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 36) || 'exposure';
  return `${sanitized}_${exposureId.slice(0, 8)}`;
}

function normalizeOperationError(raw: unknown): RelayOperationError {
  if (!isObject(raw)) {
    return {
      code: 'tool_execution_failed',
      message: 'Relay operation failed',
      retryable: true,
    };
  }

  const code = typeof raw.code === 'string' ? raw.code : 'tool_execution_failed';
  return {
    code: code as RelayOperationError['code'],
    message: typeof raw.message === 'string' ? raw.message : 'Relay operation failed',
    retryable: raw.retryable !== false,
    requiresReplan: Boolean(raw.requiresReplan),
    currentToolRevisionId: typeof raw.currentToolRevisionId === 'string' ? raw.currentToolRevisionId : undefined,
  };
}

function buildRelayExecutionError(error: RelayOperationError) {
  return Object.assign(new Error(error.message), error);
}

function previewValue(value: unknown) {
  if (typeof value === 'string') return value.slice(0, 500);
  try {
    return stableStringify(value).slice(0, 500);
  } catch {
    return '';
  }
}

function hashValue(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sendAuthError(socket: any, code: string, message: string, retryable: boolean) {
  socket.send(JSON.stringify({
    type: 'auth_error',
    code,
    message,
    retryable,
  }));
}

function verifyRelayAuthSignature(
  publicKeyPem: string,
  deviceId: string,
  challenge: string,
  nonce: string,
  signatureBase64: string,
) {
  if (!signatureBase64) return false;

  try {
    const payload = Buffer.from(`synapse-relay-auth:${deviceId}:${challenge}:${nonce}`);
    const signature = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, payload, publicKeyPem, signature);
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function parseMessage(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  return value;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeAvailable(status: RelayExposureRegistration['runtimeStatus']) {
  return status === 'healthy' || status === 'degraded' || status === 'starting';
}
