import crypto from "node:crypto"
import * as Lark from "@larksuiteoapi/node-sdk"
import { Worker } from "bullmq"
import { QUEUE_NAMES } from "@synapse/shared"
import type {
  ConversationFeedMessageItem,
  TransportAccountSummary,
} from "@synapse/shared/types"
import { redis } from "../infrastructure/redis/index.js"
import { getConversationFeedItemById } from "../modules/chat/service.js"
import {
  getConversationTransportBinding,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
  getTransportAddressByExternalId,
  loadTransportMessageLinkForDelivery,
  updateTransportMessageLinkStatus,
} from "../modules/im/service.js"
import { tryGetConnector } from "../modules/im/connectors/registry.js"
import {
  decodeFromConversationItem,
  type EncodedContentBlock,
} from "../modules/im/messaging/canonical-encoding.js"
import { registerWorker } from "./registry.js"

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function getFeishuCredentials(account: TransportAccountSummary) {
  const credentials = account.credentials || {}
  const appId =
    nonEmptyString(credentials.appId) ||
    nonEmptyString(credentials.appID) ||
    nonEmptyString(credentials.cliAppId)
  const appSecret =
    nonEmptyString(credentials.appSecret) ||
    nonEmptyString(credentials.app_secret) ||
    nonEmptyString(credentials.cliAppSecret)
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu transport account ${account.id} is missing appId/appSecret`
    )
  }
  return { appId, appSecret }
}

function createFeishuClient(account: TransportAccountSummary) {
  const { appId, appSecret } = getFeishuCredentials(account)
  return new Lark.Client({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  })
}

function buildFeishuMentionPrefix(
  mentions: Array<{ externalId: string; displayName?: string }>
) {
  if (!mentions.length) return ""
  return mentions
    .map((mention) => {
      const name = mention.displayName || mention.externalId
      return `<at user_id="${mention.externalId}">${name}</at>`
    })
    .join(" ")
}

function buildWeixinHeaders(body: string, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": Buffer.from(
      String(crypto.randomBytes(4).readUInt32BE(0)),
      "utf8"
    ).toString("base64"),
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }
  return headers
}

async function postWeixinMessage(params: {
  account: TransportAccountSummary
  to: string
  text: string
  contextToken: string
}) {
  const token = nonEmptyString(params.account.credentials?.token)
  if (!token) {
    throw new Error(
      `Weixin transport account ${params.account.id} is missing token`
    )
  }
  const baseUrl =
    nonEmptyString(params.account.config.baseUrl) ||
    "https://ilinkai.weixin.qq.com"
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: crypto.randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 1,
          text_item: {
            text: params.text,
          },
        },
      ],
      context_token: params.contextToken,
    },
    base_info: {},
  })
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`,
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
  return {
    messageId: crypto.randomUUID(),
  }
}

async function resolveTransportMentionRecipients(params: {
  transportKind: "feishu" | "weixin" | "wecom"
  transportAccountId: string
  endpointType: "direct" | "group"
  endpointExternalId: string
  item: ConversationFeedMessageItem
}) {
  const recipients = new Map<
    string,
    { externalId: string; displayName?: string }
  >()

  for (const block of params.item.contentBlocks) {
    if (block.type !== "mention") {
      continue
    }
    const participantId = block.mention.participantId || ""
    if (!participantId) continue

    const useAttachedAddressOnly =
      params.endpointType === "group" ||
      (params.endpointType === "direct" && params.transportKind === "feishu")
    const address = useAttachedAddressOnly
      ? await getPrimaryTransportAddressForParticipant({
          conversationParticipantId: participantId,
          transportAccountId: params.transportAccountId,
        })
      : await getReachableTransportAddressForParticipant({
          conversationParticipantId: participantId,
          transportAccountId: params.transportAccountId,
        })
    const externalId = nonEmptyString(address?.external_id)
    if (!externalId) continue
    if (
      params.endpointType === "direct" &&
      params.transportKind !== "feishu" &&
      externalId !== params.endpointExternalId
    ) {
      continue
    }

    if (!recipients.has(externalId)) {
      recipients.set(externalId, {
        externalId,
        displayName:
          nonEmptyString(address?.display_name) ||
          block.mention.name ||
          externalId,
      })
    }
  }

  return Array.from(recipients.values())
}

async function deliverViaFeishu(params: {
  account: TransportAccountSummary
  endpoint: {
    endpointType: "direct" | "group"
    externalId: string
  }
  item: ConversationFeedMessageItem
}) {
  const client = createFeishuClient(params.account)
  const mentions =
    params.endpoint.endpointType === "group"
      ? await resolveTransportMentionRecipients({
          transportKind: "feishu",
          transportAccountId: params.account.id,
          endpointType: params.endpoint.endpointType,
          endpointExternalId: params.endpoint.externalId,
          item: params.item,
        })
      : []
  const mentionPrefix = buildFeishuMentionPrefix(mentions)
  const text = [mentionPrefix, params.item.content.trim() || "[消息]"]
    .filter(Boolean)
    .join(" ")
    .trim()

  const response: any = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: params.endpoint.externalId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  })

  if (response?.code !== 0) {
    throw new Error(response?.msg || "Feishu send failed")
  }

  return {
    messageId:
      nonEmptyString(response?.data?.message_id) ||
      nonEmptyString(response?.data?.message?.message_id) ||
      crypto.randomUUID(),
  }
}

