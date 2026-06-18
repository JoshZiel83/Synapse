/**
 * WhatsApp 24-hour customer-service-window store.
 *
 * Cloud API only permits FREE-FORM outbound while a 24h window is open; the
 * window opens/refreshes on every inbound customer message and closes 24h
 * after the LAST inbound. Outside it, only pre-approved TEMPLATE messages
 * are deliverable (else Meta returns 131047). We track the last-inbound
 * epoch-ms per `(accountId, wa_id)` in Redis (shared across replicas; the
 * inbound webhook fires on any replica) so the outbound path can gate
 * free-form sends.
 *
 * Mirrors `weixin/session-guard.ts`'s Redis-flag pattern (lazy `redis`
 * import is module-level there; that module is only reached at runtime, not
 * at register-all import time — same here, since `index.ts` imports this
 * lazily-via-outbound, never at top level).
 *
 * Datetime: the value stored is epoch-MILLISECONDS and the `now - lastInbound`
 * comparison is numeric, so it uses `requireEpochMillis(...)` (NOT
 * `fromUnixSeconds`, which yields an ISO string for `receivedAt`). The
 * stored ms is derived from the inbound `receivedAt` ISO instant by the
 * caller, or from `Date.now()` at write time.
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import { parseIsoInstant, requireEpochMillis } from "@synapse/shared/datetime"
import type { Timestamp } from "@synapse/shared/types"

const KEY_PREFIX = "im:whatsapp:window:"
/**
 * Keep the marker a bit longer than the window itself so a borderline check
 * still finds the timestamp (and correctly reports "closed") rather than
 * treating an expired key as "never messaged". 48h TTL.
 */
const TTL_SECONDS = 48 * 60 * 60

/** The 24h window in milliseconds. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

export interface WhatsappWindowStore {
  recordInbound(input: {
    accountId: string
    waId: string
    /**
     * The inbound message's canonical instant (its `receivedAt`). Converted
     * to epoch-ms via the single canonical parser. When absent, the window
     * opens at the server-receive (eval) time.
     */
    at?: Timestamp
  }): Promise<void>
  isWithin24h(input: {
    accountId: string
    waId: string
    /** epoch ms "now"; defaults to Date.now(). Injectable for tests. */
    nowMs?: number
  }): Promise<boolean>
  getLastInboundMs(input: {
    accountId: string
    waId: string
  }): Promise<number | null>
}

function key(accountId: string, waId: string): string {
  return `${KEY_PREFIX}${accountId}:${waId}`
}

/**
 * Default Redis-backed store. The `redisClient` seam lets tests pass a fake
 * (only `set`/`get` with an EX arg are used).
 */
export function createWhatsappWindowStore(
  redisClient: Pick<typeof redis, "set" | "get"> = redis
): WhatsappWindowStore {
  return {
    async recordInbound({ accountId, waId, at }) {
      // Convert the canonical instant via the single parser (C1). A genuinely
      // absent inbound time defaults to the eval time — annotated below so the
      // datetime guard recognizes the deliberate server-receive default.
      const ms =
        at != null
          ? parseIsoInstant(at).getTime()
          : // datetime-ok: no inbound instant supplied; window opens at eval time.
            Date.now()
      await redisClient.set(key(accountId, waId), String(ms), "EX", TTL_SECONDS)
    },

    async getLastInboundMs({ accountId, waId }) {
      const raw = await redisClient.get(key(accountId, waId))
      if (raw == null) return null
      try {
        return requireEpochMillis(raw, "ms")
      } catch {
        return null
      }
    },

    async isWithin24h({ accountId, waId, nowMs }) {
      const raw = await redisClient.get(key(accountId, waId))
      if (raw == null) return false
      let lastMs: number
      try {
        lastMs = requireEpochMillis(raw, "ms")
      } catch {
        return false
      }
      // The comparison "now" is the genuine eval time (injectable for tests).
      // datetime-ok: window-open check is evaluated against the current instant.
      const now = requireEpochMillis(nowMs ?? Date.now(), "ms")
      return now - lastMs < WHATSAPP_WINDOW_MS
    },
  }
}

/** Process-wide default instance (lazy redis is bound at first use). */
export const whatsappWindowStore = createWhatsappWindowStore()
