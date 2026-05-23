/**
 * Feishu outbound: render CanonicalMessage and dispatch via Lark SDK.
 *
 * If `replyTo` is provided (typically because the conversation item this is
 * projecting has reply_to_item_id), uses im.message.reply so Feishu threads
 * the response visually. Otherwise falls back to im.message.create.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import type {
  MessageRef,
  OutboundEndpointRef,
  OutboundSendResult,
} from "../types.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { createFeishuClient } from "./client.js"
import { renderFeishuMessage } from "./render.js"

export interface FeishuSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
}

export async function sendFeishuMessage(
  input: FeishuSendInput
): Promise<OutboundSendResult> {
  const degraded = degradeForCapabilities(
    input.message,
    FEISHU_MESSAGE_CAPABILITIES
  )
  const rendered = renderFeishuMessage(degraded)
  const client = createFeishuClient(input.account)

  let response: any
  if (input.replyTo?.externalMessageId) {
    response = await client.im.message.reply({
      path: { message_id: input.replyTo.externalMessageId },
      data: {
        content: rendered.content,
        msg_type: rendered.msg_type,
      },
    })
  } else {
    response = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.endpoint.externalId,
        msg_type: rendered.msg_type,
        content: rendered.content,
      },
    })
  }

  if (response?.code !== 0) {
    throw new Error(
      `Feishu send failed: code=${response?.code} msg=${response?.msg ?? ""}`
    )
  }
  const externalMessageId =
    response?.data?.message_id || `feishu-unknown-${Date.now()}`
  return { externalMessageId, raw: response?.data }
}
