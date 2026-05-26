/**
 * Per-anchor passive-reply quota + crash-safe reservation (Stage 4, G3).
 *
 * QQ caps passive-reply messages per (anchor msg_id/event_id):
 *   C2C   → 5 replies within 60 minutes
 *   group → 5 replies within 5 minutes
 *
 * Each outbound link needs to:
 *   1. Pick the anchor (from latest-inbound-store) and reserve an
 *      msg_seq atomically — even across crashes.
 *   2. Bump the per-anchor counter once. Multi-attempt retries of the
 *      same link MUST reuse the same anchor + msg_seq (so the platform
 *      treats them as the same logical request and the duplicate-msg_seq
 *      response stays meaningful — see Stage 4 outbound flow).
 *
 * Reservation:
 *   - Key: im:qq:reply-reservation:{linkId}
 *     Value: JSON {anchorKind, anchorId, msgSeq, reservedAt, expiresAt}
 *     TTL: passive-reply window + retry slack (90 min C2C / 15 min group)
 *   - Operation is a Lua script so the "read existing? else atomic INCR
 *     + write reservation" sequence is one round-trip, no observable
 *     race window where two attempts on the same link could both consume
 *     anchor quota.
 *
 * `reserveFirstSend` is the only mutation entry-point; `getReservation`
 * is the read-only fallback the connector uses on retry attempts to
 * recover from a crash between INCR and DB metadata-write.
 */

import type { Redis } from "ioredis"
import type {
  QqAnchorKind,
  QqLatestInboundAnchor,
} from "./latest-inbound-store.js"

/** Hard cap on passive replies per anchor (matches QQ's published cap). */
export const QQ_PASSIVE_REPLY_QUOTA = 5

/** Passive-reply windows per endpoint type, in seconds (per QQ wiki). */
export const QQ_C2C_REPLY_WINDOW_SECONDS = 60 * 60
export const QQ_GROUP_REPLY_WINDOW_SECONDS = 5 * 60

/** Reservation TTL = window + retry slack. */
const C2C_RESERVATION_TTL_SECONDS = QQ_C2C_REPLY_WINDOW_SECONDS + 30 * 60 // 90 min
const GROUP_RESERVATION_TTL_SECONDS = QQ_GROUP_REPLY_WINDOW_SECONDS + 10 * 60 // 15 min

export interface QqReservation {
  anchorKind: QqAnchorKind
  anchorId: string
  msgSeq: number
  /** ISO-8601. */
  reservedAt: string
  /** Epoch ms when the platform's reply window for this anchor closes;
   *  outbound.ts checks `now >= expiresAt` before POST. */
  expiresAt: number
}

export type ReserveResult =
  | { ok: true; reservation: QqReservation; replayed: boolean }
  | { ok: false; reason: "quota_exhausted" | "no_anchor" }

const RESERVE_LUA = `
local reservationKey = KEYS[1]
local quotaKey = KEYS[2]
local existing = redis.call('GET', reservationKey)
if existing then
  return {1, existing}
end
local count = tonumber(redis.call('GET', quotaKey) or '0')
if count >= tonumber(ARGV[3]) then
  return {0, 'quota_exhausted'}
end
local msgSeq = count + 1
local reservation = cjson.encode({
  anchorKind = ARGV[1],
  anchorId = ARGV[2],
  msgSeq = msgSeq,
  reservedAt = ARGV[5],
  expiresAt = tonumber(ARGV[6])
})
redis.call('SET', reservationKey, reservation, 'EX', tonumber(ARGV[4]))
redis.call('INCR', quotaKey)
redis.call('EXPIRE', quotaKey, tonumber(ARGV[7]))
return {2, reservation}
`

function reservationKey(linkId: string): string {
  return `im:qq:reply-reservation:${linkId}`
}

function quotaKey(params: {
  accountId: string
  endpointType: "direct" | "group"
  endpointExternalId: string
  anchorKind: QqAnchorKind
  anchorId: string
}): string {
  return `im:qq:reply-quota:${params.accountId}:${params.endpointType}:${params.endpointExternalId}:${params.anchorKind}:${params.anchorId}`
}

export async function reserveFirstSend(
  redis: Redis,
  params: {
    linkId: string
    accountId: string
    endpointType: "direct" | "group"
    endpointExternalId: string
    anchor: QqLatestInboundAnchor
  }
): Promise<ReserveResult> {
  const ttl =
    params.endpointType === "group"
      ? GROUP_RESERVATION_TTL_SECONDS
      : C2C_RESERVATION_TTL_SECONDS
  const quotaTtl =
    params.endpointType === "group"
      ? QQ_GROUP_REPLY_WINDOW_SECONDS
      : QQ_C2C_REPLY_WINDOW_SECONDS
  const expiresAtMs =
    Date.now() +
    (params.endpointType === "group"
      ? QQ_GROUP_REPLY_WINDOW_SECONDS
      : QQ_C2C_REPLY_WINDOW_SECONDS) *
      1000
  const result = (await redis.eval(
    RESERVE_LUA,
    2,
    reservationKey(params.linkId),
    quotaKey({
      accountId: params.accountId,
      endpointType: params.endpointType,
      endpointExternalId: params.endpointExternalId,
      anchorKind: params.anchor.anchorKind,
      anchorId: params.anchor.anchorId,
    }),
    params.anchor.anchorKind,
    params.anchor.anchorId,
    String(QQ_PASSIVE_REPLY_QUOTA),
    String(ttl),
    new Date().toISOString(),
    String(expiresAtMs),
    String(quotaTtl)
  )) as [number, string]
  const flag = result[0]
  const payload = result[1]
  if (flag === 0) {
    return { ok: false, reason: payload as "quota_exhausted" | "no_anchor" }
  }
  const reservation = JSON.parse(payload) as QqReservation
  return { ok: true, reservation, replayed: flag === 1 }
}

export async function getReservation(
  redis: Redis,
  linkId: string
): Promise<QqReservation | null> {
  const raw = await redis.get(reservationKey(linkId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as QqReservation
  } catch {
    return null
  }
}

/** Test-only: clear a single reservation. Not exported through index.ts. */
export async function _clearReservationForTests(
  redis: Redis,
  linkId: string
): Promise<void> {
  await redis.del(reservationKey(linkId))
}
