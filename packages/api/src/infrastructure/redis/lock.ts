import { randomUUID } from "node:crypto"

/**
 * Minimal redis surface a lock needs. Kept structural so callers can pass the
 * shared ioredis client OR an in-memory fake in tests.
 */
export interface LockRedisLike {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    nx: "NX"
  ): Promise<unknown>
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>
}

/**
 * Token-fenced single-instance Redis lock (SET NX PX + Lua compare-and-*).
 *
 * This is the one canonical implementation of the pattern that was previously
 * hand-copied across outbox-sweeper, the IM transport-runtime lease, the
 * status-reaction claim client, and (buggily) the session-thinking worker.
 *
 * "Fenced" means renew and release are guarded by a per-acquire random token:
 * a holder can only extend/delete the lock if the stored value still matches
 * the token it acquired. This prevents the classic bug where, after a lock's
 * TTL lapses and another worker reacquires it, the original holder's release
 * deletes the NEW holder's lock. (That exact bug lived in session-thinking,
 * which did an unconditional redis.del.)
 *
 * It is intentionally NOT the multi-master Redlock algorithm — these are all
 * single-Redis locks, for which Redlock is overkill (and the maintained
 * `redlock` package is dormant). One Redis, one fenced key.
 */

const RENEW_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1]
  then return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else return 0 end`

const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1]
  then return redis.call("DEL", KEYS[1])
  else return 0 end`

export interface AcquiredLock {
  readonly key: string
  readonly token: string
}

/**
 * Try to acquire `key` for `ttlMs`. Returns the lock (with its fencing token)
 * or null if it is already held. `tokenPrefix` namespaces the token for easier
 * debugging (e.g. a per-process instance id).
 */
export async function acquireLock(
  redis: LockRedisLike,
  key: string,
  ttlMs: number,
  tokenPrefix?: string
): Promise<AcquiredLock | null> {
  const token = tokenPrefix
    ? `${tokenPrefix}:${randomUUID()}`
    : `${process.pid}:${randomUUID()}`
  const result = await redis.set(key, token, "PX", ttlMs, "NX")
  return result === "OK" ? { key, token } : null
}

/**
 * Extend the lock's TTL, but only if we still hold it (token match).
 * Returns true if the TTL was extended, false if we no longer hold the lock.
 */
export async function renewLock(
  redis: LockRedisLike,
  lock: AcquiredLock,
  ttlMs: number
): Promise<boolean> {
  const result = await redis.eval(
    RENEW_SCRIPT,
    1,
    lock.key,
    lock.token,
    String(ttlMs)
  )
  return Number(result) === 1
}

/**
 * Release the lock, but only if we still hold it (token match). A no-op if the
 * lock has already expired or been taken over by another holder — which is the
 * whole point: we never delete someone else's lock.
 */
export async function releaseLock(
  redis: LockRedisLike,
  lock: AcquiredLock
): Promise<void> {
  await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token)
}
