import { Worker } from "bullmq"
import { QUEUE_NAMES } from "@synapse/shared"
import type { ConversationFeedMessageItem } from "@synapse/shared/types"
import { redis } from "../infrastructure/redis/index.js"
import { getConversationFeedItemById } from "../modules/chat/service.js"
import {
  findExternalMessageIdForItem,
  getConversationTransportBinding,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
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

        // If this outbound is a reply to a previous IM message, look up the
        // platform's message_id for that conversation_item and pass it to
        // the connector. The connector decides how to use it (Feishu uses
        // im.message.reply; weixin has no reply concept and may ignore).
        let replyTo:
          | { externalMessageId: string; endpointExternalId: string }
          | undefined
        const replyToItemId = (item as unknown as { replyToItemId?: string })
          .replyToItemId
        if (replyToItemId) {
          const externalReplyMsgId = await findExternalMessageIdForItem({
            itemId: replyToItemId,
            transportEndpointId: link.endpoint.id,
          })
          if (externalReplyMsgId) {
            replyTo = {
              externalMessageId: externalReplyMsgId,
              endpointExternalId: link.endpoint.externalId,
            }
          }
        }

        const deliveryResult = await connector.sendMessage({
          account: link.account,
          endpoint: {
            endpointType: link.endpoint.endpointType,
            externalId: link.endpoint.externalId,
            metadata: link.endpoint.metadata,
          },
          message,
          replyTo,
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
