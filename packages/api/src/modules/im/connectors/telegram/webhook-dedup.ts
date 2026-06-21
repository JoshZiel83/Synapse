/**
 * Telegram inbound `update_id` dedup (webhook path).
 *
 * Telegram delivers at-least-once: a webhook POST that doesn't return 200 in
 * time is retried, and the same update can be re-sent. We guard with a short
 * Redis SET-NX marker keyed by `(accountId, update_id)`. First sighting wins
 * (returns false = not a duplicate); a repeat within the TTL returns true.
 *
 * (The long-poll path dedups structurally via the monotonic offset cursor, so
 * this helper is only used by `handleWebhook`.)
 *
 * The `redis` import is a lazily-connecting singleton → no IO at import time.
 * A `client` param (defaulting to it) is a DI seam for tests.
 */

import { redis as defaultRedis } from "../../../../infrastructure/redis/index.js"

/** Minimal redis surface (DI seam for tests). */
export interface DedupRedis {
  set(
    key: string,
    value: string,
    mode1: string,
    ttl: number,
    mode2: string
  ): Promise<unknown>
}

const KEY_PREFIX = "im:telegram:dedup:"
const TTL_SECONDS = 60 * 10 // 10 minutes — covers Telegram's webhook retry window

export function dedupKey(accountId: string, updateId: number): string {
  return `${KEY_PREFIX}${accountId}:${updateId}`
}

/**
 * Returns true if this update_id was already seen for this account (within the
 * TTL); false on the first sighting (and records it). On Redis error, fails
 * OPEN (returns false) so a transient Redis hiccup never drops a message.
 */
export async function isDuplicateUpdate(
  accountId: string,
  updateId: number,
  client: DedupRedis = defaultRedis
): Promise<boolean> {
  try {
    // SET key 1 NX EX ttl → "OK" when newly set, null when it already existed.
    const res = await client.set(
      dedupKey(accountId, updateId),
      "1",
      "EX",
      TTL_SECONDS,
      "NX"
    )
    return res === null
  } catch {
    return false
  }
}
