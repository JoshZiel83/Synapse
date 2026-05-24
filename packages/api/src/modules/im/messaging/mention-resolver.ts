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
 * Address-lookup scope is driven by capability flags, not by hardcoded
 * transport_kind checks:
 *
 *   - Group endpoints always require "attached only" — you can only @
 *     people who are actually in the group.
 *
 *   - Direct endpoints look at `capabilities.directMentionPolicy`:
 *       - "attached_only": resolve against attached addresses (Feishu — bot
 *         only knows users it has seen speak).
 *       - "self_only": only the endpoint peer is mentionable; any other
 *         resolved externalId is dropped (personal WeChat — 1:1 has one
 *         peer).
 *
 * The capability lives in `connectors/<kind>/capabilities.ts` so adding a
 * new IM is purely a connector change.
 */

import type { CanonicalPart } from "./canonical-message.js"
import type { MessageCapabilities } from "./degradation.js"

export type TransportEndpointType = "direct" | "group"

export interface ResolvedMention {
  externalId: string
  displayName: string
}

export interface ParticipantAddressLookup {
  externalId: string
  displayName?: string
}

/**
 * Async resolver signature, injected by the caller.
 *   - `loadAttachedAddress`: only addresses explicitly attached to the
 *     participant in this conversation (conversation_participant_addresses).
 *   - `loadReachableAddress`: broader — any address under the account, even
 *     if not attached.
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
  capabilities: MessageCapabilities
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId: string
}

/**
 * Walk the parts, pick mentions with participantId, resolve each via the
 * appropriate lookup based on the capability policy, and return the
 * deduplicated recipient list. Mentions without participantId or that
 * resolve to nothing are silently dropped.
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
      input.capabilities,
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
      input.capabilities.directMentionPolicy === "self_only" &&
      externalId !== input.endpointExternalId
    ) {
      // Direct chat with self-only policy: only the endpoint peer is
      // addressable. Skip anyone else who happened to resolve.
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
 * attached to the participant in this conversation. Group endpoints always
 * do; direct endpoints follow the connector's directMentionPolicy.
 */
export function shouldUseAttachedAddressOnly(
  capabilities: MessageCapabilities,
  endpointType: TransportEndpointType
): boolean {
  return (
    endpointType === "group" ||
    (endpointType === "direct" &&
      capabilities.directMentionPolicy === "attached_only")
  )
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}
