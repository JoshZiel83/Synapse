import type { EventType, SystemEvent } from "@synapse/shared"
import { sql } from "kysely"
import { REDIS_CHANNELS } from "@synapse/shared"
import { config } from "../../config/index.js"
import { transaction } from "../database/index.js"
import {
  db,
  executeCompiledQuery,
  executeCompiledSql,
  type TableInsert,
  type TableRow,
} from "../database/kysely.js"
import { redisPub, redisSub } from "../redis/index.js"

export type Queryable = {
  query: (
    text: string,
    params?: any[]
  ) => Promise<{ rows: any[]; rowCount?: number | null }>
}

export type TransactionalRealtimeEventType = "chat.sync.event"

type TransactionalRealtimeEvent = SystemEvent & {
  type: TransactionalRealtimeEventType
}

export interface TransactionalRealtimeRecipient {
  workspaceId: string
  workspaceMemberId: string
}

type EventHandler = (event: SystemEvent) => void | Promise<void>

type RealtimeEventOutboxRow = Pick<
  TableRow<"realtime_event_outbox">,
  | "id"
  | "event_timestamp"
  | "payload"
  | "recipient_workspace_member_id"
  | "workspace_id"
> & {
  event_type: TransactionalRealtimeEventType
}

const handlers: Map<string, Set<EventHandler>> = new Map()
const TRANSACTIONAL_REALTIME_EVENT_TYPES =
  new Set<TransactionalRealtimeEventType>(["chat.sync.event"])

let realtimeOutboxDispatcherRunning = false
let realtimeOutboxDispatcherPromise: Promise<void> | null = null

