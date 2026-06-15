// chat/repo.ts — DB-touching helpers for the chat module.
//
// This is the only chat file permitted to import from generated/db and to
// define map*Row helpers (see packages/api/scripts/guard-layering.mjs). It
// owns the jsonb SQL fragment builder and the push-token row mapper so that
// service.ts stays free of generated/db imports and row-mapping definitions.

import { randomUUID } from "crypto"
import { CompiledQuery, sql, type RawBuilder } from "kysely"
import type {
  ChatSyncEventType,
  ConversationMessageTransportDirection,
  ConversationParticipantType,
  RemoteAgentRuntimeStateType,
  SessionStatus,
  Timestamp,
} from "@synapse/shared"
import { parseJsonObject } from "@synapse/shared"
import type { TransportKind } from "@synapse/shared/types"
import type { JsonValue } from "../../infrastructure/database/generated/db.js"
import {
  db,
  withDbTransaction,
  type DatabaseTransaction,
  type Executor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { serializeInstant } from "../../infrastructure/datetime.js"

/** Serialize a value into a jsonb-typed SQL fragment (matches `$N::jsonb`). */
export function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value ?? null)}::jsonb`
}

export type ChatConversationItemRow = {
  id: string
  conversationId: string
  sessionId?: string | null
  turnId?: string | null
  clientMessageId: string | null
  scope: "shared" | "private"
  surface: "visible" | "internal"
  itemType: "message" | "event" | "summary" | "control"
  subtype: string
  role: "user" | "assistant" | "system" | "tool"
  authorParticipantId: string | null
  replyToItemId: string | null
  causedByItemId: string | null
  eventPayload: Record<string, unknown>
  eventTimelinePolicy?: string | null
  eventContextPolicy?: string | null
  metadata: Record<string, unknown>
  sequence: string | number
  createdAt: Date
}

export type ChatConversationItemPartRow = {
  itemId: string
  ordinal: number
  partType: "text" | "file_ref" | "json"
  textValue: string | null
  refPath: string | null
  refSha256: string | null
  jsonValue: unknown
  mimeType: string | null
  name: string | null
  metadata: Record<string, unknown>
}

export type ChatConversationParticipantLinkRow = {
  itemId: string
  targetParticipantId: string
}

export type ChatConversationDeviceStateRow = {
  clientInstanceId: string
  conversationId: string
  lastVisibleSequence: string | number
  lastInboxSeq: string | number
  lastOpenedAt: Date | null
  draftPayload: Record<string, unknown>
}

export type ChatTransportDeliveryRow = {
  itemId: string
  linkId: string
  transportKind: TransportKind
  direction: ConversationMessageTransportDirection
  deliveryStatus: "pending" | "sent" | "failed" | "skipped"
  externalMessageId: string | null
  metadata: Record<string, unknown>
  deliveredAt: Date | null
  endpointType: "direct" | "group"
  endpointExternalId: string | null
  endpointDisplayName: string | null
}

export type ChatWorkspaceMemberSyncEventRow = {
  syncSeq: string | number
  memberSeq: string | number
  workspaceId: string
  workspaceMemberId: string
  conversationId: string | null
  itemId: string | null
  eventType: ChatSyncEventType
  payload: Record<string, unknown>
  occurredAt: Date
}

export type ChatParticipantByIdRow = {
  id: string
  conversationId: string
  participantType: ConversationParticipantType
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  displayName: string | null
  state: string
}

export type ChatConversationBaseRow = {
  conversationId: string
  kind: TableInsert<"conversations">["kind"]
  isIm: boolean
  title: string | null
  createdAt: Date
  updatedAt: Date
  unreadCount: number | string
  muted: boolean
  archived: boolean
  pinnedSortKey: Date | null
  lastVisibleItemId: string | null
  lastVisibleSequence: number | string
  lastVisibleAt: Date | null
}

export type ChatParticipantRow = {
  id: string
  conversationId: string
  participantType: ConversationParticipantType
  workspaceMemberId: string | null
  actorId: string | null
  remoteAgentId: string | null
  actorJoinVersionId: string | null
  displayName: string | null
  roleKey: string
  state: "active" | "left" | "removed"
  metadata: Record<string, unknown>
  joinedAt: Date
  leftAt: Date | null
  userId: string | null
  userName: string | null
  participantName: string | null
  participantTitle: string | null
  participantRole: string | null
  actorDocs: unknown
  actorCanRepresentUser: boolean | null
  actorSpecialties: unknown
  actorConfig: unknown
  actorCurrentVersion: number | string | null
  participantAvatarEmoji: string | null
  participantAvatarFileId: string | null
  userAvatarFileId: string | null
  transportAddressId: string | null
  transportKind: string | null
  transportExternalId: string | null
  transportDisplayName: string | null
  linkedUserId: string | null
  linkedUserName: string | null
  linkedUserAvatarFileId: string | null
  sessionId: string | null
  sessionStatus: SessionStatus | RemoteAgentRuntimeStateType | null
}

export function decodeChatJsonRecord(value: unknown): Record<string, unknown> {
  return parseJsonObject(value)
}

function normalizeConversationItemRow(
  row: ChatConversationItemRow
): ChatConversationItemRow {
  return Object.assign({}, row, {
    eventPayload: decodeChatJsonRecord(row.eventPayload),
    metadata: decodeChatJsonRecord(row.metadata),
  })
}

function normalizeWorkspaceMemberSyncEventRow(
  row: ChatWorkspaceMemberSyncEventRow
): ChatWorkspaceMemberSyncEventRow {
  return Object.assign({}, row, {
    payload: decodeChatJsonRecord(row.payload),
  })
}

function normalizeConversationItemPartRow(
  row: ChatConversationItemPartRow
): ChatConversationItemPartRow {
  return Object.assign({}, row, {
    metadata: decodeChatJsonRecord(row.metadata),
  })
}

function normalizeDeviceStateRow(
  row: ChatConversationDeviceStateRow
): ChatConversationDeviceStateRow {
  return Object.assign({}, row, {
    draftPayload: decodeChatJsonRecord(row.draftPayload),
  })
}

function normalizeTransportDeliveryRow(
  row: ChatTransportDeliveryRow
): ChatTransportDeliveryRow {
  return Object.assign({}, row, {
    metadata: decodeChatJsonRecord(row.metadata),
  })
}

function normalizeParticipantRow(row: ChatParticipantRow): ChatParticipantRow {
  return Object.assign({}, row, {
    metadata: decodeChatJsonRecord(row.metadata),
  })
}

const CONVERSATION_ITEM_SELECT = `
  id,
  conversation_id AS "conversationId",
  session_id AS "sessionId",
  turn_id AS "turnId",
  client_message_id AS "clientMessageId",
  scope,
  surface,
  item_type AS "itemType",
  subtype,
  role,
  author_participant_id AS "authorParticipantId",
  reply_to_item_id AS "replyToItemId",
  caused_by_item_id AS "causedByItemId",
  event_payload AS "eventPayload",
  event_timeline_policy AS "eventTimelinePolicy",
  event_context_policy AS "eventContextPolicy",
  metadata,
  sequence,
  created_at AS "createdAt"
`

export async function listConversationItemRowsByIds(
  executor: Executor,
  itemIds: string[]
): Promise<ChatConversationItemRow[]> {
  if (itemIds.length === 0) {
    return []
  }

  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items
      WHERE id = ANY($1::uuid[])
    `,
    [itemIds]
  )
  return result.rows.map(normalizeConversationItemRow)
}

export async function listConversationItemPartRows(
  executor: Executor,
  itemIds: string[]
): Promise<ChatConversationItemPartRow[]> {
  if (itemIds.length === 0) {
    return []
  }

  const result = await runChatSql<ChatConversationItemPartRow>(
    executor,
    `
      SELECT
        item_id AS "itemId",
        ordinal,
        part_type AS "partType",
        text_value AS "textValue",
        ref_path AS "refPath",
        ref_sha256 AS "refSha256",
        json_value AS "jsonValue",
        mime_type AS "mimeType",
        name,
        metadata
      FROM conversation_item_parts
      WHERE item_id = ANY($1::uuid[])
      ORDER BY item_id ASC, ordinal ASC
    `,
    [itemIds]
  )
  return result.rows.map(normalizeConversationItemPartRow)
}

