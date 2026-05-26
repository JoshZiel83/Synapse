/**
 * QQ external_id encoding helpers.
 *
 * QQ openids are namespaced by both bot identity AND endpoint scope:
 *   - `user_openid` only appears in C2C events
 *   - `member_openid` only appears in group events and is unique
 *     per-(group_openid, user); the same human appears under a different
 *     member_openid in each group
 *   - `union_openid` aligns a user across multiple bots under the same
 *     developer principal (we don't use it yet but reserve room)
 *
 * Storing the raw openid as `transport_addresses.external_id` would
 * collide across endpoints (same string could mean different humans in
 * different groups). We encode a prefix so the same DB row never gets
 * mistakenly re-used across scopes, and so reverse-lookup from an
 * INTERACTION_CREATE event picks the right user.
 *
 * Encoding:
 *   - C2C sender             → `c2c:{user_openid}`
 *   - group sender (member)  → `gm:{group_openid}:{member_openid}`
 *
 * Endpoint external_id (the `transport_endpoints.external_id` column) is
 * scoped per `endpoint_type`, so no prefix collision risk:
 *   - direct endpoint        → `c2c:{user_openid}`
 *   - group endpoint         → `{group_openid}` (raw, no prefix)
 *
 * (`direct` endpoint external_id includes the `c2c:` prefix to match
 *  the sender address encoding for that endpoint — a 1:1 chat's peer
 *  IS the endpoint.)
 */

export interface QqC2cSenderRef {
  kind: "c2c"
  userOpenid: string
}

export interface QqGroupMemberRef {
  kind: "group_member"
  groupOpenid: string
  memberOpenid: string
}

export type QqSenderRef = QqC2cSenderRef | QqGroupMemberRef

const C2C_PREFIX = "c2c:"
const GROUP_MEMBER_PREFIX = "gm:"

export function encodeSenderExternalId(ref: QqSenderRef): string {
  if (ref.kind === "c2c") return `${C2C_PREFIX}${ref.userOpenid}`
  return `${GROUP_MEMBER_PREFIX}${ref.groupOpenid}:${ref.memberOpenid}`
}

export function encodeDirectEndpointExternalId(userOpenid: string): string {
  return `${C2C_PREFIX}${userOpenid}`
}

export function encodeGroupEndpointExternalId(groupOpenid: string): string {
  // Group endpoint external_id is the raw group_openid (no prefix); the
  // endpoint_type column distinguishes it from C2C endpoints anyway.
  return groupOpenid
}

/**
 * Reverse: given a `transport_addresses.external_id`, recover the
 * member_openid (for group mentions render / INTERACTION_CREATE
 * resolution). Returns null on shapes we don't understand so callers
 * can fall back to display-name only.
 */
export function decodeMemberOpenid(externalId: string): string | null {
  if (!externalId.startsWith(GROUP_MEMBER_PREFIX)) return null
  const rest = externalId.slice(GROUP_MEMBER_PREFIX.length)
  const sep = rest.indexOf(":")
  if (sep < 0) return null
  const member = rest.slice(sep + 1)
  return member || null
}

/**
 * Reverse for C2C: given a `transport_addresses.external_id`, recover
 * the bare user_openid.
 */
export function decodeUserOpenid(externalId: string): string | null {
  if (!externalId.startsWith(C2C_PREFIX)) return null
  const rest = externalId.slice(C2C_PREFIX.length)
  return rest || null
}

/**
 * Recover the group_openid portion from a group-member external_id.
 * Used by INTERACTION_CREATE handler to scope the
 * `transport_addresses` lookup to the right group.
 */
export function decodeGroupOpenidFromMemberId(
  externalId: string
): string | null {
  if (!externalId.startsWith(GROUP_MEMBER_PREFIX)) return null
  const rest = externalId.slice(GROUP_MEMBER_PREFIX.length)
  const sep = rest.indexOf(":")
  if (sep < 0) return null
  const group = rest.slice(0, sep)
  return group || null
}