async function deliverViaWeixin(params: {
  account: TransportAccountSummary
  endpoint: {
    externalId: string
    metadata: Record<string, unknown>
  }
  item: ConversationFeedMessageItem
}) {
  const endpointExternalId = params.endpoint.externalId
  const endpointAddress = await getTransportAddressByExternalId({
    transportAccountId: params.account.id,
    externalId: endpointExternalId,
    addressType: "user",
  })
  const endpointAddressMetadata =
    endpointAddress &&
    endpointAddress.metadata &&
    typeof endpointAddress.metadata === "object" &&
    !Array.isArray(endpointAddress.metadata)
      ? (endpointAddress.metadata as Record<string, unknown>)
      : {}
  const contextToken =
    nonEmptyString(endpointAddressMetadata.contextToken) ||
    nonEmptyString(params.endpoint.metadata.contextToken)
  if (!contextToken) {
    throw new Error(
      `Weixin direct conversation ${endpointExternalId} is missing contextToken`
    )
  }

  return postWeixinMessage({
    account: params.account,
    to: endpointExternalId,
    text: params.item.content.trim() || "[消息]",
    contextToken,
  })
}

export function startImTransportDeliveryWorker() {
  const worker = new Worker(
    QUEUE_NAMES.IM_TRANSPORT_DELIVERY,
    async (job) => {
      const linkId = nonEmptyString(job.data?.linkId)
      if (!linkId) {
        return { success: false, reason: "missing linkId" }
      }

      const link = await loadTransportMessageLinkForDelivery(linkId)
      if (!link) {
        return { success: false, reason: "missing link" }
      }
      if (link.direction !== "outbound") {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "skipped",
          metadata: { skippedReason: "not_outbound" },
        })
        return { success: true, reason: "not outbound" }
      }
      // Allow BullMQ retries: pending or failed are eligible to (re-)send.
      // sent/skipped are terminal and short-circuit.
      if (link.deliveryStatus === "sent" || link.deliveryStatus === "skipped") {
        return {
          success: true,
          reason: `already ${link.deliveryStatus}`,
        }
      }
      if (link.account.status !== "active") {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "skipped",
          metadata: { skippedReason: "account_disabled" },
        })
        return { success: true, reason: "account disabled" }
      }

      const binding = await getConversationTransportBinding({
        workspaceId: link.workspaceId,
        conversationId: link.conversationId,
      })
      if (
        !binding ||
        binding.account.status !== "active" ||
        !binding.outboundEnabled ||
        binding.account.id !== link.transportAccountId ||
        binding.endpoint.id !== link.transportEndpointId
      ) {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "skipped",
          metadata: {
            skippedReason: !binding
              ? "binding_missing"
              : binding.account.status !== "active"
                ? "account_disabled"
                : !binding.outboundEnabled
                  ? "binding_disabled"
                  : "binding_changed",
          },
        })
        return { success: true, reason: "binding unavailable" }
      }

      const item = await getConversationFeedItemById(link.itemId)
      if (!item || item.kind !== "message") {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "skipped",
          metadata: { skippedReason: "item_missing_or_not_message" },
        })
        return { success: true, reason: "item missing" }
      }
      if (item.author?.participantType === "external") {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "skipped",
          metadata: { skippedReason: "external_author" },
        })
        return { success: true, reason: "external author" }
      }
      try {
        const connector = tryGetConnector(link.transportKind)
        if (!connector) {
          throw new Error(
            `no TransportConnector registered for transport_kind=${link.transportKind}`
          )
        }
        // Build the CanonicalMessage from the conversation item, resolve
        // mentions, then hand to the connector to render + send.
        const message = decodeFromConversationItem({
          content: item.content,
          contentBlocks: item.contentBlocks as EncodedContentBlock[],
          transportMetadata:
            ((item as unknown as { metadata?: Record<string, unknown> })
              .metadata?.transport as Record<string, unknown>) || undefined,
        })
        const mentions = await resolveTransportMentionRecipients({
          transportKind: link.transportKind,
          transportAccountId: link.account.id,
          endpointType: link.endpoint.endpointType,
          endpointExternalId: link.endpoint.externalId,
          item,
        })
        for (const m of mentions) {
          message.parts.push({
            type: "mention",
            externalId: m.externalId,
            displayName: m.displayName || m.externalId,
          })
        }
        const deliveryResult = await connector.sendMessage({
          account: link.account,
          endpoint: {
            endpointType: link.endpoint.endpointType,
            externalId: link.endpoint.externalId,
            metadata: link.endpoint.metadata,
          },
          message,
        })

        await updateTransportMessageLinkStatus({
          linkId,
          status: "sent",
          externalMessageId: deliveryResult.externalMessageId,
        })
        return { success: true, messageId: deliveryResult.externalMessageId }
      } catch (error: any) {
        await updateTransportMessageLinkStatus({
          linkId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },
    { connection: redis }
  )

  registerWorker(worker)
}
