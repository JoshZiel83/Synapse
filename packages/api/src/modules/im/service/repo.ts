/**
 * IM service repo — DB-row types + row normalizers.
 *
 * Houses the `normalize*Row` functions (DB row → shared/types shape) that the
 * IM service/domain files consume. Lives in a repo file so it may legitimately
 * define `normalize*Row` and shape DB rows. `_helpers.ts` re-exports these so
 * existing importers keep working unchanged.
 */

import type {
  TransportAccountInboundActorMode,
  TransportAccountStatus,
  TransportAccountOwnerScope,
  TransportAccountSummary,
  TransportConnectionMode,
  TransportConversationInboundActorMode,
  TransportDeliveryStatus,
  TransportEndpointType,
  TransportEndpointSummary,
  TransportExternalUserSummary,
  TransportKind,
  TransportSessionSummary,
  ConversationTransportBindingSummary,
} from "@synapse/shared/types"

import { sql } from "kysely"
import { v4 as uuidv4 } from "uuid"
import { parseJsonObject } from "@synapse/shared"
import {
  db,
  withDbTransaction,
  type DatabaseTransaction,
} from "../../../infrastructure/database/kysely.js"
import type {
  TransportAddressMetadataInsert,
  ConversationParticipantAddressMetadataInsert,
  TransportMessageLinkMetadataInsert,
} from "../repo.types.js"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../../infrastructure/datetime.js"
import { parseJsonArray, readTrimmedString } from "./_helpers.js"

type TransportAccountRow = {
  id: string
  workspaceId: string | null
  transportKind: TransportKind
  accountKey: string
  displayName: string | null
  ownerScope?: TransportAccountOwnerScope | null
  ownerWorkspaceMemberId?: string | null
  accountInboundActorMode?: TransportAccountInboundActorMode | null
  inboundActorMode?:
    | TransportAccountInboundActorMode
    | TransportConversationInboundActorMode
    | null
  accountInboundActorId?: string | null
  inboundActorId?: string | null
  connectionMode: TransportConnectionMode
  status: TransportAccountStatus
  credentials: unknown
  config: unknown
  metadata: unknown
  createdAt: Date
  updatedAt: Date
}

type TransportEndpointRow = {
  endpointId?: string | null
  id?: string | null
  transportAccountId: string
  endpointType: TransportEndpointType
  endpointExternalId?: string | null
  externalId?: string | null
  parentExternalId?: string | null
  endpointDisplayName?: string | null
  displayName?: string | null
  endpointMetadata?: unknown
  metadata?: unknown
  endpointCreatedAt?: Date | null
  createdAt?: Date | null
  endpointUpdatedAt?: Date | null
  updatedAt?: Date | null
}

type ConversationTransportBindingRow = TransportAccountRow &
  TransportEndpointRow & {
    bindingId?: string | null
    conversationId: string | null
    outboundEnabled: boolean | null
    bindingMetadata?: unknown
    bindingCreatedAt?: Date | null
    bindingUpdatedAt?: Date | null
  }

type TransportSessionRow = ConversationTransportBindingRow & {
  accountWorkspaceId?: string | null
  conversationTitle?: string | null
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
}

type TransportExternalUserRow = {
  id: string
  workspaceId: string
  transportAccountId: string
  transportKind: TransportKind
  accountDisplayName?: string | null
  externalId: string
  displayName?: string | null
  linkedWorkspaceMemberId?: string | null
  linkedWorkspaceMemberName?: string | null
  metadata: unknown
  createdAt: Date
  updatedAt: Date
  sessions?: unknown
}

