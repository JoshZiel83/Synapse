/**
 * Redis-backed lease for the per-account transport runtime.
 *
 * Ensures that at most one process at a time runs the long-connection /
 * long-poll loop for a given transport account, even with multiple API
 * replicas. Lease TTL is renewed on every reconcile tick by the manager.
 */

import crypto from "node:crypto"
import { redis } from "../../../infrastructure/redis/index.js"

export const RUNTIME_LEASE_TTL_MS = 30_000

/**
 * A per-process instance id. Used to namespace leaseTokens so that even
 * if two processes generate the same crypto.randomUUID() (impossible in
 * practice), they'll still differ.
 */
export const RUNTIME_MANAGER_INSTANCE_ID = `${process.pid}:${crypto.randomUUID()}`

function key(accountId: string): string {
  return `im:transport-runtime-lease:${accountId}`
}

export async function acquireTransportRuntimeLease(
  accountId: string
): Promise<string | null> {
  const leaseToken = `${RUNTIME_MANAGER_INSTANCE_ID}:${accountId}:${crypto.randomUUID()}`
  const result = await redis.set(
    key(accountId),
    leaseToken,
    "PX",
    RUNTIME_LEASE_TTL_MS,
    "NX"
  )
  return result === "OK" ? leaseToken : null
}

export async function renewTransportRuntimeLease(
  accountId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1]
       then
         return redis.call("PEXPIRE", KEYS[1], ARGV[2])
       else
         return 0
       end`,
    1,
    key(accountId),
    leaseToken,
    String(RUNTIME_LEASE_TTL_MS)
  )
  return Number(result) === 1
}

export async function releaseTransportRuntimeLease(
  accountId: string,
  leaseToken: string
): Promise<void> {
  await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1]
       then
         return redis.call("DEL", KEYS[1])
       else
         return 0
       end`,
    1,
    key(accountId),
    leaseToken
  )
}
