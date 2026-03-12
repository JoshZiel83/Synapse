import type { SystemEvent } from '@synapse/shared';
import { REDIS_CHANNELS } from '@synapse/shared';
import { redisPub, redisSub } from '../redis/index.js';

type EventHandler = (event: SystemEvent) => void | Promise<void>;

const handlers: Map<string, Set<EventHandler>> = new Map();

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

      // Also fire wildcard handlers
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
  try {
    await redisSub.unsubscribe(REDIS_CHANNELS.EVENTS);
  } catch {
    // Ignore unsubscribe errors during shutdown.
  }
}
