import { query } from '../../infrastructure/database/index.js';

/**
 * Log an MCP tool call (every invocation)
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
  // Sanitize sensitive fields in input (remove anything that looks like a key/token)
  const sanitizedInput = sanitizeInput(data.input);

  await query(
    `INSERT INTO mcp_tool_call_logs
       (workspace_id, session_id, turn_id, round, actor_id, user_id, plugin_id, relay_id,
        tool_name, tool_type, input, output, is_error, error_message, duration_ms, transport, instance_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      data.workspaceId,
      data.sessionId || null,
      data.turnId || null,
      data.round || null,
      data.actorId || null,
      data.userId || null,
      data.pluginId || null,
      data.relayId || null,
      data.toolName,
      data.toolType || 'mcp_plugin',
      JSON.stringify(sanitizedInput),
      data.output ?? null,
      data.isError || false,
      data.errorMessage || null,
      data.durationMs || null,
      data.transport || null,
      data.instanceKey || null,
    ]
  ).catch(err => {
    console.error('[MCP Audit] Failed to log tool call:', err.message);
  });
}

/**
 * Log an MCP lifecycle event
 */
export async function logEvent(data: {
  workspaceId?: string;
  userId?: string;
  pluginId?: string;
  relayId?: string;
  eventType: string;
  eventData?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO mcp_event_logs (workspace_id, user_id, plugin_id, relay_id, event_type, event_data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.workspaceId || null,
      data.userId || null,
      data.pluginId || null,
      data.relayId || null,
      data.eventType,
      JSON.stringify(data.eventData || {}),
    ]
  ).catch(err => {
    console.error('[MCP Audit] Failed to log event:', err.message);
  });
}

/**
 * Query tool call logs
 */
export async function getToolCallLogs(workspaceId: string, filters?: {
  pluginId?: string;
  sessionId?: string;
  actorId?: string;
  limit?: number;
  before?: string;
}) {
  let where = 'workspace_id = $1';
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.pluginId) { where += ` AND plugin_id = $${idx++}`; values.push(filters.pluginId); }
  if (filters?.sessionId) { where += ` AND session_id = $${idx++}`; values.push(filters.sessionId); }
  if (filters?.actorId) { where += ` AND actor_id = $${idx++}`; values.push(filters.actorId); }
  if (filters?.before) { where += ` AND created_at < $${idx++}`; values.push(filters.before); }

  const limit = Math.min(filters?.limit || 50, 200);
  values.push(limit);

  const result = await query(
    `SELECT * FROM mcp_tool_call_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    values
  );
  return result.rows;
}

/**
 * Query event logs
 */
export async function getEventLogs(workspaceId: string, filters?: {
  eventType?: string;
  pluginId?: string;
  limit?: number;
  before?: string;
}) {
  let where = 'workspace_id = $1';
  const values: unknown[] = [workspaceId];
  let idx = 2;

  if (filters?.eventType) { where += ` AND event_type = $${idx++}`; values.push(filters.eventType); }
  if (filters?.pluginId) { where += ` AND plugin_id = $${idx++}`; values.push(filters.pluginId); }
  if (filters?.before) { where += ` AND created_at < $${idx++}`; values.push(filters.before); }

  const limit = Math.min(filters?.limit || 50, 200);
  values.push(limit);

  const result = await query(
    `SELECT * FROM mcp_event_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    values
  );
  return result.rows;
}

function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  const sensitiveKeys = ['apiKey', 'api_key', 'token', 'secret', 'password', 'authorization'];
  for (const key of Object.keys(result)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
      result[key] = '***REDACTED***';
    }
  }
  return result;
}
