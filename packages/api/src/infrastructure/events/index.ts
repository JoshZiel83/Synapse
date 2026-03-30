import type { EventType, SystemEvent } from '@synapse/shared';
import { REDIS_CHANNELS } from '@synapse/shared';
import { config } from '../../config/index.js';
import { query, transaction } from '../database/index.js';
import { redisPub, redisSub } from '../redis/index.js';

export type Queryable = {
  query: (
    text: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type TransactionalRealtimeEventType =
  | 'feed.item.created'
  | 'conversation.read.updated'
  | 'conversation.updated'
  | 'interaction.updated';

type TransactionalRealtimeEvent = SystemEvent & {
  type: TransactionalRealtimeEventType;
};

type EventHandler = (event: SystemEvent) => void | Promise<void>;

type RealtimeEventOutboxRow = {
  id: string;
  event_type: TransactionalRealtimeEventType;
  workspace_id: string;
  payload: unknown;
  event_timestamp: string | Date;
};

const handlers: Map<string, Set<EventHandler>> = new Map();
const TRANSACTIONAL_REALTIME_EVENT_TYPES = new Set<TransactionalRealtimeEventType>([
  'feed.item.created',
  'conversation.read.updated',
  'conversation.updated',
  'interaction.updated',
]);

let realtimeOutboxDispatcherRunning = false;
let realtimeOutboxDispatcherPromise: Promise<void> | null = null;

function isTransactionalRealtimeEventType(
  type: EventType,
): type is TransactionalRealtimeEventType {
  return TRANSACTIONAL_REALTIME_EVENT_TYPES.has(
    type as TransactionalRealtimeEventType,
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function eventTimestampToIso(value: string | Date) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function wait(ms: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function claimPendingRealtimeOutboxEntries(limit: number) {
  return transaction(async (client) => {
    const result = await client.query<RealtimeEventOutboxRow>(
      `WITH claimed AS (
       SELECT id
         FROM realtime_event_outbox
         WHERE status IN ('pending', 'failed')
           AND available_at <= NOW()
         ORDER BY created_at ASC, id ASC
         LIMIT $1
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
       RETURNING reo.id, reo.event_type, reo.workspace_id, reo.payload, reo.event_timestamp`,
      [limit],
    );

    return result.rows;
  });
}

async function markRealtimeOutboxEntryDispatched(id: string) {
  await query(
    `UPDATE realtime_event_outbox
     SET status = 'dispatched',
         last_error = NULL,
         dispatched_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}

async function markRealtimeOutboxEntryFailed(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await query(
    `UPDATE realtime_event_outbox
     SET status = 'failed',
         last_error = $2,
         available_at = NOW() + (LEAST(attempts, 6) * INTERVAL '5 seconds'),
         updated_at = NOW()
     WHERE id = $1`,
    [id, message],
  );
}

async function materializeRealtimeOutboxEvent(
  entry: RealtimeEventOutboxRow,
): Promise<SystemEvent> {
  const payload = parseJsonObject(entry.payload);
  const timestamp = eventTimestampToIso(entry.event_timestamp);

  switch (entry.event_type) {
    case 'feed.item.created': {
      const itemId =
        typeof payload.itemId === 'string' ? payload.itemId.trim() : '';
      if (!itemId) {
        throw new Error(`Outbox entry ${entry.id} is missing itemId`);
      }
      const { getConversationFeedItemById } = await import(
        '../../modules/conversation/service.js'
      );
      const item = await getConversationFeedItemById(itemId);
      if (!item) {
        throw new Error(
          `Conversation item ${itemId} not found for outbox entry ${entry.id}`,
        );
      }
      return {
        type: 'feed.item.created',
        workspaceId: entry.workspace_id,
        payload: item as unknown as Record<string, unknown>,
        timestamp,
      };
    }
    case 'interaction.updated': {
      const interactionId =
        typeof payload.interactionId === 'string'
          ? payload.interactionId.trim()
          : '';
      if (!interactionId) {
        throw new Error(`Outbox entry ${entry.id} is missing interactionId`);
      }
      const { getInteractionRequestSummary } = await import(
        '../../modules/interactions/service.js'
      );
      const interaction = await getInteractionRequestSummary(interactionId);
      if (!interaction) {
        throw new Error(
          `Interaction ${interactionId} not found for outbox entry ${entry.id}`,
        );
      }
      return {
        type: 'interaction.updated',
        workspaceId: entry.workspace_id,
        payload: {
          conversationId: interaction.conversationId,
          interactionId: interaction.id,
          itemId: interaction.itemId,
          interaction,
        } as unknown as Record<string, unknown>,
        timestamp,
      };
    }
    case 'conversation.read.updated':
    case 'conversation.updated':
      return {
        type: entry.event_type,
        workspaceId: entry.workspace_id,
        payload,
        timestamp,
      };
    default:
      throw new Error(`Unsupported realtime outbox event type ${entry.event_type}`);
  }
}

async function processRealtimeOutboxEntry(entry: RealtimeEventOutboxRow) {
  try {
    const event = await materializeRealtimeOutboxEvent(entry);
    await emitEvent(event);
    await markRealtimeOutboxEntryDispatched(entry.id);
    return true;
  } catch (error) {
    await markRealtimeOutboxEntryFailed(entry.id, error);
    console.error(
      `[events] Failed to dispatch realtime outbox entry ${entry.id}:`,
      error,
    );
    return false;
  }
}

export async function enqueueTransactionalEvent(
  queryable: Queryable,
  event: TransactionalRealtimeEvent,
) {
  if (!isTransactionalRealtimeEventType(event.type)) {
    throw new Error(`Event type ${event.type} does not support transactional outbox`);
  }

  await queryable.query(
    `INSERT INTO realtime_event_outbox (
       event_type,
       workspace_id,
       payload,
       event_timestamp,
       available_at
     )
     VALUES ($1, $2, $3::jsonb, $4::timestamptz, NOW())`,
    [
      event.type,
      event.workspaceId,
      JSON.stringify(event.payload || {}),
      event.timestamp,
    ],
  );
}

export async function drainRealtimeEventOutbox(
  batchSize = config.realtime.outboxBatchSize,
) {
  let processed = 0;

  while (true) {
    const entries = await claimPendingRealtimeOutboxEntries(batchSize);
    if (entries.length === 0) {
      return processed;
    }

    for (const entry of entries) {
      if (await processRealtimeOutboxEntry(entry)) {
        processed += 1;
      }
    }
  }
}

async function runRealtimeOutboxDispatcherLoop() {
  while (realtimeOutboxDispatcherRunning) {
    try {
      const processed = await drainRealtimeEventOutbox();
      if (!realtimeOutboxDispatcherRunning) {
        break;
      }
      await wait(processed > 0 ? 10 : config.realtime.outboxPollMs);
    } catch (error) {
      console.error('[events] Realtime outbox dispatcher loop failed:', error);
      if (!realtimeOutboxDispatcherRunning) {
        break;
      }
      await wait(config.realtime.outboxPollMs);
    }
  }
}

export async function startRealtimeEventOutboxDispatcher() {
  if (realtimeOutboxDispatcherRunning) {
    return;
  }
  realtimeOutboxDispatcherRunning = true;
  realtimeOutboxDispatcherPromise = runRealtimeOutboxDispatcherLoop();
}

export async function stopRealtimeEventOutboxDispatcher() {
  realtimeOutboxDispatcherRunning = false;
  const pending = realtimeOutboxDispatcherPromise;
  realtimeOutboxDispatcherPromise = null;
  if (pending) {
    await pending;
  }
}

export async function initEventBus() {
  await redisSub.subscribe(REDIS_CHANNELS.EVENTS);

  redisSub.on('message', async (channel: string, message: string) => {
    if (channel !== REDIS_CHANNELS.EVENTS) return;

    try {
      const event: SystemEvent = JSON.parse(message);
      const typeHandlers = handlers.get(event.type);
      if (typeHandlers) {
        for (const handler of typeHandlers) {
          try {
            await handler(event);
          } catch (err) {
            console.error(`Event handler error for ${event.type}:`, err);
          }
        }
      }

      const wildcardHandlers = handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            await handler(event);
          } catch (err) {
            console.error('Wildcard event handler error:', err);
          }
        }
      }
    } catch (err) {
      console.error('Event parse error:', err);
    }
  });
}

export function onEvent(type: string, handler: EventHandler) {
  if (!handlers.has(type)) {
    handlers.set(type, new Set());
  }
  handlers.get(type)!.add(handler);
  return () => handlers.get(type)?.delete(handler);
}

export async function emitEvent(event: SystemEvent) {
  await redisPub.publish(REDIS_CHANNELS.EVENTS, JSON.stringify(event));
}

export async function shutdownEventBus() {
  await stopRealtimeEventOutboxDispatcher();

  try {
    await redisSub.unsubscribe(REDIS_CHANNELS.EVENTS);
  } catch {
    // Ignore unsubscribe errors during shutdown.
  }
}
