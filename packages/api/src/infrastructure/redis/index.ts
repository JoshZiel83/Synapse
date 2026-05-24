import Redis from "ioredis"
import { config } from "../../config/index.js"

// Use any for the client type — ioredis's default export is a class but
// TypeScript only sees it as a namespace via this CJS interop; the
// runtime constructor is what we actually need.
type RedisClient = any

function createRedisClient(): RedisClient {
  return new (Redis as any)(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
}

// Lazy clients: the underlying ioredis instance is created on first
// property access. Modules that import { redis } at the top level for
// type-side or fallback reasons (e.g., the entire chat module graph
// transitively reaches infrastructure/events → infrastructure/redis)
// don't pay for a Redis connection until something actually calls a
// command on it. This keeps unit tests that never touch Redis from
// opening sockets that then fail with NOAUTH and hang the test runner.
type LazyHandle = {
  client: RedisClient
  isMaterialized: () => boolean
}

function lazyRedisClient(): LazyHandle {
  let materialized: RedisClient | null = null
  function ensure(): RedisClient {
    if (!materialized) materialized = createRedisClient()
    return materialized
  }
  const proxy = new Proxy({} as RedisClient, {
    get(_target, prop) {
      const client = ensure()
      const value = (client as unknown as Record<PropertyKey, unknown>)[
        prop as string
      ]
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(client)
        : value
    },
  }) as RedisClient
  return {
    client: proxy,
    isMaterialized: () => materialized !== null,
  }
}

const lazyRedis = lazyRedisClient()
const lazyRedisSub = lazyRedisClient()
const lazyRedisPub = lazyRedisClient()

export const redis = lazyRedis.client
export const redisSub = lazyRedisSub.client
export const redisPub = lazyRedisPub.client

export async function testRedisConnection(): Promise<boolean> {
  try {
    await redis.ping()
    return true
  } catch {
    return false
  }
}

export async function shutdownRedisConnections() {
  const handles = [lazyRedisSub, lazyRedisPub, lazyRedis]
  await Promise.allSettled(
    handles
      .filter((handle) => handle.isMaterialized())
      .map(async (handle) => {
        try {
          await handle.client.quit()
        } catch {
          handle.client.disconnect()
        }
      })
  )
}
