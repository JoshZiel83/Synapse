/**
 * Feishu outbound: plan + dispatch a CanonicalMessage.
 *
 * `planFeishuSends` splits the message into ordered (text, image*,
 * file*) sub-sends because Feishu's im.message.create accepts one
 * msg_type per call. For attachments, we upload the bytes to Feishu
 * first (im.image.create / im.file.create), then send the resulting
 * key as the message content.
 *
 * `replyTo` only applies to the FIRST send (Feishu threads the reply
 * marker on a single message; subsequent attachments aren't replies).
 * The first send's external_message_id is what we return as the
 * primary id — that's what transport_message_links records, and
 * what's used for later reply lookups.
 */

import crypto from "node:crypto"
import type * as Lark from "@larksuiteoapi/node-sdk"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { CanonicalMessage } from "../../messaging/canonical-message.js"
import { degradeForCapabilities } from "../../messaging/degradation.js"
import type {
  MessageRef,
  OutboundEndpointRef,
  OutboundSendResult,
} from "../types.js"
import { uploadFeishuFile, uploadFeishuImage } from "./attachments.js"
import { FEISHU_MESSAGE_CAPABILITIES } from "./capabilities.js"
import { createFeishuClient } from "./client.js"
import { planFeishuSends, type FeishuSendPlanItem } from "./render.js"

export interface FeishuSendInput {
  account: TransportAccountSummary
  endpoint: OutboundEndpointRef
  message: CanonicalMessage
  replyTo?: MessageRef
  /**
   * `transport_message_links.id` for this delivery. Used to derive a stable
   * per-send `uuid` so a whole-plan worker retry is idempotent on Feishu's
   * side (already-delivered sends are de-duplicated instead of doubled).
   */
  transportMessageLinkId?: string
}

/**
 * Deterministic Feishu idempotency key for the Nth send of one delivery.
 * Feishu de-duplicates identical (chat, uuid) sends within a time window, so
 * the SAME link + plan-step must always produce the SAME uuid across retries.
 * sha1 hex is 40 chars — within Feishu's 50-char uuid limit.
 */
function stableSendUuid(linkId: string, planIndex: number): string {
  return crypto
    .createHash("sha1")
    .update(`${linkId}:${planIndex}`)
    .digest("hex")
}

interface RenderedSend {
  msg_type: "text" | "interactive" | "image" | "file"
  content: string
}

/**
 * Resolve a single plan item to a {msg_type, content} payload, uploading
 * to Feishu's media APIs as needed. Errors propagate so BullMQ can retry.
 */
async function resolvePlanItem(
  client: Lark.Client,
  item: FeishuSendPlanItem
): Promise<RenderedSend> {
  switch (item.kind) {
    case "text":
      return {
        msg_type: "text",
        content: JSON.stringify({ text: item.content }),
      }
    case "interactive":
      return {
        msg_type: "interactive",
        content: JSON.stringify(item.payload),
      }
    case "image": {
      const image_key = await uploadFeishuImage({
        client,
        fileRef: item.fileRef,
      })
      return {
        msg_type: "image",
        content: JSON.stringify({ image_key }),
      }
    }
    case "file": {
      const file_key = await uploadFeishuFile({
        client,
        fileRef: item.fileRef,
      })
      return {
        msg_type: "file",
        content: JSON.stringify({ file_key }),
      }
    }
  }
}

async function postRendered(input: {
  client: Lark.Client
  endpoint: OutboundEndpointRef
  rendered: RenderedSend
  /** When set, the FIRST send uses im.message.reply; later sends ignore it. */
  replyTo?: MessageRef
  /** Idempotency key forwarded to Feishu (`uuid`); omitted when unavailable. */
  uuid?: string
}) {
  let response: any
  if (input.replyTo?.externalMessageId) {
    response = await input.client.im.message.reply({
      path: { message_id: input.replyTo.externalMessageId },
      data: {
        content: input.rendered.content,
        msg_type: input.rendered.msg_type,
        ...(input.uuid ? { uuid: input.uuid } : {}),
      },
    })
  } else {
    response = await input.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.endpoint.externalId,
        msg_type: input.rendered.msg_type,
        content: input.rendered.content,
        ...(input.uuid ? { uuid: input.uuid } : {}),
      },
    })
  }
  if (response?.code !== 0 && response?.code != null) {
    throw new Error(
      `Feishu send failed: code=${response?.code} msg=${response?.msg ?? ""}`
    )
  }
  const externalMessageId: string | undefined = response?.data?.message_id
  return { externalMessageId, raw: response?.data }
}

export async function sendFeishuMessage(
  input: FeishuSendInput
): Promise<OutboundSendResult> {
  const degraded = degradeForCapabilities(
    input.message,
    FEISHU_MESSAGE_CAPABILITIES
  )
  const plan = planFeishuSends(degraded)
  if (plan.length === 0) {
    // No text and no attachments and no card — most likely a reaction-only
    // message that should not have routed here in the first place. Emit a
    // visible placeholder so the operator sees the empty payload instead
    // of a silent no-op.
    plan.push({ kind: "text", content: "[消息]" })
  }

  const client = createFeishuClient(input.account)

  // Run sequentially so attachment ordering is preserved and so a
  // single failure aborts the rest (BullMQ will retry the whole link).
  const results: Array<{ externalMessageId?: string; raw?: unknown }> = []
  for (let i = 0; i < plan.length; i++) {
    const rendered = await resolvePlanItem(client, plan[i])
    const result = await postRendered({
      client,
      endpoint: input.endpoint,
      rendered,
      replyTo: i === 0 ? input.replyTo : undefined,
      uuid: input.transportMessageLinkId
        ? stableSendUuid(input.transportMessageLinkId, i)
        : undefined,
    })
    results.push(result)
  }

  const primary = results[0]
  const externalMessageId =
    primary?.externalMessageId || `feishu-unknown-${Date.now()}`
  return {
    externalMessageId,
    raw: {
      primary: primary?.raw,
      extras: results.slice(1).map((r) => r.raw),
    },
  }
}
