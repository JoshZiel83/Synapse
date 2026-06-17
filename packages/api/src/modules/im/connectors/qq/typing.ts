/**
 * QQ typing indicator — NOT SUPPORTED.
 *
 * QQ Bot OpenAPI v2 has NO "正在输入" / typing-indicator API. The message
 * send enum is exactly 0 text / 2 markdown / 3 ark / 4 embed / 7 media
 * (富媒体); there is no `msg_type: 6` and no `input_notify` field on the
 * C2C/group messages endpoint (confirmed against tencent-connect/botpy +
 * botgo). The previous `{msg_type:6, input_notify:{…}}` call was copied
 * from the openclaw reference and only ever produced swallowed 4xx noise,
 * so the adapter is disabled: `createQqTypingAdapter` always returns null
 * and the IM typing controller becomes a no-op for QQ.
 */

import type { EndpointRef, MessageRef, TypingAdapterResult } from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"

/**
 * QQ has no typing-indicator API → always null (the connector contract
 * treats null as "no typing on this platform"). The signature is kept
 * stable so the `createTypingAdapter` hook in index.ts stays wired.
 */
export function createQqTypingAdapter(_input: {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  lastInboundMessageRef?: MessageRef
}): TypingAdapterResult | null {
  return null
}
