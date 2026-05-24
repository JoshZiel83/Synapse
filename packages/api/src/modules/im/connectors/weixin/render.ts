/**
 * Personal-WeChat outbound rendering: derive a single plain-text string
 * (ilink only sends text_item per message; richer parts must be degraded
 * before this point by degradation.ts).
 */

import type { CanonicalMessage } from "../../messaging/canonical-message.js"

export interface WeixinRenderedMessage {
  text: string
}

export function renderWeixinMessage(
  msg: CanonicalMessage
): WeixinRenderedMessage {
  return { text: msg.plainText || "[消息]" }
}
