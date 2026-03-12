import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { QUEUE_NAMES } from '@synapse/shared';
import { getSession } from '../modules/session/service.js';
import { registerWorker } from './registry.js';

/**
 * Session timeout worker — handles timed-out sessions.
 * In the group model, there's no waiting state. Sessions are either active or sleeping.
 * This worker is kept for safety but most timeout scenarios are no longer applicable.
 */
export function startSessionTimeoutWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_TIMEOUT,
    async (job) => {
      const { sessionId } = job.data;

      const session = await getSession(sessionId);
      if (!session) return { success: false, reason: 'session not found' };

      // In the group model, sessions don't have a 'waiting' state
      // This worker is now a no-op for most cases
      console.log(`[session-timeout] Session ${sessionId} timeout check — status: ${session.status}`);

      return { success: true, status: session.status };
    },
    {
      connection: redis,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Session timeout job ${job?.id} failed:`, err.message);
  });

  registerWorker(worker);
  return worker;
}
