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
  type DatabaseTransaction,
  type KyselyDb,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { v4 as uuidv4 } from "uuid"
import type {
  ConversationTransportBindingSummary,
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

type DbOrTx = KyselyDb | DatabaseTransaction

/**
 * Step 1 of the projection split (G5): resolve the binding for an outbound
 * projection and return `null` early when the link must not be created.
 *
 * Caller decides what to do with `null`: the legacy
 * `queueConversationTransportProjection` returns null silently; the new
 * `interaction-projection` worker uses the reason to mark
 * `interaction_transport_projections.error` accordingly.
 */
export type ResolveOutboundBindingResult =
  | {
      ok: true
      binding: ConversationTransportBindingSummary
    }
  | {
      ok: false
      reason:
        | "no_binding"
        | "account_inactive"
        | "outbound_disabled"
        | "not_supported_in_v1"
        | "webhook_inbound_unavailable"
    }

export async function resolveBindingForOutbound(params: {
  workspaceId: string
  conversationId: string
  /**
   * Optional list of transport_kinds this projection supports. Used by the
   * interaction-projection worker (v1: ["qq"]) to keep approval prompts
   * off Feishu/Weixin until those connectors gain interaction-prompt
   * rendering. Leave undefined for kind-agnostic projections (the legacy
   * outbound path).
   */
  allowedTransportKinds?: readonly TransportKind[]
}): Promise<ResolveOutboundBindingResult> {
  const binding = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  })
  if (!binding) return { ok: false, reason: "no_binding" }
  if (
    params.allowedTransportKinds &&
    !params.allowedTransportKinds.includes(binding.transportKind)
  ) {
    return { ok: false, reason: "not_supported_in_v1" }
  }
  if (binding.account.status !== "active") {
    return { ok: false, reason: "account_inactive" }
  }
  if (!binding.outboundEnabled) {
    return { ok: false, reason: "outbound_disabled" }
  }
  return { ok: true, binding }
}

/**
 * Step 2 of the projection split (G5): create the transport_message_links
 * row inside an external transaction. Returns the linkId. Does NOT enqueue
 * a BullMQ job; call `enqueueOutboundDelivery(linkId)` AFTER the outer
 * transaction commits.
 *
 * Use this from worker code that needs both the link row and a related
 * write (e.g. `interaction_transport_projections.status='projected'`) to
 * happen atomically.
 */
