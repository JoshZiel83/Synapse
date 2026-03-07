import { Queue } from 'bullmq';
import { redis } from '../infrastructure/redis/index.js';
import { QUEUE_NAMES } from '@synapse/shared';

const connection = redis;

export const actorThinkingQueue = new Queue(QUEUE_NAMES.ACTOR_THINKING, { connection });
export const memoryArchivalQueue = new Queue(QUEUE_NAMES.MEMORY_ARCHIVAL, { connection });
export const standingOrdersQueue = new Queue(QUEUE_NAMES.STANDING_ORDERS, { connection });
