/**
 * transport_message_links domain: outbound projection enqueue + inbound
 * dedupe lookup + status updates + the joined-row loader the delivery
 * worker uses to send.
 *
 * Extracted from service.ts. service.ts re-exports for back-compat.
 */

import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type DatabaseTransaction,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  TransportDeliveryStatus,
  TransportKind,
} from "@synapse/shared/types"
import { enqueueTransportDeliveryJobs } from "../../../workers/queues.js"
import {
  normalizeAccountRow,
  normalizeEndpointRow,
  normalizeTransportMessageLinkRow,
  parseJsonObject,
} from "./_helpers.js"
import { getConversationTransportBinding } from "../service.js"
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("im.delivery")

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

  const link = await db
    .insertInto("transportMessageLinks")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      itemId: params.itemId,
      transportAccountId: binding.account.id,
      transportEndpointId: binding.endpoint.id,
      transportKind: binding.transportKind,
      direction,
      deliveryStatus: "pending",
      externalMessageId: params.externalMessageId || null,
      externalReplyToId: params.externalReplyToId || null,
      externalThreadId: params.externalThreadId || null,
      metadata: {
        bindingId: binding.id,
        endpointType: binding.endpoint.endpointType,
        endpointExternalId: binding.endpoint.externalId,
        ...(params.metadata || {}),
      } as TableInsert<"transportMessageLinks">["metadata"],
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["itemId", "transportEndpointId", "direction"]).doUpdateSet({
        externalMessageId: sql`COALESCE(excluded.external_message_id, transport_message_links.external_message_id)`,
        externalReplyToId: sql`COALESCE(excluded.external_reply_to_id, transport_message_links.external_reply_to_id)`,
        externalThreadId: sql`COALESCE(excluded.external_thread_id, transport_message_links.external_thread_id)`,
        metadata: sql`transport_message_links.metadata || excluded.metadata`,
      })
    )
    .returningAll()
    .executeTakeFirst()
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

