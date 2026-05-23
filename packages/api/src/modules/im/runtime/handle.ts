/**
 * Per-process registry of active TransportConnector account runners
 * (WSClient connections, long-poll loops). Each entry holds the lease
 * token used to renew the Redis lease.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"

export interface RuntimeHandle {
  accountId: string
  fingerprint: string
  leaseToken: string
  stop: () => Promise<void>
}

export function accountFingerprint(account: TransportAccountSummary): string {
  return JSON.stringify({
    updatedAt: account.updatedAt,
    connectionMode: account.connectionMode,
    status: account.status,
    credentials: account.credentials || {},
    config: account.config || {},
    metadata: account.metadata || {},
  })
}

export const runtimeHandles = new Map<string, RuntimeHandle>()