export async function listConversationItemTargetRows(
  executor: Executor,
  itemIds: string[]
): Promise<ChatConversationParticipantLinkRow[]> {
  if (itemIds.length === 0) {
    return []
  }

  const result = await runChatSql<ChatConversationParticipantLinkRow>(
    executor,
    `
      SELECT item_id AS "itemId", target_participant_id AS "targetParticipantId"
      FROM conversation_item_targets
      WHERE item_id = ANY($1::uuid[])
      ORDER BY item_id ASC, target_participant_id ASC
    `,
    [itemIds]
  )
  return result.rows
}

export async function getVisibleConversationReplyTargetRow(
  executor: Executor,
  input: {
    conversationId: string
    replyToItemId: string
    authorParticipantId?: string | null
  }
): Promise<ChatConversationItemRow | null> {
  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items
      WHERE id = $1
        AND conversation_id = $2
        AND scope = 'shared'
        AND surface = 'visible'
        AND (
          $3::uuid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets cit0
            WHERE cit0.item_id = conversation_items.id
          )
          OR conversation_items.author_participant_id = $3
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets cit
            WHERE cit.item_id = conversation_items.id
              AND cit.target_participant_id = $3
          )
        )
      LIMIT 1
    `,
    [
      input.replyToItemId,
      input.conversationId,
      input.authorParticipantId ?? null,
    ]
  )
  return result.rows[0] ? normalizeConversationItemRow(result.rows[0]) : null
}

export async function getVisibleConversationReplyRefRow(
  executor: Executor,
  input: {
    conversationId: string
    sequence: number
    participantId?: string | null
  }
): Promise<Pick<ChatConversationItemRow, "id" | "sequence"> | null> {
  const result = await runChatSql<
    Pick<ChatConversationItemRow, "id" | "sequence">
  >(
    executor,
    `
      SELECT id, sequence
      FROM conversation_items
      WHERE conversation_id = $1
        AND sequence = $2::bigint
        AND scope = 'shared'
        AND surface = 'visible'
        AND (
          $3::uuid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets cit0
            WHERE cit0.item_id = conversation_items.id
          )
          OR conversation_items.author_participant_id = $3
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets cit
            WHERE cit.item_id = conversation_items.id
              AND cit.target_participant_id = $3
          )
        )
      LIMIT 1
    `,
    [input.conversationId, input.sequence, input.participantId ?? null]
  )
  return result.rows[0] ?? null
}

export async function listNearbyVisibleConversationReplyRefRows(
  executor: Executor,
  input: {
    conversationId: string
    sequence: number
    participantId?: string | null
  }
): Promise<Array<Pick<ChatConversationItemRow, "id" | "sequence">>> {
  const result = await runChatSql<
    Pick<ChatConversationItemRow, "id" | "sequence">
  >(
    executor,
    `
      SELECT id, sequence
      FROM conversation_items
      WHERE conversation_id = $1
        AND scope = 'shared'
        AND surface = 'visible'
        AND (
          $3::uuid IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets cit0
            WHERE cit0.item_id = conversation_items.id
          )
          OR conversation_items.author_participant_id = $3
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets cit
            WHERE cit.item_id = conversation_items.id
              AND cit.target_participant_id = $3
          )
        )
      ORDER BY ABS(sequence - $2::bigint) ASC, sequence ASC
      LIMIT 3
    `,
    [input.conversationId, input.sequence, input.participantId ?? null]
  )
  return result.rows
}

export async function getConversationItemRowById(
  executor: Executor,
  itemId: string
): Promise<ChatConversationItemRow | null> {
  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items
      WHERE id = $1
      LIMIT 1
    `,
    [itemId]
  )
  return result.rows[0] ? normalizeConversationItemRow(result.rows[0]) : null
}

