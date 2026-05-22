/**
 * Feishu outbound: render CanonicalMessage and dispatch via Lark SDK.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import type { OutboundEndpointRef, OutboundSendResult } from "../types.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { createFeishuClient } from "./client.js"
import { renderFeishuMessage } from "./render.js"

export interface FeishuSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
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

  const response = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: input.endpoint.externalId,
      msg_type: rendered.msg_type,
      content: rendered.content,
    },
  })
  if (response?.code !== 0) {
    throw new Error(
      `Feishu send failed: code=${response?.code} msg=${response?.msg ?? ""}`
    )
  }
  const externalMessageId =
    response?.data?.message_id || `feishu-unknown-${Date.now()}`
  return { externalMessageId, raw: response?.data }
}
