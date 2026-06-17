/**
 * Personal-WeChat (ilink) session pause guard.
 *
 * When getupdates returns errcode -14 the bot session has expired and the
 * account must be re-authenticated (re-scan QR). Upstream pauses the account
 * for ~1h on this code instead of hot-looping retries; we mirror that with a
 * Redis flag so the pause is shared across replicas and the outbound path can
 * fail fast instead of hammering a dead session.
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import { WEIXIN_SESSION_EXPIRED_ERRCODE } from "./protocol.js"

const KEY_PREFIX = "im:weixin:session-paused:"
const PAUSE_SECONDS = 60 * 60 // 1h, matches upstream

function key(accountId: string): string {
  return KEY_PREFIX + accountId
}

/** Pause an account for the cooldown window after a session-expired error. */
export async function pauseSession(accountId: string): Promise<void> {
  await redis.set(key(accountId), String(Date.now()), "EX", PAUSE_SECONDS)
}

/** Milliseconds remaining in the pause window (0 when not paused). */
export async function getRemainingPauseMs(accountId: string): Promise<number> {
  const ttl = await redis.ttl(key(accountId))
  return ttl > 0 ? ttl * 1000 : 0
}

export async function isSessionPaused(accountId: string): Promise<boolean> {
  return (await redis.exists(key(accountId))) === 1
}

/** Clear the pause flag (e.g. on a fresh account start after re-login). */
export async function clearSessionPause(accountId: string): Promise<void> {
  await redis.del(key(accountId))
}

/** Throw if the account is currently paused. Call before outbound API work. */
export async function assertSessionActive(accountId: string): Promise<void> {
  if (await isSessionPaused(accountId)) {
    const ms = await getRemainingPauseMs(accountId)
    throw new Error(
      `weixin session paused for ${accountId}, ${Math.ceil(ms / 60_000)} min remaining (errcode ${WEIXIN_SESSION_EXPIRED_ERRCODE})`
    )
  }
}
