/**
 * DingTalk mention parsing + outbound text-render helper.
 *
 * Pure functions. Heavy lifting (filtering by chatbotUserId, dropping
 * mentions without staffId, etc.) is done here so normalize.ts and
 * render.ts both stay focused on payload shape conversion.
 *
 * Inbound rule: only mentions with a staffId become CanonicalPart.mention
 * — DingTalk `atUsers[].dingtalkId` cannot be reliably mapped back to a
 * staffId without an extra (unreliable) API call, and mention.externalId
 * carries staffId semantics for outbound (used as `at.atUserIds` entries).
 *
 * Inbound also drops the bot itself from the @-list so the actor doesn't
 * see a noisy "@bot" mention on every triggering message.
 */

import type { CanonicalPart } from "../../messaging/canonical-message.js"
import type { OutboundMentionInput, ParsedInboundMention } from "../types.js"

export interface DingtalkAtUser {
  dingtalkId?: string
  staffId?: string
}

export interface ParseDingtalkMentionsInput {
  rawText: string
  atUsers: DingtalkAtUser[] | undefined
  chatbotUserId: string | undefined
  logger?: { warn: (msg: string) => void }
}

export interface ParseDingtalkMentionsResult {
  text: string
  mentions: ParsedInboundMention[]
}

/**
 * Synapse `TransportConnector.parseInboundMentions` adapter — takes the
 * already-extracted rawText + raw atUsers array and returns the connector
 * contract shape. Bot self-mention filtering and staffId-only retention
 * live here.
 */
export function parseDingtalkMentions(
  input: ParseDingtalkMentionsInput
): ParseDingtalkMentionsResult {
  const mentions: ParsedInboundMention[] = []
  const atUsers = Array.isArray(input.atUsers) ? input.atUsers : []
  for (let i = 0; i < atUsers.length; i++) {
    const u = atUsers[i]
    if (!u) continue
    if (input.chatbotUserId && u.dingtalkId === input.chatbotUserId) {
      // The "@bot" entry is implicit in inbound delivery; don't surface it
      // to the actor as if a user had been mentioned.
      continue
    }
    const staffId =
      typeof u.staffId === "string" && u.staffId.trim() !== ""
        ? u.staffId.trim()
        : undefined
    if (!staffId) {
      // DingTalk doesn't ship a stable dingtalkId → staffId reverse lookup;
      // dropping the part is safer than emitting a mention whose externalId
      // would later be misinterpreted as a staffId by the renderer.
      input.logger?.warn(
        `dingtalk: dropping inbound mention without staffId (dingtalkId=${u.dingtalkId ?? "?"} index=${i})`
      )
      continue
    }
    mentions.push({
      externalId: staffId,
      // displayName isn't carried in DingTalk's atUsers list; leave blank
      // and let the renderer fall back to "@" with a generic label.
      displayName: undefined,
      // The connector contract requires a `key` for the placeholder lookup;
      // DingTalk doesn't use placeholder substitution (it just appends
      // @-names in the inline text), so we synthesize a stable key.
      key: `staff:${staffId}`,
    })
  }
  return { text: input.rawText, mentions }
}

/**
 * Outbound: render a single mention as inline text. The real @-highlight
 * is delivered via the sessionWebhook body's `at.atUserIds` array (built
 * in render.ts) — this text is just a human-readable placeholder so the
 * markdown body reads naturally even when at-highlight isn't honored
 * (OpenAPI fallback path).
 */
export function renderDingtalkMention(input: OutboundMentionInput): string {
  return `@${input.displayName}`
}

/**
 * Helper used by render.ts to collect staffId values from canonical parts.
 *
 * Drops mentions whose `externalId` is:
 *   - undefined (mention-resolver didn't find a transport address; we'd
 *     rather omit the @-highlight than fabricate one), or
 *   - prefixed with "senderId:" (the normalize fallback used when a
 *     dev/test app's payload didn't carry a senderStaffId — sending
 *     such a value as if it were a staffId would route to the wrong user).
 *
 * Result is de-duplicated while preserving first-seen order.
 */
export function collectAtUserIdsFromParts(parts: CanonicalPart[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (part.type !== "mention") continue
    const externalId = part.externalId
    if (typeof externalId !== "string") continue
    if (externalId.startsWith("senderId:")) continue
    if (seen.has(externalId)) continue
    seen.add(externalId)
    out.push(externalId)
  }
  return out
}
