/**
 * Latest-inbound store (Stage 4, supports G3 passive-anchor strategy).
 *
 * QQ requires every outbound message that uses passive-reply semantics
 * to carry either `msg_id` (for normal message events) or `event_id`
 * (for non-message events like INTERACTION_CREATE), plus a `msg_seq`.
 * Without an anchor the only fallback is the proactive API which QQ
 * shut down on 2025-04-21, so anchor selection is on the critical path
 * for delivery.
 *
 * The connector pulls the anchor at outbound time from this Redis-
 * backed store. Inbound normalize writes here every time an event is
 * accepted; outbound reads via `getLatestInboundAnchor` and locks the
 * chosen anchor into `transport_message_links.metadata.qq.anchor`
 * (reply-quota.ts handles that lock atomically against the QQ-side
 * passive-reply quota).
 *
 * Key namespace:
 *   im:qq:latest-inbound:{accountId}:{endpointType}:{endpointExternalId}
 *
 * `endpointExternalId` is the canonical address-encoded value
 * (`c2c:{user_openid}` or just `{group_openid}`) so the same Redis key
 * is used by both inbound writers and outbound readers regardless of
 * who produced the value.
 *
 * TTL:
 *   C2C → 1 hour (matches the QQ passive-reply window for C2C)
 *   group → 5 minutes (matches the QQ passive-reply window for groups)
 */

import type { Redis } from "ioredis"
import type { Timestamp, TransportEndpointType } from "@synapse/shared/types"

export type QqAnchorKind = "msg_id" | "event_id"

export interface QqLatestInboundAnchor {
  /** Whether the anchor was sourced from a message event (msg_id) or
   *  a non-message event such as INTERACTION_CREATE (event_id). */
  anchorKind: QqAnchorKind
  /** The platform-issued identifier (event.id for messages, event.id
   *  for non-message events; QQ's wiki uses the same field). */
  anchorId: string
  /** The dispatch event name (e.g. C2C_MESSAGE_CREATE). Kept for
   *  diagnostics — connector code doesn't need it. */
  eventType: string
  /** ISO-8601. */
  receivedAt: Timestamp
}

const C2C_TTL_SECONDS = 60 * 60
const GROUP_TTL_SECONDS = 5 * 60

function key(
  accountId: string,
  endpointType: TransportEndpointType,
  endpointExternalId: string
): string {
  return `im:qq:latest-inbound:${accountId}:${endpointType}:${endpointExternalId}`
}

export async function writeLatestInboundAnchor(
  redis: Redis,
  params: {
    accountId: string
    endpointType: TransportEndpointType
    endpointExternalId: string
    anchor: QqLatestInboundAnchor
  }
): Promise<void> {
  const ttl =
    params.endpointType === "group" ? GROUP_TTL_SECONDS : C2C_TTL_SECONDS
  await redis.set(
    key(params.accountId, params.endpointType, params.endpointExternalId),
    JSON.stringify(params.anchor),
    "EX",
    ttl
  )
}

export async function getLatestInboundAnchor(
  redis: Redis,
  params: {
    accountId: string
    endpointType: TransportEndpointType
    endpointExternalId: string
  }
): Promise<QqLatestInboundAnchor | null> {
  const raw = await redis.get(
    key(params.accountId, params.endpointType, params.endpointExternalId)
  )
  if (!raw) return null
  try {
    return JSON.parse(raw) as QqLatestInboundAnchor
  } catch {
    return null
  }
}

/** Test-only: clear a single anchor. Not exported through index.ts. */
export async function _clearLatestInboundAnchorForTests(
  redis: Redis,
  params: {
    accountId: string
    endpointType: TransportEndpointType
    endpointExternalId: string
  }
): Promise<void> {
  await redis.del(
    key(params.accountId, params.endpointType, params.endpointExternalId)
  )
}
