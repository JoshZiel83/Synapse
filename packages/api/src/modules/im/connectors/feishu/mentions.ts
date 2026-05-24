/**
 * Feishu mention parsing/rendering. <at user_id="ou_x">Name</at> style.
 *
 * Inbound: Feishu sends `text` with `@_user_1` placeholders + a `mentions[]`
 * array mapping placeholder → user info. We resolve to `<at>` markup.
 *
 * Outbound: render an `OutboundMentionInput` to the same XML-like markup.
 */

import type { ParsedInboundMention } from "../types.js"

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

export interface RawFeishuMention {
  key: string
  id: { open_id?: string; user_id?: string; union_id?: string }
  name?: string
}

export interface FeishuParseInput {
  rawText: string
  rawMentions: unknown
}

export interface FeishuParseResult {
  text: string
  mentions: ParsedInboundMention[]
}

/**
 * Resolve `@_user_1` placeholders in `rawText` to `<at user_id="ou_x">name</at>`,
 * and return the de-duplicated mention list.
 */
export function parseFeishuMentions(
  input: FeishuParseInput
): FeishuParseResult {
  const text = input.rawText || ""
  const list = isMentionArray(input.rawMentions) ? input.rawMentions : []
  if (list.length === 0) return { text: text.trim(), mentions: [] }

  let normalized = text
  const mentions: ParsedInboundMention[] = []
  const seen = new Set<string>()

  for (const m of list) {
    const key = nonEmpty(m.key)
    if (!key) continue
    const externalId = nonEmpty(m.id?.open_id) || nonEmpty(m.id?.user_id)
    const displayName = nonEmpty(m.name) || "User"
    const replacement = externalId
      ? `<at user_id="${externalId}">${displayName}</at>`
      : `@${displayName}`
    normalized = normalized.replace(
      new RegExp(escapeRegex(key), "g"),
      replacement
    )
    if (externalId && !seen.has(externalId)) {
      seen.add(externalId)
      mentions.push({ externalId, displayName, key })
    }
  }

  return { text: normalized.trim(), mentions }
}

function isMentionArray(v: unknown): v is RawFeishuMention[] {
  if (!Array.isArray(v)) return false
  return v.every(
    (m) =>
      m &&
      typeof m === "object" &&
      typeof (m as RawFeishuMention).key === "string"
  )
}

/** Render an outbound mention for Feishu text payload. */
export function renderFeishuMention(input: {
  externalId: string
  displayName: string
}): string {
  return `<at user_id="${input.externalId}">${input.displayName}</at>`
}