type TransportMessageLinkRow = {
  id: string
  workspaceId: string
  conversationId: string
  itemId: string
  transportAccountId: string
  transportEndpointId: string
  transportKind: TransportKind
  direction: "inbound" | "outbound"
  deliveryStatus: TransportDeliveryStatus
  externalMessageId?: string | null
  externalReplyToId?: string | null
  externalThreadId?: string | null
  externalEmojiReactions?: unknown
  metadata: unknown
  deliveredAt?: Date | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

export function normalizeAccountRow(
  row: TransportAccountRow
): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId || "",
    transportKind: row.transportKind,
    accountKey: row.accountKey,
    displayName: row.displayName || row.accountKey,
    ownerScope:
      (row.ownerScope as TransportAccountOwnerScope | undefined) || "workspace",
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId || undefined,
    inboundActorMode:
      (row.accountInboundActorMode as
        | TransportAccountInboundActorMode
        | undefined) ||
      (row.inboundActorMode as TransportAccountInboundActorMode | undefined) ||
      "none",
    inboundActorId:
      row.accountInboundActorId || row.inboundActorId || undefined,
    connectionMode: row.connectionMode,
    status: row.status,
    credentials: parseJsonObject(row.credentials),
    config: parseJsonObject(row.config),
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

export function normalizeEndpointRow(
  row: TransportEndpointRow,
  transportKind: TransportKind
): TransportEndpointSummary {
  return {
    id: row.endpointId || row.id || "",
    transportAccountId: row.transportAccountId,
    transportKind,
    endpointType: row.endpointType,
    externalId: row.endpointExternalId || row.externalId || "",
    parentExternalId: row.parentExternalId || undefined,
    displayName: row.endpointDisplayName || row.displayName || undefined,
    metadata: parseJsonObject(row.endpointMetadata || row.metadata),
    createdAt: serializeOptionalInstant(
      row.endpointCreatedAt || row.createdAt
    )!,
    updatedAt: serializeOptionalInstant(
      row.endpointUpdatedAt || row.updatedAt
    )!,
  }
}

export function normalizeBindingRow(
  row: ConversationTransportBindingRow
): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row)
  return {
    id: row.bindingId || row.id,
    conversationId: row.conversationId || "",
    workspaceId: row.workspaceId || account.workspaceId,
    transportKind: row.transportKind,
    outboundEnabled: Boolean(row.outboundEnabled),
    inboundActorMode:
      (row.inboundActorMode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inboundActorId || undefined,
    metadata: parseJsonObject(row.bindingMetadata || row.metadata),
    createdAt: serializeOptionalInstant(row.bindingCreatedAt || row.createdAt)!,
    updatedAt: serializeOptionalInstant(row.bindingUpdatedAt || row.updatedAt)!,
    account,
    endpoint: normalizeEndpointRow(row, row.transportKind),
  }
}

export function normalizeTransportSessionRow(
  row: TransportSessionRow
): TransportSessionSummary {
  const workspaceId = row.accountWorkspaceId || row.workspaceId || ""
  const account = normalizeAccountRow({ ...row, workspaceId })
  return {
    id: row.endpointId || row.bindingId || row.id,
    workspaceId,
    transportKind: row.transportKind,
    outboundEnabled: Boolean(row.outboundEnabled),
    inboundActorMode:
      (row.inboundActorMode as
        | TransportConversationInboundActorMode
        | undefined) || "inherit_account",
    inboundActorId: row.inboundActorId || undefined,
    metadata: parseJsonObject(
      row.bindingMetadata || row.endpointMetadata || row.metadata
    ),
    createdAt: serializeOptionalInstant(
      row.bindingCreatedAt || row.endpointCreatedAt || row.createdAt
    )!,
    updatedAt: serializeOptionalInstant(
      row.bindingUpdatedAt || row.endpointUpdatedAt || row.updatedAt
    )!,
    conversationId: row.conversationId || undefined,
    conversationTitle: readTrimmedString(row, "conversationTitle"),
    lastInboundAt: serializeOptionalInstant(row.lastInboundAt),
    lastOutboundAt: serializeOptionalInstant(row.lastOutboundAt),
    account,
    endpoint: normalizeEndpointRow(row, row.transportKind),
  }
}

