/**
 * Module-level registry of live Baileys sockets, keyed by accountId.
 *
 * `startAccount` (connection-controller) registers the live handle once the WS
 * is open; `sendMessage` (outbound) reads it to find the socket started by the
 * driver — mirrors WeCom's `holders` map. The per-account Redis lease in the
 * runtime guarantees ONE replica owns each number, so the local map is the
 * authoritative socket for outbound on the owning replica. If the entry is
 * absent here, outbound fails retryable (this replica does not hold the socket
 * yet, or it is reconnecting).
 *
 * The registered value is an indirection (`RunningWhatsappHandle`) so the
 * driver can swap the underlying socket on reconnect without re-registering.
 */

import type { WASocket } from "baileys"

export interface RunningWhatsappHandle {
  /** The current live socket; null while (re)connecting. */
  socket: WASocket | null
  /** True once `connection==='open'` was observed at least once. */
  connected: boolean
}

const holders = new Map<string, RunningWhatsappHandle>()

export function registerHandle(
  accountId: string,
  handle: RunningWhatsappHandle
): void {
  holders.set(accountId, handle)
}

export function getHandle(
  accountId: string
): RunningWhatsappHandle | undefined {
  return holders.get(accountId)
}

export function unregisterHandle(accountId: string): void {
  holders.delete(accountId)
}

/** Test helper: clear the whole registry. */
export function __resetHandlesForTest(): void {
  holders.clear()
}
