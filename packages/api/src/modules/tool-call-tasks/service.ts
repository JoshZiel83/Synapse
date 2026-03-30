import {
  extractText,
  textBlocks,
  type CanonicalContentBlock,
  type TaskNoticeStatus,
} from "@synapse/shared";
import { query, transaction } from "../../infrastructure/database/index.js";
import {
  createConversationEvent,
  getConversationMember,
} from "../conversation/service.js";
import { enqueueSessionWakeup } from "../session/runtime.js";

export type ToolCallTaskStatus =
  | "working"
  | "input_required"
  | TaskNoticeStatus;

export type ToolCallTaskDispatchStatus =
  | "accepted"
  | "queued"
  | "dispatched"
  | "received"
  | "started"
  | "input_requested"
  | "cancel_requested";

export type ToolCallTaskDeliveryPolicy =
  | "online_only"
  | "store_and_forward"
  | "human_interaction";

export type ToolCallTaskExecutorKind =
  | "interaction_question"
  | "interaction_form"
  | "relay_authorization"
  | "relay_mcp";

type Queryable = {
  query: (
    text: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

type ToolCallTaskRow = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  session_id: string;
  actor_id: string;
  turn_id: string | null;
  source_tool_call_id: string | null;
  source_tool_name: string;
  executor_kind: ToolCallTaskExecutorKind;
  delivery_policy: ToolCallTaskDeliveryPolicy;
  status: ToolCallTaskStatus;
  status_message: string | null;
  dispatch_status: ToolCallTaskDispatchStatus;
  supports_cancel: boolean;
  supports_output_tail: boolean;
  request_payload: unknown;
  immediate_result_payload: unknown;
  final_result_payload: unknown;
  final_error_payload: unknown;
  metadata: unknown;
  completion_item_id: string | null;
  deadline_at: string | null;
  retention_ttl_ms: number | null;
  retain_until: string | null;
  cancel_requested_at: string | null;
  cancel_reason: string | null;
  last_output_seq: string | number | null;
  last_output_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface ToolCallTaskRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  sessionId: string;
  actorId: string;
  turnId?: string;
  sourceToolCallId?: string;
  sourceToolName: string;
  executorKind: ToolCallTaskExecutorKind;
  deliveryPolicy: ToolCallTaskDeliveryPolicy;
  status: ToolCallTaskStatus;
  statusMessage?: string;
  dispatchStatus: ToolCallTaskDispatchStatus;
  supportsCancel: boolean;
  supportsOutputTail: boolean;
  requestPayload: Record<string, unknown>;
  immediateResultPayload: Record<string, unknown>;
  finalResultPayload: Record<string, unknown>;
  finalErrorPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  completionItemId?: string;
  deadlineAt?: string;
  retentionTtlMs?: number;
  retainUntil?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  lastOutputSeq: number;
  lastOutputAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateToolCallTaskParams {
  workspaceId: string;
  conversationId: string;
  sessionId: string;
  actorId: string;
  turnId?: string;
  sourceToolCallId?: string;
  sourceToolName: string;
  executorKind: ToolCallTaskExecutorKind;
  deliveryPolicy: ToolCallTaskDeliveryPolicy;
  status?: ToolCallTaskStatus;
  statusMessage?: string;
  dispatchStatus?: ToolCallTaskDispatchStatus;
  supportsCancel?: boolean;
  supportsOutputTail?: boolean;
  requestPayload?: Record<string, unknown>;
  immediateResultPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  deadlineAt?: string;
  retentionTtlMs?: number;
  retainUntil?: string;
}

interface ToolCallTaskTerminalNoticeParams {
  summary: string;
  message?: string;
  messageBlocks?: CanonicalContentBlock[];
  finalResultPayload?: Record<string, unknown>;
  finalErrorPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  notifyActor?: boolean;
}

export interface ToolCallTaskOutputChunk {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

const TERMINAL_TOOL_CALL_TASK_STATUSES = new Set<ToolCallTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function mapToolCallTaskRow(
  row: ToolCallTaskRow | null,
): ToolCallTaskRecord | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    actorId: row.actor_id,
    turnId: row.turn_id || undefined,
    sourceToolCallId: row.source_tool_call_id || undefined,
    sourceToolName: row.source_tool_name,
    executorKind: row.executor_kind,
    deliveryPolicy: row.delivery_policy,
    status: row.status,
    statusMessage: row.status_message || undefined,
    dispatchStatus: row.dispatch_status,
    supportsCancel: row.supports_cancel === true,
    supportsOutputTail: row.supports_output_tail === true,
    requestPayload: parseJsonObject(row.request_payload),
    immediateResultPayload: parseJsonObject(row.immediate_result_payload),
    finalResultPayload: parseJsonObject(row.final_result_payload),
    finalErrorPayload: parseJsonObject(row.final_error_payload),
    metadata: parseJsonObject(row.metadata),
    completionItemId: row.completion_item_id || undefined,
    deadlineAt: row.deadline_at || undefined,
    retentionTtlMs:
      typeof row.retention_ttl_ms === "number"
        ? row.retention_ttl_ms
        : undefined,
    retainUntil: row.retain_until || undefined,
    cancelRequestedAt: row.cancel_requested_at || undefined,
    cancelReason: row.cancel_reason || undefined,
    lastOutputSeq:
      typeof row.last_output_seq === "number"
        ? row.last_output_seq
        : Number(row.last_output_seq || 0),
    lastOutputAt: row.last_output_at || undefined,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies ToolCallTaskRecord;
}

async function assertSessionAllowsToolCallTasks(
  client: Queryable,
  sessionId: string,
) {
  const result = await client.query(
    `SELECT id, channel_type, status
     FROM sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (row.channel_type === "api") {
    throw new Error("Tool-call tasks are not supported for API sessions");
  }
  if (row.status === "closed") {
    throw new Error(`Session ${sessionId} is closed`);
  }
}

export async function insertToolCallTask(
  client: Queryable,
  params: CreateToolCallTaskParams,
) {
  await assertSessionAllowsToolCallTasks(client, params.sessionId);

  const result = (await client.query(
    `INSERT INTO tool_call_tasks (
       workspace_id,
       conversation_id,
       session_id,
       actor_id,
       turn_id,
       source_tool_call_id,
       source_tool_name,
       executor_kind,
       delivery_policy,
       status,
       status_message,
       dispatch_status,
       supports_cancel,
       supports_output_tail,
       request_payload,
       immediate_result_payload,
       metadata,
       deadline_at,
       retention_ttl_ms,
       retain_until
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12,
       $13,
       $14,
       $15::jsonb,
       $16::jsonb,
       $17::jsonb,
       $18,
       $19,
       $20
     )
     RETURNING *`,
    [
      params.workspaceId,
      params.conversationId,
      params.sessionId,
      params.actorId,
      params.turnId || null,
      params.sourceToolCallId || null,
      params.sourceToolName,
      params.executorKind,
      params.deliveryPolicy,
      params.status || "working",
      params.statusMessage || null,
      params.dispatchStatus || "accepted",
      params.supportsCancel === true,
      params.supportsOutputTail === true,
      JSON.stringify(params.requestPayload || {}),
      JSON.stringify(params.immediateResultPayload || {}),
      JSON.stringify(params.metadata || {}),
      params.deadlineAt || null,
      params.retentionTtlMs ?? null,
      params.retainUntil || null,
    ],
  )) as { rows: ToolCallTaskRow[] };

  const record = mapToolCallTaskRow(result.rows[0] || null);
  if (!record) {
    throw new Error("Failed to create tool-call task");
  }
  return record;
}

export async function createToolCallTask(params: CreateToolCallTaskParams) {
  return transaction((client) => insertToolCallTask(client, params));
}

export async function getToolCallTask(taskId: string) {
  const result = await query<ToolCallTaskRow>(
    `SELECT *
     FROM tool_call_tasks
     WHERE id = $1
     LIMIT 1`,
    [taskId],
  );

  return mapToolCallTaskRow(result.rows[0] || null);
}

export async function appendToolCallTaskOutput(
  taskId: string,
  chunk: {
    seq: number;
    stream: "stdout" | "stderr" | "system";
    text: string;
    createdAt?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const text = chunk.text.trim();
  if (!text) {
    return getToolCallTask(taskId);
  }

  await query(
    `INSERT INTO tool_call_task_output_chunks (
       task_id,
       seq,
       stream,
       text_value,
       metadata,
       created_at
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5::jsonb,
       COALESCE($6::timestamptz, NOW())
     )
     ON CONFLICT (task_id, seq) DO NOTHING`,
    [
      taskId,
      chunk.seq,
      chunk.stream,
      text,
      JSON.stringify(chunk.metadata || {}),
      chunk.createdAt || null,
    ],
  );

  return updateToolCallTaskRecord(taskId, {
    lastOutputSeq: Math.max(0, chunk.seq),
    lastOutputAt: chunk.createdAt || new Date().toISOString(),
  });
}

export async function requestToolCallTaskCancel(
  taskId: string,
  reason?: string,
) {
  const existing = await getToolCallTask(taskId);
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`);
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing;
  }
  return updateToolCallTaskRecord(taskId, {
    dispatchStatus: "cancel_requested",
    cancelRequestedAt: new Date().toISOString(),
    cancelReason: reason?.trim() || existing.cancelReason || null,
    statusMessage: reason?.trim() || existing.statusMessage || "Cancellation requested.",
  });
}

export async function getToolCallTaskForSession(
  sessionId: string,
  taskId: string,
) {
  const result = await query<ToolCallTaskRow>(
    `SELECT *
     FROM tool_call_tasks
     WHERE id = $1
       AND session_id = $2
     LIMIT 1`,
    [taskId, sessionId],
  );

  return mapToolCallTaskRow(result.rows[0] || null);
}

export async function listToolCallTasksForSession(params: {
  sessionId: string;
  statuses?: ToolCallTaskStatus[];
  limit?: number;
}) {
  const result = await query<ToolCallTaskRow>(
    `SELECT *
     FROM tool_call_tasks
     WHERE session_id = $1
       AND ($2::varchar(20)[] IS NULL OR status = ANY($2::varchar(20)[]))
     ORDER BY created_at DESC
     LIMIT $3`,
    [
      params.sessionId,
      params.statuses && params.statuses.length > 0 ? params.statuses : null,
      Math.min(Math.max(params.limit || 20, 1), 100),
    ],
  );

  return result.rows
    .map((row) => mapToolCallTaskRow(row))
    .filter((row): row is ToolCallTaskRecord => row !== null);
}

export async function getToolCallTaskOutput(params: {
  taskId: string;
  afterSeq?: number;
  limit?: number;
  stream?: "stdout" | "stderr" | "system" | "combined";
}) {
  const normalizedLimit = Math.min(Math.max(params.limit || 20, 1), 200);
  const afterSeq = Math.max(0, params.afterSeq || 0);
  const stream =
    params.stream && params.stream !== "combined" ? params.stream : null;

  const result = await query<{
    seq: string | number;
    stream: "stdout" | "stderr" | "system";
    text_value: string;
    metadata: unknown;
    created_at: string;
  }>(
    afterSeq > 0
      ? `SELECT seq, stream, text_value, metadata, created_at
         FROM tool_call_task_output_chunks
         WHERE task_id = $1
           AND seq > $2
           AND ($3::varchar(20) IS NULL OR stream = $3)
         ORDER BY seq ASC
         LIMIT $4`
      : `SELECT seq, stream, text_value, metadata, created_at
         FROM (
           SELECT seq, stream, text_value, metadata, created_at
           FROM tool_call_task_output_chunks
           WHERE task_id = $1
             AND ($2::varchar(20) IS NULL OR stream = $2)
           ORDER BY seq DESC
           LIMIT $3
         ) tail
         ORDER BY seq ASC`,
    afterSeq > 0
      ? [params.taskId, afterSeq, stream, normalizedLimit]
      : [params.taskId, stream, normalizedLimit],
  );

  return result.rows.map((row) => ({
    seq: typeof row.seq === "number" ? row.seq : Number(row.seq || 0),
    stream: row.stream,
    text: row.text_value,
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata),
  })) satisfies ToolCallTaskOutputChunk[];
}

