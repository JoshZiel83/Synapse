import { Queue } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { QUEUE_NAMES } from '@synapse/shared';

const connection = redis;

export const sessionThinkingQueue = new Queue(QUEUE_NAMES.SESSION_THINKING, { connection });
export const automationSchedulerQueue = new Queue(QUEUE_NAMES.AUTOMATION_SCHEDULER, { connection });
export const automationExecutionQueue = new Queue(QUEUE_NAMES.AUTOMATION_EXECUTION, { connection });

export async function enqueueAutomationExecutionJobs(executionIds: string[]) {
  const uniqueExecutionIds = Array.from(
    new Set(executionIds.map((executionId) => executionId.trim()).filter(Boolean)),
  );
  await Promise.all(
    uniqueExecutionIds.map((executionId) =>
      automationExecutionQueue.add(
        'execute',
        { executionId },
        { jobId: `automation:execution:${executionId}` },
      ),
    ),
  );
}

const queues = [
  sessionThinkingQueue,
  automationSchedulerQueue,
  automationExecutionQueue,
];

export async function shutdownQueues() {
  await Promise.allSettled(queues.map((queue) => queue.close()));
}
