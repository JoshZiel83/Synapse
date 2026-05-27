/**
 * WeCom outbound sender.
 *
 * Flow:
 *   1. Degrade the CanonicalMessage against WECOM_MESSAGE_CAPABILITIES
 *      — drops image/file/card, flattens mentions, truncates to 4096 B
 *   2. Render the remaining parts into a single markdown content string
 *   3. Dispatch through `outbound-router` — local holder fast path or
 *      Redis pub/sub to the holder replica
 *   4. Resolve externalMessageId using the fallback chain
 *      `headers.req_id → body.msgid → fresh uuid` (the SDK's
 *      `aibot_send_msg` response carries the req_id in `headers`; some
 *      versions also surface a `body.msgid`, neither is guaranteed)
 */

import { randomUUID } from "node:crypto"
import type { OutboundSendInput, OutboundSendResult } from "../types.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import { WECOM_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { dispatchOutbound, type FrameBody } from "./outbound-router.js"
import { renderWecomMarkdown } from "./render.js"

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export async function sendWecomMessage(
  input: OutboundSendInput
): Promise<OutboundSendResult> {
  const degraded = degradeForCapabilities(
    input.message,
    WECOM_MESSAGE_CAPABILITIES
  )
  const content = renderWecomMarkdown(
    degraded,
    WECOM_MESSAGE_CAPABILITIES.maxTextBytes
  )
  const frameBody: FrameBody = {
    chatid: input.endpoint.externalId,
    body: {
      msgtype: "markdown",
      markdown: { content },
    },
  }
  const result = await dispatchOutbound({
    accountId: input.account.id,
    frameBody,
  })
  const externalMessageId =
    nonEmptyString(result.headers?.req_id) ||
    nonEmptyString((result.body as { msgid?: unknown } | undefined)?.msgid) ||
    randomUUID()
  return {
    externalMessageId,
    raw: result,
  }
}
