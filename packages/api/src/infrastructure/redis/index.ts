import Redis from 'ioredis';
import { config } from '../../config/index.js';

export const redis = new (Redis as any)(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const redisSub = new (Redis as any)(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const redisPub = new (Redis as any)(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export async function testRedisConnection(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
