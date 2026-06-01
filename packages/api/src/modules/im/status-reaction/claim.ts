/**
 * Per-(account, externalMessageId) Redis claim for the status/typing
 * controllers.
 *
 * Solves the multi-replica fan-out problem: actor lifecycle events
 * (actor.thinking / actor.action / session.thinking / session.status.changed)
 * are delivered through Redis pub/sub, so every API replica subscribed to
 * the bus runs the hook in parallel. Without a claim, all replicas would
 * race to create/delete the same Feishu reaction or weixin typing — the
 * platform calls duplicate, the persisted `external_emoji_reactions`
 * JSONB row gets stomped, and the user sees flickering or no reaction
 * at all.
 *
 * Contract:
 *
 *   1. The hook calls `acquire` before constructing the controllers
 *      for a given inbound message. The first replica to grab the
 *      claim wins and proceeds; everyone else returns null and
 *      silently skips.
 *
 *   2. While the claim holder is running a session it calls
 *      `renew` periodically. The TTL is long enough to ride out a
 *      normal actor turn but short enough that a crashed holder
 *      releases the claim within ~10 minutes — at which point another
 *      replica can pick up future events for that message.
 *
 *   3. On terminal events (done/error/stall) the hook calls
 *      `release` so the lock is freed immediately.
 *
 * This module is pure / DB-free: it does NOT bind to the real Redis
 * client at module load (that would leak a connection into every test
 * that imports the module). Consumers create a client via
 * `createStatusClaimClient(redis)` once at boot time.
 */

import crypto from "node:crypto"
import {
  acquireLock,
  renewLock,
  releaseLock,
  type LockRedisLike,
} from "../../../infrastructure/redis/lock.js"

/**
 * Default TTL. Long enough to span a typical multi-step actor turn
 * (web search + LLM + tool calls can hit several minutes); short
 * enough that a crashed replica releases the claim within ~10 min.
 */
export const STATUS_CLAIM_TTL_MS = 10 * 60 * 1000

export interface StatusClaimKey {
  transportAccountId: string
  externalMessageId: string
}

function buildKey(input: StatusClaimKey): string {
  return `im:status-claim:${input.transportAccountId}:${input.externalMessageId}`
}

/**
 * Per-process instance id. Identifies WHICH replica owns a given claim,
 * so renew / release can no-op if a different replica has already taken
 * over (e.g. after the original holder's TTL expired).
 */
export const STATUS_CLAIM_INSTANCE_ID = `${process.pid}:${crypto.randomUUID()}`

/**
 * Subset of the ioredis client surface this module needs. It is exactly the
 * lock helper's client surface (SET NX PX + eval), re-exported under this name
 * for the existing callers/tests.
 */
export type ClaimRedisLike = LockRedisLike

export interface StatusClaimClient {
  acquire(input: StatusClaimKey): Promise<string | null>
  renew(input: StatusClaimKey, token: string): Promise<boolean>
  release(input: StatusClaimKey, token: string): Promise<void>
}

/**
 * Build a claim client over the given Redis-like backend.
 */
export function createStatusClaimClient(
  backend: ClaimRedisLike,
  options: { ttlMs?: number; instanceId?: string } = {}
): StatusClaimClient {
  const ttlMs = options.ttlMs ?? STATUS_CLAIM_TTL_MS
  const instanceId = options.instanceId ?? STATUS_CLAIM_INSTANCE_ID

  return {
    async acquire(input) {
      const lock = await acquireLock(
        backend,
        buildKey(input),
        ttlMs,
        instanceId
      )
      return lock?.token ?? null
    },

    async renew(input, token) {
      return renewLock(backend, { key: buildKey(input), token }, ttlMs)
    },

    async release(input, token) {
      await releaseLock(backend, { key: buildKey(input), token })
    },
  }
}
