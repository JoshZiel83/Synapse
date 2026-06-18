/**
 * WeCom inbound frame → CanonicalMessage normalizer.
 *
 * Input is the SDK's `WsFrame<BaseMessage>` (already decrypted + parsed).
 * Output is an InboundEnvelope ready to feed into `ingest.ts`.
 *
 * v1 keeps it minimal: text / mixed → text part; voice converts ASR
 * content to text; image / file / video degrade to bracketed text
 * placeholders ("[图片]" / "[文件 name]") because media flow isn't wired
 * in v1. The full frame (headers + body) is preserved verbatim in
 * `envelope.raw`, so `response_url`, `quote`, `aeskey` etc. flow through
 * to `conversation_items.metadata.body.*` for later consumers.
 */

import type {
  BaseMessage,
  FileMessage,
  ImageMessage,
  MixedMessage,
  TextMessage,
  VideoMessage,
  VoiceMessage,
  WsFrame,
} from "@wecom/aibot-node-sdk"
import { fromUnixSeconds, serverReceiveInstant } from "@synapse/shared/datetime"
import {
  buildCanonicalMessage,
  type CanonicalPart,
} from "../../messaging/canonical-message.js"
import type { InboundEnvelope, ParsedInboundMention } from "../types.js"

function partsFromMessage(body: BaseMessage): {
  parts: CanonicalPart[]
  plainText: string
} {
  switch (body.msgtype) {
    case "text": {
      const text = (body as TextMessage).text?.content ?? ""
      return {
        parts: [{ type: "text", text }],
        plainText: text,
      }
    }
    case "voice": {
      // ASR-rendered content lives in `voice.content`. Treat as text.
      const text = (body as VoiceMessage).voice?.content ?? ""
      return {
        parts: [{ type: "text", text }],
        plainText: text,
      }
    }
    case "mixed": {
      const items = (body as MixedMessage).mixed?.msg_item ?? []
      const parts: CanonicalPart[] = []
      const plain: string[] = []
      for (const item of items) {
        if (item.msgtype === "text") {
          const t = item.text?.content ?? ""
          parts.push({ type: "text", text: t })
          plain.push(t)
        } else if (item.msgtype === "image") {
          parts.push({ type: "text", text: "[图片]" })
          plain.push("[图片]")
        }
      }
      return { parts, plainText: plain.join("") }
    }
    case "image": {
      void (body as ImageMessage).image // consume for typing
      const text = "[图片]"
      return { parts: [{ type: "text", text }], plainText: text }
    }
    case "file": {
      void (body as FileMessage).file
      const text = "[文件]"
      return { parts: [{ type: "text", text }], plainText: text }
    }
    case "video": {
      void (body as VideoMessage).video
      const text = "[视频]"
      return { parts: [{ type: "text", text }], plainText: text }
    }
    default: {
      const text = `[暂不支持的消息类型: ${String(body.msgtype)}]`
      return { parts: [{ type: "text", text }], plainText: text }
    }
  }
}

export function normalizeWecomFrame(
  frame: WsFrame<BaseMessage>
): InboundEnvelope | null {
  const body = frame.body
  if (!body) return null
  const externalMessageId = body.msgid
  if (!externalMessageId) return null
  const senderExternalId = body.from?.userid
  if (!senderExternalId) return null

  let endpointType: "direct" | "group"
  let endpointExternalId: string
  if (body.chattype === "group") {
    if (!body.chatid) return null
    endpointType = "group"
    endpointExternalId = body.chatid
  } else if (body.chattype === "single") {
    endpointType = "direct"
    endpointExternalId = senderExternalId
  } else {
    return null
  }

  const { parts } = partsFromMessage(body)
  // WeCom `create_time` is documented as Unix SECONDS — convert with the
  // explicit-unit adapter (fails loud on implausible values). Only when it is
  // genuinely absent do we record the server receive instant.
  const receivedAt = body.create_time
    ? fromUnixSeconds(body.create_time)
    : serverReceiveInstant()

  return {
    endpointType,
    endpointExternalId,
    externalMessageId,
    sender: {
      externalId: senderExternalId,
      // BaseMessage.from in SDK 1.0.6 only exposes `userid`. displayName
      // would require a separate contacts API call; left undefined in v1.
    },
    receivedAt,
    message: buildCanonicalMessage(parts),
    // Full frame preserved verbatim — `headers.req_id`, `body.response_url`,
    // `body.quote`, media `aeskey` etc. all land at
    // conversation_items.metadata.{headers, body} via ingest.ts:266
    // (`{...envelope.raw}` spread).
    raw: frame as unknown as Record<string, unknown>,
  }
}

/** Inbound mentions are not parsed in v1 — WeCom AI-Bot doesn't expose a
 *  structured mention list separate from the text body. Always return empty. */
export function parseWecomMentions(_input: {
  rawText: string
  rawMentions: unknown
}): { text: string; mentions: ParsedInboundMention[] } {
  return { text: "", mentions: [] }
}

/** Outbound mention renderer for the connector contract. Markdown messages
 *  in WeCom AI-Bot don't have a native @-mention syntax that resolves to a
 *  user; the best v1 can do is print the display name as plain text. */
export function renderWecomMention(input: { displayName: string }): string {
  return `@${input.displayName}`
}
