import { Queue } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { QUEUE_NAMES } from '@synapse/shared';

const connection = redis;

export const actorThinkingQueue = new Queue(QUEUE_NAMES.ACTOR_THINKING, { connection });
export const sessionThinkingQueue = new Queue(QUEUE_NAMES.SESSION_THINKING, { connection });
export const sessionTimeoutQueue = new Queue(QUEUE_NAMES.SESSION_TIMEOUT, { connection });
export const automationSchedulerQueue = new Queue(QUEUE_NAMES.AUTOMATION_SCHEDULER, { connection });
export const automationExecutionQueue = new Queue(QUEUE_NAMES.AUTOMATION_EXECUTION, { connection });

const queues = [
  actorThinkingQueue,
  sessionThinkingQueue,
  sessionTimeoutQueue,
  automationSchedulerQueue,
  automationExecutionQueue,
];

export async function shutdownQueues() {
  await Promise.allSettled(queues.map((queue) => queue.close()));
}
