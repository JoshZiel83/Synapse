import { createHash } from 'crypto';
import { sql } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { PayloadBlobsRetentionClass } from '../../infrastructure/database/generated/db.js';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { updateSessionStatus } from '../session/service.js';
import { markTurnWakeupsDropped, publishSessionRuntime } from '../session/runtime.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function asNullableUuid(value: unknown) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

async function getRuntimeTargetByTurnId(turnId: string) {
  const row = await db
    .selectFrom('turns as t')
    .innerJoin('sessions as s', 's.id', 't.session_id')
    .select(['s.workspace_id as workspace_id', 's.id as session_id'])
    .where('t.id', '=', turnId)
    .limit(1)
    .executeTakeFirst();

  return row
    ? {
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
      }
    : null;
}

async function getRuntimeTargetByToolCallId(toolCallId: string) {
  const row = await db
    .selectFrom('tool_calls as tc')
    .innerJoin('turns as t', 't.id', 'tc.turn_id')
    .innerJoin('sessions as s', 's.id', 't.session_id')
    .select(['s.workspace_id as workspace_id', 's.id as session_id'])
    .where('tc.id', '=', toolCallId)
    .limit(1)
    .executeTakeFirst();

  return row
    ? {
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
      }
    : null;
}

async function publishRuntimeForTurn(turnId: string) {
  const runtimeTarget = await getRuntimeTargetByTurnId(turnId);
  if (!runtimeTarget) return;
  await publishSessionRuntime(runtimeTarget.workspaceId, runtimeTarget.sessionId);
}

async function publishRuntimeForToolCall(toolCallId: string) {
  const runtimeTarget = await getRuntimeTargetByToolCallId(toolCallId);
  if (!runtimeTarget) return;
  await publishSessionRuntime(runtimeTarget.workspaceId, runtimeTarget.sessionId);
}

async function storePayloadBlobInternal(
  contentType: 'json' | 'text',
  payload: unknown,
  retentionClass: PayloadBlobsRetentionClass = 'audit',
) {
  const body = contentType === 'json'
    ? JSON.stringify(payload ?? {})
    : String(payload ?? '');
  const sha256 = createHash('sha256').update(body).digest('hex');

  const existing = await db
    .selectFrom('payload_blobs')
    .select('id')
    .where('sha256', '=', sha256)
    .limit(1)
    .executeTakeFirst();
  if (existing) {
    return existing.id;
  }

  const inserted = await db
    .insertInto('payload_blobs')
    .values({
      id: uuidv4(),
      sha256,
      content_type: contentType,
      json_body: (
        contentType === 'json' ? (payload ?? {}) : null
      ) as TableInsert<'payload_blobs'>['json_body'],
      text_body: contentType === 'text' ? String(payload ?? '') : null,
      byte_size: Buffer.byteLength(body, 'utf8'),
      retention_class: retentionClass,
      created_at: sql`NOW()`,
    })
    .returning('id')
    .executeTakeFirst();
  if (!inserted) {
    throw new Error('Failed to store payload blob');
  }

  return inserted.id;
}

export async function storePayloadBlob(
  payload: unknown,
  retentionClass: PayloadBlobsRetentionClass = 'audit',
) {
  return storePayloadBlobInternal('json', payload, retentionClass);
}

