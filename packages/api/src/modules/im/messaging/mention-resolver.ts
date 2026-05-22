/**
 * Mention resolution between conversation participants and transport addresses.
 *
 * The same participant may have multiple addresses across transports
 * (Feishu open_id, WeChat user id). When delivering an outbound message,
 * we need to translate each mention block (which carries a participantId)
 * into the externalId of the right address under the current binding.
 *
 * This file exposes the pure rules; IO (DB lookups) is injected via a resolver.
 *
 * Group endpoints use a stricter rule: only addresses that are explicitly
 * attached to the participant via conversation_participant_addresses are valid
 * (so we don't accidentally @ someone who's never been in this chat).
 * Direct endpoints with feishu also use the attached-only rule (the bot only
 * knows mentions that have actually spoken in the conversation).
 * Direct endpoints with weixin require the mention's externalId to match the
 * endpoint's externalId (you can only @ the single person in the direct chat).
 */

import type { CanonicalPart } from "./canonical-message.js"

export type TransportEndpointType = "direct" | "group"
export type TransportKind = string

export interface ResolvedMention {
  externalId: string
  displayName: string
}

export interface ParticipantAddressLookup {
  externalId: string
  displayName?: string
}

/**
 * Async resolver signature, injected by the caller. Two flavors:
 *   - "attached only": only addresses explicitly attached to the participant in
 *     this conversation (conversation_participant_addresses); used for groups
 *     and for direct flows on Feishu.
 *   - "reachable": broader — any address under the account, even if not
 *     attached; used for direct flows on transports that allow it.
 */
export interface MentionResolverDeps {
  loadAttachedAddress(input: {
    conversationParticipantId: string
    transportAccountId: string
  }): Promise<ParticipantAddressLookup | null>
  loadReachableAddress(input: {
    conversationParticipantId: string
    transportAccountId: string
  }): Promise<ParticipantAddressLookup | null>
}

export interface ResolveMentionsInput {
  parts: readonly CanonicalPart[]
  transportKind: TransportKind
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}

/**
 * Walk the parts, pick mentions with participantId, resolve each via the
 * appropriate lookup based on transport rules, and return the deduplicated
 * recipient list. Mentions without participantId or that resolve to nothing
 * are silently dropped.
 *
 * Order: first appearance in `parts` wins; later duplicates are ignored.
 */
export async function resolveMentionRecipients(
  input: ResolveMentionsInput,
  deps: MentionResolverDeps
): Promise<ResolvedMention[]> {
  const recipients = new Map<string, ResolvedMention>()

  for (const part of input.parts) {
    if (part.type !== "mention") continue
    const participantId = part.participantId
    if (!participantId) continue

    const useAttached = shouldUseAttachedAddressOnly(
      input.transportKind,
      input.endpointType
    )
    const address = useAttached
      ? await deps.loadAttachedAddress({
          conversationParticipantId: participantId,
          transportAccountId: input.transportAccountId,
        })
      : await deps.loadReachableAddress({
          conversationParticipantId: participantId,
          transportAccountId: input.transportAccountId,
        })
    const externalId = nonEmptyString(address?.externalId)
    if (!externalId) continue

    if (
      input.endpointType === "direct" &&
      input.transportKind !== "feishu" &&
      externalId !== input.endpointExternalId
    ) {
      // For weixin direct chat, you can only mention the single peer.
      continue
    }

    if (!recipients.has(externalId)) {
      recipients.set(externalId, {
        externalId,
        displayName:
          nonEmptyString(address?.displayName) ||
          part.displayName ||
          externalId,
      })
    }
  }

  return Array.from(recipients.values())
}

/**
 * Whether the resolver should restrict candidates to addresses explicitly
 * attached to the participant in this conversation. Group endpoints always do;
 * direct endpoints do for Feishu (so the bot only @ s users it has seen).
 */
export function shouldUseAttachedAddressOnly(
  transportKind: TransportKind,
  endpointType: TransportEndpointType
): boolean {
  return (
    endpointType === "group" ||
    (endpointType === "direct" && transportKind === "feishu")
  )
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
