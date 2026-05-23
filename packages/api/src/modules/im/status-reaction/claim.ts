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
 * Subset of the ioredis client surface this module needs. Keeping it
 * minimal lets tests pass a small fake without dragging in ioredis
 * types or a real Redis connection.
 */
export interface ClaimRedisLike {
  set(
    key: string,
    value: string,
    px: "PX",
    ttlMs: number,
    nx: "NX"
  ): Promise<"OK" | null>
  eval(
    script: string,
    numKeys: 1,
    key: string,
    arg1: string,
    arg2?: string
  ): Promise<unknown>
}

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
      const token = `${instanceId}:${crypto.randomUUID()}`
      const result = await backend.set(
        buildKey(input),
        token,
        "PX",
        ttlMs,
        "NX"
      )
      return result === "OK" ? token : null
    },

    async renew(input, token) {
      const result = await backend.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1]
           then
             return redis.call("PEXPIRE", KEYS[1], ARGV[2])
           else
             return 0
           end`,
        1,
        buildKey(input),
        token,
        String(ttlMs)
      )
      return Number(result) === 1
    },

    async release(input, token) {
      await backend.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1]
           then
             return redis.call("DEL", KEYS[1])
           else
             return 0
           end`,
        1,
        buildKey(input),
        token
      )
    },
  }
}