export async function storeTextPayloadBlob(
  payload: string,
  retentionClass: PayloadBlobsRetentionClass = 'audit',
) {
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
  return db
    .insertInto('turns')
    .values({
      id: params.id || uuidv4(),
      session_id: params.sessionId,
      conversation_id: params.conversationId,
      actor_id: params.actorId,
      trigger_item_id: params.triggerItemId || null,
      trigger_type: params.triggerType,
      status: 'running',
      metadata: (params.metadata || {}) as TableInsert<'turns'>['metadata'],
      started_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst();
}

export async function updateTurnStatus(turnId: string, status: 'completed' | 'failed' | 'cancelled', extra?: {
  metadata?: Record<string, unknown>;
}) {
  const update = db
    .updateTable('turns')
    .set({
      status,
      updated_at: sql`NOW()`,
      completed_at: sql`NOW()`,
      ...(extra?.metadata
        ? {
            metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify(extra.metadata)}::jsonb`,
          }
        : {}),
    })
    .where('id', '=', turnId);
  await update.execute();
}

export async function logProviderStep(params: {
  turnId: string;
  stepIndex: number;
  providerType: string;
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

  return db
    .insertInto('provider_steps')
    .values({
      id: uuidv4(),
      turn_id: params.turnId,
      step_index: params.stepIndex,
      provider_type: params.providerType,
      request_type: params.requestType,
      model_group_id: asNullableUuid(params.modelGroupId),
      model_profile_id: asNullableUuid(params.modelProfileId),
      model_profile_revision_id: asNullableUuid(params.modelProfileRevisionId),
      model_name: params.modelName,
      capabilities_snapshot: (params.capabilitiesSnapshot || {}) as TableInsert<'provider_steps'>['capabilities_snapshot'],
      request_payload_blob_id: requestPayloadBlobId,
      response_payload_blob_id: responsePayloadBlobId,
      stop_reason: params.stopReason || null,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cost_micros: params.costMicros || 0,
      latency_ms: params.latencyMs,
      status: params.status,
      error_message: params.errorMessage || null,
      created_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(['turn_id', 'step_index']).doUpdateSet({
        provider_type: params.providerType,
        request_type: params.requestType,
        model_group_id: asNullableUuid(params.modelGroupId),
        model_profile_id: asNullableUuid(params.modelProfileId),
        model_profile_revision_id: asNullableUuid(params.modelProfileRevisionId),
        model_name: params.modelName,
        capabilities_snapshot: (params.capabilitiesSnapshot || {}) as TableInsert<'provider_steps'>['capabilities_snapshot'],
        request_payload_blob_id: requestPayloadBlobId,
        response_payload_blob_id: responsePayloadBlobId,
        stop_reason: params.stopReason || null,
        input_tokens: params.inputTokens,
        output_tokens: params.outputTokens,
        cost_micros: params.costMicros || 0,
        latency_ms: params.latencyMs,
        status: params.status,
        error_message: params.errorMessage || null,
      }),
    )
    .returningAll()
    .executeTakeFirst();
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
  const row = await db
    .insertInto('tool_calls')
    .values({
      id: params.id || uuidv4(),
      turn_id: params.turnId,
      provider_step_id: params.providerStepId || null,
      conversation_id: params.conversationId,
      session_id: params.sessionId || null,
      call_index: params.callIndex,
      provider_call_id: params.providerCallId || null,
      bundle_id: params.bundleId,
      tool_kind: params.toolKind,
      tool_name: params.toolName,
      plugin_id: params.pluginId || null,
      relay_id: params.relayId || null,
      normalized_input: params.normalizedInput as TableInsert<'tool_calls'>['normalized_input'],
      status: 'pending',
      created_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst();

  if (row) {
    await publishRuntimeForTurn(params.turnId);
  }

  return row;
}

export async function updateToolCallStatus(toolCallId: string, status: 'running' | 'completed' | 'failed' | 'skipped') {
  await db
    .updateTable('tool_calls')
    .set({
      status,
      completed_at:
        status === 'completed' || status === 'failed' || status === 'skipped'
          ? sql`NOW()`
          : sql`completed_at`,
    })
    .where('id', '=', toolCallId)
    .execute();

  await publishRuntimeForToolCall(toolCallId);
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

  return db
    .insertInto('tool_execution_attempts')
    .values({
      id: uuidv4(),
      tool_call_id: params.toolCallId,
      attempt_no: params.attemptNo,
      executor_kind: params.executorKind,
      plugin_id: params.pluginId || null,
      relay_id: params.relayId || null,
      transport: params.transport || null,
      instance_key: params.instanceKey || null,
      request_payload_blob_id: requestPayloadBlobId,
      status: 'success',
      is_error: false,
      created_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst();
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

  await db
    .updateTable('tool_execution_attempts')
    .set({
      status: params.status,
      is_error: params.isError || false,
      error_message: params.errorMessage || null,
      duration_ms: params.durationMs || null,
      ...(responsePayloadBlobId
        ? { response_payload_blob_id: responsePayloadBlobId }
        : {}),
    })
    .where('id', '=', params.attemptId)
    .execute();
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
  const result = await db
    .insertInto('tool_results')
    .values({
      id: uuidv4(),
      tool_call_id: params.toolCallId,
      attempt_id: params.attemptId || null,
      result_index: params.resultIndex || 0,
      is_error: params.isError || false,
      error_message: params.errorMessage || null,
      metadata: (params.metadata || {}) as TableInsert<'tool_results'>['metadata'],
      created_at: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst();

  if (!result) {
    throw new Error('Failed to create tool result');
  }

  if (params.parts.length > 0) {
    await db
      .insertInto('tool_result_parts')
      .values(
        params.parts.map((part, ordinal) => ({
          id: uuidv4(),
          tool_result_id: result.id,
          ordinal,
          part_type: part.type,
          text_value: part.type === 'text' ? part.text || '' : null,
          file_id: part.type === 'file_ref' ? part.fileId || null : null,
          json_value:
            part.type === 'json'
              ? sql`${JSON.stringify(part.json ?? {})}::jsonb`
              : null,
          mime_type: part.mimeType || null,
          name: part.name || null,
          metadata: (part.metadata || {}) as TableInsert<'tool_result_parts'>['metadata'],
        })),
      )
      .execute();
  }

  await publishRuntimeForToolCall(params.toolCallId);

  return result;
}

export async function getToolHistoryForSession(sessionId: string) {
  return db
    .selectFrom('tool_calls as tc')
    .leftJoin('provider_steps as ps', 'ps.id', 'tc.provider_step_id')
    .leftJoin('tool_results as tr', 'tr.tool_call_id', 'tc.id')
    .leftJoin('tool_result_parts as trp', 'trp.tool_result_id', 'tr.id')
    .select([
      'tc.id',
      'tc.turn_id',
      'tc.provider_step_id',
      'tc.conversation_id',
      'tc.session_id',
      'tc.call_index',
      'tc.provider_call_id',
      'tc.bundle_id',
      'tc.tool_kind',
      'tc.tool_name',
      'tc.plugin_id',
      'tc.relay_id',
      'tc.normalized_input',
      'tc.status',
      'tc.created_at',
      'tc.completed_at',
      'tr.id as tool_result_id',
      'tr.is_error',
      'tr.error_message',
      'ps.step_index',
      'trp.ordinal as result_part_ordinal',
      'trp.part_type as result_part_type',
      'trp.text_value as result_text_value',
      'trp.file_id as result_file_id',
      'trp.json_value as result_json_value',
      'trp.mime_type as result_mime_type',
      'trp.name as result_name',
      'trp.metadata as result_part_metadata',
    ])
    .where('tc.session_id', '=', sessionId)
    .orderBy('tc.created_at', 'asc')
    .orderBy(sql`ps.step_index asc nulls last`)
    .orderBy('tc.call_index', 'asc')
    .orderBy('tr.result_index', 'asc')
    .orderBy('trp.ordinal', 'asc')
    .execute();
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
  await db
    .insertInto('runtime_events')
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId || null,
      conversation_id: params.conversationId || null,
      session_id: params.sessionId || null,
      turn_id: params.turnId || null,
      provider_step_id: params.providerStepId || null,
      tool_call_id: params.toolCallId || null,
      tool_attempt_id: params.toolAttemptId || null,
      actor_id: params.actorId || null,
      user_id: params.userId || null,
      source: params.source,
      level: params.level || 'info',
      event_type: params.eventType,
      payload: (params.payload || {}) as TableInsert<'runtime_events'>['payload'],
      created_at: sql`NOW()`,
    })
    .execute()
    .catch((err) => {
    console.error('[runtime_events] failed:', err.message);
  });
}

export async function recoverInterruptedExecutions(params?: {
  errorMessage?: string;
}) {
  const errorMessage = params?.errorMessage || 'Interrupted while the turn was still running.';

  const interruptedToolCalls = await db
    .selectFrom('tool_calls as tc')
    .innerJoin('turns as t', 't.id', 'tc.turn_id')
    .select([
      'tc.id as tool_call_id',
      'tc.session_id',
      sql<string | null>`(
         SELECT tea.id
         FROM tool_execution_attempts tea
         WHERE tea.tool_call_id = tc.id
         ORDER BY tea.attempt_no DESC
         LIMIT 1
       )`.as('latest_attempt_id'),
    ])
    .where('t.status', '=', 'running')
    .where('tc.status', 'in', ['pending', 'running'])
    .execute() as Array<{
    tool_call_id: string;
    latest_attempt_id: string | null;
    session_id: string | null;
  }>;

  let recoveredToolCalls = 0;
  for (const row of interruptedToolCalls) {
    if (row.latest_attempt_id) {
      await db
        .updateTable('tool_execution_attempts')
        .set({
          status: 'error',
          is_error: true,
          error_message: sql`COALESCE(error_message, ${errorMessage})`,
        })
        .where('id', '=', row.latest_attempt_id)
        .execute();
    }

    const existingResult = await db
      .selectFrom('tool_results')
      .select('id')
      .where('tool_call_id', '=', row.tool_call_id)
      .limit(1)
      .executeTakeFirst();

    if (!existingResult) {
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

  const interruptedTurns = await db
    .selectFrom('turns as t')
    .leftJoin('sessions as s', 's.id', 't.session_id')
    .leftJoin('conversations as c', 'c.id', 's.conversation_id')
    .select([
      't.id',
      't.session_id',
      's.workspace_id',
    ])
    .where('t.status', '=', 'running')
    .execute() as Array<{
    id: string;
    session_id: string | null;
    workspace_id: string | null;
  }>;

  const sessionsById = new Map<string, { workspaceId: string | null; turnId: string }>();
  for (const row of interruptedTurns) {
    await markTurnWakeupsDropped(row.id).catch(() => {});
    await updateTurnStatus(row.id, 'failed', {
      metadata: { errorMessage, interruptedByRecovery: true },
    });
    if (row.session_id) {
      sessionsById.set(row.session_id, {
        workspaceId: row.workspace_id,
        turnId: row.id,
      });
    }
  }

  let recoveredSessions = 0;
  for (const [sessionId, sessionInfo] of sessionsById.entries()) {
    await updateSessionStatus(sessionId, 'blocked', { errorMessage });
    if (sessionInfo.workspaceId) {
      await publishSessionRuntime(sessionInfo.workspaceId, sessionId, {
        laneState: 'blocked',
        health: 'error',
        phase: 'error',
        statusText: errorMessage,
        activeTurnId: sessionInfo.turnId,
        lastError: {
          message: errorMessage,
          at: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    recoveredSessions += 1;
  }

  return {
    recoveredToolCalls,
    recoveredTurns: interruptedTurns.length,
    recoveredSessions,
  };
}
