/**
 * transport_message_links domain: outbound projection enqueue + inbound
 * dedupe lookup + status updates + the joined-row loader the delivery
 * worker uses to send.
 *
 * The raw queries live in repo.ts (the module's repo file, which may
 * import the db client + sql); this file keeps the orchestration
 * (binding lookup, BullMQ enqueue, metadata deep-merge) and re-exports
 * the moved functions so service.ts + workers stay unchanged.
 */

import type { DatabaseTransaction } from "../../../infrastructure/database/kysely.js"
import type {
  TransportDeliveryStatus,
  TransportKind,
} from "@synapse/shared/types"
import { enqueueTransportDeliveryJobs } from "../../../workers/queues.js"
import {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeTransportMessageLinkRow,
} from "./_helpers.js"
import { getConversationTransportBinding } from "./bindings.js"
import {
  decodeConversationItemMetadata,
  insertTransportMessageLinkProjection,
  loadTransportMessageLinkForDeliveryRow,
  runTransportMessageLinkTransaction,
  selectTransportMessageLinkMetadataForUpdate,
  updateTransportMessageLinkMetadataRow,
  updateTransportMessageLinkStatusRow,
} from "./repo.js"
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("im.delivery")

// transport_message_links query helpers now live in repo.ts; re-export so
// importers that pulled them from this file keep working unchanged.
export {
  findTransportMessageLinkByExternalMessage,
  insertOutboundLinkRowRaw as persistOutboundLinkRowRaw,
  removeTransportMessageLinkMetadataKey,
} from "./repo.js"

/**
 * Recursively merge `patch` into `target`, returning a new object.
 * Plain objects are merged key-by-key; arrays and primitives in
 * `patch` overwrite the matching slot wholesale (arrays merging is
 * almost always wrong for delivery metadata, and the worker only
 * needs object-level merge semantics).
 *
 * Used by `patchTransportMessageLinkMetadata` so writes to
 * `metadata.delivery.*` from the sweeper don't clobber sibling
 * `metadata.delivery.*` keys an in-flight `sendMessage` patched
 * before it crashed (and vice versa).
 */
export function deepMergeJsonObjects(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key]
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeJsonObjects(
        existing as Record<string, unknown>,
        value as Record<string, unknown>
      )
    } else {
      out[key] = value
    }
  }
  return out
}

export async function queueConversationTransportProjection(params: {
  tx?: DatabaseTransaction
  workspaceId: string
  conversationId: string
  itemId: string
  direction?: "inbound" | "outbound"
  externalMessageId?: string
  externalReplyToId?: string
  externalThreadId?: string
  metadata?: Record<string, unknown>
}) {
  const direction = params.direction || "outbound"
  const binding = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!binding) {
    return null
  }
  if (direction === "outbound" && binding.account.status !== "active") {
    return null
  }
  if (direction === "outbound" && !binding.outboundEnabled) {
    return null
  }

  const link = await insertTransportMessageLinkProjection({
    queryable: params.tx,
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: params.itemId,
    transportAccountId: binding.account.id,
    transportEndpointId: binding.endpoint.id,
    transportKind: binding.transportKind,
    direction,
    externalMessageId: params.externalMessageId || null,
    externalReplyToId: params.externalReplyToId || null,
    externalThreadId: params.externalThreadId || null,
    metadata: {
      bindingId: binding.id,
      endpointType: binding.endpoint.endpointType,
      endpointExternalId: binding.endpoint.externalId,
      ...(params.metadata || {}),
    },
  })
  if (link && direction === "outbound") {
    await enqueueTransportDeliveryJobs([link.id]).catch((error) => {
      log.error(
        { err: error },
        `[im] Failed to enqueue transport delivery job for link ${link.id}`
      )
    })
  }

  return link
}

