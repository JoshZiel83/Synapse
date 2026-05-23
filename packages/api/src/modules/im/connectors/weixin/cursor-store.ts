/**
 * Redis-backed cursor store for the Weixin long-poll sync_buf.
 *
 * The legacy implementation kept sync_buf in a process-local Map, so a
 * second replica or a restart would lose the cursor and either re-receive
 * already-delivered messages (dedupe saves us from duplicates but wastes
 * round-trips) or skip messages that arrived during the gap. Redis with
 * a key per-account lets reconcile-lease handoff move the cursor with
 * the active worker.
 */

import { redis } from "../../../../infrastructure/redis/index.js"

const KEY_PREFIX = "im:weixin:sync-buf:"
const TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

function key(accountId: string): string {
  return KEY_PREFIX + accountId
}

export async function getSyncBuf(accountId: string): Promise<string> {
  const v = await redis.get(key(accountId))
  return typeof v === "string" ? v : ""
}

export async function setSyncBuf(
  accountId: string,
  value: string
): Promise<void> {
  if (!value) return
  await redis.set(key(accountId), value, "EX", TTL_SECONDS)
}

export async function clearSyncBuf(accountId: string): Promise<void> {
  await redis.del(key(accountId))
}
