import { query } from '../../infrastructure/database/index.js';
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
  let where = `workspace_id = $1 AND event_type = 'tool.call.legacy'`;
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.sessionId) {
    where += ` AND session_id = $${idx++}`;
    values.push(filters.sessionId);
  }
  if (filters?.actorId) {
    where += ` AND actor_id = $${idx++}`;
    values.push(filters.actorId);
  }
  if (filters?.pluginId) {
    where += ` AND payload->>'pluginId' = $${idx++}`;
    values.push(filters.pluginId);
  }
  if (filters?.before) {
    where += ` AND created_at < $${idx++}`;
    values.push(filters.before);
  }

  const limit = Math.min(filters?.limit || 50, 200);
  values.push(limit);

  const result = await query(
    `SELECT *
     FROM runtime_events
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return result.rows;
}

export async function getEventLogs(workspaceId: string, filters?: {
  eventType?: string;
  pluginId?: string;
  limit?: number;
  before?: string;
}) {
  let where = 'workspace_id = $1';
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.eventType) {
    where += ` AND event_type = $${idx++}`;
    values.push(filters.eventType);
  }
  if (filters?.pluginId) {
    where += ` AND payload->>'pluginId' = $${idx++}`;
    values.push(filters.pluginId);
  }
  if (filters?.before) {
    where += ` AND created_at < $${idx++}`;
    values.push(filters.before);
  }

  const limit = Math.min(filters?.limit || 50, 200);
  values.push(limit);

  const result = await query(
    `SELECT *
     FROM runtime_events
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    values,
  );
  return result.rows;
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
