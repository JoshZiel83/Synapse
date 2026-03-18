import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../infrastructure/database/index.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function asNullableUuid(value: unknown) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

async function storePayloadBlobInternal(contentType: 'json' | 'text', payload: unknown, retentionClass = 'audit') {
  const body = contentType === 'json'
    ? JSON.stringify(payload ?? {})
    : String(payload ?? '');
  const sha256 = createHash('sha256').update(body).digest('hex');

  const existing = await query(
    `SELECT id FROM payload_blobs WHERE sha256 = $1 LIMIT 1`,
    [sha256],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id as string;
  }

  const result = await query(
    `INSERT INTO payload_blobs
       (id, sha256, content_type, json_body, text_body, byte_size, retention_class, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [
      uuidv4(),
      sha256,
      contentType,
      contentType === 'json' ? JSON.stringify(payload ?? {}) : null,
      contentType === 'text' ? String(payload ?? '') : null,
      Buffer.byteLength(body, 'utf8'),
      retentionClass,
    ],
  );

  return result.rows[0].id as string;
}

export async function storePayloadBlob(payload: unknown, retentionClass = 'audit') {
  return storePayloadBlobInternal('json', payload, retentionClass);
}

export async function storeTextPayloadBlob(payload: string, retentionClass = 'audit') {
  return storePayloadBlobInternal('text', payload, retentionClass);
}

export async function createTurn(params: {
  id?: string;
  sessionId: string;
  conversationId: string;
  actorId: string;
  triggerType: string;
  triggerItemId?: string;
  metadata?: Record<string, unknown>;
}) {
  const result = await query(
    `INSERT INTO turns
       (id, session_id, conversation_id, actor_id, trigger_item_id, trigger_type, status, metadata, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, NOW(), NOW())
     RETURNING *`,
    [
      params.id || uuidv4(),
      params.sessionId,
      params.conversationId,
      params.actorId,
      params.triggerItemId || null,
      params.triggerType,
      JSON.stringify(params.metadata || {}),
    ],
  );

  return result.rows[0];
}

export async function updateTurnStatus(turnId: string, status: 'completed' | 'failed' | 'cancelled', extra?: {
  metadata?: Record<string, unknown>;
}) {
  const values: any[] = [turnId, status];
  const sets = ['status = $2', 'updated_at = NOW()', 'completed_at = NOW()'];
  if (extra?.metadata) {
    values.push(JSON.stringify(extra.metadata));
    sets.push(`metadata = metadata || $${values.length}::jsonb`);
  }
  await query(
    `UPDATE turns SET ${sets.join(', ')} WHERE id = $1`,
    values,
  );
}

export async function logProviderStep(params: {
  turnId: string;
  stepIndex: number;
  providerType: 'anthropic' | 'openai';
  requestType: 'actor_think' | 'ai_complete';
  modelGroupId?: string;
  modelProfileId?: string;
  modelProfileRevisionId?: string;
  modelName: string;
  capabilitiesSnapshot?: Record<string, unknown>;
  requestPayload?: unknown;
  responsePayload?: unknown;
  stopReason?: string;
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
  latencyMs: number;
  status: 'success' | 'error' | 'timeout';
  errorMessage?: string;
}) {
  const requestPayloadBlobId = params.requestPayload !== undefined
    ? await storePayloadBlob(params.requestPayload, params.status === 'error' ? 'debug' : 'audit')
    : null;
  const responsePayloadBlobId = params.responsePayload !== undefined
    ? await storePayloadBlob(params.responsePayload, params.status === 'error' ? 'debug' : 'audit')
    : null;

  const result = await query(
    `INSERT INTO provider_steps
       (id, turn_id, step_index, provider_type, request_type, model_group_id, model_profile_id,
        model_profile_revision_id, model_name, capabilities_snapshot, request_payload_blob_id, response_payload_blob_id,
        stop_reason, input_tokens, output_tokens, cost_micros, latency_ms, status, error_message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW())
     ON CONFLICT (turn_id, step_index)
     DO UPDATE SET
       provider_type = EXCLUDED.provider_type,
       request_type = EXCLUDED.request_type,
       model_group_id = EXCLUDED.model_group_id,
       model_profile_id = EXCLUDED.model_profile_id,
       model_profile_revision_id = EXCLUDED.model_profile_revision_id,
       model_name = EXCLUDED.model_name,
       capabilities_snapshot = EXCLUDED.capabilities_snapshot,
       request_payload_blob_id = EXCLUDED.request_payload_blob_id,
       response_payload_blob_id = EXCLUDED.response_payload_blob_id,
       stop_reason = EXCLUDED.stop_reason,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       cost_micros = EXCLUDED.cost_micros,
       latency_ms = EXCLUDED.latency_ms,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message
     RETURNING *`,
    [
      uuidv4(),
      params.turnId,
      params.stepIndex,
      params.providerType,
      params.requestType,
      asNullableUuid(params.modelGroupId),
      asNullableUuid(params.modelProfileId),
      asNullableUuid(params.modelProfileRevisionId),
      params.modelName,
      JSON.stringify(params.capabilitiesSnapshot || {}),
      requestPayloadBlobId,
      responsePayloadBlobId,
      params.stopReason || null,
      params.inputTokens,
      params.outputTokens,
      params.costMicros || 0,
      params.latencyMs,
      params.status,
      params.errorMessage || null,
    ],
  );

  return result.rows[0];
}

export async function createToolCall(params: {
  id?: string;
  turnId: string;
  providerStepId?: string;
  conversationId: string;
  sessionId?: string;
  callIndex: number;
  providerCallId?: string;
  bundleId: string;
  toolKind: 'builtin' | 'callable' | 'action' | 'mcp_plugin' | 'mcp_relay' | 'provider_builtin' | 'a2a_proxy';
  toolName: string;
  pluginId?: string | null;
  relayId?: string;
  normalizedInput: Record<string, unknown>;
}) {
  const result = await query(
    `INSERT INTO tool_calls
       (id, turn_id, provider_step_id, conversation_id, session_id, call_index, provider_call_id,
        bundle_id, tool_kind, tool_name, plugin_id, relay_id, normalized_input, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', NOW())
     RETURNING *`,
    [
      params.id || uuidv4(),
      params.turnId,
      params.providerStepId || null,
      params.conversationId,
      params.sessionId || null,
      params.callIndex,
      params.providerCallId || null,
      params.bundleId,
      params.toolKind,
      params.toolName,
      params.pluginId || null,
      params.relayId || null,
      JSON.stringify(params.normalizedInput),
    ],
  );

  return result.rows[0];
}

export async function updateToolCallStatus(toolCallId: string, status: 'running' | 'completed' | 'failed' | 'skipped') {
  await query(
    `UPDATE tool_calls
     SET status = $2::varchar(20),
         completed_at = CASE
           WHEN $2::varchar(20) IN ('completed', 'failed', 'skipped') THEN NOW()
           ELSE completed_at
         END
     WHERE id = $1`,
    [toolCallId, status],
  );
}

export async function createToolExecutionAttempt(params: {
  toolCallId: string;
  attemptNo: number;
  executorKind: 'builtin' | 'callable' | 'action' | 'mcp_plugin' | 'mcp_relay' | 'provider_builtin' | 'a2a_proxy';
  pluginId?: string | null;
  relayId?: string;
  transport?: string;
  instanceKey?: string;
  requestPayload?: unknown;
}) {
  const requestPayloadBlobId = params.requestPayload !== undefined
    ? await storePayloadBlob(params.requestPayload)
    : null;

  const result = await query(
    `INSERT INTO tool_execution_attempts
       (id, tool_call_id, attempt_no, executor_kind, plugin_id, relay_id, transport, instance_key,
        request_payload_blob_id, status, is_error, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'success', FALSE, NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.toolCallId,
      params.attemptNo,
      params.executorKind,
      params.pluginId || null,
      params.relayId || null,
      params.transport || null,
      params.instanceKey || null,
      requestPayloadBlobId,
    ],
  );

  return result.rows[0];
}

export async function finalizeToolExecutionAttempt(params: {
  attemptId: string;
  status: 'success' | 'error' | 'timeout';
  isError?: boolean;
  errorMessage?: string;
  durationMs?: number;
  responsePayload?: unknown;
}) {
  const responsePayloadBlobId = params.responsePayload !== undefined
    ? await storePayloadBlob(params.responsePayload, params.status === 'error' ? 'debug' : 'audit')
    : null;

  await query(
    `UPDATE tool_execution_attempts
     SET status = $2,
         is_error = $3,
         error_message = $4,
         duration_ms = $5,
         response_payload_blob_id = COALESCE($6, response_payload_blob_id)
     WHERE id = $1`,
    [
      params.attemptId,
      params.status,
      params.isError || false,
      params.errorMessage || null,
      params.durationMs || null,
      responsePayloadBlobId,
    ],
  );
}

export async function createToolResult(params: {
  toolCallId: string;
  attemptId?: string;
  resultIndex?: number;
  isError?: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  parts: Array<{
    type: 'text' | 'file_ref' | 'json';
    text?: string;
    fileId?: string;
    json?: unknown;
    mimeType?: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }>;
}) {
  const result = await query(
    `INSERT INTO tool_results
       (id, tool_call_id, attempt_id, result_index, is_error, error_message, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.toolCallId,
      params.attemptId || null,
      params.resultIndex || 0,
      params.isError || false,
      params.errorMessage || null,
      JSON.stringify(params.metadata || {}),
    ],
  );

  const toolResultId = result.rows[0].id as string;
  let ordinal = 0;
  for (const part of params.parts) {
    await query(
      `INSERT INTO tool_result_parts
         (id, tool_result_id, ordinal, part_type, text_value, file_id, json_value, mime_type, name, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        uuidv4(),
        toolResultId,
        ordinal++,
        part.type,
        part.type === 'text' ? part.text || '' : null,
        part.type === 'file_ref' ? part.fileId || null : null,
        part.type === 'json' ? JSON.stringify(part.json ?? {}) : null,
        part.mimeType || null,
        part.name || null,
        JSON.stringify(part.metadata || {}),
      ],
    );
  }

  return result.rows[0];
}

