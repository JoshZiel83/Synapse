/**
 * QQ mention parser + renderer.
 *
 * Stage 1 stub:
 *   - QQ group events carry `mentions: [{user_openid?, member_openid?, ...}]`
 *     plus `<@member_openid>` markers in the message body. Full parsing
 *     lands in Stage 2 (inbound normalize); for now we surface a clean
 *     "no mentions found" result that matches the empty case.
 *   - Outbound rendering returns a literal `@displayName` until Stage
 *     4.5 wires the group-only `<@member_openid>` syntax. Until then
 *     `MessageCapabilities.supportsMention` is false, so degradation
 *     flattens mention parts to text before this is even called.
 */

import type { OutboundMentionInput, ParsedInboundMention } from "../types.js"

export function parseQqMentions(_input: {
  rawText: string
  rawMentions: unknown
}): { text: string; mentions: ParsedInboundMention[] } {
  // Stage 2 fills this in. Returning empty arrays keeps the connector
  // safe to register immediately — `text` is consumed verbatim if there
  // are no mentions, so a real value isn't required here.
  return { text: "", mentions: [] }
}

export function renderQqMention(input: OutboundMentionInput): string {
  return `@${input.displayName}`
}
