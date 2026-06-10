import type { EventType, SystemEvent, Timestamp } from "@synapse/shared"
import {
  parseInstantString,
  requireInstantDate,
  serializeInstant,
} from "../datetime.js"
import { sql } from "kysely"
import { REDIS_CHANNELS, parseJsonObject } from "@synapse/shared"
import { config } from "../../config/index.js"
import {
  db,
  runBuilder,
  withDbTransaction,
  type Executor,
  type TableInsert,
  type TableRow,
} from "../database/kysely.js"
import { redisPub, redisSub } from "../redis/index.js"
import { createLogger } from "../logger/index.js"
import { maybeEnqueuePush } from "../../modules/chat/push.js"

const log = createLogger("events")

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
  TableRow<"realtimeEventOutbox">,
  | "id"
  | "eventTimestamp"
  | "payload"
  | "recipientWorkspaceMemberId"
  | "workspaceId"
> & {
  eventType: TransactionalRealtimeEventType
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

function eventTimestampToIso(value: unknown) {
  if (typeof value === "string") {
    return serializeInstant(parseInstantString(value))
  }
  return serializeInstant(
    requireInstantDate(value as Date | null, "event timestamp")
  )
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function claimPendingRealtimeOutboxEntries(limit: number) {
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

    return result.rows
  })
}

