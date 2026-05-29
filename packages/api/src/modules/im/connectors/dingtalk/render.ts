/**
 * DingTalk outbound renderers (two payload shapes).
 *
 * Two destinations need two body shapes:
 *
 *   1. sessionWebhook body
 *      `{msgtype:"markdown", markdown:{title,text}, at:{atUserIds, isAtAll}}`
 *      — actually highlights @ in the DingTalk UI via `at.atUserIds`.
 *
 *   2. OpenAPI body
 *      `{msgKey:"sampleMarkdown", msgParam: JSON.stringify({title, text})}`
 *      — v1 does NOT write a top-level `at` field. The DingTalk OpenAPI
 *      `groupMessages/send` shape's mention semantics aren't confirmed in
 *      either the public docs or the OpenClaw production references; we
 *      accept "OpenAPI fallback path = no @-highlight" as a v1 limit and
 *      surface the names as plain `@<displayName>` text inside the markdown.
 *
 * Both renderers take only a `CanonicalMessage` (mention parts are already
 * filled in by mention-resolver upstream — the worker contract does not
 * pass a separate `mentions` argument).
 */

import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import type { SessionWebhookBody } from "./client.js"
import { collectAtUserIdsFromParts } from "./mentions.js"

function partsToMarkdown(message: CanonicalMessage): string {
  // The canonical message already includes a derived plainText; for v1 we
  // hand it over essentially as-is (DingTalk markdown understands the
  // same surface — headers, bold, lists, links — that the upstream chat
  // layer produces). We prefer plainText over assembling parts ourselves
  // because mention parts have already been flattened to "@<name>" by
  // `degradeForCapabilities` when `supportsMention` is true but the
  // sessionWebhook path is *unable* to highlight them inline (so the
  // text always carries the human-readable name, while the at-array
  // separately drives the actual highlight).
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

export function renderSessionWebhookPayload(
  message: CanonicalMessage
): SessionWebhookBody {
  const text = partsToMarkdown(message) || "[消息]"
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
