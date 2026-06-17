import { CompiledQuery, sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import type { TransportKind } from "@synapse/shared/types"
import {
  withDbTransaction,
  type Executor,
  type TableInsert,
} from "../infrastructure/database/kysely.js"

export type TaskProjectionExecutor = Executor

export interface PendingTaskProjectionRecord {
  id: string
  taskId: string
  workspaceId: string
  conversationId: string
  transportMessageLinkId: string | null
  attempts: number
}

export interface LockedTaskProjectionTaskRecord {
  id: string
  status: string
  expiresAt: Date | null
}

type PendingTaskProjectionRow = {
  id: string
  task_id: string
  workspace_id: string
  conversation_id: string
  transport_message_link_id: string | null
  attempts: number
}

type LockedTaskProjectionTaskRow = {
  id: string
  status: string
  expires_at: Date | null
}

async function runOn<T extends object = Record<string, unknown>>(
  executor: TaskProjectionExecutor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[] }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  // CamelCasePlugin's transformResult camelCases raw result rows too (it only
  // skips the query transform), so a bare `SELECT task_id, expires_at` comes
  // back as { taskId, expiresAt }. The readers below are snake_case, so
  // re-snake the top-level keys. Values pass through; idempotent.
  return {
    rows: result.rows.map((row) => snakeCaseTopLevelKeys(row) as T),
  }
}

function snakeCaseTopLevelKeys<T extends object>(row: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = value
  }
  return out as T
}

export async function runTaskProjectionBatch<T>(
  fn: (client: TaskProjectionExecutor) => Promise<T>
): Promise<T> {
  return withDbTransaction((trx) => fn(trx))
}

export async function listPendingTaskProjectionRows(
  client: TaskProjectionExecutor,
  limit: number
): Promise<PendingTaskProjectionRecord[]> {
  const result = await runOn<PendingTaskProjectionRow>(
    client,
    `
      SELECT id, task_id, workspace_id, conversation_id,
             transport_message_link_id, attempts
      FROM tool_call_task_transport_projections
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `,
    [limit]
  )
  return result.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    transportMessageLinkId: row.transport_message_link_id,
    attempts: row.attempts,
  }))
}

export async function lockTaskProjectionTask(
  client: TaskProjectionExecutor,
  taskId: string
): Promise<LockedTaskProjectionTaskRecord | undefined> {
  const result = await runOn<LockedTaskProjectionTaskRow>(
    client,
    `
      SELECT id, lifecycle_status AS status, expires_at
      FROM tool_call_tasks
      WHERE id = $1
      FOR UPDATE
    `,
    [taskId]
  )
  const row = result.rows[0]
  return row
    ? {
        id: row.id,
        status: row.status,
        expiresAt: row.expires_at,
      }
    : undefined
}

export async function beginProjectionBusinessSavepoint(
  client: TaskProjectionExecutor
): Promise<void> {
  await runOn(client, "SAVEPOINT projection_business", [])
}

export async function releaseProjectionBusinessSavepoint(
  client: TaskProjectionExecutor
): Promise<void> {
  await runOn(client, "RELEASE SAVEPOINT projection_business", [])
}

export async function rollbackProjectionBusinessSavepoint(
  client: TaskProjectionExecutor
): Promise<void> {
  await runOn(client, "ROLLBACK TO SAVEPOINT projection_business", [])
}

export async function markTaskProjectionProjected(
  client: TaskProjectionExecutor,
  rowId: string,
  linkId: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET status = 'projected',
          transport_message_link_id = $2,
          error = NULL
      WHERE id = $1
    `,
    [rowId, linkId]
  )
}

export async function skipTaskProjectionRow(
  client: TaskProjectionExecutor,
  rowId: string,
  error: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET status = 'skipped',
          error = $2
      WHERE id = $1
    `,
    [rowId, error]
  )
}

export async function markTaskProjectionFailed(
  client: TaskProjectionExecutor,
  rowId: string,
  attempts: number,
  error: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET status = 'failed',
          attempts = $2,
          error = $3
      WHERE id = $1
    `,
    [rowId, attempts, error]
  )
}

export async function scheduleTaskProjectionRetry(
  client: TaskProjectionExecutor,
  rowId: string,
  attempts: number,
  backoffSeconds: number,
  error: string
): Promise<void> {
  await runOn(
    client,
    `
      UPDATE tool_call_task_transport_projections
      SET attempts = $2,
          next_attempt_at = NOW() + ($3 || ' seconds')::interval,
          error = $4
      WHERE id = $1
    `,
    [rowId, attempts, String(backoffSeconds), error]
  )
}

export async function insertTaskProjectionOutboundLink(
  client: TaskProjectionExecutor,
  params: {
    workspaceId: string
    conversationId: string
    itemId: string
    transportAccountId: string
    transportEndpointId: string
    transportKind: TransportKind
    metadata?: Record<string, unknown>
  }
): Promise<{ id: string }> {
  const row = await client
    .insertInto("transportMessageLinks")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      itemId: params.itemId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: params.transportEndpointId,
      transportKind: params.transportKind,
      direction: "outbound",
      deliveryStatus: "pending",
      externalMessageId: null,
      externalReplyToId: null,
      externalThreadId: null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transportMessageLinks">["metadata"],
      createdAt: sql`NOW()`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return { id: row.id }
}