async function updateToolCallTaskRecord(
  taskId: string,
  params: {
    status?: ToolCallTaskStatus;
    statusMessage?: string;
    dispatchStatus?: ToolCallTaskDispatchStatus;
    supportsCancel?: boolean;
    supportsOutputTail?: boolean;
    immediateResultPayload?: Record<string, unknown>;
    finalResultPayload?: Record<string, unknown>;
    finalErrorPayload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    completionItemId?: string;
    deadlineAt?: string;
    retentionTtlMs?: number;
    retainUntil?: string;
    cancelRequestedAt?: string | null;
    cancelReason?: string | null;
    lastOutputSeq?: number;
    lastOutputAt?: string | null;
  },
) {
  const existing = await getToolCallTask(taskId);
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`);
  }

  const nextStatus = params.status || existing.status;
  if (
    TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status) &&
    existing.status !== nextStatus
  ) {
    return existing;
  }

  const nextMetadata =
    params.metadata !== undefined
      ? {
          ...existing.metadata,
          ...params.metadata,
        }
      : existing.metadata;

  const result = await query<ToolCallTaskRow>(
    `UPDATE tool_call_tasks
     SET status = $2,
         status_message = $3,
         dispatch_status = $4,
         supports_cancel = $5,
         supports_output_tail = $6,
         immediate_result_payload = $7::jsonb,
         final_result_payload = $8::jsonb,
         final_error_payload = $9::jsonb,
         metadata = $10::jsonb,
         completion_item_id = $11,
         deadline_at = $12,
         retention_ttl_ms = $13,
         retain_until = $14,
         cancel_requested_at = $15,
         cancel_reason = $16,
         last_output_seq = $17,
         last_output_at = $18,
         completed_at = CASE
           WHEN $2::varchar(20) IN ('completed', 'failed', 'cancelled')
             THEN COALESCE(completed_at, NOW())
           ELSE completed_at
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      taskId,
      nextStatus,
      params.statusMessage ?? existing.statusMessage ?? null,
      params.dispatchStatus || existing.dispatchStatus,
      params.supportsCancel ?? existing.supportsCancel,
      params.supportsOutputTail ?? existing.supportsOutputTail,
      JSON.stringify(
        params.immediateResultPayload ?? existing.immediateResultPayload ?? {},
      ),
      JSON.stringify(
        params.finalResultPayload ?? existing.finalResultPayload ?? {},
      ),
      JSON.stringify(
        params.finalErrorPayload ?? existing.finalErrorPayload ?? {},
      ),
      JSON.stringify(nextMetadata),
      params.completionItemId ?? existing.completionItemId ?? null,
      params.deadlineAt ?? existing.deadlineAt ?? null,
      params.retentionTtlMs ?? existing.retentionTtlMs ?? null,
      params.retainUntil ?? existing.retainUntil ?? null,
      params.cancelRequestedAt ?? existing.cancelRequestedAt ?? null,
      params.cancelReason ?? existing.cancelReason ?? null,
      params.lastOutputSeq ?? existing.lastOutputSeq ?? 0,
      params.lastOutputAt ?? existing.lastOutputAt ?? null,
    ],
  );

  return mapToolCallTaskRow(result.rows[0] || null);
}