export async function listContextConversationItemRowsForParticipant(
  executor: Executor,
  input: {
    conversationId: string
    participantId: string
    beforeSequence?: number | null
    limit: number
  }
): Promise<ChatConversationItemRow[]> {
  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items ci
      WHERE ci.conversation_id = $1
        AND ci.scope = 'shared'
        AND (
          (
            ci.surface = 'visible'
            AND (
              NOT EXISTS (
                SELECT 1
                FROM conversation_item_targets cit0
                WHERE cit0.item_id = ci.id
              )
              OR ci.author_participant_id = $2
              OR EXISTS (
                SELECT 1
                FROM conversation_item_targets cit
                WHERE cit.item_id = ci.id
                  AND cit.target_participant_id = $2
              )
            )
          )
          OR EXISTS (
            SELECT 1
            FROM conversation_item_context_targets cict
            WHERE cict.item_id = ci.id
              AND cict.target_participant_id = $2
          )
        )
        AND ($3::bigint IS NULL OR ci.sequence < $3)
      ORDER BY ci.sequence DESC
      LIMIT $4
    `,
    [
      input.conversationId,
      input.participantId,
      input.beforeSequence ?? null,
      input.limit,
    ]
  )
  return result.rows.map(normalizeConversationItemRow)
}

export async function getLastVisibleConversationItemRow(
  executor: Executor,
  conversationId: string
): Promise<ChatConversationItemRow | null> {
  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items
      WHERE conversation_id = $1
        AND scope = 'shared'
        AND surface = 'visible'
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [conversationId]
  )
  return result.rows[0] ? normalizeConversationItemRow(result.rows[0]) : null
}

export async function listVisibleConversationMessageRows(
  executor: Executor,
  input: {
    conversationId: string
    participantId: string
    limit: number
    afterSequence?: number
    beforeSequence?: number
  }
): Promise<ChatConversationItemRow[]> {
  if (typeof input.afterSequence === "number") {
    const result = await runChatSql<ChatConversationItemRow>(
      executor,
      `
        SELECT
          ${CONVERSATION_ITEM_SELECT}
        FROM conversation_items
        WHERE conversation_id = $1
          AND scope = 'shared'
          AND surface = 'visible'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM conversation_item_targets cit0
              WHERE cit0.item_id = conversation_items.id
            )
            OR conversation_items.author_participant_id = $3
            OR EXISTS (
              SELECT 1
              FROM conversation_item_targets cit
              WHERE cit.item_id = conversation_items.id
                AND cit.target_participant_id = $3
            )
          )
          AND sequence > $2
        ORDER BY sequence ASC
        LIMIT $4
      `,
      [
        input.conversationId,
        input.afterSequence,
        input.participantId,
        input.limit,
      ]
    )
    return result.rows.map(normalizeConversationItemRow)
  }

  if (typeof input.beforeSequence === "number") {
    const result = await runChatSql<ChatConversationItemRow>(
      executor,
      `
        SELECT
          ${CONVERSATION_ITEM_SELECT}
        FROM conversation_items
        WHERE conversation_id = $1
          AND scope = 'shared'
          AND surface = 'visible'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM conversation_item_targets cit0
              WHERE cit0.item_id = conversation_items.id
            )
            OR conversation_items.author_participant_id = $3
            OR EXISTS (
              SELECT 1
              FROM conversation_item_targets cit
              WHERE cit.item_id = conversation_items.id
                AND cit.target_participant_id = $3
            )
          )
          AND sequence < $2
        ORDER BY sequence DESC
        LIMIT $4
      `,
      [
        input.conversationId,
        input.beforeSequence,
        input.participantId,
        input.limit,
      ]
    )
    return result.rows.map(normalizeConversationItemRow)
  }

  const result = await runChatSql<ChatConversationItemRow>(
    executor,
    `
      SELECT
        ${CONVERSATION_ITEM_SELECT}
      FROM conversation_items
      WHERE conversation_id = $1
        AND scope = 'shared'
        AND surface = 'visible'
        AND (
          NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets cit0
            WHERE cit0.item_id = conversation_items.id
          )
          OR conversation_items.author_participant_id = $2
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets cit
            WHERE cit.item_id = conversation_items.id
              AND cit.target_participant_id = $2
          )
        )
      ORDER BY sequence DESC
      LIMIT $3
    `,
    [input.conversationId, input.participantId, input.limit]
  )
  return result.rows.map(normalizeConversationItemRow)
}

export async function getConversationDeviceState(
  executor: Executor,
  input: { conversationId: string; clientInstanceId: string }
): Promise<ChatConversationDeviceStateRow | null> {
  const result = await runChatSql<ChatConversationDeviceStateRow>(
    executor,
    `
      SELECT
        client_instance_id AS "clientInstanceId",
        conversation_id AS "conversationId",
        last_visible_sequence AS "lastVisibleSequence",
        last_inbox_seq AS "lastInboxSeq",
        last_opened_at AS "lastOpenedAt",
        draft_payload AS "draftPayload"
      FROM conversation_device_states
      WHERE conversation_id = $1
        AND client_instance_id = $2
      LIMIT 1
    `,
    [input.conversationId, input.clientInstanceId]
  )
  return result.rows[0] ? normalizeDeviceStateRow(result.rows[0]) : null
}

export async function conversationItemHasTargets(
  executor: Executor,
  itemId: string
): Promise<boolean> {
  const row = await executor
    .selectFrom("conversationItemTargets")
    .select("itemId")
    .where("itemId", "=", itemId)
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}

export async function getConversationKind(
  executor: Executor,
  conversationId: string
): Promise<TableInsert<"conversations">["kind"] | null> {
  const row = await executor
    .selectFrom("conversations")
    .select("kind")
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()

  return row?.kind ?? null
}

export async function listTransportDeliveryRowsForItems(
  executor: Executor,
  itemIds: string[]
): Promise<ChatTransportDeliveryRow[]> {
  if (itemIds.length === 0) {
    return []
  }

  const result = await runChatSql<ChatTransportDeliveryRow>(
    executor,
    `
      SELECT
        tml.item_id AS "itemId",
        tml.id AS "linkId",
        tml.transport_kind AS "transportKind",
        tml.direction,
        tml.delivery_status AS "deliveryStatus",
        tml.external_message_id AS "externalMessageId",
        tml.metadata,
        tml.delivered_at AS "deliveredAt",
        te.endpoint_type AS "endpointType",
        te.external_id AS "endpointExternalId",
        te.display_name AS "endpointDisplayName"
      FROM transport_message_links tml
      INNER JOIN transport_endpoints te
        ON te.id = tml.transport_endpoint_id
      WHERE tml.item_id = ANY($1::uuid[])
      ORDER BY tml.item_id ASC, tml.created_at ASC
    `,
    [itemIds]
  )
  return result.rows.map(normalizeTransportDeliveryRow)
}

export async function listWorkspaceMemberSyncEventRows(
  executor: Executor,
  input: {
    workspaceId: string
    workspaceMemberId: string
    cursor: number
    limit: number
  }
): Promise<ChatWorkspaceMemberSyncEventRow[]> {
  const result = await runChatSql<ChatWorkspaceMemberSyncEventRow>(
    executor,
    `
      SELECT
        sync_seq AS "syncSeq",
        member_seq AS "memberSeq",
        workspace_id AS "workspaceId",
        workspace_member_id AS "workspaceMemberId",
        conversation_id AS "conversationId",
        item_id AS "itemId",
        event_type AS "eventType",
        payload,
        occurred_at AS "occurredAt"
      FROM workspace_member_sync_events
      WHERE workspace_id = $1
        AND workspace_member_id = $2
        AND member_seq > $3
      ORDER BY member_seq ASC
      LIMIT $4
    `,
    [input.workspaceId, input.workspaceMemberId, input.cursor, input.limit]
  )

  return result.rows.map(normalizeWorkspaceMemberSyncEventRow)
}

export async function updateConversationMutableFields(
  executor: Executor,
  input: {
    conversationId: string
    title?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<boolean> {
  const update: {
    title?: string | null
    metadata?: RawBuilder<JsonValue>
  } = {}
  if (input.title !== undefined) {
    update.title = input.title?.trim() || null
  }
  if (input.metadata !== undefined) {
    update.metadata = jsonbValue(input.metadata)
  }
  if (Object.keys(update).length === 0) {
    return false
  }

  await executor
    .updateTable("conversations")
    .set(update)
    .where("id", "=", input.conversationId)
    .execute()

  return true
}

export async function getConversationParticipantById(
  executor: Executor,
  input: { conversationId: string; participantId: string }
): Promise<ChatParticipantByIdRow | null> {
  const result = await runChatSql<ChatParticipantByIdRow>(
    executor,
    `
      SELECT cp.id, cp.conversation_id AS "conversationId", cpsubj.kind AS "participantType",
             cpsubj.workspace_member_id AS "workspaceMemberId",
             cpsubj.actor_id AS "actorId",
             cpsubj.remote_agent_id AS "remoteAgentId",
             cp.display_name AS "displayName", cp.state
      FROM conversation_participants cp
      JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      WHERE cp.conversation_id = $1 AND cp.id = $2
      LIMIT 1
    `,
    [input.conversationId, input.participantId]
  )
  return result.rows[0] ?? null
}

export async function listChatConversationParticipantRows(
  executor: Executor,
  conversationIds: string[],
  options?: { useProfileSnapshot?: boolean }
): Promise<ChatParticipantRow[]> {
  if (conversationIds.length === 0) {
    return []
  }

  const participantDisplayNameExpr = options?.useProfileSnapshot
    ? "COALESCE(remote_agent_app.display_name, joined_version.display_name, actor_app.display_name)"
    : "COALESCE(remote_agent_app.display_name, actor_app.display_name)"
  const participantTitleExpr = options?.useProfileSnapshot
    ? "COALESCE(ra.title, joined_version.title, a.title)"
    : "COALESCE(ra.title, a.title)"
  const participantRoleExpr = options?.useProfileSnapshot
    ? "COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, joined_version.role::text, a.role::text)"
    : "COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, a.role::text)"
  const participantCanRepresentExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.can_represent_user, a.can_represent_user)"
    : "a.can_represent_user"
  const participantSpecialtiesExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.specialties, a.specialties)"
    : "a.specialties"
  const participantConfigExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.config, a.config)"
    : "a.config"
  const participantCurrentVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(joined_version.version, a.current_version)"
    : "a.current_version"
  const participantDocVersionExpr = options?.useProfileSnapshot
    ? "COALESCE(cp.actor_join_version_id, current_version.id)"
    : "current_version.id"

  const result = await runChatSql<ChatParticipantRow>(
    executor,
    `
      SELECT
        cp.id,
        cp.conversation_id AS "conversationId",
        cpsubj.kind AS "participantType",
        cpsubj.workspace_member_id AS "workspaceMemberId",
        cpsubj.actor_id AS "actorId",
        cpsubj.remote_agent_id AS "remoteAgentId",
        cp.actor_join_version_id AS "actorJoinVersionId",
        cp.display_name AS "displayName",
        cp.role_key AS "roleKey",
        cp.state,
        cp.metadata,
        cp.joined_at AS "joinedAt",
        cp.left_at AS "leftAt",
        wm.user_id AS "userId",
        u.name AS "userName",
        ${participantDisplayNameExpr} AS "participantName",
        ${participantTitleExpr} AS "participantTitle",
        ${participantRoleExpr} AS "participantRole",
        CASE
          WHEN ra.id IS NOT NULL THEN '[]'::jsonb
          ELSE COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'key', avd.doc_key,
                  'title', avd.title,
                  'visibility', avd.visibility,
                  'priority', avd.priority,
                  'content', avd.content_blocks
                )
                ORDER BY avd.priority DESC, avd.created_at ASC
              )
              FROM actor_version_docs avd
              WHERE avd.actor_version_id = ${participantDocVersionExpr}
            ),
            '[]'::jsonb
          )
        END AS "actorDocs",
        ${participantCanRepresentExpr} AS "actorCanRepresentUser",
        ${participantSpecialtiesExpr} AS "actorSpecialties",
        ${participantConfigExpr} AS "actorConfig",
        ${participantCurrentVersionExpr} AS "actorCurrentVersion",
        a.avatar_emoji AS "participantAvatarEmoji",
        a.avatar_file_id AS "participantAvatarFileId",
        u.avatar_file_id AS "userAvatarFileId",
        primary_address.id AS "transportAddressId",
        primary_address.transport_kind AS "transportKind",
        primary_address.external_id AS "transportExternalId",
        primary_address.display_name AS "transportDisplayName",
        primary_address.linked_user_id AS "linkedUserId",
        linked_user.name AS "linkedUserName",
        linked_user.avatar_file_id AS "linkedUserAvatarFileId",
        ls.id AS "sessionId",
        COALESCE(ls.status::text, rab.runtime_state::text) AS "sessionStatus"
      FROM conversation_participants cp
      LEFT JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      LEFT JOIN workspace_members wm ON wm.id = cpsubj.workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      LEFT JOIN actors a ON a.id = cpsubj.actor_id
      LEFT JOIN workspace_apps_live actor_app ON actor_app.id = a.id
      LEFT JOIN remote_agents ra ON ra.id = cpsubj.remote_agent_id
      LEFT JOIN workspace_apps_live remote_agent_app ON remote_agent_app.id = ra.id
      LEFT JOIN actor_versions current_version
        ON current_version.actor_id = a.id
       AND current_version.version = a.current_version
      LEFT JOIN actor_versions joined_version
        ON joined_version.id = cp.actor_join_version_id
      LEFT JOIN LATERAL (
        SELECT
          ta.id,
          ta.transport_kind,
          ta.external_id,
          linked_wm.user_id AS linked_user_id,
          COALESCE(ta.display_name, cp.display_name) AS display_name
        FROM conversation_participant_addresses cpa
        JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
        LEFT JOIN workspace_members linked_wm
          ON linked_wm.id = ta.workspace_member_id
        WHERE cpa.conversation_participant_id = cp.id
        ORDER BY cpa.is_primary DESC, cpa.created_at ASC
        LIMIT 1
      ) primary_address ON TRUE
      LEFT JOIN users linked_user ON linked_user.id = primary_address.linked_user_id
      LEFT JOIN remote_agent_bindings rab
        ON rab.remote_agent_id = cpsubj.remote_agent_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.status
        FROM sessions s
        WHERE s.conversation_id = cp.conversation_id
          AND s.actor_id = cpsubj.actor_id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) ls ON TRUE
      WHERE cp.conversation_id = ANY($1::uuid[])
      ORDER BY cp.conversation_id ASC, cp.joined_at ASC, cp.id ASC
    `,
    [conversationIds]
  )

  return result.rows.map(normalizeParticipantRow)
}

export async function getChatWorkspaceMemberConversationParticipantRow(
  executor: Executor,
  input: { conversationId: string; workspaceMemberId: string }
): Promise<ChatParticipantRow | null> {
  const result = await runChatSql<ChatParticipantRow>(
    executor,
    `
      SELECT
        cp.id,
        cp.conversation_id AS "conversationId",
        cpsubj.kind AS "participantType",
        cpsubj.workspace_member_id AS "workspaceMemberId",
        cpsubj.actor_id AS "actorId",
        cpsubj.remote_agent_id AS "remoteAgentId",
        cp.actor_join_version_id AS "actorJoinVersionId",
        cp.display_name AS "displayName",
        cp.role_key AS "roleKey",
        cp.state,
        cp.metadata,
        cp.joined_at AS "joinedAt",
        cp.left_at AS "leftAt",
        wm.user_id AS "userId",
        u.name AS "userName",
        COALESCE(remote_agent_app.display_name, actor_app.display_name) AS "participantName",
        COALESCE(ra.title, a.title) AS "participantTitle",
        COALESCE(CASE WHEN ra.id IS NOT NULL THEN 'remote_agent' END, a.role::text) AS "participantRole",
        '[]'::jsonb AS "actorDocs",
        a.can_represent_user AS "actorCanRepresentUser",
        a.specialties AS "actorSpecialties",
        a.config AS "actorConfig",
        a.current_version AS "actorCurrentVersion",
        COALESCE(ra.avatar_emoji, a.avatar_emoji) AS "participantAvatarEmoji",
        COALESCE(ra.avatar_file_id, a.avatar_file_id) AS "participantAvatarFileId",
        u.avatar_file_id AS "userAvatarFileId",
        primary_address.id AS "transportAddressId",
        primary_address.transport_kind AS "transportKind",
        primary_address.external_id AS "transportExternalId",
        primary_address.display_name AS "transportDisplayName",
        primary_address.linked_user_id AS "linkedUserId",
        linked_user.name AS "linkedUserName",
        linked_user.avatar_file_id AS "linkedUserAvatarFileId",
        ls.id AS "sessionId",
        COALESCE(ls.status::text, rab.runtime_state::text) AS "sessionStatus"
      FROM conversation_participants cp
      LEFT JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      LEFT JOIN workspace_members wm ON wm.id = cpsubj.workspace_member_id
      LEFT JOIN users u ON u.id = wm.user_id
      LEFT JOIN actors a ON a.id = cpsubj.actor_id
      LEFT JOIN workspace_apps_live actor_app ON actor_app.id = a.id
      LEFT JOIN remote_agents ra ON ra.id = cpsubj.remote_agent_id
      LEFT JOIN workspace_apps_live remote_agent_app ON remote_agent_app.id = ra.id
      LEFT JOIN LATERAL (
        SELECT
          ta.id,
          ta.transport_kind,
          ta.external_id,
          linked_wm.user_id AS linked_user_id,
          COALESCE(ta.display_name, cp.display_name) AS display_name
        FROM conversation_participant_addresses cpa
        JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
        LEFT JOIN workspace_members linked_wm
          ON linked_wm.id = ta.workspace_member_id
        WHERE cpa.conversation_participant_id = cp.id
        ORDER BY cpa.is_primary DESC, cpa.created_at ASC
        LIMIT 1
      ) primary_address ON TRUE
      LEFT JOIN users linked_user ON linked_user.id = primary_address.linked_user_id
      LEFT JOIN remote_agent_bindings rab
        ON rab.remote_agent_id = cpsubj.remote_agent_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.status
        FROM sessions s
        WHERE s.conversation_id = cp.conversation_id
          AND s.actor_id = cpsubj.actor_id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) ls ON TRUE
      WHERE cp.conversation_id = $1
        AND cpsubj.workspace_member_id = $2
      LIMIT 1
    `,
    [input.conversationId, input.workspaceMemberId]
  )

  return result.rows[0] ? normalizeParticipantRow(result.rows[0]) : null
}

export async function getChatConversationBaseRow(
  executor: Executor,
  input: { workspaceMemberId: string; conversationId: string }
): Promise<ChatConversationBaseRow | null> {
  const result = await runChatSql<ChatConversationBaseRow>(
    executor,
    `
      SELECT
        c.id AS "conversationId",
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS "isIm",
        c.title,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        v.unread_count AS "unreadCount",
        v.muted,
        v.archived,
        v.pinned_sort_key AS "pinnedSortKey",
        v.last_visible_item_id AS "lastVisibleItemId",
        v.last_visible_sequence AS "lastVisibleSequence",
        v.last_visible_at AS "lastVisibleAt"
      FROM workspace_member_conversation_views v
      INNER JOIN conversations c ON c.id = v.conversation_id
      WHERE v.workspace_member_id = $1
        AND v.conversation_id = $2
        AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM conversation_participants cp
          INNER JOIN access_subjects cps ON cps.id = cp.subject_id
          WHERE cp.conversation_id = v.conversation_id
            AND cps.workspace_member_id = v.workspace_member_id
            AND cp.state = 'active'
        )
      LIMIT 1
    `,
    [input.workspaceMemberId, input.conversationId]
  )

  return result.rows[0] ?? null
}

export async function listChatConversationBaseRows(
  executor: Executor,
  workspaceMemberId: string
): Promise<ChatConversationBaseRow[]> {
  const result = await runChatSql<ChatConversationBaseRow>(
    executor,
    `
      SELECT
        c.id AS "conversationId",
        c.kind,
        EXISTS (
          SELECT 1 FROM conversation_transport_bindings b
          WHERE b.conversation_id = c.id
        ) AS "isIm",
        c.title,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        v.unread_count AS "unreadCount",
        v.muted,
        v.archived,
        v.pinned_sort_key AS "pinnedSortKey",
        v.last_visible_item_id AS "lastVisibleItemId",
        v.last_visible_sequence AS "lastVisibleSequence",
        v.last_visible_at AS "lastVisibleAt"
      FROM workspace_member_conversation_views v
      INNER JOIN conversations c ON c.id = v.conversation_id
      WHERE v.workspace_member_id = $1
        AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM conversation_participants cp
          INNER JOIN access_subjects cps ON cps.id = cp.subject_id
          WHERE cp.conversation_id = v.conversation_id
            AND cps.workspace_member_id = v.workspace_member_id
            AND cp.state = 'active'
        )
      ORDER BY
        v.archived ASC,
        v.pinned_sort_key DESC NULLS LAST,
        COALESCE(v.last_visible_at, c.updated_at, c.created_at) DESC,
        c.id ASC
    `,
    [workspaceMemberId]
  )

  return result.rows
}

export async function insertConversationItemRecord(
  executor: Executor,
  input: {
    itemId: string
    conversationId: string
    sessionId?: string | null
    turnId?: string | null
    clientMessageId?: string | null
    scope: "shared" | "private"
    surface: "visible" | "internal"
    itemType: "message" | "event" | "summary" | "control"
    subtype: string
    role: "user" | "assistant" | "system" | "tool"
    authorParticipantId?: string | null
    bundleId?: string | null
    replyToItemId?: string | null
    causedByItemId?: string | null
    eventPayload?: unknown
    eventTimelinePolicy?: string | null
    eventContextPolicy?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<{ item: ChatConversationItemRow | null; inserted: boolean }> {
  const inserted = await executor.executeQuery<ChatConversationItemRow>(
    CompiledQuery.raw(
      `
        INSERT INTO conversation_items (
          id,
          conversation_id,
          session_id,
          turn_id,
          client_message_id,
          scope,
          surface,
          item_type,
          subtype,
          role,
          author_participant_id,
          bundle_id,
          reply_to_item_id,
          caused_by_item_id,
          event_payload,
          event_timeline_policy,
          event_context_policy,
          metadata,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15::jsonb, $16, $17, $18::jsonb, NOW()
        )
        ON CONFLICT (conversation_id, author_participant_id, client_message_id)
        WHERE author_participant_id IS NOT NULL AND client_message_id IS NOT NULL
        DO NOTHING
        RETURNING
          ${CONVERSATION_ITEM_SELECT}
      `,
      [
        input.itemId,
        input.conversationId,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.clientMessageId ?? null,
        input.scope,
        input.surface,
        input.itemType,
        input.subtype,
        input.role,
        input.authorParticipantId ?? null,
        input.bundleId ?? null,
        input.replyToItemId ?? null,
        input.causedByItemId ?? null,
        JSON.stringify(input.eventPayload ?? {}),
        input.eventTimelinePolicy ?? null,
        input.eventContextPolicy ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    )
  )
  const insertedItem = inserted.rows[0] ?? null
  if (insertedItem) {
    return { item: normalizeConversationItemRow(insertedItem), inserted: true }
  }

  if (input.clientMessageId && input.authorParticipantId) {
    const existing = await executor.executeQuery<ChatConversationItemRow>(
      CompiledQuery.raw(
        `
          SELECT
            ${CONVERSATION_ITEM_SELECT}
          FROM conversation_items
          WHERE conversation_id = $1
            AND author_participant_id = $2
            AND client_message_id = $3
          LIMIT 1
        `,
        [input.conversationId, input.authorParticipantId, input.clientMessageId]
      )
    )
    return {
      item: existing.rows[0]
        ? normalizeConversationItemRow(existing.rows[0])
        : null,
      inserted: false,
    }
  }

  return { item: null, inserted: false }
}

export async function insertConversationItemDetailRows(
  executor: Executor,
  input: {
    itemId: string
    parts: Array<{
      type: "text" | "file_ref" | "json"
      text?: string
      refPath?: string | null
      refSha256?: string | null
      json?: unknown
      mimeType?: string
      name?: string
      metadata?: Record<string, unknown>
    }>
    mentionedParticipants: Array<{ ordinal: number; participantId: string }>
    restrictedAudienceParticipantIds?: string[]
    contextTargetParticipantIds?: string[]
  }
): Promise<void> {
  for (const [ordinal, part] of input.parts.entries()) {
    await executor
      .insertInto("conversationItemParts")
      .values({
        id: randomUUID(),
        itemId: input.itemId,
        ordinal,
        partType: part.type,
        textValue: part.type === "text" ? (part.text ?? "") : null,
        refPath: part.type === "file_ref" ? (part.refPath ?? null) : null,
        refSha256: part.type === "file_ref" ? (part.refSha256 ?? null) : null,
        jsonValue: part.type === "json" ? jsonbValue(part.json ?? {}) : null,
        mimeType: part.mimeType ?? null,
        name: part.name ?? null,
        metadata: jsonbValue(part.metadata ?? {}),
      })
      .execute()
  }

  for (const mention of input.mentionedParticipants) {
    await executor
      .insertInto("conversationItemMentions")
      .values({
        itemId: input.itemId,
        ordinal: mention.ordinal,
        mentionedParticipantId: mention.participantId,
      })
      .execute()
  }

  for (const participantId of input.restrictedAudienceParticipantIds ?? []) {
    await executor
      .insertInto("conversationItemTargets")
      .values({
        itemId: input.itemId,
        targetParticipantId: participantId,
        targetKind: "to",
      })
      .execute()
  }

  for (const participantId of input.contextTargetParticipantIds ?? []) {
    await executor
      .insertInto("conversationItemContextTargets")
      .values({
        itemId: input.itemId,
        targetParticipantId: participantId,
      })
      .execute()
  }
}

export async function touchConversationUpdatedAt(
  executor: Executor,
  conversationId: string
): Promise<void> {
  await executor
    .updateTable("conversations")
    .set({ updatedAt: sql`NOW()` })
    .where("id", "=", conversationId)
    .execute()
}

export async function insertConversationRecord(
  executor: Executor,
  input: {
    conversationId: string
    kind: TableInsert<"conversations">["kind"]
    workspaceId: string
    title?: string | null
    createdByWorkspaceMemberId?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await executor
    .insertInto("conversations")
    .values({
      id: input.conversationId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      title: input.title?.trim() || null,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId ?? null,
      metadata: jsonbValue(input.metadata ?? {}),
      createdAt: sql`NOW()`,
    })
    .execute()
}

export async function insertChatConversationCreateRequest(
  executor: Executor,
  input: {
    workspaceMemberId: string
    clientRequestId: string
    workspaceId: string
    conversationId: string
  }
): Promise<void> {
  await executor
    .insertInto("chatConversationCreateRequests")
    .values({
      workspaceMemberId: input.workspaceMemberId,
      clientRequestId: input.clientRequestId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      createdAt: sql`NOW()`,
    })
    .execute()
}

export async function getChatClientInstanceOwner(
  executor: Executor,
  clientInstanceId: string
): Promise<{ workspaceId: string; workspaceMemberId: string } | null> {
  const row = await executor
    .selectFrom("chatClientInstances")
    .select(["workspaceId", "workspaceMemberId"])
    .where("id", "=", clientInstanceId)
    .limit(1)
    .executeTakeFirst()

  return row ?? null
}

export async function insertChatClientInstance(
  executor: Executor,
  input: {
    clientInstanceId: string
    workspaceId: string
    workspaceMemberId: string
    platform?: string | null
    deviceLabel?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await executor
    .insertInto("chatClientInstances")
    .values({
      id: input.clientInstanceId,
      workspaceId: input.workspaceId,
      workspaceMemberId: input.workspaceMemberId,
      platform: input.platform ?? null,
      deviceLabel: input.deviceLabel ?? null,
      status: "active",
      metadata: jsonbValue(input.metadata ?? {}),
      lastSeenAt: sql`NOW()`,
      createdAt: sql`NOW()`,
    })
    .execute()
}

export async function updateChatClientInstanceSeen(
  executor: Executor,
  input: {
    clientInstanceId: string
    platform?: string | null
    deviceLabel?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await executor
    .updateTable("chatClientInstances")
    .set({
      platform: sql`COALESCE(${input.platform ?? null}, platform)`,
      deviceLabel: sql`COALESCE(${input.deviceLabel ?? null}, device_label)`,
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || ${jsonbValue(
        input.metadata ?? {}
      )}`,
      status: "active",
      lastSeenAt: sql`NOW()`,
    })
    .where("id", "=", input.clientInstanceId)
    .execute()
}

