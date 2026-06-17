import { UnrecoverableError } from "bullmq"
import { tracedWorker } from "./job-tracing.js"
import { CONVERSATION_PARTICIPANT_TYPE, QUEUE_NAMES } from "@synapse/shared"
import type { TransportKind } from "@synapse/shared/types"
import { redis } from "../infrastructure/redis/index.js"
import { getConversationFeedItemById } from "../modules/chat/conversation-item-read.js"
import {
  findExternalMessageIdForItem,
  getConversationTransportBinding,
  getPrimaryTransportAddressForParticipant,
  getReachableTransportAddressForParticipant,
  getTransportAddressByExternalId,
  loadTransportMessageLinkForDelivery,
  patchTransportMessageLinkMetadata,
  updateTransportMessageLinkStatus,
} from "../modules/im/service.js"
import { tryGetConnector } from "../modules/im/connectors/registry.js"
import type { TransportConnector } from "../modules/im/connectors/types.js"
import { PermanentTransportError } from "../modules/im/connectors/types.js"
import {
  decodeFromConversationItem,
  type EncodedContentBlock,
} from "../modules/im/messaging/canonical-encoding.js"
import {
  resolveMentionRecipientsByParticipant,
  type ResolveMentionsInput,
  type ResolvedMention,
} from "../modules/im/messaging/mention-resolver.js"
import { registerWorker } from "./registry.js"

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
 * `loadRecipientAddress` is invoked only for connectors that set
 * `requiresRecipientAddressMetadata` (today: Weixin, which needs the
 * ilink contextToken from the address row). `resolveMentions` is the
 * shared participant-keyed resolver used to fill `externalId` in place
 * on each mention part before the connector send.
 *
 * `patchLinkMetadata` is the deep-merge helper exposed to the
 * connector through `OutboundSendInput.patchLinkMetadata` — connectors
 * persist per-attempt state (msg_seq reservation, in-flight markers,
 * ambiguity flags) before the HTTP round-trip.
 */