async function emitTaskNotice(
  record: ToolCallTaskRecord,
  status: TaskNoticeStatus,
  params: ToolCallTaskTerminalNoticeParams,
) {
  if (params.notifyActor === false) {
    return updateToolCallTaskRecord(record.id, {
      status,
      statusMessage: params.summary,
      finalResultPayload: params.finalResultPayload,
      finalErrorPayload: params.finalErrorPayload,
      metadata: params.metadata,
    });
  }

  const actorMember = await getConversationMember({
    conversationId: record.conversationId,
    actorId: record.actorId,
  });

  const messageBlocks =
    params.messageBlocks && params.messageBlocks.length > 0
      ? params.messageBlocks
      : params.message?.trim()
        ? textBlocks(params.message.trim())
        : textBlocks(params.summary);
  const message =
    params.message?.trim() || extractText(messageBlocks).trim() || params.summary;

  let completionItemId: string | undefined;
  if (actorMember?.id) {
    const created = await createConversationEvent({
      workspaceId: record.workspaceId,
      conversationId: record.conversationId,
      sessionId: record.sessionId,
      turnId: record.turnId,
      eventType: "task_notice",
      eventPayload: {
        taskId: record.id,
        toolName: record.sourceToolName,
        status,
        summary: params.summary,
        message,
        messageBlocks,
      },
      timelinePolicy: "none",
      contextPolicy: "actor_private",
      contextTargetMemberIds: [actorMember.id],
      metadata: {
        taskId: record.id,
        sourceToolName: record.sourceToolName,
      },
    });
    completionItemId = created.item.id;
  }

  const updated = await updateToolCallTaskRecord(record.id, {
    status,
    statusMessage: params.summary,
    finalResultPayload: params.finalResultPayload,
    finalErrorPayload: params.finalErrorPayload,
    metadata: params.metadata,
    completionItemId,
  });

  await enqueueSessionWakeup({
    sessionId: record.sessionId,
    actorId: record.actorId,
    workspaceId: record.workspaceId,
    sourceType: "system_interrupt",
    sourceItemId: completionItemId,
    sourceMemberType: "system",
    sourceName: record.sourceToolName,
    summary: params.summary,
    reasonText: message || params.summary,
    metadata: {
      taskId: record.id,
      taskStatus: status,
      executorKind: record.executorKind,
      sourceToolName: record.sourceToolName,
      activationKind: "tool_call_task",
      delivery: record.id,
      ...(params.metadata || {}),
    },
    trigger: "system_interrupt",
  });

  return updated;
}

