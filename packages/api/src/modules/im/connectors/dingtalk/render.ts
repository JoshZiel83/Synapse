/**
 * DingTalk outbound renderers (two payload shapes).
 *
 * Two destinations need two body shapes:
 *
 *   1. sessionWebhook body
 *      `{msgtype:"markdown", markdown:{title,text}, at:{atUserIds, isAtAll}}`
 *
 *      @-mentions: DingTalk only fires a mention when the literal
 *      `@<staffId>` token — the SAME id placed in `at.atUserIds` — is present
 *      INLINE in the markdown text. A bare `at.atUserIds` array, or an
 *      `@<displayName>` token that doesn't equal the staffId, produces no
 *      mention at all. DingTalk substitutes the user's nick for the
 *      `@<staffId>` token when rendering, so readability is preserved.
 *      (Caveat: in markdown the mention shows as a chat-list reminder, not the
 *      blue/clickable highlight that only `msgtype:"text"` renders. We keep
 *      markdown to preserve rich formatting and accept the reminder-level
 *      mention as a v1 trade-off.)
 *
 *   2. OpenAPI body
 *      `{msgKey:"sampleMarkdown", msgParam: JSON.stringify({title, text})}`
 *      — v1 does NOT write a top-level `at` field. The DingTalk OpenAPI
 *      `groupMessages/send` mention semantics aren't confirmed in the public
 *      docs or the OpenClaw references; we accept "OpenAPI fallback path = no
 *      @-highlight" as a v1 limit and surface the names as plain
 *      `@<displayName>` text inside the markdown.
 *
 * Both renderers take only a `CanonicalMessage` (mention parts are already
 * filled in by mention-resolver upstream — the worker contract does not pass
 * a separate `mentions` argument). `degradeForCapabilities` runs BEFORE these
 * renderers; because DingTalk's `supportsMention` is true, mention parts are
 * KEPT (not flattened to text) and reach us intact.
 */

import {
  buildCanonicalMessage,
  type CanonicalFileRef,
  type CanonicalMessage,
  type CanonicalPart,
  derivePlainText,
} from "../../messaging/canonical-message.js"
import type { SessionWebhookBody } from "./client.js"
import { collectAtUserIdsFromParts } from "./mentions.js"

/**
 * One DingTalk robot message. A robot message carries exactly ONE msgKey, so a
 * CanonicalMessage with mixed text + media becomes an ordered sequence: the
 * text/markdown body first (sessionWebhook-first / OpenAPI fallback), then one
 * send per media part (upload → robot sample*Msg via OpenAPI). The outbound
 * dispatcher in outbound.ts executes the plan. Video parts never appear here —
 * `supportsVideo: false` degrades them to a "[视频]" marker before planning.
 */
export type DingtalkSendPlanItem =
  | { kind: "text"; message: CanonicalMessage }
  | { kind: "image"; fileRef: CanonicalFileRef }
  | { kind: "voice"; fileRef: CanonicalFileRef; durationMs?: number }
  | { kind: "file"; fileRef: CanonicalFileRef & { name: string } }

export function planDingtalkSends(
  message: CanonicalMessage
): DingtalkSendPlanItem[] {
  const textParts: CanonicalPart[] = []
  const mediaItems: DingtalkSendPlanItem[] = []
  for (const part of message.parts) {
    switch (part.type) {
      case "image":
        mediaItems.push({ kind: "image", fileRef: part.fileRef })
        break
      case "voice":
        mediaItems.push({
          kind: "voice",
          fileRef: part.fileRef,
          ...(part.durationMs != null ? { durationMs: part.durationMs } : {}),
        })
        break
      case "file":
        mediaItems.push({ kind: "file", fileRef: part.fileRef })
        break
      default:
        textParts.push(part)
    }
  }
  const items: DingtalkSendPlanItem[] = []
  const textMessage = buildCanonicalMessage(textParts)
  // Emit a text send only when there's actual renderable text — avoids an
  // empty "[消息]" bubble when the message is media-only.
  if (textMessage.plainText.trim() !== "") {
    items.push({ kind: "text", message: textMessage })
  }
  items.push(...mediaItems)
  return items
}

function partsToMarkdown(message: CanonicalMessage): string {
  // The canonical message already carries a derived plainText whose surface
  // (headers, bold, lists, links) matches DingTalk markdown; hand it over
  // essentially as-is. Mentions render as "@<displayName>" here — the
  // sessionWebhook path rebuilds them as "@<staffId>" via
  // renderSessionWebhookText so the inline token and the at-array agree.
  return (message.plainText || "").trim()
}

function deriveTitle(body: string): string {
  // DingTalk's notification preview surfaces the markdown title; fall back
  // to first 32 chars of the body so empty titles don't blank the preview.
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ""
  const trimmed = firstLine.trim()
  if (trimmed) return trimmed.slice(0, 32)
  if (body) return body.slice(0, 32)
  return "Message"
}

/**
 * A mention part whose externalId is a usable staffId (present and NOT the
 * "senderId:"-prefixed fallback) — exactly the ids that land in
 * `at.atUserIds`. These must appear inline in the markdown text as
 * `@<staffId>` for the mention to actually fire.
 */
function isHighlightableMention(
  part: CanonicalPart
): part is CanonicalPart & { type: "mention"; externalId: string } {
  return (
    part.type === "mention" &&
    typeof part.externalId === "string" &&
    !part.externalId.startsWith("senderId:")
  )
}

/**
 * Build the sessionWebhook markdown text. When the message carries
 * highlightable mentions, render each inline as `@<staffId>` (matching
 * `at.atUserIds`) instead of `@<displayName>`; every other part falls back to
 * its canonical plainText fragment. With no highlightable mention this is just
 * the message's plainText (cheap path).
 */
function renderSessionWebhookText(message: CanonicalMessage): string {
  if (!message.parts.some(isHighlightableMention)) {
    return (message.plainText || "").trim()
  }
  const out: string[] = []
  for (const part of message.parts) {
    if (isHighlightableMention(part)) {
      out.push(`@${part.externalId}`)
    } else {
      const fragment = derivePlainText([part])
      if (fragment) out.push(fragment)
    }
  }
  return out.join(" ").trim()
}

export function renderSessionWebhookPayload(
  message: CanonicalMessage
): SessionWebhookBody {
  const text = renderSessionWebhookText(message) || "[消息]"
  const title = deriveTitle(text)
  const atUserIds = collectAtUserIdsFromParts(message.parts)
  return {
    msgtype: "markdown",
    markdown: { title, text },
    at: { atUserIds, isAtAll: false },
  }
}

export interface OpenApiRenderedPayload {
  msgKey: string
  msgParam: string
}

export function renderOpenApiPayload(
  message: CanonicalMessage
): OpenApiRenderedPayload {
  const text = partsToMarkdown(message) || "[消息]"
  const title = deriveTitle(text)
  return {
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title, text }),
  }
}
