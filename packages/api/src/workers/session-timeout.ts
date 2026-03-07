import { Worker } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { QUEUE_NAMES, nowISO } from '@synapse/shared';
import {
  getSession,
  addSessionMessage,
} from '../modules/session/service.js';
import { resumeSession } from '../modules/session/completion.js';

export function startSessionTimeoutWorker() {
  const worker = new Worker(
    QUEUE_NAMES.SESSION_TIMEOUT,
    async (job) => {
      const { sessionId, workspaceId } = job.data;

      const session = await getSession(sessionId);
      if (!session) return { success: false, reason: 'session not found' };

      // Only process if session is still waiting
      if (session.status !== 'waiting') {
        return { success: false, reason: `session is ${session.status}, not waiting` };
      }

      console.log(`[session-timeout] Session ${sessionId} wait timed out`);

      // Inject timeout notification message
      await addSessionMessage({
        sessionId,
        workspaceId,
        role: 'system',
        content: '[系统通知] 你等待的子任务已超时。你仍在等待的子任务ID: ' +
          (session.waiting_for || []).join(', ') +
          '。请决定下一步操作：你可以继续等待、取消子任务、或先处理已完成的部分。',
      });

      // Resume the session so the model can decide what to do
      await resumeSession(sessionId);

      return { success: true };
    },
    {
      connection: redis,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    console.error(`Session timeout job ${job?.id} failed:`, err.message);
  });

  return worker;
}