export async function getToolHistoryForSession(sessionId: string) {
  const result = await query(
    `SELECT tc.*, tr.id AS tool_result_id, tr.is_error, tr.error_message,
            ps.step_index,
            trp.ordinal AS result_part_ordinal,
            trp.part_type AS result_part_type,
            trp.text_value AS result_text_value,
            trp.file_id AS result_file_id,
            trp.json_value AS result_json_value,
            trp.mime_type AS result_mime_type,
            trp.name AS result_name,
            trp.metadata AS result_part_metadata
     FROM tool_calls tc
     LEFT JOIN provider_steps ps ON ps.id = tc.provider_step_id
     LEFT JOIN tool_results tr ON tr.tool_call_id = tc.id
     LEFT JOIN tool_result_parts trp ON trp.tool_result_id = tr.id
     WHERE tc.session_id = $1
     ORDER BY tc.created_at ASC, ps.step_index ASC NULLS LAST, tc.call_index ASC, tr.result_index ASC, trp.ordinal ASC`,
    [sessionId],
  );

  return result.rows;
}

export async function logRuntimeEvent(params: {
  workspaceId?: string;
  conversationId?: string;
  sessionId?: string;
  turnId?: string;
  providerStepId?: string;
  toolCallId?: string;
  toolAttemptId?: string;
  actorId?: string;
  userId?: string;
  source: 'conversation' | 'provider' | 'tool' | 'relay' | 'a2a' | 'system';
  level?: 'debug' | 'info' | 'warn' | 'error';
  eventType: string;
  payload?: Record<string, unknown>;
}) {
  await query(
    `INSERT INTO runtime_events
       (id, workspace_id, conversation_id, session_id, turn_id, provider_step_id, tool_call_id, tool_attempt_id,
        actor_id, user_id, source, level, event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
    [
      uuidv4(),
      params.workspaceId || null,
      params.conversationId || null,
      params.sessionId || null,
      params.turnId || null,
      params.providerStepId || null,
      params.toolCallId || null,
      params.toolAttemptId || null,
      params.actorId || null,
      params.userId || null,
      params.source,
      params.level || 'info',
      params.eventType,
      JSON.stringify(params.payload || {}),
    ],
  ).catch((err) => {
    console.error('[runtime_events] failed:', err.message);
  });
}

export async function recoverInterruptedExecutions(params?: {
  errorMessage?: string;
}) {
  const errorMessage = params?.errorMessage || 'Interrupted by server shutdown before the tool call completed.';

  const interruptedToolCalls = await query<{
    tool_call_id: string;
    latest_attempt_id: string | null;
    session_id: string | null;
  }>(
    `SELECT
       tc.id AS tool_call_id,
       tc.session_id,
       (
         SELECT tea.id
         FROM tool_execution_attempts tea
         WHERE tea.tool_call_id = tc.id
         ORDER BY tea.attempt_no DESC
         LIMIT 1
       ) AS latest_attempt_id
     FROM tool_calls tc
     JOIN turns t ON t.id = tc.turn_id
     WHERE t.status = 'running'
       AND tc.status IN ('pending', 'running')`,
  );

  let recoveredToolCalls = 0;
  for (const row of interruptedToolCalls.rows) {
    if (row.latest_attempt_id) {
      await query(
        `UPDATE tool_execution_attempts
         SET status = 'error',
             is_error = TRUE,
             error_message = COALESCE(error_message, $2)
         WHERE id = $1`,
        [row.latest_attempt_id, errorMessage],
      );
    }

    const existingResult = await query(
      `SELECT id FROM tool_results WHERE tool_call_id = $1 LIMIT 1`,
      [row.tool_call_id],
    );

    if (!existingResult.rows[0]) {
      await createToolResult({
        toolCallId: row.tool_call_id,
        attemptId: row.latest_attempt_id || undefined,
        isError: true,
        errorMessage,
        parts: [{ type: 'text', text: `Error: ${errorMessage}` }],
      });
    }

    await updateToolCallStatus(row.tool_call_id, 'failed');
    recoveredToolCalls += 1;
  }

  const interruptedTurns = await query<{ id: string; session_id: string | null }>(
    `SELECT id, session_id FROM turns WHERE status = 'running'`,
  );

  const sessionIds = new Set<string>();
  for (const row of interruptedTurns.rows) {
    await updateTurnStatus(row.id, 'failed', {
      metadata: { errorMessage, interruptedByShutdown: true },
    });
    if (row.session_id) sessionIds.add(row.session_id);
  }

  let recoveredSessions = 0;
  for (const sessionId of sessionIds) {
    await query(
      `UPDATE sessions
       SET status = 'failed',
           error_message = COALESCE(error_message, $2),
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'active'`,
      [sessionId, errorMessage],
    );
    recoveredSessions += 1;
  }

  return {
    recoveredToolCalls,
    recoveredTurns: interruptedTurns.rows.length,
    recoveredSessions,
  };
}