export function normalizeTransportExternalUserRow(
  row: TransportExternalUserRow
): TransportExternalUserSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    transportAccountId: row.transportAccountId,
    transportKind: row.transportKind,
    accountDisplayName: row.accountDisplayName || "Transport account",
    externalId: row.externalId,
    displayName: row.displayName || undefined,
    linkedWorkspaceMemberId: row.linkedWorkspaceMemberId || undefined,
    linkedWorkspaceMemberName: row.linkedWorkspaceMemberName || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
    sessions: parseJsonArray<any>(row.sessions),
  }
}

export function normalizeTransportMessageLinkRow(row: TransportMessageLinkRow) {
  const rawReactions = row.externalEmojiReactions
  const reactions: Record<string, string> = {}
  if (
    rawReactions &&
    typeof rawReactions === "object" &&
    !Array.isArray(rawReactions)
  ) {
    for (const [k, v] of Object.entries(
      rawReactions as Record<string, unknown>
    )) {
      if (typeof v === "string") reactions[k] = v
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    itemId: row.itemId,
    transportAccountId: row.transportAccountId,
    transportEndpointId: row.transportEndpointId,
    transportKind: row.transportKind as TransportKind,
    direction: row.direction as "inbound" | "outbound",
    deliveryStatus: row.deliveryStatus as TransportDeliveryStatus,
    externalMessageId: row.externalMessageId || undefined,
    externalReplyToId: row.externalReplyToId || undefined,
    externalThreadId: row.externalThreadId || undefined,
    externalEmojiReactions: reactions,
    metadata: parseJsonObject(row.metadata),
    deliveredAt: serializeOptionalInstant(row.deliveredAt),
    createdAt: serializeOptionalInstant(row.createdAt),
    updatedAt: serializeOptionalInstant(row.updatedAt),
  }
}

// ───────────────────────── queries: ingest ─────────────────────────

export async function getWorkspaceOwnerId(
  workspaceId: string
): Promise<string> {
  const row = await db
    .selectFrom("workspaces")
    .select("ownerId")
    .where("id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  const ownerId = row?.ownerId
  if (!ownerId) {
    throw new Error(`Workspace ${workspaceId} not found`)
  }
  return ownerId
}

// ─────────────────────── queries: external-users ───────────────────────

export async function listTransportExternalUsers(params: {
  workspaceId: string
  transportAccountId?: string
}): Promise<TransportExternalUserSummary[]> {
  const activity = db
    .selectFrom("conversationParticipantAddresses as cpa_activity")
    .innerJoin(
      "conversationParticipants as cm_activity",
      "cm_activity.id",
      "cpa_activity.conversationParticipantId"
    )
    .innerJoin(
      "transportMessageLinks as tml",
      "tml.conversationId",
      "cm_activity.conversationId"
    )
    .select("cpa_activity.transportAddressId")
    .select(sql<Date | null>`MAX(tml.created_at)`.as("lastSeenAt"))
    .groupBy("cpa_activity.transportAddressId")
    .as("activity")

  let builder = db
    .selectFrom("transportAddresses as ta")
    .innerJoin(
      "transportAccounts as account",
      "account.id",
      "ta.transportAccountId"
    )
    .leftJoin(
      "workspaceMembers as linked_wm",
      "linked_wm.id",
      "ta.workspaceMemberId"
    )
    .leftJoin("users as linked_user", "linked_user.id", "linked_wm.userId")
    .leftJoin(
      "conversationParticipantAddresses as cpa",
      "cpa.transportAddressId",
      "ta.id"
    )
    .leftJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .leftJoin("conversations as c", "c.id", "cm.conversationId")
    .leftJoin(
      "conversationTransportBindings as ctb",
      "ctb.conversationId",
      "c.id"
    )
    .leftJoin("transportEndpoints as te", "te.id", "ctb.transportEndpointId")
    .leftJoin(activity, "activity.transportAddressId", "ta.id")
    .select([
      "ta.id",
      "ta.workspaceId",
      "ta.transportAccountId",
      "ta.transportKind",
      "ta.externalId",
      "ta.displayName",
      "ta.metadata",
      "ta.createdAt",
      "ta.updatedAt",
      "account.displayName as accountDisplayName",
      "linked_wm.id as linkedWorkspaceMemberId",
      "linked_user.name as linkedWorkspaceMemberName",
      "activity.lastSeenAt as lastSeenAt",
      sql<any>`COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'conversationId', c.id,
            'conversationTitle', c.title,
            'endpointId', te.id,
            'endpointType', te.endpoint_type,
            'endpointExternalId', te.external_id,
            'endpointDisplayName', te.display_name
          )
        ) FILTER (WHERE te.id IS NOT NULL),
        '[]'::jsonb
      )`.as("sessions"),
    ])
    .where("ta.workspaceId", "=", params.workspaceId)
    .where("ta.addressType", "=", "user")

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transportAccountId",
      "=",
      params.transportAccountId
    )
  }

  const rows = await builder
    .groupBy([
      "ta.id",
      "account.displayName",
      "linked_user.id",
      "linked_user.name",
      "activity.lastSeenAt",
    ])
    .orderBy(
      sql`COALESCE(activity.last_seen_at, ta.updated_at, ta.created_at)`,
      "desc"
    )
    .orderBy("ta.createdAt", "desc")
    .execute()

  return rows.map(normalizeTransportExternalUserRow)
}

