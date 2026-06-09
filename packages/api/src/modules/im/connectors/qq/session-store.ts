/**
 * Redis-backed session store for the QQ WebSocket gateway.
 *
 * QQ's WS gateway lets a reconnecting client send `op:6 Resume {token,
 * session_id, seq}` instead of a fresh Identify. The platform then
 * replays any events queued since the last `s` we acked, ending with
 * a RESUMED event. To take advantage of this across process restarts
 * we persist the `session_id` + last `seq` to Redis.
 *
 * Key namespace: `im:qq:ws-session:{accountId}`
 * TTL: 5 minutes (the QQ platform's resume window). Any longer and we
 * just take an Identify hit on reconnect.
 *
 * Stored value also carries `appId`: if the operator rotates the
 * account's appId/clientSecret the saved session_id becomes invalid;
 * we compare on load and drop mismatched sessions explicitly so we
 * don't silently try to RESUME against a stale token.
 */

import { nowIsoInstant } from "@synapse/shared/datetime"
import type { Redis } from "ioredis"

export interface QqWsSessionState {
  sessionId: string
  lastSeq: number
  appId: string
  savedAt: string
}

const TTL_MS = 5 * 60 * 1000
const SAVE_THROTTLE_MS = 1000 // don't pound Redis on every dispatch tick

const lastSaveAt = new Map<string, number>()

function key(accountId: string): string {
  return `im:qq:ws-session:${accountId}`
}

export async function loadQqWsSession(
  redis: Redis,
  accountId: string,
  currentAppId: string
): Promise<QqWsSessionState | null> {
  const raw = await redis.get(key(accountId))
  if (!raw) return null
  let parsed: QqWsSessionState
  try {
    parsed = JSON.parse(raw) as QqWsSessionState
  } catch {
    return null
  }
  if (parsed.appId !== currentAppId) {
    // App identity changed — saved session_id is for a different bot.
    // Drop it explicitly so we don't try to resume against the new bot's
    // gateway with stale state.
    await redis.del(key(accountId)).catch(() => undefined)
    return null
  }
  return parsed
}

export async function saveQqWsSession(
  redis: Redis,
  accountId: string,
  state: Omit<QqWsSessionState, "savedAt">
): Promise<void> {
  const now = Date.now()
  const last = lastSaveAt.get(accountId) ?? 0
  if (now - last < SAVE_THROTTLE_MS) return
  lastSaveAt.set(accountId, now)
  const value: QqWsSessionState = {
    ...state,
    savedAt: nowIsoInstant(),
  }
  await redis.set(key(accountId), JSON.stringify(value), "PX", TTL_MS)
}

export async function clearQqWsSession(
  redis: Redis,
  accountId: string
): Promise<void> {
  lastSaveAt.delete(accountId)
  await redis.del(key(accountId)).catch(() => undefined)
}