export async function upsertWorkspaceMemberConversationView(
  executor: Executor,
  params: {
    workspaceMemberId: string
    conversationId: string
    lastVisibleItemId?: string | null
    lastVisibleSequence?: number
    lastVisibleAt?: Date | null
    unreadCount: number
    summary?: Record<string, unknown>
  }
): Promise<void> {
  await executor
    .insertInto("workspaceMemberConversationViews")
    .values({
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId,
      lastVisibleItemId: params.lastVisibleItemId ?? null,
      lastVisibleSequence: params.lastVisibleSequence ?? 0,
      lastVisibleAt: params.lastVisibleAt ?? null,
      unreadCount: params.unreadCount,
      summary: jsonbValue(params.summary ?? {}),
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["workspaceMemberId", "conversationId"]).doUpdateSet({
        lastVisibleItemId: sql`COALESCE(EXCLUDED.last_visible_item_id, workspace_member_conversation_views.last_visible_item_id)`,
        lastVisibleSequence: sql`GREATEST(workspace_member_conversation_views.last_visible_sequence, EXCLUDED.last_visible_sequence)`,
        lastVisibleAt: sql`COALESCE(EXCLUDED.last_visible_at, workspace_member_conversation_views.last_visible_at)`,
        unreadCount: sql`EXCLUDED.unread_count`,
        summary: sql`COALESCE(workspace_member_conversation_views.summary, '{}'::jsonb) || EXCLUDED.summary`,
      })
    )
    .execute()
}

