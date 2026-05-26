import { UnrecoverableError, Worker } from "bullmq"
import { CONVERSATION_PARTICIPANT_TYPE, QUEUE_NAMES } from "@synapse/shared"
import type { TransportKind } from "@synapse/shared/types"
import { redis } from "../infrastructure/redis/index.js"
import { getConversationFeedItemById } from "../modules/chat/service.js"
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
import {
  PermanentTransportError,
  type TransportConnector,
} from "../modules/im/connectors/types.js"
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
  /**
   * G6 deep-merge patch into `transport_message_links.metadata`. The
   * worker hands a closure bound to the current link's id to each
   * `connector.sendMessage` call so connectors can persist per-attempt
   * state BEFORE the HTTP POST. Defaults to
   * `patchTransportMessageLinkMetadata`.
   */
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
 * Per-job context the BullMQ wrapper hands to the pure handler. Today
 * only `attemptNumber` lives here (sourced from `job.attemptsMade`); the
 * shape stays open for future per-job fields.
 */
export interface ImTransportDeliveryJobContext {
  attemptNumber: number
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
  deps: ImTransportDeliveryDeps,
  context: ImTransportDeliveryJobContext = { attemptNumber: 0 }
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
      transportMessageLinkId: linkId,
      linkMetadata: link.metadata,
      attemptNumber: context.attemptNumber,
      patchLinkMetadata: (patch) => deps.patchLinkMetadata(linkId, patch),
    })

    // `externalMessageId` is now optional (G6): the duplicate-ambiguous
    // path returns `{}` after marking `metadata.qq.deliveryAmbiguous`.
    // When absent, leave `external_message_id` NULL on the link row;
    // updateStatus only writes the column when an id is supplied.
    await deps.updateStatus({
      linkId,
      status: "sent",
      externalMessageId: deliveryResult.externalMessageId,
    })
    return { success: true, messageId: deliveryResult.externalMessageId }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorCode =
      error instanceof PermanentTransportError ? error.code : undefined
    await deps.updateStatus({
      linkId,
      status: "failed",
      error: errorCode ? `${errorCode}: ${errorMessage}` : errorMessage,
    })
    // PermanentTransportError → BullMQ stops retrying immediately.
    // Anything else (RetryableTransportError, bare Error, network) →
    // re-throw so BullMQ counts the attempt against the configured
    // `attempts` budget and backs off.
    if (error instanceof PermanentTransportError) {
      throw new UnrecoverableError(errorMessage)
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
                externalId: String(row.external_id),
                displayName: row.display_name ?? undefined,
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
                externalId: String(row.external_id),
                displayName: row.display_name ?? undefined,
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
  const worker = new Worker(
    QUEUE_NAMES.IM_TRANSPORT_DELIVERY,
    async (job) =>
      processImTransportDeliveryJob(job.data, deps, {
        attemptNumber: job.attemptsMade,
      }),
    { connection: redis }
  )

  registerWorker(worker)
}