export async function persistOutboundLinkRow(
  exec: DbOrTx,
  params: {
    workspaceId: string
    conversationId: string
    itemId: string
    binding: ConversationTransportBindingSummary
    direction?: "inbound" | "outbound"
    externalMessageId?: string
    externalReplyToId?: string
    externalThreadId?: string
    metadata?: Record<string, unknown>
  }
): Promise<{
  linkId: string
  row: ReturnType<typeof normalizeTransportMessageLinkRow>
}> {
  const direction = params.direction || "outbound"
  const row = await exec
    .insertInto("transport_message_links")
    .values({
      id: uuidv4(),
      workspace_id: params.workspaceId,
      conversation_id: params.conversationId,
      item_id: params.itemId,
      transport_account_id: params.binding.account.id,
      transport_endpoint_id: params.binding.endpoint.id,
      transport_kind: params.binding.transportKind,
      direction,
      delivery_status: "pending",
      external_message_id: params.externalMessageId || null,
      external_reply_to_id: params.externalReplyToId || null,
      external_thread_id: params.externalThreadId || null,
      metadata: {
        bindingId: params.binding.id,
        endpointType: params.binding.endpoint.endpointType,
        endpointExternalId: params.binding.endpoint.externalId,
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
    .executeTakeFirstOrThrow()
  return { linkId: row.id, row: normalizeTransportMessageLinkRow(row) }
}

/**
 * Step 3 of the projection split (G5): enqueue the BullMQ delivery job
 * for an existing transport_message_links row. Must be called AFTER the
 * tx that wrote the row commits — otherwise the worker may pick up the
 * job before the row is visible.
 *
 * This is a thin wrapper around `enqueueTransportDeliveryJobs([linkId])`
 * kept here so projection-side code never imports the queue module
 * directly (avoiding the circular shape `workers → service → workers`).
 */
export async function enqueueOutboundDelivery(linkId: string): Promise<void> {
  await enqueueTransportDeliveryJobs([linkId])
}

/**
 * Legacy wrapper preserved for existing callers
 * (session/service.ts session push, im/service/ingest.ts inbound dedupe).
 *
 * Behavior on inbound (`direction:"inbound"`): writes the row only;
 * never enqueues a BullMQ job. Behavior on outbound:
 * resolveBinding → persist → enqueue (no transaction; the three steps
 * are sequential and the enqueue happens after the row is committed).
 *
 * Returns null when the binding is missing / account inactive / outbound
 * disabled — matching the legacy "silently skip" contract.
 */
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
  if (!binding) return null
  if (direction === "outbound" && binding.account.status !== "active") {
    return null
  }
  if (direction === "outbound" && !binding.outboundEnabled) return null

  const { row, linkId } = await persistOutboundLinkRow(db, {
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    itemId: params.itemId,
    binding,
    direction,
    externalMessageId: params.externalMessageId,
    externalReplyToId: params.externalReplyToId,
    externalThreadId: params.externalThreadId,
    metadata: params.metadata,
  })
  if (direction === "outbound") {
    await enqueueOutboundDelivery(linkId).catch((error) => {
      console.error(
        `[im] Failed to enqueue transport delivery job for link ${linkId}:`,
        error
      )
    })
  }
  return row
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
}) {
  const extraMetadata = {
    ...(params.metadata || {}),
    ...(params.error ? { lastError: params.error } : {}),
  }
  const row = await db
    .updateTable("transport_message_links")
    .set({
      delivery_status: params.status,
      ...(params.externalMessageId
        ? { external_message_id: params.externalMessageId }
        : {}),
      metadata: sql`transport_message_links.metadata || ${JSON.stringify(extraMetadata)}::jsonb`,
      ...(params.status === "sent"
        ? { delivered_at: sql`COALESCE(delivered_at, NOW())` }
        : {}),
      updated_at: sql`NOW()`,
    })
    .where("id", "=", params.linkId)
    .returningAll()
    .executeTakeFirst()
  return row ? normalizeTransportMessageLinkRow(row) : null
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
 * Deep-merge a patch into `transport_message_links.metadata`. G6 callback:
 * connectors invoke this from within `sendMessage` to persist per-attempt
 * state (msg_seq, anchor reservation, attempts.<n>.outcome) BEFORE the
 * HTTP POST, so a crash mid-flight doesn't lose the record.
 *
 * Implementation: `SELECT … FOR UPDATE` → application-level deep merge →
 * `UPDATE`. The row lock serializes concurrent attempts on the same link
 * so neither overwrites the other.
 *
 * Postgres jsonb `||` is shallow merge — does NOT recurse into nested
 * objects (it would overwrite `metadata.qq` entirely with the patch's
 * `qq` object). We therefore deep merge in application code.
 *
 * Arrays are replaced wholesale (not concatenated). Connectors should
 * structure attempt history as `{ "0": {...}, "1": {...} }` keyed by
 * attemptNumber instead of an array to keep updates additive.
 */
export async function patchTransportMessageLinkMetadata(
  linkId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom("transport_message_links")
      .select(["metadata"])
      .where("id", "=", linkId)
      .forUpdate()
      .limit(1)
      .executeTakeFirst()
    if (!row) return
    const current = parseJsonObject(row.metadata) as Record<string, unknown>
    const merged = deepMergeJsonObjects(current, patch)
    await tx
      .updateTable("transport_message_links")
      .set({
        metadata: merged as TableInsert<"transport_message_links">["metadata"],
        updated_at: sql`NOW()`,
      })
      .where("id", "=", linkId)
      .execute()
  })
}

/**
 * Delete a single top-level key from `transport_message_links.metadata`.
 * Used by recovery paths to clear `skippedReason` after flipping a link
 * back to `pending`. Postgres jsonb supports `metadata - $key` for this
 * directly so we don't need a SELECT…UPDATE roundtrip.
 */
export async function removeTransportMessageLinkMetadataKey(
  exec: DbOrTx,
  linkId: string,
  key: string
): Promise<void> {
  await exec
    .updateTable("transport_message_links")
    .set({
      metadata: sql`transport_message_links.metadata - ${key}`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", linkId)
    .execute()
}

/**
 * Recursive jsonb-shaped deep merge: `patch` keys take precedence,
 * but nested plain objects are merged key-by-key. Arrays and scalars
 * are replaced wholesale.
 *
 * Exported for unit-test coverage; production code reaches it via
 * `patchTransportMessageLinkMetadata`.
 */
export function deepMergeJsonObjects(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = out[key]
    if (isPlainObject(baseValue) && isPlainObject(patchValue)) {
      out[key] = deepMergeJsonObjects(
        baseValue as Record<string, unknown>,
        patchValue as Record<string, unknown>
      )
    } else {
      out[key] = patchValue
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