// ─────────────────────── queries: reactions-storage ───────────────────────

/**
 * Read the persisted glyph → reaction_id map for an inbound message.
 * Returns {} when the column is empty / malformed / row missing.
 */
export async function loadTransportEmojiReactions(input: {
  transportAccountId: string
  externalMessageId: string
}): Promise<Record<string, string>> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .select("externalEmojiReactions")
    .where("transportAccountId", "=", input.transportAccountId)
    .where("externalMessageId", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  const raw = row?.externalEmojiReactions
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

/**
 * Replace the persisted glyph → reaction_id map for an inbound message.
 * Called by the Feishu reaction adapter's onReactionTracked callback on
 * every successful add/delete.
 */
export async function saveTransportEmojiReactions(input: {
  transportAccountId: string
  externalMessageId: string
  reactionIdsByEmoji: Record<string, string>
}): Promise<void> {
  await db
    .updateTable("transportMessageLinks")
    .set({
      externalEmojiReactions: sql`${JSON.stringify(input.reactionIdsByEmoji)}::jsonb`,
    })
    .where("transportAccountId", "=", input.transportAccountId)
    .where("externalMessageId", "=", input.externalMessageId)
    .where("direction", "=", "inbound")
    .execute()
}

/**
 * Resolve the external_message_id of the inbound link that recorded the
 * given conversation_item. Used by the delivery worker to translate
 * `conversation_items.reply_to_item_id` (internal id) into the platform
 * message_id that connector.sendMessage(replyTo) expects.
 */
export async function findExternalMessageIdForItem(input: {
  itemId: string
  transportEndpointId: string
}): Promise<string | null> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .select(["externalMessageId"])
    .where("itemId", "=", input.itemId)
    .where("transportEndpointId", "=", input.transportEndpointId)
    .where("direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  return row?.externalMessageId || null
}

// ─────────────────────── queries: weixin-binding ───────────────────────

export async function findWeixinWorkspaceMemberIdByUser(params: {
  workspaceId: string
  userId: string
}): Promise<string | null> {
  const row = await db
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", params.workspaceId)
    .where("userId", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

export async function findWorkspaceMemberWeixinAccountRow(params: {
  workspaceId: string
  workspaceMemberId: string
  transportKind: "weixin"
}): Promise<TransportAccountRow | undefined> {
  return db
    .selectFrom("transportAccounts")
    .selectAll()
    .where("workspaceId", "=", params.workspaceId)
    .where("transportKind", "=", params.transportKind)
    .where("ownerScope", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", params.workspaceMemberId)
    .orderBy(
      sql<number>`CASE
        WHEN status = 'active' THEN 0
        WHEN status = 'error' THEN 1
        ELSE 2
      END`
    )
    .orderBy("updatedAt", "desc")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst() as Promise<TransportAccountRow | undefined>
}

export async function findWorkspaceMemberDisplayName(params: {
  workspaceId: string
  workspaceMemberId: string
}): Promise<string | undefined> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select("u.name as name")
    .where("wm.workspaceId", "=", params.workspaceId)
    .where("wm.id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return readTrimmedString((row || {}) as Record<string, unknown>, "name")
}

// ─────────────────────── queries: delivery-links ───────────────────────

async function runWithTransaction<T>(
  tx: DatabaseTransaction | undefined,
  fn: (tx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  if (tx) return fn(tx)
  return withDbTransaction(fn)
}

/**
 * Upsert the transport_message_links projection row for a conversation
 * item. Returns the raw inserted/updated row (the direction check +
 * BullMQ enqueue side-effect stay in the service orchestration).
 */
export async function insertTransportMessageLinkProjection(params: {
  workspaceId: string
  conversationId: string
  itemId: string
  transportAccountId: string
  transportEndpointId: string
  transportKind: TransportKind
  direction: "inbound" | "outbound"
  externalMessageId?: string | null
  externalReplyToId?: string | null
  externalThreadId?: string | null
  metadata: Record<string, unknown>
}) {
  return db
    .insertInto("transportMessageLinks")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      itemId: params.itemId,
      transportAccountId: params.transportAccountId,
      transportEndpointId: params.transportEndpointId,
      transportKind: params.transportKind,
      direction: params.direction,
      deliveryStatus: "pending",
      externalMessageId: params.externalMessageId || null,
      externalReplyToId: params.externalReplyToId || null,
      externalThreadId: params.externalThreadId || null,
      metadata: params.metadata as TransportMessageLinkMetadataInsert,
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

/**
 * UPDATE delivery status + write the (already deep-merged) metadata back
 * inside the supplied transaction. The locking read
 * (selectTransportMessageLinkMetadataForUpdate) + the deep merge live in
 * the service; this owns only the write so the lock taken by the read is
 * held until commit.
 */
export async function updateTransportMessageLinkStatusRow(
  tx: DatabaseTransaction,
  params: {
    linkId: string
    status: TransportDeliveryStatus
    externalMessageId?: string
    mergedMetadata: Record<string, unknown>
  }
) {
  const row = await tx
    .updateTable("transportMessageLinks")
    .set({
      deliveryStatus: params.status,
      ...(params.externalMessageId
        ? { externalMessageId: params.externalMessageId }
        : {}),
      metadata: params.mergedMetadata as TransportMessageLinkMetadataInsert,
      ...(params.status === "sent"
        ? { deliveredAt: sql`COALESCE(delivered_at, NOW())` }
        : {}),
    })
    .where("id", "=", params.linkId)
    .returningAll()
    .executeTakeFirst()
  return row ? normalizeTransportMessageLinkRow(row) : null
}

/**
 * SELECT … FOR UPDATE the current metadata of a link inside the supplied
 * (or freshly-opened) transaction. The deep-merge + write-back live in the
 * service so the merge logic stays out of the repo; this owns only the
 * locking read so the lock is held for the duration of the merge + UPDATE.
 */
export async function selectTransportMessageLinkMetadataForUpdate(
  tx: DatabaseTransaction,
  linkId: string
): Promise<unknown> {
  const existing = await tx
    .selectFrom("transportMessageLinks")
    .select("metadata")
    .where("id", "=", linkId)
    .forUpdate()
    .executeTakeFirst()
  return existing?.metadata
}

/**
 * Write a deep-merged metadata blob back to a link inside the supplied
 * transaction (companion to selectTransportMessageLinkMetadataForUpdate).
 */
export async function updateTransportMessageLinkMetadataRow(
  tx: DatabaseTransaction,
  linkId: string,
  mergedMetadata: Record<string, unknown>
): Promise<void> {
  await tx
    .updateTable("transportMessageLinks")
    .set({
      metadata: mergedMetadata as TransportMessageLinkMetadataInsert,
    })
    .where("id", "=", linkId)
    .execute()
}

/**
 * Open (or reuse) a transaction for a metadata patch. Used by
 * patchTransportMessageLinkMetadata so the SELECT … FOR UPDATE and the
 * UPDATE compose in one commit.
 */
export async function runTransportMessageLinkTransaction<T>(
  tx: DatabaseTransaction | undefined,
  fn: (tx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return runWithTransaction(tx, fn)
}

export async function loadTransportMessageLinkForDeliveryRow(linkId: string) {
  return db
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
        sql`metadata - ${key}` as unknown as TransportMessageLinkMetadataInsert,
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
export async function insertOutboundLinkRowRaw(params: {
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
      metadata: (params.metadata || {}) as TransportMessageLinkMetadataInsert,
      createdAt: sql`NOW()`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return { id: row.id }
}

// ─────────────────────── queries: addresses ───────────────────────

/**
 * The reachable-address candidate row returned by
 * selectReachableTransportAddressForParticipant. The raw UNION ALL
 * selects `ta.*` (snake_case, bypassing the CamelCasePlugin) plus the
 * derived flags, so callers read snake_case column names.
 */
export type ReachableTransportAddressRow = {
  id: string
  external_id: string
  display_name: string | null
  is_attached: boolean
  is_primary: boolean
  binding_created_at: Date | null
  [column: string]: unknown
}

export async function insertTransportAddress(params: {
  workspaceId: string
  transportAccountId: string
  transportKind: TransportKind
  addressType?: "user" | "bot" | "system"
  externalId: string
  displayName?: string
  workspaceMemberId?: string
  metadata?: Record<string, unknown>
}) {
  return db
    .insertInto("transportAddresses")
    .values({
      id: uuidv4(),
      workspaceId: params.workspaceId,
      transportAccountId: params.transportAccountId,
      transportKind: params.transportKind,
      addressType: params.addressType || "user",
      externalId: params.externalId.trim(),
      displayName: params.displayName?.trim() || null,
      workspaceMemberId: params.workspaceMemberId || null,
      metadata: (params.metadata || {}) as TransportAddressMetadataInsert,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["transportAccountId", "addressType", "externalId"])
        .doUpdateSet({
          displayName: sql`COALESCE(excluded.display_name, transport_addresses.display_name)`,
          workspaceMemberId: sql`COALESCE(excluded.workspace_member_id, transport_addresses.workspace_member_id)`,
          metadata: sql`transport_addresses.metadata || excluded.metadata`,
        })
    )
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function selectTransportAddressByExternalId(params: {
  transportAccountId: string
  externalId: string
  addressType?: "user" | "bot" | "system"
}) {
  return db
    .selectFrom("transportAddresses")
    .selectAll()
    .where("transportAccountId", "=", params.transportAccountId)
    .where("addressType", "=", params.addressType || "user")
    .where("externalId", "=", params.externalId.trim())
    .limit(1)
    .executeTakeFirst()
}

export async function selectTransportAddressById(transportAddressId: string) {
  return db
    .selectFrom("transportAddresses")
    .selectAll()
    .where("id", "=", transportAddressId)
    .limit(1)
    .executeTakeFirst()
}

export async function selectPrimaryTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId?: string
}) {
  let builder = db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin("transportAddresses as ta", "ta.id", "cpa.transportAddressId")
    .selectAll("ta")
    .where(
      "cpa.conversationParticipantId",
      "=",
      params.conversationParticipantId
    )

  if (params.transportAccountId) {
    builder = builder.where(
      "ta.transportAccountId",
      "=",
      params.transportAccountId
    )
  }

  return builder
    .orderBy("cpa.isPrimary", "desc")
    .orderBy("cpa.createdAt", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function selectReachableTransportAddressForParticipant(params: {
  conversationParticipantId: string
  transportAccountId: string
}): Promise<ReachableTransportAddressRow | null> {
  const result = await db.executeQuery(
    sql<ReachableTransportAddressRow>`SELECT candidate.*
      FROM (
        SELECT ta.*,
               TRUE AS is_attached,
               cpa.is_primary,
               cpa.created_at AS binding_created_at
        FROM conversation_participant_addresses cpa
        JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
        WHERE cpa.conversation_participant_id = ${params.conversationParticipantId}
          AND ta.transport_account_id = ${params.transportAccountId}

        UNION ALL

        SELECT ta.*,
               FALSE AS is_attached,
               FALSE AS is_primary,
               ta.created_at AS binding_created_at
        FROM conversation_participants cm
        JOIN access_subjects cm_subj ON cm_subj.id = cm.subject_id
        JOIN transport_addresses ta
          ON ta.workspace_member_id = cm_subj.workspace_member_id
         AND ta.address_type = 'user'
        WHERE cm.id = ${params.conversationParticipantId}
          AND cm_subj.workspace_member_id IS NOT NULL
          AND ta.transport_account_id = ${params.transportAccountId}
      ) candidate
      ORDER BY candidate.is_attached DESC,
               candidate.is_primary DESC,
               candidate.binding_created_at ASC
      LIMIT 1`.compile(db)
  )
  return result.rows[0] ?? null
}

/**
 * conversation_participant_addresses is a persistent child guarded by
 * sd_reject_delete; the detach goes through the SECURITY DEFINER fn (§7.5/§11).
 */
export async function detachParticipantAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
}): Promise<void> {
  await sql`SELECT sd_detach_participant_address(${params.conversationParticipantId}::uuid, ${params.transportAddressId}::uuid)`.execute(
    db
  )
}

/**
 * Read the orphan-decision inputs for a conversation participant: its
 * subject kind, lifecycle state, and whether it still has any attached
 * addresses. The orphan business rule (decide whether to archive) stays
 * in the service.
 */
export async function selectConversationParticipantOrphanState(
  conversationParticipantId: string
): Promise<
  | { subjectKind: string | null; state: string; hasAddresses: boolean }
  | undefined
> {
  const row = await db
    .selectFrom("conversationParticipants as cm")
    .leftJoin("accessSubjects as cmsubj", "cmsubj.id", "cm.subjectId")
    .select([
      "cmsubj.kind as subjectKind",
      "cm.state",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM conversation_participant_addresses cpa
        WHERE cpa.conversation_participant_id = cm.id
      )`.as("hasAddresses"),
    ])
    .where("cm.id", "=", conversationParticipantId)
    .limit(1)
    .executeTakeFirst()
  if (!row) return undefined
  return {
    subjectKind: row.subjectKind ?? null,
    state: row.state as string,
    hasAddresses: Boolean(row.hasAddresses),
  }
}

/**
 * Mark an orphaned external conversation participant as `left`,
 * stamping `leftAt` + a `retiredByTransportLink` metadata marker.
 */
export async function updateConversationParticipantToLeft(
  conversationParticipantId: string
): Promise<void> {
  await db
    .updateTable("conversationParticipants")
    .set({
      state: "left",
      leftAt: sql`COALESCE(left_at, NOW())`,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ retiredByTransportLink: true })}::jsonb`,
    })
    .where("id", "=", conversationParticipantId)
    .execute()
}

/**
 * Preflight binding lookup used by syncTransportAddressConversationParticipant
 * to validate the conversation is bound (participant addresses are IM-only)
 * before any write.
 */
export async function selectConversationTransportBindingForAddressSync(
  conversationId: string
): Promise<{ workspaceId: string; transportAccountId: string } | undefined> {
  return db
    .selectFrom("conversationTransportBindings")
    .select(["workspaceId", "transportAccountId"])
    .where("conversationId", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
}

/**
 * Members in a conversation (other than the desired one) currently
 * attached to a given transport address — used to detach + archive
 * stale memberships during a membership sync.
 */
export async function selectAttachedParticipantsForAddress(params: {
  conversationId: string
  transportAddressId: string
  excludeParticipantId: string
}): Promise<{ id: string }[]> {
  return db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .select(["cm.id"])
    .where("cpa.transportAddressId", "=", params.transportAddressId)
    .where("cm.conversationId", "=", params.conversationId)
    .where("cm.id", "<>", params.excludeParticipantId)
    .execute()
}

export async function selectConversationIdsForTransportAddress(
  transportAddressId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom("conversationParticipantAddresses as cpa")
    .innerJoin(
      "conversationParticipants as cm",
      "cm.id",
      "cpa.conversationParticipantId"
    )
    .select("cm.conversationId")
    .distinct()
    .where("cpa.transportAddressId", "=", transportAddressId)
    .execute()
  return rows.map((row) => row.conversationId as string).filter(Boolean)
}

export async function selectConversationExternalParticipantPrimaryAddress(params: {
  workspaceId: string
  conversationId: string
  conversationParticipantId: string
}) {
  return db
    .selectFrom("conversationParticipants as cm")
    .leftJoin(
      "conversationParticipantAddresses as cpa",
      "cpa.conversationParticipantId",
      "cm.id"
    )
    .leftJoin("transportAddresses as ta", "ta.id", "cpa.transportAddressId")
    .leftJoin("accessSubjects as cmsubj", "cmsubj.id", "cm.subjectId")
    .select([
      "cm.id as conversationParticipantId",
      "ta.id as transportAddressId",
    ])
    .where("cm.conversationId", "=", params.conversationId)
    .where("cm.id", "=", params.conversationParticipantId)
    .where("cmsubj.kind", "=", "external")
    .where("ta.workspaceId", "=", params.workspaceId)
    .orderBy("cpa.isPrimary", "desc")
    .orderBy("cpa.createdAt", "asc")
    .limit(1)
    .executeTakeFirst()
}

export async function existsWorkspaceMember(params: {
  workspaceId: string
  workspaceMemberId: string
}): Promise<boolean> {
  const row = await db
    .selectFrom("workspaceMembers")
    .select("workspaceId")
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function updateTransportAddressLinkedMember(params: {
  workspaceId: string
  transportAddressId: string
  workspaceMemberId: string | null
}) {
  return db
    .updateTable("transportAddresses")
    .set({
      workspaceMemberId: params.workspaceMemberId,
    })
    .where("workspaceId", "=", params.workspaceId)
    .where("id", "=", params.transportAddressId)
    .where("addressType", "=", "user")
    .returningAll()
    .executeTakeFirst()
}

/**
 * Attach (or re-attach) a transport address to a conversation
 * participant. Owns BOTH the clear-other-primaries update and the
 * insert/onConflict so the two-statement effect stays together in the
 * repo.
 */
export async function upsertConversationParticipantAddress(params: {
  conversationParticipantId: string
  transportAddressId: string
  isPrimary?: boolean
  metadata?: Record<string, unknown>
}) {
  if (params.isPrimary) {
    await db
      .updateTable("conversationParticipantAddresses")
      .set({
        isPrimary: false,
      })
      .where("conversationParticipantId", "=", params.conversationParticipantId)
      .execute()
  }

  return db
    .insertInto("conversationParticipantAddresses")
    .values({
      conversationParticipantId: params.conversationParticipantId,
      transportAddressId: params.transportAddressId,
      isPrimary: params.isPrimary ?? false,
      metadata: (params.metadata ||
        {}) as ConversationParticipantAddressMetadataInsert,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc
        .columns(["conversationParticipantId", "transportAddressId"])
        .doUpdateSet({
          isPrimary: sql`CASE
            WHEN excluded.is_primary THEN TRUE
            ELSE conversation_participant_addresses.is_primary
          END`,
          metadata: sql`conversation_participant_addresses.metadata || excluded.metadata`,
        })
    )
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportAddressMetadataJsonb(params: {
  transportAddressId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transportAddresses")
    .set({
      metadata: sql`transport_addresses.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
    })
    .where("id", "=", params.transportAddressId)
    .returningAll()
    .executeTakeFirst()
}

export async function updateTransportEndpointMetadataJsonb(params: {
  endpointId: string
  metadata: Record<string, unknown>
}) {
  return db
    .updateTable("transportEndpoints")
    .set({
      metadata: sql`transport_endpoints.metadata || ${JSON.stringify(params.metadata || {})}::jsonb`,
    })
    .where("id", "=", params.endpointId)
    .returningAll()
    .executeTakeFirst()
}
