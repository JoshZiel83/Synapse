import { Worker } from "bullmq"
import { CONVERSATION_PARTICIPANT_TYPE, QUEUE_NAMES } from "@synapse/shared"
import type {
  ConversationFeedMessageItem,
  TransportKind,
} from "@synapse/shared/types"
import { redis } from "../infrastructure/redis/index.js"
import { getConversationFeedItemById } from "../modules/chat/service.js"
import {
  findExternalMessageIdForItem,
  getConversationTransportBinding,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
  getTransportAddressByExternalId,
  loadTransportMessageLinkForDelivery,
  updateTransportMessageLinkStatus,
} from "../modules/im/service.js"
import { tryGetConnector } from "../modules/im/connectors/registry.js"
import type { TransportConnector } from "../modules/im/connectors/types.js"
import type { MessageCapabilities } from "../modules/im/messaging/degradation.js"
import {
  decodeFromConversationItem,
  type EncodedContentBlock,
} from "../modules/im/messaging/canonical-encoding.js"
import { registerWorker } from "./registry.js"

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * The transport_address row's `metadata` JSONB column is typed as
 * Kysely's `JsonValue`, which permits primitives and arrays. Connectors
 * always want `Record<string, unknown> | undefined` here, so normalize
 * once at the worker boundary instead of asking every connector to
 * re-validate.
 */
function asObjectMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function resolveTransportMentionRecipients(params: {
  capabilities: MessageCapabilities
  transportAccountId: string
  endpointType: "direct" | "group"
  endpointExternalId: string
  item: ConversationFeedMessageItem
}) {
  const recipients = new Map<
    string,
    { externalId: string; displayName?: string }
  >()

  const useAttachedAddressOnly =
    params.endpointType === "group" ||
    (params.endpointType === "direct" &&
      params.capabilities.directMentionPolicy === "attached_only")

  for (const block of params.item.contentBlocks) {
    if (block.type !== "mention") {
      continue
    }
    const participantId = block.mention.participantId || ""
    if (!participantId) continue

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
      params.capabilities.directMentionPolicy === "self_only" &&
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

/**
 * Dependencies injected into processImTransportDeliveryJob.
 *
 * Each field corresponds to a cross-module call the handler currently makes
 * directly. Tests pass stub implementations; production wires the real
 * helpers via defaultImTransportDeliveryDeps().
 *
 * `getConnector` wraps tryGetConnector and throws the exact same error
 * string the handler used to throw inline, so behavior is preserved.
 *
 * Future commits add fields here:
 *   - Commit 3 adds `loadRecipientAddress` (for Weixin recipient address
 *     metadata pre-load).
 *   - Commit 4 adds `resolveMentions` (when the mention pipeline moves to
 *     the shared resolver).
 */
export interface ImTransportDeliveryDeps {
  loadLink: typeof loadTransportMessageLinkForDelivery
  findExternalMessageIdForItem: typeof findExternalMessageIdForItem
  /**
   * Looks up the recipient transport_address row when the connector
   * declares `requiresRecipientAddressMetadata = true`. The result's
   * `metadata` is normalized to a plain object before being passed to
   * `connector.sendMessage` (see `asObjectMetadata`).
   */
  loadRecipientAddress: typeof getTransportAddressByExternalId
  updateStatus: typeof updateTransportMessageLinkStatus
  getBinding: typeof getConversationTransportBinding
  getItem: typeof getConversationFeedItemById
  decode: typeof decodeFromConversationItem
  getConnector: (transportKind: TransportKind) => TransportConnector
}

export interface ImTransportDeliveryResult {
  success: boolean
  reason?: string
  messageId?: string
}

/**
 * Pure handler body lifted out of the BullMQ Worker constructor so it can
 * be unit-tested with stub deps. The BullMQ wrapper at
 * startImTransportDeliveryWorker() is now 3 lines.
 *
 * Behavior is preserved 1:1 with the previous inline handler, including:
 *   - defensive parsing of jobData (may be null/undefined; linkId may be
 *     missing or non-string)
 *   - the try/catch that wraps everything from connector lookup through
 *     send + status update — any throw inside that block flips the link
 *     to status="failed" and re-throws so BullMQ retries per its policy
 *   - skipped-reason metadata for every short-circuit path
 */
export async function processImTransportDeliveryJob(
  jobData: { linkId?: unknown } | null | undefined,
  deps: ImTransportDeliveryDeps
): Promise<ImTransportDeliveryResult> {
  const linkId = nonEmptyString(jobData?.linkId)
  if (!linkId) {
    return { success: false, reason: "missing linkId" }
  }

  const link = await deps.loadLink(linkId)
  if (!link) {
    return { success: false, reason: "missing link" }
  }
  if (link.direction !== "outbound") {
    await deps.updateStatus({
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
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: { skippedReason: "account_disabled" },
    })
    return { success: true, reason: "account disabled" }
  }

  const binding = await deps.getBinding({
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
    await deps.updateStatus({
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

  const item = await deps.getItem(link.itemId)
  if (!item || item.kind !== "message") {
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: { skippedReason: "item_missing_or_not_message" },
    })
    return { success: true, reason: "item missing" }
  }
  if (item.author?.participantType === CONVERSATION_PARTICIPANT_TYPE.EXTERNAL) {
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: { skippedReason: "external_author" },
    })
    return { success: true, reason: "external author" }
  }
  try {
    const connector = deps.getConnector(link.transportKind)
    const message = deps.decode({
      content: item.content,
      contentBlocks: item.contentBlocks as EncodedContentBlock[],
      transportMetadata:
        ((item as unknown as { metadata?: Record<string, unknown> }).metadata
          ?.transport as Record<string, unknown>) || undefined,
    })
    const mentions = await resolveTransportMentionRecipients({
      capabilities: connector.messageCapabilities,
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
      const externalReplyMsgId = await deps.findExternalMessageIdForItem({
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

    // Pre-load the recipient transport_address metadata when the connector
    // wants it. Lookup throws are caught by the surrounding try/catch and
    // surface as `status="failed"` + re-throw, which is what we want for
    // BullMQ retries — the address row may be created on a subsequent
    // inbound and the retry will succeed.
    let recipientAddressMetadata: Record<string, unknown> | undefined
    if (connector.requiresRecipientAddressMetadata) {
      const addressRow = await deps.loadRecipientAddress({
        transportAccountId: link.account.id,
        addressType: "user",
        externalId: link.endpoint.externalId,
      })
      recipientAddressMetadata = asObjectMetadata(addressRow?.metadata)
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
      recipientAddressMetadata,
    })

    await deps.updateStatus({
      linkId,
      status: "sent",
      externalMessageId: deliveryResult.externalMessageId,
    })
    return { success: true, messageId: deliveryResult.externalMessageId }
  } catch (error: any) {
    await deps.updateStatus({
      linkId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Default deps factory wiring the real service implementations.
 *
 * The `getConnector` wrapper preserves the inline error string the previous
 * handler threw (im-transport-delivery.ts:170-172 pre-extraction), so the
 * catch block produces the same `metadata.lastError` text as before.
 */
export function defaultImTransportDeliveryDeps(): ImTransportDeliveryDeps {
  return {
    loadLink: loadTransportMessageLinkForDelivery,
    findExternalMessageIdForItem,
    loadRecipientAddress: getTransportAddressByExternalId,
    updateStatus: updateTransportMessageLinkStatus,
    getBinding: getConversationTransportBinding,
    getItem: getConversationFeedItemById,
    decode: decodeFromConversationItem,
    getConnector: (transportKind) => {
      const c = tryGetConnector(transportKind)
      if (!c) {
        throw new Error(
          `no TransportConnector registered for transport_kind=${transportKind}`
        )
      }
      return c
    },
  }
}

export function startImTransportDeliveryWorker() {
  const deps = defaultImTransportDeliveryDeps()
  const worker = new Worker(
    QUEUE_NAMES.IM_TRANSPORT_DELIVERY,
    async (job) => processImTransportDeliveryJob(job.data, deps),
    { connection: redis }
  )

  registerWorker(worker)
}