export async function markToolCallTaskInputRequired(
  taskId: string,
  statusMessage: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "input_required",
    statusMessage,
    dispatchStatus: "input_requested",
    metadata,
  });
}

export async function markToolCallTaskQueued(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "queued",
    metadata,
  });
}

export async function markToolCallTaskDispatched(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "dispatched",
    metadata,
  });
}

export async function markToolCallTaskReceived(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "received",
    metadata,
  });
}

export async function markToolCallTaskStarted(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "started",
    metadata,
  });
}

export async function markToolCallTaskCancelRequested(
  taskId: string,
  statusMessage?: string,
  metadata?: Record<string, unknown>,
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: "cancel_requested",
    metadata,
    cancelRequestedAt: new Date().toISOString(),
  });
}

export async function markToolCallTaskWorking(
  taskId: string,
  statusMessage?: string,
  params?: {
    dispatchStatus?: ToolCallTaskDispatchStatus;
    metadata?: Record<string, unknown>;
  },
) {
  return updateToolCallTaskRecord(taskId, {
    status: "working",
    statusMessage,
    dispatchStatus: params?.dispatchStatus,
    metadata: params?.metadata,
  });
}

export async function completeToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams,
) {
  const existing = await getToolCallTask(taskId);
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`);
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing;
  }
  return emitTaskNotice(existing, "completed", params);
}

export async function failToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams,
) {
  const existing = await getToolCallTask(taskId);
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`);
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing;
  }
  return emitTaskNotice(existing, "failed", params);
}

export async function cancelToolCallTask(
  taskId: string,
  params: ToolCallTaskTerminalNoticeParams,
) {
  const existing = await getToolCallTask(taskId);
  if (!existing) {
    throw new Error(`Tool-call task ${taskId} not found`);
  }
  if (TERMINAL_TOOL_CALL_TASK_STATUSES.has(existing.status)) {
    return existing;
  }
  return emitTaskNotice(existing, "cancelled", params);
}
