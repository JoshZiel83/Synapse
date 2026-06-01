/**
 * Redis-backed lease for the per-account transport runtime.
 *
 * Ensures that at most one process at a time runs the long-connection /
 * long-poll loop for a given transport account, even with multiple API
 * replicas. Lease TTL is renewed on every reconcile tick by the manager.
 */

import crypto from "node:crypto"
import { redis } from "../../../infrastructure/redis/index.js"
import {
  acquireLock,
  renewLock,
  releaseLock,
} from "../../../infrastructure/redis/lock.js"

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
  const lock = await acquireLock(
    redis,
    key(accountId),
    RUNTIME_LEASE_TTL_MS,
    `${RUNTIME_MANAGER_INSTANCE_ID}:${accountId}`
  )
  return lock?.token ?? null
}

export async function renewTransportRuntimeLease(
  accountId: string,
  leaseToken: string
): Promise<boolean> {
  return renewLock(
    redis,
    { key: key(accountId), token: leaseToken },
    RUNTIME_LEASE_TTL_MS
  )
}

export async function releaseTransportRuntimeLease(
  accountId: string,
  leaseToken: string
): Promise<void> {
  await releaseLock(redis, { key: key(accountId), token: leaseToken })
}
