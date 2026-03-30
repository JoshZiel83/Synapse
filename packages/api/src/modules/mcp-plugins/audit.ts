import { db } from '../../infrastructure/database/kysely.js';
import { sql } from 'kysely';
import { logRuntimeEvent } from '../execution/service.js';

/**
 * Legacy MCP audit wrapper.
 * New canonical tool execution should write tool_calls / tool_results directly.
 * This module now records searchable runtime_events instead of old mcp_* log tables.
 */
export async function logToolCall(data: {
  workspaceId: string;
  sessionId?: string;
  turnId?: string;
  round?: number;
  actorId?: string;
  userId?: string;
  pluginId?: string | null;
  relayId?: string;
  toolName: string;
  toolType?: 'callable' | 'mcp_plugin' | 'relay' | 'action';
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  errorMessage?: string;
  durationMs?: number;
  transport?: string;
  instanceKey?: string;
}) {
  const sanitizedInput = sanitizeInput(data.input);

  await logRuntimeEvent({
    workspaceId: data.workspaceId,
    sessionId: data.sessionId,
    turnId: data.turnId,
    actorId: data.actorId,
    userId: data.userId,
    source: data.toolType === 'relay' ? 'relay' : 'tool',
    level: data.isError ? 'error' : 'info',
    eventType: 'tool.call.legacy',
    payload: {
      round: data.round,
      pluginId: data.pluginId,
      relayId: data.relayId,
      toolName: data.toolName,
      toolType: data.toolType || 'mcp_plugin',
      input: sanitizedInput,
      output: data.output,
      isError: data.isError || false,
      errorMessage: data.errorMessage,
      durationMs: data.durationMs,
      transport: data.transport,
      instanceKey: data.instanceKey,
    },
  });
}

export async function logEvent(data: {
  workspaceId?: string;
  userId?: string;
  pluginId?: string;
  relayId?: string;
  eventType: string;
  eventData?: Record<string, unknown>;
}) {
  await logRuntimeEvent({
    workspaceId: data.workspaceId,
    userId: data.userId,
    source: data.relayId ? 'relay' : 'tool',
    level: 'info',
    eventType: data.eventType,
    payload: {
      pluginId: data.pluginId,
      relayId: data.relayId,
      ...(data.eventData || {}),
    },
  });
}

export async function getToolCallLogs(workspaceId: string, filters?: {
  pluginId?: string;
  sessionId?: string;
  actorId?: string;
  limit?: number;
  before?: string;
}) {
  const limit = Math.min(filters?.limit || 50, 200);
  let statement = db
    .selectFrom('runtime_events')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('event_type', '=', 'tool.call.legacy');

  if (filters?.sessionId) {
    statement = statement.where('session_id', '=', filters.sessionId);
  }
  if (filters?.actorId) {
    statement = statement.where('actor_id', '=', filters.actorId);
  }
  if (filters?.pluginId) {
    statement = statement.where(sql<boolean>`payload->>'pluginId' = ${filters.pluginId}`);
  }
  if (filters?.before) {
    statement = statement.where('created_at', '<', new Date(filters.before));
  }

  return statement
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

export async function getEventLogs(workspaceId: string, filters?: {
  eventType?: string;
  pluginId?: string;
  limit?: number;
  before?: string;
}) {
  const limit = Math.min(filters?.limit || 50, 200);
  let statement = db
    .selectFrom('runtime_events')
    .selectAll()
    .where('workspace_id', '=', workspaceId);

  if (filters?.eventType) {
    statement = statement.where('event_type', '=', filters.eventType);
  }
  if (filters?.pluginId) {
    statement = statement.where(sql<boolean>`payload->>'pluginId' = ${filters.pluginId}`);
  }
  if (filters?.before) {
    statement = statement.where('created_at', '<', new Date(filters.before));
  }

  return statement
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  const sensitiveKeys = ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization'];
  for (const key of Object.keys(result)) {
    if (sensitiveKeys.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey.toLowerCase()))) {
      result[key] = '***REDACTED***';
    }
  }
  return result;
}
