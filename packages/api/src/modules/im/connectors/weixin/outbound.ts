/**
 * Personal-WeChat (ilinkai) outbound sender.
 *
 * The protocol requires a contextToken to address an outbound reply.
 * The worker pre-loads the recipient transport_address row's metadata
 * (triggered by `requiresRecipientAddressMetadata = true` on the
 * connector) and passes it in as `recipientAddressMetadata`. We fall
 * back to the endpoint metadata if it's missing. This keeps the
 * connector package self-contained — it does not reach into the
 * modules/im/service layer.
 */

import crypto from "node:crypto"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import type { OutboundEndpointRef, OutboundSendResult } from "../types.js"
import { WEIXIN_MESSAGE_CAPABILITIES } from "./capabilities.js"
import {
  buildWeixinHeaders,
  getWeixinCredentialsOrThrow,
  nonEmpty,
} from "./client.js"
import { renderWeixinMessage } from "./render.js"

export interface WeixinSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: import("../../messaging/canonical-message.js").CanonicalMessage
  /**
   * Metadata of the recipient transport_address row. Pre-loaded by the
   * worker because we set `requiresRecipientAddressMetadata = true` on
   * the connector. May be undefined if the worker found no row, in
   * which case we fall back to `endpoint.metadata`.
   */
  recipientAddressMetadata?: Record<string, unknown>
}

export async function sendWeixinMessage(
  input: WeixinSendInput
): Promise<OutboundSendResult> {
  const { token, baseUrl } = getWeixinCredentialsOrThrow(input.account)
  const endpointExternalId = input.endpoint.externalId

  // Resolve contextToken: prefer the pre-loaded transport_address metadata
  // (refreshed by every inbound, see weixin/inbound.ts), fall back to the
  // endpoint metadata. The worker is responsible for the lookup; this
  // connector stays self-contained.
  const contextToken =
    nonEmpty(input.recipientAddressMetadata?.contextToken) ||
    nonEmpty(input.endpoint.metadata.contextToken)
  if (!contextToken) {
    throw new Error(
      `Weixin direct conversation ${endpointExternalId} is missing contextToken`
    )
  }

  const degraded = degradeForCapabilities(
    input.message,
    WEIXIN_MESSAGE_CAPABILITIES
  )
  const rendered = renderWeixinMessage(degraded)

  const clientId = crypto.randomUUID()
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: endpointExternalId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: rendered.text } }],
      context_token: contextToken,
    },
    base_info: {},
  })
  const response = await fetch(
    `${baseUrl!.replace(/\/+$/, "")}/ilink/bot/sendmessage`,
    {
      method: "POST",
      headers: buildWeixinHeaders(body, token),
      body,
    }
  )
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Weixin send failed with ${response.status}: ${text}`)
  }

  // Parse the protocol response for a real message id. ilink returns
  // shapes like { ret, errcode, msg_id?, msg?: { message_id?, items?: [...] } }
  // depending on version. Fall back to the client_id we sent so the row
  // still has a stable key for dedupe.
  let externalMessageId: string | undefined
  try {
    const parsed = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const p = parsed as Record<string, any>
      externalMessageId =
        nonEmpty(p.msg_id) ||
        nonEmpty(p.message_id) ||
        nonEmpty(p.msg?.message_id) ||
        nonEmpty(p.msg?.msg_id) ||
        (Array.isArray(p.msg?.item_list)
          ? nonEmpty(p.msg.item_list[0]?.msg_id)
          : undefined)
    }
  } catch {
    // Non-JSON body — fall through to client_id fallback
  }
  return {
    externalMessageId: externalMessageId || clientId,
    raw: text,
  }
}