export async function insertWorkspaceMemberSyncEventRow<
  T extends string = string,
>(
  trx: DatabaseTransaction,
  params: {
    workspaceId: string
    workspaceMemberId: string
    conversationId?: string
    itemId?: string
    eventType: T
    payload: unknown
  }
): Promise<{
  syncSeq: number | string
  memberSeq: number | string
  occurredAt: Date
}> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${params.workspaceMemberId}, 0))`.execute(
    trx
  )

  return trx
    .insertInto("workspaceMemberSyncEvents")
    .values({
      memberSeq: sql<number>`(
        SELECT COALESCE(MAX(member_seq), 0) + 1
        FROM workspace_member_sync_events
        WHERE workspace_member_id = ${params.workspaceMemberId}
      )`,
      workspaceId: params.workspaceId,
      workspaceMemberId: params.workspaceMemberId,
      conversationId: params.conversationId ?? null,
      itemId: params.itemId ?? null,
      eventType: params.eventType,
      payload: jsonbValue(params.payload),
      occurredAt: sql`NOW()`,
      createdAt: sql`NOW()`,
    })
    .returning(["syncSeq", "memberSeq", "occurredAt"])
    .executeTakeFirstOrThrow()
}

export async function getConversationMaxSequence(
  executor: Executor,
  conversationId: string
): Promise<unknown> {
  const row = await executor
    .selectFrom("conversationItems")
    .select((eb) => eb.fn.max("sequence").as("maxSequence"))
    .where("conversationId", "=", conversationId)
    .executeTakeFirst()

  return row?.maxSequence
}

export async function getLastConversationItemIdAtOrBeforeSequence(
  executor: Executor,
  conversationId: string,
  sequence: number
): Promise<string | null> {
  const row = await executor
    .selectFrom("conversationItems")
    .select("id")
    .where("conversationId", "=", conversationId)
    .where("sequence", "<=", String(sequence))
    .orderBy("sequence", "desc")
    .limit(1)
    .executeTakeFirst()

  return row?.id ?? null
}

export async function listMentionedParticipantIdsForConversationItem(
  executor: Executor,
  itemId: string
): Promise<string[]> {
  const rows = await executor
    .selectFrom("conversationItemMentions")
    .select("mentionedParticipantId")
    .where("itemId", "=", itemId)
    .orderBy("ordinal", "asc")
    .orderBy("mentionedParticipantId", "asc")
    .execute()

  return rows.map((row) => row.mentionedParticipantId)
}

export async function updateConversationItemEventPayload(
  executor: Executor,
  itemId: string,
  payload: unknown
): Promise<void> {
  await executor
    .updateTable("conversationItems")
    .set({ eventPayload: jsonbValue(payload) })
    .where("id", "=", itemId)
    .execute()
}

export async function listConversationItemContextTargetRows(
  executor: Executor,
  itemIds: string[]
): Promise<Array<{ itemId: string; targetParticipantId: string }>> {
  if (itemIds.length === 0) {
    return []
  }

  return executor
    .selectFrom("conversationItemContextTargets")
    .select(["itemId", "targetParticipantId"])
    .where("itemId", "in", itemIds)
    .orderBy("itemId", "asc")
    .orderBy("targetParticipantId", "asc")
    .execute()
}

export async function insertConversationParticipantRecord(
  executor: Executor,
  input: {
    participantId: string
    conversationId: string
    subjectId: string
    actorJoinVersionId?: string | null
    displayName?: string | null
    roleKey: string
    metadata?: Record<string, unknown>
    transportAddressId?: string | null
  }
): Promise<void> {
  await executor
    .insertInto("conversationParticipants")
    .values({
      id: input.participantId,
      conversationId: input.conversationId,
      subjectId: input.subjectId,
      actorJoinVersionId: input.actorJoinVersionId ?? null,
      displayName: input.displayName ?? null,
      roleKey: input.roleKey,
      state: "active",
      metadata: jsonbValue(input.metadata ?? {}),
      joinedAt: sql`NOW()`,
    })
    .execute()

  await executor
    .insertInto("conversationParticipantStates")
    .values({
      conversationId: input.conversationId,
      participantId: input.participantId,
      readWatermarkSequence: 0,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["conversationId", "participantId"]).doNothing()
    )
    .execute()

  if (input.transportAddressId) {
    await upsertConversationParticipantAddress(
      executor,
      input.participantId,
      input.transportAddressId,
      { updateOnConflict: false }
    )
  }
}

export async function getConversationParticipantStateBySubject(
  executor: Executor,
  input: {
    conversationId: string
    subjectId: string
  }
): Promise<{ id: string; state: string | null } | null> {
  const row = await executor
    .selectFrom("conversationParticipants")
    .select(["id", "state"])
    .where("conversationId", "=", input.conversationId)
    .where("subjectId", "=", input.subjectId)
    .limit(1)
    .executeTakeFirst()

  return row ?? null
}

export async function reactivateConversationParticipant(
  executor: Executor,
  input: {
    participantId: string
    actorJoinVersionId?: string | null
    displayName?: string | null
    roleKey: string
    metadata?: Record<string, unknown>
  }
): Promise<void> {
  await executor
    .updateTable("conversationParticipants")
    .set({
      actorJoinVersionId: sql`COALESCE(${
        input.actorJoinVersionId ?? null
      }, actor_join_version_id)`,
      displayName: sql`COALESCE(${input.displayName ?? null}, display_name)`,
      roleKey: sql`COALESCE(${input.roleKey}, role_key)`,
      state: "active",
      leftAt: null,
      metadata: sql`COALESCE(conversation_participants.metadata, '{}'::jsonb) || ${jsonbValue(
        input.metadata ?? {}
      )}`,
    })
    .where("id", "=", input.participantId)
    .execute()
}

export async function upsertConversationParticipantAddress(
  executor: Executor,
  participantId: string,
  transportAddressId: string,
  options?: { updateOnConflict?: boolean }
): Promise<void> {
  const updateOnConflict = options?.updateOnConflict ?? true
  await executor
    .insertInto("conversationParticipantAddresses")
    .values({
      conversationParticipantId: participantId,
      transportAddressId,
      isPrimary: true,
      metadata: jsonbValue({}),
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      updateOnConflict
        ? oc
            .columns(["conversationParticipantId", "transportAddressId"])
            .doUpdateSet({
              isPrimary: sql`EXCLUDED.is_primary`,
            })
        : oc
            .columns(["conversationParticipantId", "transportAddressId"])
            .doNothing()
    )
    .execute()
}

export async function updateConversationParticipantState(
  executor: Executor,
  participantId: string,
  state: "removed" | "left"
): Promise<void> {
  await executor
    .updateTable("conversationParticipants")
    .set({
      state,
      leftAt: sql`COALESCE(left_at, NOW())`,
    })
    .where("id", "=", participantId)
    .execute()
}

export async function getConversationParticipantReadState(
  executor: Executor,
  input: {
    conversationId: string
    participantId: string
  }
): Promise<{
  readWatermarkSequence: string | number
  lastReadAt: Date | null
} | null> {
  const row = await executor
    .selectFrom("conversationParticipantStates")
    .select(["readWatermarkSequence", "lastReadAt"])
    .where("conversationId", "=", input.conversationId)
    .where("participantId", "=", input.participantId)
    .limit(1)
    .executeTakeFirst()

  return row ?? null
}

export async function upsertConversationParticipantReadState(
  executor: Executor,
  input: {
    conversationId: string
    participantId: string
    readWatermarkSequence: number
    lastReadItemId: string | null
  }
): Promise<void> {
  await executor
    .insertInto("conversationParticipantStates")
    .values({
      conversationId: input.conversationId,
      participantId: input.participantId,
      readWatermarkSequence: input.readWatermarkSequence,
      lastReadItemId: input.lastReadItemId,
      lastReadAt: sql`NOW()`,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["conversationId", "participantId"]).doUpdateSet({
        readWatermarkSequence: sql`GREATEST(conversation_participant_states.read_watermark_sequence, EXCLUDED.read_watermark_sequence)`,
        lastReadItemId: sql`EXCLUDED.last_read_item_id`,
        lastReadAt: sql`NOW()`,
      })
    )
    .execute()
}

export async function upsertConversationDeviceState(
  executor: Executor,
  input: {
    conversationId: string
    clientInstanceId: string
    lastVisibleSequence: number
  }
): Promise<void> {
  await executor
    .insertInto("conversationDeviceStates")
    .values({
      conversationId: input.conversationId,
      clientInstanceId: input.clientInstanceId,
      lastVisibleSequence: input.lastVisibleSequence,
      lastOpenedAt: sql`NOW()`,
      lastInboxSeq: 0,
      draftPayload: jsonbValue({}),
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.columns(["conversationId", "clientInstanceId"]).doUpdateSet({
        lastVisibleSequence: sql`GREATEST(conversation_device_states.last_visible_sequence, EXCLUDED.last_visible_sequence)`,
        lastOpenedAt: sql`NOW()`,
      })
    )
    .execute()
}

export async function getTransportAddressSubjectRow(
  executor: Executor,
  transportAddressId: string
): Promise<{
  workspaceId: string
  addressType: string
  workspaceMemberId: string | null
} | null> {
  const row = await executor
    .selectFrom("transportAddresses")
    .select(["workspaceId", "addressType", "workspaceMemberId"])
    .where("id", "=", transportAddressId)
    .limit(1)
    .executeTakeFirst()

  return row ?? null
}

export async function listWorkspaceMemberNameRows(
  executor: Executor,
  workspaceId: string,
  workspaceMemberIds: string[]
): Promise<Array<{ id: string; userName: string }>> {
  if (workspaceMemberIds.length === 0) {
    return []
  }

  return executor
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select(["wm.id", "u.name as userName"])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.id", "in", workspaceMemberIds)
    .execute()
}

export async function listActorDisplayNameRows(
  executor: Executor,
  workspaceId: string,
  actorIds: string[]
): Promise<Array<{ id: string; displayName: string | null }>> {
  if (actorIds.length === 0) {
    return []
  }

  return executor
    .selectFrom("actors as actor")
    .innerJoin("workspaceAppsLive as app", "app.id", "actor.id")
    .select(["actor.id", "app.displayName"])
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("actor.id", "in", actorIds)
    .execute()
}

export async function listRemoteAgentDisplayNameRows(
  executor: Executor,
  workspaceId: string,
  remoteAgentIds: string[]
): Promise<Array<{ id: string; displayName: string | null }>> {
  if (remoteAgentIds.length === 0) {
    return []
  }

  return executor
    .selectFrom("remoteAgents as agent")
    .innerJoin("workspaceAppsLive as app", "app.id", "agent.id")
    .select(["agent.id", "app.displayName"])
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("agent.id", "in", remoteAgentIds)
    .execute()
}

export async function getConversationRecord(
  executor: Executor,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  const row = await executor
    .selectFrom("conversations")
    .selectAll()
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()

  return (row as Record<string, unknown> | undefined) ?? null
}

export async function insertConversationRecordReturning(
  executor: Executor,
  input: {
    conversationId: string
    kind: TableInsert<"conversations">["kind"]
    workspaceId: string
    title?: string | null
    createdByWorkspaceMemberId?: string | null
    metadata?: Record<string, unknown>
  }
): Promise<Record<string, unknown>> {
  const row = await executor
    .insertInto("conversations")
    .values({
      id: input.conversationId,
      kind: input.kind,
      workspaceId: input.workspaceId,
      title: input.title?.trim() || null,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId ?? null,
      metadata: jsonbValue(input.metadata ?? {}),
      createdAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    throw new Error("Failed to create conversation")
  }

  return row as Record<string, unknown>
}

export async function conversationParticipantExists(
  executor: Executor,
  input: { conversationId: string; participantId: string }
): Promise<boolean> {
  const row = await executor
    .selectFrom("conversationParticipants")
    .select("id")
    .where("conversationId", "=", input.conversationId)
    .where("id", "=", input.participantId)
    .limit(1)
    .executeTakeFirst()

  return Boolean(row)
}

export async function listConversationParticipantStatesByWorkspaceMember(
  executor: Executor,
  input: { conversationId: string; workspaceMemberIds: string[] }
): Promise<Array<{ workspaceMemberId: string; state: string }>> {
  if (input.workspaceMemberIds.length === 0) {
    return []
  }

  const rows = await executor
    .selectFrom("conversationParticipants as cp")
    .innerJoin("accessSubjects as cps", "cps.id", "cp.subjectId")
    .select(["cps.workspaceMemberId", "cp.state"])
    .where("cp.conversationId", "=", input.conversationId)
    .where("cps.workspaceMemberId", "in", input.workspaceMemberIds)
    .execute()

  return rows.flatMap((row) =>
    row.workspaceMemberId
      ? [{ workspaceMemberId: row.workspaceMemberId, state: row.state }]
      : []
  )
}

export async function getWorkspaceMemberSyncCursor(
  executor: Executor,
  input: { workspaceId: string; workspaceMemberId: string }
): Promise<string | number | null> {
  const row = await executor
    .selectFrom("workspaceMemberSyncEvents")
    .select((eb) =>
      eb.fn.coalesce(eb.fn.max("memberSeq"), eb.val(0)).as("cursor")
    )
    .where("workspaceId", "=", input.workspaceId)
    .where("workspaceMemberId", "=", input.workspaceMemberId)
    .executeTakeFirst()

  return row?.cursor ?? null
}

export async function countUnreadVisibleConversationMessages(
  executor: Executor,
  input: { conversationId: string; participantId: string }
): Promise<string | number | null> {
  const result = await runChatSql<{ unreadCount: string | number }>(
    executor,
    `
      SELECT COUNT(*)::int AS "unreadCount"
      FROM conversation_items ci
      WHERE ci.conversation_id = $1
        AND ci.item_type = 'message'
        AND ci.scope = 'shared'
        AND ci.surface = 'visible'
        AND ci.author_participant_id IS DISTINCT FROM $2::uuid
        AND ci.sequence > COALESCE((
          SELECT cps.read_watermark_sequence
          FROM conversation_participant_states cps
          WHERE cps.conversation_id = $1
            AND cps.participant_id = $2::uuid
        ), 0)
        AND (
          NOT EXISTS (
            SELECT 1
            FROM conversation_item_targets t
            WHERE t.item_id = ci.id
          )
          OR EXISTS (
            SELECT 1
            FROM conversation_item_targets t
            WHERE t.item_id = ci.id
              AND t.target_participant_id = $2::uuid
          )
        )
    `,
    [input.conversationId, input.participantId]
  )

  return result.rows[0]?.unreadCount ?? null
}

export async function listConversationRealtimeRecipientRows(
  executor: Executor,
  conversationId: string
): Promise<Array<{ workspaceId: string; workspaceMemberId: string }>> {
  const result = await runChatSql<{
    workspaceId: string
    workspaceMemberId: string
  }>(
    executor,
    `
      SELECT wm.workspace_id AS "workspaceId", cpsubj.workspace_member_id AS "workspaceMemberId"
      FROM conversation_participants cp
      INNER JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      INNER JOIN workspace_members wm
        ON wm.id = cpsubj.workspace_member_id
      WHERE cp.conversation_id = $1
        AND cp.state = 'active'
        AND cpsubj.workspace_member_id IS NOT NULL
    `,
    [conversationId]
  )

  return result.rows
}

export async function getChatConversationCreateRequestConversationId(
  executor: Executor,
  input: { workspaceMemberId: string; clientRequestId: string }
): Promise<string | null> {
  const row = await executor
    .selectFrom("chatConversationCreateRequests")
    .select("conversationId")
    .where("workspaceMemberId", "=", input.workspaceMemberId)
    .where("clientRequestId", "=", input.clientRequestId)
    .limit(1)
    .executeTakeFirst()

  return row?.conversationId ?? null
}

export async function upsertChatPushTokenRecord(input: {
  workspaceMemberId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel?: string | null
  metadata?: Record<string, unknown>
}): Promise<ChatPushTokenRow> {
  const result = await runChatSqlOnRoot<Record<string, unknown>>(
    `
      INSERT INTO chat_push_tokens (workspace_member_id, platform, token, device_label, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (workspace_member_id, token)
      DO UPDATE SET platform = EXCLUDED.platform,
                    device_label = EXCLUDED.device_label,
                    metadata = EXCLUDED.metadata,
                    last_seen_at = NOW()
      RETURNING id, workspace_member_id, platform, token, device_label,
                created_at, last_seen_at
    `,
    [
      input.workspaceMemberId,
      input.platform,
      input.token,
      input.deviceLabel ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  )
  const row = result.rows[0]
  if (!row) {
    throw new Error("Failed to register push token")
  }
  return mapPushTokenRow(row)
}

export async function listChatPushTokenRecords(
  workspaceMemberId: string
): Promise<ChatPushTokenRow[]> {
  const result = await runChatSqlOnRoot<Record<string, unknown>>(
    `
      SELECT id, workspace_member_id, platform, token, device_label,
             created_at, last_seen_at
      FROM chat_push_tokens
      WHERE workspace_member_id = $1
      ORDER BY last_seen_at DESC
    `,
    [workspaceMemberId]
  )
  return result.rows.map(mapPushTokenRow)
}

export async function deleteChatPushTokenRecord(input: {
  tokenId: string
  workspaceMemberId: string
}): Promise<boolean> {
  const result = await runChatSqlOnRoot<{ id: string }>(
    `
      DELETE FROM chat_push_tokens
      WHERE id = $1 AND workspace_member_id = $2
      RETURNING id
    `,
    [input.tokenId, input.workspaceMemberId]
  )

  return result.rows.length > 0
}

export function chatRootExecutor(): Executor {
  return db
}

export function isChatTransaction(
  executor: Executor
): executor is DatabaseTransaction {
  return (executor as { isTransaction?: boolean }).isTransaction === true
}

export async function withChatTransaction<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return withDbTransaction(fn)
}

export async function withChatRepeatableRead<T>(
  fn: (trx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return db.transaction().setIsolationLevel("repeatable read").execute(fn)
}

export async function runChatSqlOnRoot<
  T extends object = Record<string, unknown>,
>(
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  return runChatSql<T>(db, text, params)
}

async function runChatSql<T extends object = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return { rows: result.rows as T[] }
}

export interface ChatPushTokenRow {
  id: string
  workspaceMemberId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel: string | null
  createdAt: Timestamp
  lastSeenAt: Timestamp
}

export function mapPushTokenRow(
  row: Record<string, unknown>
): ChatPushTokenRow {
  // The push-token query runs via `runOnDb` (CompiledQuery.raw) but still flows
  // through Kysely's CamelCasePlugin result transformer, so top-level keys arrive
  // camelCased (createdAt / lastSeenAt / workspaceMemberId / deviceLabel) even
  // though the SQL RETURNING list is snake_case. Read the camelCase keys, and
  // coerce the pg-text timestamps to Date before serializing.
  return {
    id: String(row.id),
    workspaceMemberId: String(row.workspaceMemberId),
    platform: row.platform as "ios" | "android" | "web",
    token: String(row.token),
    deviceLabel: (row.deviceLabel as string | null) ?? null,
    createdAt: serializeInstant(new Date(row.createdAt as string)),
    lastSeenAt: serializeInstant(new Date(row.lastSeenAt as string)),
  }
}

// ─────────────────────────── workspace-member identity ───────────────────────
// The workspace-member identity record + its two reads. Lives in repo.ts (the
// only chat file allowed to touch the DB client, guard r8); the public surface
// (workspace-identity.ts) re-exports these + adds the pure require* wrapper, so
// the 6 cross-module importers are unchanged. round-6 P1-6.

export interface WorkspaceMemberIdentity {
  workspaceMemberId: string
  workspaceId: string
  userId: string
  userName: string
  avatarFileId?: string | null
  trustLevel: string
}

export async function getWorkspaceMemberIdentity(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .where("wm.userId", "=", userId)
    // Soft delete (§8.4): only an active member + live user resolves to an identity.
    .where("wm.status", "=", "active")
    .where("u.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
  }
}

export async function getWorkspaceMemberIdentityById(
  workspaceMemberId: string
): Promise<WorkspaceMemberIdentity | null> {
  const row = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wm.id as workspaceMemberId",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "u.name as userName",
      "u.avatarFileId",
    ])
    .where("wm.id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return null
  }

  return {
    workspaceMemberId: row.workspaceMemberId,
    workspaceId: row.workspaceId,
    userId: row.userId,
    userName: row.userName,
    avatarFileId: row.avatarFileId,
    trustLevel: row.trustLevel,
  }
}