function isTransactionalRealtimeEventType(
  type: EventType
): type is TransactionalRealtimeEventType {
  return TRANSACTIONAL_REALTIME_EVENT_TYPES.has(
    type as TransactionalRealtimeEventType
  )
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function eventTimestampToIso(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString()
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function claimPendingRealtimeOutboxEntries(limit: number) {
  return transaction(async (client) => {
    const compiled = sql<RealtimeEventOutboxRow[]>`
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
          processing_started_at = NOW(),
          updated_at = NOW()
      FROM claimed
      WHERE reo.id = claimed.id
      RETURNING reo.id,
                reo.event_type,
                reo.workspace_id,
                reo.recipient_workspace_member_id,
                reo.payload,
                reo.event_timestamp
    `.compile(db)
    const result = await executeCompiledSql<RealtimeEventOutboxRow>(
      client,
      compiled
    )

    return result.rows
  })
}

async function markRealtimeOutboxEntryDispatched(id: string) {
  await db
    .updateTable("realtime_event_outbox")
    .set({
      status: "dispatched",
      last_error: null,
      dispatched_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .execute()
}

async function markRealtimeOutboxEntryFailed(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  await db
    .updateTable("realtime_event_outbox")
    .set({
      status: "failed",
      last_error: message,
      available_at: sql`NOW() + (LEAST(attempts, 6) * INTERVAL '5 seconds')`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .execute()
}

async function materializeRealtimeOutboxEvent(
  entry: RealtimeEventOutboxRow
): Promise<SystemEvent> {
  const payload = parseJsonObject(entry.payload)
  const timestamp = eventTimestampToIso(entry.event_timestamp)

  switch (entry.event_type) {
    case "chat.sync.event":
      return {
        type: entry.event_type,
        workspaceId: entry.workspace_id,
        recipientWorkspaceMemberId: entry.recipient_workspace_member_id,
        payload,
        timestamp,
      }
    default:
      throw new Error(
        `Unsupported realtime outbox event type ${entry.event_type}`
      )
  }
}

async function processRealtimeOutboxEntry(entry: RealtimeEventOutboxRow) {
  try {
    const event = await materializeRealtimeOutboxEvent(entry)
    await emitEvent(event)
    await markRealtimeOutboxEntryDispatched(entry.id)
    return true
  } catch (error) {
    await markRealtimeOutboxEntryFailed(entry.id, error)
    console.error(
      `[events] Failed to dispatch realtime outbox entry ${entry.id}:`,
      error
    )
    return false
  }
}

export async function enqueueTransactionalEventDeliveries(
  queryable: Queryable,
  event: {
    type: TransactionalRealtimeEventType
    payload: Record<string, unknown>
    timestamp: string
    recipients: TransactionalRealtimeRecipient[]
  }
) {
  if (!isTransactionalRealtimeEventType(event.type)) {
    throw new Error(
      `Event type ${event.type} does not support transactional outbox`
    )
  }

  const recipients = event.recipients.filter(
    (recipient) => recipient.workspaceId && recipient.workspaceMemberId
  )
  if (recipients.length === 0) {
    return
  }

  await executeCompiledQuery(
    queryable,
    db.insertInto("realtime_event_outbox").values(
      recipients.map((recipient) => ({
        available_at: new Date(),
        event_timestamp: event.timestamp,
        event_type: event.type,
        payload: (event.payload ||
          {}) as TableInsert<"realtime_event_outbox">["payload"],
        workspace_id: recipient.workspaceId,
        recipient_workspace_member_id: recipient.workspaceMemberId,
      }))
    )
  )
}

export async function enqueueTransactionalEvent(
  queryable: Queryable,
  event: TransactionalRealtimeEvent
) {
  const recipientWorkspaceMemberId =
    typeof event.recipientWorkspaceMemberId === "string"
      ? event.recipientWorkspaceMemberId
      : ""
  if (!recipientWorkspaceMemberId) {
    throw new Error(
      `Transactional realtime event ${event.type} requires recipientWorkspaceMemberId`
    )
  }

  return enqueueTransactionalEventDeliveries(queryable, {
    type: event.type,
    payload: event.payload,
    timestamp: event.timestamp,
    recipients: [
      {
        workspaceId: event.workspaceId,
        workspaceMemberId: recipientWorkspaceMemberId,
      },
    ],
  })
}

export async function drainRealtimeEventOutbox(
  batchSize = config.realtime.outboxBatchSize
) {
  let processed = 0

  while (true) {
    const entries = await claimPendingRealtimeOutboxEntries(batchSize)
    if (entries.length === 0) {
      return processed
    }

    for (const entry of entries) {
      if (await processRealtimeOutboxEntry(entry)) {
        processed += 1
      }
    }
  }
}

async function runRealtimeOutboxDispatcherLoop() {
  while (realtimeOutboxDispatcherRunning) {
    try {
      const processed = await drainRealtimeEventOutbox()
      if (!realtimeOutboxDispatcherRunning) {
        break
      }
      await wait(processed > 0 ? 10 : config.realtime.outboxPollMs)
    } catch (error) {
      console.error("[events] Realtime outbox dispatcher loop failed:", error)
      if (!realtimeOutboxDispatcherRunning) {
        break
      }
      await wait(config.realtime.outboxPollMs)
    }
  }
}

export async function startRealtimeEventOutboxDispatcher() {
  if (realtimeOutboxDispatcherRunning) {
    return
  }
  realtimeOutboxDispatcherRunning = true
  realtimeOutboxDispatcherPromise = runRealtimeOutboxDispatcherLoop()
}

export async function stopRealtimeEventOutboxDispatcher() {
  realtimeOutboxDispatcherRunning = false
  const pending = realtimeOutboxDispatcherPromise
  realtimeOutboxDispatcherPromise = null
  if (pending) {
    await pending
  }
}

export async function initEventBus() {
  await redisSub.subscribe(REDIS_CHANNELS.EVENTS)

  redisSub.on("message", async (channel: string, message: string) => {
    if (channel !== REDIS_CHANNELS.EVENTS) return

    try {
      const event: SystemEvent = JSON.parse(message)
      const typeHandlers = handlers.get(event.type)
      if (typeHandlers) {
        for (const handler of typeHandlers) {
          try {
            await handler(event)
          } catch (err) {
            console.error(`Event handler error for ${event.type}:`, err)
          }
        }
      }

      const wildcardHandlers = handlers.get("*")
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            await handler(event)
          } catch (err) {
            console.error("Wildcard event handler error:", err)
          }
        }
      }
    } catch (err) {
      console.error("Event parse error:", err)
    }
  })
}

export function onEvent(type: string, handler: EventHandler) {
  if (!handlers.has(type)) {
    handlers.set(type, new Set())
  }
  handlers.get(type)!.add(handler)
  return () => handlers.get(type)?.delete(handler)
}

export async function emitEvent(event: SystemEvent) {
  await redisPub.publish(REDIS_CHANNELS.EVENTS, JSON.stringify(event))
}

export async function shutdownEventBus() {
  await stopRealtimeEventOutboxDispatcher()

  try {
    await redisSub.unsubscribe(REDIS_CHANNELS.EVENTS)
  } catch {
    // Ignore unsubscribe errors during shutdown.
  }
}