export async function findTransportMessageLinkByExternalMessage(params: {
  transportAccountId: string
  transportEndpointId?: string
  externalMessageId: string
  direction: "inbound" | "outbound"
}) {
  let builder = db
    .selectFrom("transportMessageLinks")
    .selectAll()
    .where("transportAccountId", "=", params.transportAccountId)
    .where("externalMessageId", "=", params.externalMessageId.trim())
    .where("direction", "=", params.direction)

  if (params.transportEndpointId) {
    builder = builder.where(
      "transportEndpointId",
      "=",
      params.transportEndpointId
    )
  }

  const row = await builder.limit(1).executeTakeFirst()
  return row ? normalizeTransportMessageLinkRow(row) : null
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
  return await runWithTransaction(params.tx, async (tx) => {
    const existing = await tx
      .selectFrom("transportMessageLinks")
      .select("metadata")
      .where("id", "=", params.linkId)
      .forUpdate()
      .executeTakeFirst()
    const current = parseJsonObject(existing?.metadata)
    const merged = deepMergeJsonObjects(current, extraMetadata)
    const row = await tx
      .updateTable("transportMessageLinks")
      .set({
        deliveryStatus: params.status,
        ...(params.externalMessageId
          ? { externalMessageId: params.externalMessageId }
          : {}),
        metadata: merged as TableInsert<"transportMessageLinks">["metadata"],
        ...(params.status === "sent"
          ? { deliveredAt: sql`COALESCE(delivered_at, NOW())` }
          : {}),
      })
      .where("id", "=", params.linkId)
      .returningAll()
      .executeTakeFirst()
    return row ? normalizeTransportMessageLinkRow(row) : null
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
  await runWithTransaction(params.tx, async (tx) => {
    const existing = await tx
      .selectFrom("transportMessageLinks")
      .select("metadata")
      .where("id", "=", params.linkId)
      .forUpdate()
      .executeTakeFirst()
    const current = parseJsonObject(existing?.metadata)
    const merged = deepMergeJsonObjects(current, params.patch)
    await tx
      .updateTable("transportMessageLinks")
      .set({
        metadata: merged as TableInsert<"transportMessageLinks">["metadata"],
      })
      .where("id", "=", params.linkId)
      .execute()
  })
}

async function runWithTransaction<T>(
  tx: DatabaseTransaction | undefined,
  fn: (tx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  if (tx) return fn(tx)
  return withDbTransaction(fn)
}

export async function loadTransportMessageLinkForDelivery(linkId: string) {
  const row = await db
    .selectFrom("transportMessageLinks as tml")
    .innerJoin("transportAccounts as ta", "ta.id", "tml.transportAccountId")
    .innerJoin("transportEndpoints as te", "te.id", "tml.transportEndpointId")
    .innerJoin("conversationItems as ci", "ci.id", "tml.itemId")
    .select([
      "tml.id",
      "tml.workspaceId",
      "tml.conversationId",
      "tml.itemId",
      "tml.transportAccountId",
      "tml.transportEndpointId",
      "tml.transportKind",
      "tml.direction",
      "tml.deliveryStatus",
      "tml.externalMessageId",
      "tml.metadata",
      "tml.deliveredAt",
      "tml.createdAt",
      "tml.updatedAt",
      "ta.workspaceId as accountWorkspaceId",
      "ta.accountKey",
      "ta.displayName as accountDisplayName",
      "ta.ownerScope",
      "ta.ownerWorkspaceMemberId",
      "ta.connectionMode",
      "ta.status as accountStatus",
      "ta.credentials",
      "ta.config",
      "ta.metadata as accountMetadata",
      "ta.createdAt as accountCreatedAt",
      "ta.updatedAt as accountUpdatedAt",
      "te.endpointType",
      "te.externalId as endpointExternalId",
      "te.parentExternalId",
      "te.displayName as endpointDisplayName",
      "te.metadata as endpointMetadata",
      "te.createdAt as endpointCreatedAt",
      "te.updatedAt as endpointUpdatedAt",
      "ci.metadata as itemMetadata",
    ])
    .where("tml.id", "=", linkId)
    .limit(1)
    .executeTakeFirst()
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
    itemMetadata: parseJsonObject(row.itemMetadata),
  }
}

/**
 * Drop a top-level key from `transport_message_links.metadata` (jsonb
 * `-` operator). Used by recovery flips that need to clear stale
 * markers like `skippedReason` without rewriting the rest of the
 * metadata object. Accepts a Kysely transaction so callers can keep
 * the delete in the same commit as the related UPDATE.
 */
export async function removeTransportMessageLinkMetadataKey(
  tx: DatabaseTransaction,
  linkId: string,
  key: string
): Promise<void> {
  await tx
    .updateTable("transportMessageLinks")
    .set({
      metadata:
        sql`metadata - ${key}` as unknown as TableInsert<"transportMessageLinks">["metadata"],
    })
    .where("id", "=", linkId)
    .execute()
}

/**
 * Persist a fully-formed `transport_message_links` row directly.
 * Used by the task-projection worker to insert a link
 * already keyed to a freshly-minted action token before enqueueing
 * delivery.
 */
export async function persistOutboundLinkRowRaw(params: {
  workspaceId: string
  conversationId: string
  itemId: string
  transportAccountId: string
  transportEndpointId: string
  transportKind: TransportKind
  metadata?: Record<string, unknown>
}): Promise<{ id: string }> {
  const row = await db
    .insertInto("transportMessageLinks")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      itemId: params.itemId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: params.transportEndpointId,
      transportKind: params.transportKind,
      direction: "outbound",
      deliveryStatus: "pending",
      externalMessageId: null,
      externalReplyToId: null,
      externalThreadId: null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transportMessageLinks">["metadata"],
      createdAt: sql`NOW()`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return { id: row.id }
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
