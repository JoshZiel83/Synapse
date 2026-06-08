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
    .insertInto("transport_message_links")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      item_id: params.itemId,
      transport_account_id: binding.account.id,
      transport_endpoint_id: binding.endpoint.id,
      transport_kind: binding.transportKind,
      direction,
      delivery_status: "pending",
      external_message_id: params.externalMessageId || null,
      external_reply_to_id: params.externalReplyToId || null,
      external_thread_id: params.externalThreadId || null,
      metadata: {
        bindingId: binding.id,
        endpointType: binding.endpoint.endpointType,
        endpointExternalId: binding.endpoint.externalId,
        ...(params.metadata || {}),
      } as TableInsert<"transport_message_links">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["item_id", "transport_endpoint_id", "direction"])
        .doUpdateSet({
          external_message_id: sql`COALESCE(excluded.external_message_id, transport_message_links.external_message_id)`,
          external_reply_to_id: sql`COALESCE(excluded.external_reply_to_id, transport_message_links.external_reply_to_id)`,
          external_thread_id: sql`COALESCE(excluded.external_thread_id, transport_message_links.external_thread_id)`,
          metadata: sql`transport_message_links.metadata || excluded.metadata`,
          updated_at: sql`NOW()`,
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
    .selectFrom("transport_message_links")
    .selectAll()
    .where("transport_account_id", "=", params.transportAccountId)
    .where("external_message_id", "=", params.externalMessageId.trim())
    .where("direction", "=", params.direction)

  if (params.transportEndpointId) {
    builder = builder.where(
      "transport_endpoint_id",
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
      .selectFrom("transport_message_links")
      .select("metadata")
      .where("id", "=", params.linkId)
      .forUpdate()
      .executeTakeFirst()
    const current = parseJsonObject(existing?.metadata)
    const merged = deepMergeJsonObjects(current, extraMetadata)
    const row = await tx
      .updateTable("transport_message_links")
      .set({
        delivery_status: params.status,
        ...(params.externalMessageId
          ? { external_message_id: params.externalMessageId }
          : {}),
        metadata: merged as TableInsert<"transport_message_links">["metadata"],
        ...(params.status === "sent"
          ? { delivered_at: sql`COALESCE(delivered_at, NOW())` }
          : {}),
        updated_at: sql`NOW()`,
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
      .selectFrom("transport_message_links")
      .select("metadata")
      .where("id", "=", params.linkId)
      .forUpdate()
      .executeTakeFirst()
    const current = parseJsonObject(existing?.metadata)
    const merged = deepMergeJsonObjects(current, params.patch)
    await tx
      .updateTable("transport_message_links")
      .set({
        metadata: merged as TableInsert<"transport_message_links">["metadata"],
        updated_at: sql`NOW()`,
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
    .selectFrom("transport_message_links as tml")
    .innerJoin("transport_accounts as ta", "ta.id", "tml.transport_account_id")
    .innerJoin(
      "transport_endpoints as te",
      "te.id",
      "tml.transport_endpoint_id"
    )
    .innerJoin("conversation_items as ci", "ci.id", "tml.item_id")
    .select([
      "tml.id",
      "tml.workspace_id",
      "tml.conversation_id",
      "tml.item_id",
      "tml.transport_account_id",
      "tml.transport_endpoint_id",
      "tml.transport_kind",
      "tml.direction",
      "tml.delivery_status",
      "tml.external_message_id",
      "tml.metadata",
      "tml.delivered_at",
      "tml.created_at",
      "tml.updated_at",
      "ta.workspace_id as account_workspace_id",
      "ta.account_key",
      "ta.display_name as account_display_name",
      "ta.owner_scope",
      "ta.owner_workspace_member_id",
      "ta.connection_mode",
      "ta.status as account_status",
      "ta.credentials",
      "ta.config",
      "ta.metadata as account_metadata",
      "ta.created_at as account_created_at",
      "ta.updated_at as account_updated_at",
      "te.endpoint_type",
      "te.external_id as endpoint_external_id",
      "te.parent_external_id",
      "te.display_name as endpoint_display_name",
      "te.metadata as endpoint_metadata",
      "te.created_at as endpoint_created_at",
      "te.updated_at as endpoint_updated_at",
      "ci.metadata as item_metadata",
    ])
    .where("tml.id", "=", linkId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null

  return {
    ...normalizeTransportMessageLinkRow(row),
    account: normalizeAccountRow({
      id: row.transport_account_id,
      workspace_id: row.account_workspace_id,
      transport_kind: row.transport_kind,
      account_key: row.account_key,
      display_name: row.account_display_name,
      owner_scope: row.owner_scope,
      owner_workspace_member_id: row.owner_workspace_member_id,
      connection_mode: row.connection_mode,
      status: row.account_status,
      credentials: row.credentials,
      config: row.config,
      metadata: row.account_metadata,
      created_at: row.account_created_at,
      updated_at: row.account_updated_at,
    }),
    endpoint: normalizeEndpointRow(
      {
        endpoint_id: row.transport_endpoint_id,
        transport_account_id: row.transport_account_id,
        endpoint_type: row.endpoint_type,
        endpoint_external_id: row.endpoint_external_id,
        parent_external_id: row.parent_external_id,
        endpoint_display_name: row.endpoint_display_name,
        endpoint_metadata: row.endpoint_metadata,
        endpoint_created_at: row.endpoint_created_at,
        endpoint_updated_at: row.endpoint_updated_at,
      },
      row.transport_kind as TransportKind
    ),
    itemMetadata: parseJsonObject(row.item_metadata),
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
    .updateTable("transport_message_links")
    .set({
      metadata:
        sql`metadata - ${key}` as unknown as TableInsert<"transport_message_links">["metadata"],
      updated_at: sql`NOW()`,
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
    .insertInto("transport_message_links")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      item_id: params.itemId,
      transport_account_id: params.transportAccountId,
      transport_endpoint_id: params.transportEndpointId,
      transport_kind: params.transportKind,
      direction: "outbound",
      delivery_status: "pending",
      external_message_id: null,
      external_reply_to_id: null,
      external_thread_id: null,
      metadata: (params.metadata ||
        {}) as TableInsert<"transport_message_links">["metadata"],
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
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