export interface ImTransportDeliveryDeps {
  loadLink: typeof loadTransportMessageLinkForDelivery
  findExternalMessageIdForItem: typeof findExternalMessageIdForItem
  /**
   * Looks up the recipient transport_address row when the connector
   * declares `requiresRecipientAddressMetadata = true`. The repo normalizes
   * `metadata` to a plain object before this worker sees the row.
   */
  loadRecipientAddress: typeof getTransportAddressByExternalId
  /**
   * Resolves mention parts in the decoded CanonicalMessage to a
   * `participantId → ResolvedMention` map. The worker uses the map to
   * fill `externalId` in place on each mention part, instead of
   * appending new mention parts at the end. The default deps wire this
   * to `resolveMentionRecipientsByParticipant` with the by-participant
   * variant of the resolver.
   */
  resolveMentions: (
    input: ResolveMentionsInput
  ) => Promise<Map<string, ResolvedMention>>
  updateStatus: typeof updateTransportMessageLinkStatus
  patchLinkMetadata: typeof patchTransportMessageLinkMetadata
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
 * Pure handler body lifted out of the BullMQ Worker constructor so it
 * can be unit-tested with stub deps.
 *
 * Behavior contracts worth calling out:
 *   - **Binding-changed check runs BEFORE the account-status check.**
 *     A legitimate binding switch (the conversation rebound to a
 *     freshly-active account, while the link's stale account is
 *     disabled) must classify as `binding_changed` and not as
 *     `account_disabled`; otherwise recovery code that scans for
 *     `binding_changed` skipReason never sees the link.
 *   - Connector errors are wrapped: `PermanentTransportError` becomes
 *     BullMQ's `UnrecoverableError` so the job stops retrying; every
 *     other error keeps the default retry behavior driven by
 *     `IM_TRANSPORT_DELIVERY_JOB_DEFAULTS`.
 *   - `OutboundSendResult.deliveryAmbiguous === true` accepts an
 *     undefined `externalMessageId`, marks the link `sent` with
 *     `external_message_id` NULL, and writes
 *     `metadata.delivery.ambiguous = true`. A missing id without an
 *     explicit ambiguous flag is treated as a connector bug and
 *     raises `PermanentTransportError`.
 */
export async function processImTransportDeliveryJob(
  jobData: { linkId?: unknown } | null | undefined,
  deps: ImTransportDeliveryDeps,
  /**
   * BullMQ `job.attemptsMade` at handler entry. The production wrapper
   * (`startImTransportDeliveryWorker`) passes the BullMQ value; tests
   * default to 0 when omitted to keep call-sites short.
   */
  attemptNumber: number = 0
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

  // Binding-changed recovery: look at the *current* binding before
  // trusting the link's stale account snapshot. If the binding has
  // moved to a different (account, endpoint) pair, the link is stale
  // — classify it `skipped` with `binding_changed` so recovery can
  // requeue work onto the new binding. This MUST run before the
  // `link.account.status !== "active"` early-return, because the
  // common legitimate case is `old account disabled → new account
  // active`. Without the swap, the link would forever look like
  // "account_disabled" and never get rebound.
  const binding = await deps.getBinding({
    workspaceId: link.workspaceId,
    conversationId: link.conversationId,
  })
  if (
    binding &&
    (binding.account.id !== link.transportAccountId ||
      binding.endpoint.id !== link.transportEndpointId)
  ) {
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: { skippedReason: "binding_changed" },
    })
    return { success: true, reason: "binding changed" }
  }

  if (link.account.status !== "active") {
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: { skippedReason: "account_disabled" },
    })
    return { success: true, reason: "account disabled" }
  }

  if (
    !binding ||
    binding.account.status !== "active" ||
    !binding.outboundEnabled
  ) {
    await deps.updateStatus({
      linkId,
      status: "skipped",
      metadata: {
        skippedReason: !binding
          ? "binding_missing"
          : binding.account.status !== "active"
            ? "account_disabled"
            : "binding_disabled",
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
      transportMetadata: objectField(item.metadata.transport),
    })
    // Resolve mentions to a participantId → ResolvedMention map, then
    // fill `externalId` in place on each mention part. This preserves the
    // original positional order in `message.parts` instead of appending
    // duplicate mention parts at the end (which the prior worker did, and
    // which caused renderers like Feishu to show the same @ twice).
    //
    // Mentions with no participantId (inbound-mirrored — already carry an
    // externalId from the parsing pass) pass through untouched.
    //
    // The displayName fill uses a trim-based emptiness check: a part with
    // `displayName: " "` is treated as missing so the connector renderer
    // doesn't emit an `<at>` tag with a whitespace name.
    const resolvedMentions = await deps.resolveMentions({
      parts: message.parts,
      capabilities: connector.messageCapabilities,
      transportAccountId: link.account.id,
      endpointType: link.endpoint.endpointType,
      endpointExternalId: link.endpoint.externalId,
    })
    for (const part of message.parts) {
      if (part.type !== "mention") continue
      const participantId = part.participantId
      if (!participantId) continue
      const resolved = resolvedMentions.get(participantId)
      if (!resolved) continue
      part.externalId = resolved.externalId
      if (!part.displayName?.trim()) {
        part.displayName = resolved.displayName
      }
    }

    // If this outbound is a reply to a previous IM message, look up the
    // platform's message_id for that conversation_item and pass it to
    // the connector. The connector decides how to use it (Feishu uses
    // im.message.reply; weixin has no reply concept and may ignore).
    let replyTo:
      | { externalMessageId: string; endpointExternalId: string }
      | undefined
    const replyToItemId = item.replyToItemId
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
      recipientAddressMetadata = addressRow?.metadata
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
      transportMessageLinkId: link.id,
      linkMetadata: link.metadata ?? {},
      attemptNumber,
      patchLinkMetadata: (patch) =>
        deps.patchLinkMetadata({ linkId: link.id, patch }),
    })

    // Ambiguous-success path: connector knows the send was delivered
    // but didn't get an id back (QQ duplicate msg_seq + prior
    // unknown attempt). Stamp `delivery.ambiguous` and finish.
    if (deliveryResult.deliveryAmbiguous) {
      await deps.updateStatus({
        linkId,
        status: "sent",
        metadata: { delivery: { ambiguous: true } },
      })
      return { success: true }
    }

    // Connector returned no id and no ambiguity flag — treat as a
    // bug. PermanentTransportError so we don't retry-burn on a
    // missing-implementation case.
    if (!deliveryResult.externalMessageId) {
      throw new PermanentTransportError(
        `${connector.transportKind} sendMessage returned no externalMessageId and did not set deliveryAmbiguous`,
        { code: "missing_external_message_id" }
      )
    }

    await deps.updateStatus({
      linkId,
      status: "sent",
      externalMessageId: deliveryResult.externalMessageId,
    })
    return { success: true, messageId: deliveryResult.externalMessageId }
  } catch (error: unknown) {
    await deps.updateStatus({
      linkId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    })
    if (error instanceof PermanentTransportError) {
      // BullMQ stops retrying when the worker throws
      // `UnrecoverableError`. Preserve the original message so
      // `metadata.lastError` and worker logs stay readable.
      throw new UnrecoverableError(error.message)
    }
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
    // Bind the by-participant resolver to the real address loaders. The
    // mapper translates the snake_case transport_addresses row shape into
    // the resolver's expected ParticipantAddressLookup (camelCase fields).
    resolveMentions: (input) =>
      resolveMentionRecipientsByParticipant(input, {
        loadAttachedAddress: async ({
          conversationParticipantId,
          transportAccountId,
        }) => {
          const row = await getPrimaryTransportAddressForParticipant({
            conversationParticipantId,
            transportAccountId,
          })
          return row
            ? {
                externalId: String(row.externalId),
                displayName: row.displayName ?? undefined,
              }
            : null
        },
        loadReachableAddress: async ({
          conversationParticipantId,
          transportAccountId,
        }) => {
          const row = await getReachableTransportAddressForParticipant({
            conversationParticipantId,
            transportAccountId,
          })
          return row
            ? {
                externalId: String(row.externalId),
                displayName: row.displayName ?? undefined,
              }
            : null
        },
      }),
    updateStatus: updateTransportMessageLinkStatus,
    patchLinkMetadata: patchTransportMessageLinkMetadata,
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
  const worker = tracedWorker(
    QUEUE_NAMES.IM_TRANSPORT_DELIVERY,
    async (job) =>
      processImTransportDeliveryJob(job.data, deps, job.attemptsMade),
    { connection: redis }
  )

  registerWorker(worker)
}
