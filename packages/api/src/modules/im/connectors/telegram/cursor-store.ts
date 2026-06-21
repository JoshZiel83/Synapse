/**
 * Telegram getUpdates offset cursor — Redis get/set/clear.
 *
 * Mirrors `weixin/cursor-store.ts`. The offset is `max(update_id)+1`; storing
 * it in Redis (keyed per account, 7d TTL) means a lease handoff to another
 * replica resumes from the same point instead of redelivering/dropping.
 *
 * The `redis` import is a lazily-connecting singleton, so this module does no
 * IO at import time — calls happen inside async functions only. A `client`
 * param (defaulting to that singleton) is a DI seam so tests can inject a
 * fake (mirrors qq/session-store.ts).
 */

import { redis as defaultRedis } from "../../../../infrastructure/redis/index.js"

/** Minimal redis surface this module uses (DI seam for tests). */
export interface CursorRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>
  del(key: string): Promise<unknown>
}

const KEY_PREFIX = "im:telegram:offset:"
const TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

export function offsetKey(accountId: string): string {
  return KEY_PREFIX + accountId
}

/** Read the stored offset; 0 (poll from the latest pending) when unset. */
export async function getOffset(
  accountId: string,
  client: CursorRedis = defaultRedis
): Promise<number> {
  const v = await client.get(offsetKey(accountId))
  if (typeof v !== "string") return 0
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Persist the next offset. No-op for non-positive values. */
export async function setOffset(
  accountId: string,
  offset: number,
  client: CursorRedis = defaultRedis
): Promise<void> {
  if (!Number.isFinite(offset) || offset <= 0) return
  await client.set(offsetKey(accountId), String(offset), "EX", TTL_SECONDS)
}

/** Clear the stored offset (e.g. on account teardown / reset). */
export async function clearOffset(
  accountId: string,
  client: CursorRedis = defaultRedis
): Promise<void> {
  await client.del(offsetKey(accountId))
}
