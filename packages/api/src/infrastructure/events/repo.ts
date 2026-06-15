import { parseJsonObject, type Timestamp } from "@synapse/shared"
import { sql } from "kysely"
import {
  parseInstantString,
  requireInstantDate,
  serializeInstant,
} from "../datetime.js"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
  type TableInsert,
  type TableRow,
} from "../database/kysely.js"

export type RealtimeOutboxEventType = "chat.sync.event"

export interface RealtimeOutboxRecipient {
  workspaceId: string
  workspaceMemberId: string
}

export interface RealtimeOutboxEntry {
  id: string
  eventType: RealtimeOutboxEventType
  workspaceId: string
  recipientWorkspaceMemberId: string
  payload: Record<string, unknown>
  timestamp: Timestamp
}

export interface RealtimeOutboxDeliveryInput {
  type: RealtimeOutboxEventType
  payload: Record<string, unknown>
  timestamp: Timestamp
  recipients: RealtimeOutboxRecipient[]
}

type RealtimeEventOutboxRow = Pick<
  TableRow<"realtimeEventOutbox">,
  | "id"
  | "eventTimestamp"
  | "payload"
  | "recipientWorkspaceMemberId"
  | "workspaceId"
> & {
  eventType: string
}

function requireRealtimeOutboxEventType(
  value: string
): RealtimeOutboxEventType {
  if (value === "chat.sync.event") return value
  throw new Error(`Unsupported realtime outbox event type ${value}`)
}

function eventTimestampToIso(value: unknown) {
  if (typeof value === "string") {
    return serializeInstant(parseInstantString(value))
  }
  return serializeInstant(
    requireInstantDate(value as Date | null, "event timestamp")
  )
}

function normalizeRealtimeOutboxEntry(
  row: RealtimeEventOutboxRow
): RealtimeOutboxEntry {
  return {
    id: row.id,
    eventType: requireRealtimeOutboxEventType(row.eventType),
    workspaceId: row.workspaceId,
    recipientWorkspaceMemberId: row.recipientWorkspaceMemberId,
    payload: parseJsonObject(row.payload),
    timestamp: eventTimestampToIso(row.eventTimestamp),
  }
}

export async function claimPendingRealtimeOutboxEntries(limit: number) {
  return withDbTransaction(async (trx) => {
    const result = await sql<RealtimeEventOutboxRow>`
      WITH claimed AS (
        SELECT id
        FROM realtime_event_outbox
        WHERE status IN ('pending', 'failed')
          AND available_at <= NOW()
        ORDER BY created_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE realtime_event_outbox reo
      SET status = 'processing',
          attempts = attempts + 1,
          last_error = NULL,
          processing_started_at = NOW()
      FROM claimed
      WHERE reo.id = claimed.id
      RETURNING reo.id,
                reo.event_type,
                reo.workspace_id,
                reo.recipient_workspace_member_id,
                reo.payload,
                reo.event_timestamp
    `.execute(trx)

    return result.rows.map(normalizeRealtimeOutboxEntry)
  })
}

export async function markRealtimeOutboxEntryDispatched(id: string) {
  await db
    .updateTable("realtimeEventOutbox")
    .set({
      status: "dispatched",
      lastError: null,
      dispatchedAt: sql`NOW()`,
    })
    .where("id", "=", id)
    .execute()
}

export async function markRealtimeOutboxEntryFailed(
  id: string,
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error)
  await db
    .updateTable("realtimeEventOutbox")
    .set({
      status: "failed",
      lastError: message,
      availableAt: sql`NOW() + (LEAST(attempts, 6) * INTERVAL '5 seconds')`,
    })
    .where("id", "=", id)
    .execute()
}

export async function insertRealtimeOutboxDeliveries(
  queryable: Executor,
  input: RealtimeOutboxDeliveryInput
) {
  await runBuilder(
    queryable,
    db.insertInto("realtimeEventOutbox").values(
      input.recipients.map((recipient) => ({
        availableAt: new Date(),
        eventTimestamp: parseInstantString(input.timestamp),
        eventType: input.type,
        payload: (input.payload ||
          {}) as TableInsert<"realtimeEventOutbox">["payload"],
        workspaceId: recipient.workspaceId,
        recipientWorkspaceMemberId: recipient.workspaceMemberId,
      }))
    )
  )
}

export async function deleteDispatchedRealtimeOutboxEntries(
  retentionHours: number
) {
  const result = await db
    .deleteFrom("realtimeEventOutbox")
    .where("status", "=", "dispatched")
    .where(
      "updatedAt",
      "<",
      sql<Date>`NOW() - (${String(retentionHours)} || ' hours')::interval`
    )
    .executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}

export async function recoverStuckProcessingRealtimeOutboxEntries(
  timeoutMs: number
) {
  const result = await db
    .updateTable("realtimeEventOutbox")
    .set({
      status: "failed",
      lastError: "recovered: stuck in processing past timeout",
      availableAt: sql`NOW()`,
    })
    .where("status", "=", "processing")
    .where(
      "processingStartedAt",
      "<",
      sql<Date>`NOW() - (${String(timeoutMs)} || ' milliseconds')::interval`
    )
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}