export async function updateTransportMessageLinkStatus(params: {
  linkId: string
  status: TransportDeliveryStatus
  externalMessageId?: string
  metadata?: Record<string, unknown>
  error?: string
  tx?: DatabaseTransaction
}) {
  const extraMetadata: Record<string, unknown> = {
    ...(params.metadata || {}),
    ...(params.error ? { lastError: params.error } : {}),
  }
  // Postgres jsonb `||` is a SHALLOW merge — writing
  // `{ delivery: { lastSweeperRetryAt: ... } }` would replace the
  // entire `delivery` subtree, blowing away `delivery.ambiguous` etc.
  // Use `patchTransportMessageLinkMetadata` (deep merge in
  // application code) to keep everything that shares a namespace.
  return await runTransportMessageLinkTransaction(params.tx, async (tx) => {
    const existing = await selectTransportMessageLinkMetadataForUpdate(
      tx,
      params.linkId
    )
    const merged = deepMergeJsonObjects(existing, extraMetadata)
    return updateTransportMessageLinkStatusRow(tx, {
      linkId: params.linkId,
      status: params.status,
      externalMessageId: params.externalMessageId,
      mergedMetadata: merged,
    })
  })
}

/**
 * Deep-merge a JSON patch into `transport_message_links.metadata`.
 * Called as `OutboundSendInput.patchLinkMetadata` from inside
 * `connector.sendMessage` so connectors can persist per-attempt
 * state (msg_seq, in-flight markers, ambiguity flags) before the
 * HTTP round-trip, surviving a process crash mid-flight.
 *
 * Semantics:
 *  - `SELECT … FOR UPDATE` locks the link row in the supplied
 *    (or freshly opened) transaction so a parallel attempt on the
 *    same link serializes after this one rather than racing.
 *  - Application-level deep merge means writing
 *    `{ delivery: { sweeperRetryCount: 3 } }` keeps any other
 *    `metadata.delivery.*` keys intact (`delivery.ambiguous`,
 *    `delivery.lastSweeperRetryAt`, …).
 *  - Pass `tx` when composing with surrounding writes (e.g. the
 *    worker's job-cleanup or sweeper SQL); omit to open a single-
 *    shot transaction.
 */
export async function patchTransportMessageLinkMetadata(params: {
  linkId: string
  patch: Record<string, unknown>
  tx?: DatabaseTransaction
}): Promise<void> {
  if (!params.patch || Object.keys(params.patch).length === 0) return
  await runTransportMessageLinkTransaction(params.tx, async (tx) => {
    const existing = await selectTransportMessageLinkMetadataForUpdate(
      tx,
      params.linkId
    )
    const merged = deepMergeJsonObjects(existing, params.patch)
    await updateTransportMessageLinkMetadataRow(tx, params.linkId, merged)
  })
}

export async function loadTransportMessageLinkForDelivery(linkId: string) {
  const row = await loadTransportMessageLinkForDeliveryRow(linkId)
  if (!row) return null

  return {
    ...normalizeTransportMessageLinkRow(row),
    account: normalizeAccountRow({
      id: row.transportAccountId,
      workspaceId: row.accountWorkspaceId,
      transportKind: row.transportKind,
      accountKey: row.accountKey,
      displayName: row.accountDisplayName,
      ownerScope: row.ownerScope,
      ownerWorkspaceMemberId: row.ownerWorkspaceMemberId,
      connectionMode: row.connectionMode,
      status: row.accountStatus,
      credentials: row.credentials,
      config: row.config,
      metadata: row.accountMetadata,
      createdAt: row.accountCreatedAt,
      updatedAt: row.accountUpdatedAt,
    }),
    endpoint: normalizeEndpointRow(
      {
        endpointId: row.transportEndpointId,
        transportAccountId: row.transportAccountId,
        endpointType: row.endpointType,
        endpointExternalId: row.endpointExternalId,
        parentExternalId: row.parentExternalId,
        endpointDisplayName: row.endpointDisplayName,
        endpointMetadata: row.endpointMetadata,
        endpointCreatedAt: row.endpointCreatedAt,
        endpointUpdatedAt: row.endpointUpdatedAt,
      },
      row.transportKind as TransportKind
    ),
    itemMetadata: decodeConversationItemMetadata(row),
  }
}

/**
 * Enqueue a freshly-created link for outbound delivery — the
 * task-projection worker writes the link row, then calls this
 * to push the job onto BullMQ with the standard
 * `IM_TRANSPORT_DELIVERY_JOB_DEFAULTS` (attempts + backoff).
 */
export async function enqueueOutboundDelivery(linkId: string): Promise<void> {
  await enqueueTransportDeliveryJobs([linkId])
}
