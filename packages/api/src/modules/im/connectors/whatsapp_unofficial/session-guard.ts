/**
 * Session-guard: a Redis pause flag for the Baileys connection.
 *
 * Two ways it gets set (per plan §4.5):
 *   - AUTO: the DisconnectReason state machine pauses on loggedOut/forbidden
 *     (the session is dead — re-link required). TTL-bounded so it self-clears.
 *   - OPERATOR: a manual kill-switch for a protocol break (Meta changes the
 *     private protocol without notice → P0). `pauseSessionOperator` sets a
 *     longer TTL and a distinguishable reason so on-call can stop the socket
 *     fleet without a code deploy. Cleared via `clearSessionPause`.
 *
 * Effect:
 *   - the inbound/connection loop checks `isSessionPaused` and sleeps instead
 *     of reconnecting (a paused socket must NOT fight for the connection);
 *   - outbound `sendMessage` fails fast (RetryableTransportError) when paused.
 *
 * Mirrors weixin/session-guard.ts (flat `prefix + accountId` key, `EXISTS`
 * check, TTL-derived remaining time) and adds the operator toggle + reason.
 */

import { redis as defaultRedis } from "../../../../infrastructure/redis/index.js"

/**
 * Minimal Redis surface the guard uses. Defaults to the shared singleton; tests
 * inject an in-memory stub (mirrors qq/session-store's DI). The `setRedisForTest`
 * seam swaps the module-level client used by the no-arg public functions.
 */
export interface SessionGuardRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
  ttl(key: string): Promise<number>
  exists(key: string): Promise<number>
}

let redis: SessionGuardRedis = defaultRedis as unknown as SessionGuardRedis

/** Test seam: swap the redis client. Returns a restore fn. */
export function setRedisForTest(client: SessionGuardRedis): () => void {
  const prev = redis
  redis = client
  return () => {
    redis = prev
  }
}

const KEY_PREFIX = "im:whatsapp_unofficial:session-paused:"

/** Auto-pause (dead session). 1h, like weixin. */
export const AUTO_PAUSE_SECONDS = 60 * 60
/** Operator kill-switch default. 24h — long enough to ride out a protocol break. */
export const OPERATOR_PAUSE_SECONDS = 24 * 60 * 60

export type SessionPauseReason = "logged_out" | "forbidden" | "operator"

function key(accountId: string): string {
  return KEY_PREFIX + accountId
}

interface PausePayload {
  reason: SessionPauseReason
  at: number
}

/** Auto-pause from the DisconnectReason state machine (dead session). */
export async function pauseSession(
  accountId: string,
  reason: Exclude<SessionPauseReason, "operator">
): Promise<void> {
  const payload: PausePayload = { reason, at: Date.now() }
  await redis.set(
    key(accountId),
    JSON.stringify(payload),
    "EX",
    AUTO_PAUSE_SECONDS
  )
}

/** Operator kill-switch. Longer TTL + a distinguishable reason. */
export async function pauseSessionOperator(
  accountId: string,
  ttlSeconds: number = OPERATOR_PAUSE_SECONDS
): Promise<void> {
  const payload: PausePayload = { reason: "operator", at: Date.now() }
  await redis.set(
    key(accountId),
    JSON.stringify(payload),
    "EX",
    Math.max(1, ttlSeconds)
  )
}

export async function isSessionPaused(accountId: string): Promise<boolean> {
  return (await redis.exists(key(accountId))) === 1
}

export async function getSessionPause(
  accountId: string
): Promise<{ reason: SessionPauseReason; remainingMs: number } | null> {
  const raw = await redis.get(key(accountId))
  if (raw == null) return null
  const ttl = await redis.ttl(key(accountId))
  let reason: SessionPauseReason = "operator"
  try {
    const parsed = JSON.parse(raw) as Partial<PausePayload>
    if (
      parsed.reason === "logged_out" ||
      parsed.reason === "forbidden" ||
      parsed.reason === "operator"
    ) {
      reason = parsed.reason
    }
  } catch {
    /* legacy / opaque value → treat as operator pause */
  }
  return { reason, remainingMs: ttl > 0 ? ttl * 1000 : 0 }
}

export async function getRemainingPauseMs(accountId: string): Promise<number> {
  const ttl = await redis.ttl(key(accountId))
  return ttl > 0 ? ttl * 1000 : 0
}

export async function clearSessionPause(accountId: string): Promise<void> {
  await redis.del(key(accountId))
}