async function markRealtimeOutboxEntryDispatched(id: string) {
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

async function markRealtimeOutboxEntryFailed(id: string, error: unknown) {
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

async function materializeRealtimeOutboxEvent(
  entry: RealtimeEventOutboxRow
): Promise<SystemEvent> {
  const payload = parseJsonObject(entry.payload)
  const timestamp = eventTimestampToIso(entry.eventTimestamp)

  switch (entry.eventType) {
    case "chat.sync.event":
      return {
        type: entry.eventType,
        workspaceId: entry.workspaceId,
        recipientWorkspaceMemberId: entry.recipientWorkspaceMemberId,
        payload,
        timestamp,
      }
    default:
      throw new Error(
        `Unsupported realtime outbox event type ${entry.eventType}`
      )
  }
}

async function processRealtimeOutboxEntry(entry: RealtimeEventOutboxRow) {
  try {
    const event = await materializeRealtimeOutboxEvent(entry)
    await emitEvent(event)
    await markRealtimeOutboxEntryDispatched(entry.id)
    // WI-4 reserved seam (no-op today): push delivery for recipients with no
    // live socket. See modules/chat/push.ts. Never throws / never blocks
    // dispatch success.
    void maybeEnqueuePush(event).catch((err) =>
      log.error({ err }, "[events] maybeEnqueuePush hook failed")
    )
    return true
  } catch (error) {
    await markRealtimeOutboxEntryFailed(entry.id, error)
    log.error(
      { err: error },
      `[events] Failed to dispatch realtime outbox entry ${entry.id}`
    )
    return false
  }
}

export async function enqueueTransactionalEventDeliveries(
  queryable: Executor,
  event: {
    type: TransactionalRealtimeEventType
    payload: Record<string, unknown>
    timestamp: Timestamp
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

  await runBuilder(
    queryable,
    db.insertInto("realtimeEventOutbox").values(
      recipients.map((recipient) => ({
        availableAt: new Date(),
        eventTimestamp: parseInstantString(event.timestamp),
        eventType: event.type,
        payload: (event.payload ||
          {}) as TableInsert<"realtimeEventOutbox">["payload"],
        workspaceId: recipient.workspaceId,
        recipientWorkspaceMemberId: recipient.workspaceMemberId,
      }))
    )
  )
}

export async function enqueueTransactionalEvent(
  queryable: Executor,
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

/**
 * GC dispatched outbox rows older than the configured retention.
 * The original S8 plan called for dropping the realtime_event_outbox
 * table entirely; that's not viable because chat.sync.event still uses
 * it as a transactional outbox (see service.ts:enqueueTransactionalEvent).
 * Instead, keep the table but trim stale rows so it doesn't grow without
 * bound.
 *
 * S40 — IMPORTANT: this function deletes ONLY `status='dispatched'`
 * rows. `failed` is NOT a terminal status: claimPendingRealtimeOutbox
 * Entries() above retries `WHERE status IN ('pending','failed') AND
 * available_at <= NOW()`, and markRealtimeOutboxEntryFailed() backs
 * available_at off by at most ~30s. A failed row with an old
 * updated_at is either currently retrying or stuck in a loop that
 * needs ops attention. In both cases GC'ing it would silently drop a
 * realtime event the dispatcher still intends to deliver. If we later
 * want to drop chronically-failing rows we should first add a
 * terminal `dead_letter` status capped by attempts and only GC that.
 *
 * Returns the number of rows deleted so the dispatcher loop can log it.
 */
export async function gcRealtimeEventOutbox(
  retentionHours = config.realtime.outboxRetentionHours
) {
  if (retentionHours < 0) return 0
  // One DELETE statement on the pool — no need for an explicit
  // transaction. Indexed on (status, available_at, created_at) so the
  // status filter is cheap.
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

/**
 * Recover rows stuck in `status='processing'`. A row enters 'processing' when
 * claimPendingRealtimeOutboxEntries claims it; on success it becomes
 * 'dispatched', on failure 'failed'. But if the dispatcher process crashes
 * between the claim and either terminal write, the row stays 'processing'
 * forever — claimPending only re-claims ('pending','failed'), so nothing ever
 * picks it up again and the realtime event is silently never delivered.
 *
 * This sweeper resets rows whose processing_started_at is older than the
 * configured timeout back to 'failed' with immediate availability, so the next
 * drain re-claims and re-publishes them (at-least-once). Bounded by the same
 * GC cadence so it is cheap. Returns the number of rows recovered.
 */
export async function recoverStuckProcessingRealtimeOutboxEntries(
  timeoutMs = config.realtime.outboxProcessingTimeoutMs
) {
  if (timeoutMs <= 0) return 0
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

async function runRealtimeOutboxDispatcherLoop() {
  let lastGcAt = 0
  while (realtimeOutboxDispatcherRunning) {
    try {
      const processed = await drainRealtimeEventOutbox()

      // Periodic maintenance (bounded by outboxGcIntervalMs so it doesn't run
      // on every drain): (1) recover rows stuck in 'processing' from a crashed
      // dispatcher, BEFORE GC so recovered rows get re-claimed next drain;
      // (2) GC dispatched rows (NOT failed — those are retryable).
      const now = Date.now()
      if (now - lastGcAt >= config.realtime.outboxGcIntervalMs) {
        lastGcAt = now
        try {
          const recovered = await recoverStuckProcessingRealtimeOutboxEntries()
          if (recovered > 0) {
            log.warn(
              `[events] realtime_event_outbox: recovered ${recovered} rows stuck in processing`
            )
          }
        } catch (recoverError) {
          log.error(
            { err: recoverError },
            "[events] realtime_event_outbox stuck-processing recovery failed"
          )
        }
        try {
          const gced = await gcRealtimeEventOutbox()
          if (gced > 0) {
            log.info(
              `[events] realtime_event_outbox GC: pruned ${gced} dispatched rows`
            )
          }
        } catch (gcError) {
          log.error(
            { err: gcError },
            "[events] realtime_event_outbox GC failed"
          )
        }
      }

      if (!realtimeOutboxDispatcherRunning) {
        break
      }
      await wait(processed > 0 ? 10 : config.realtime.outboxPollMs)
    } catch (error) {
      log.error(
        { err: error },
        "[events] Realtime outbox dispatcher loop failed"
      )
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
            log.error({ err }, `Event handler error for ${event.type}`)
          }
        }
      }

      const wildcardHandlers = handlers.get("*")
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            await handler(event)
          } catch (err) {
            log.error({ err }, "Wildcard event handler error")
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Event parse error")
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
